// The agent loop for one incident (spec steps 1–8). All state lives in Atlas:
// the incident, an agent_runs document for per-step status, the attempt, the
// runbook stats and the time-series metric. Revision + replay are in revise.ts.
import * as db from "@/db/tenantScoped";
import { callStructured } from "@/lib/claude";
import { embedOne } from "@/lib/embed";
import { SelectAndAdaptSchema } from "@/lib/schemas";
import type { Attempt, Incident, RollingStats, Runbook } from "@/lib/types";
import { initialState, injectFault, runSteps, verify } from "@/sim/engine";
import { hiddenFor } from "@/sim/tenants";
import { SELECT_SYSTEM, selectUser } from "./prompts";
import { maybeRevise, type RevisionOutcome } from "./revise";

export const AGENT_STEPS = ["embed", "recall", "select", "execute", "verify", "record", "revise"] as const;

export type HandleResult = {
  runId: string;
  incidentId: string;
  attempt: Attempt;
  runbook: Runbook;
  rolling: RollingStats;
  revision: RevisionOutcome | null;
};

export type FireInput = { type: Incident["type"]; title: string; symptoms: string[]; env_snapshot: db.NewIncident["env_snapshot"] };

/** Creates the incident, injects its hidden fault into the simulator, then runs the loop. */
export async function fireIncident(tenantId: string, input: FireInput): Promise<HandleResult> {
  const tenant = await db.getTenant(tenantId);
  if (!tenant) throw new Error(`tenant ${tenantId} not seeded`);
  const vector = await embedOne(`${input.title}. ${input.symptoms.join(". ")}`, "document");
  const incidentId = await db.insertIncident(tenantId, { ...input, embedding: vector });

  const state = (await db.getSimState(tenantId)) ?? initialState(tenant.environment, hiddenFor(tenantId));
  await db.saveSimState(tenantId, injectFault(state, input.type));

  return handleIncident(tenantId, incidentId, { queryVector: vector });
}

export async function handleIncident(tenantId: string, incidentId: string, opts: { queryVector?: number[]; phase?: Attempt["phase"]; forceRunbookId?: string } = {}): Promise<HandleResult> {
  const tenant = await db.getTenant(tenantId);
  const incident = await db.getIncident(tenantId, incidentId);
  if (!tenant || !incident) throw new Error(`incident ${incidentId} not found for ${tenantId}`);
  const env = tenant.environment;
  const runId = await db.createAgentRun(tenantId, incidentId, [...AGENT_STEPS]);
  const step = (name: (typeof AGENT_STEPS)[number], status: "running" | "done" | "failed", detail?: string) => db.updateAgentRunStep(tenantId, runId, name, status, detail);

  try {
    // 1. embed
    await step("embed", "running");
    const queryVector = opts.queryVector ?? (await db.getIncidentEmbedding(tenantId, incidentId)) ?? (await embedOne(`${incident.title}. ${incident.symptoms.join(". ")}`, "query"));
    await step("embed", "done", `${queryVector.length}-dim vector`);

    // 2. recall: tenant-filtered hybrid search + the attempts behind each hit
    await step("recall", "running");
    const similarIncidents = await db.searchSimilarIncidents(tenantId, queryVector, `${incident.title} ${incident.symptoms.join(" ")}`, 5, { excludeIncidentId: incidentId });
    const similarAttempts = await db.listAttempts(tenantId, { incidentIds: similarIncidents.map((s) => s._id), limit: 25 });
    const similar = similarIncidents.map((s) => ({ incident: s, attempts: similarAttempts.filter((a) => a.incident_id === s._id) }));
    await step("recall", "done", `${similar.length} similar incidents, ${similarAttempts.length} attempts (filter: tenant_id=${tenantId})`);

    // 3+4. candidates, then Claude selects + adapts
    await step("select", "running");
    const candidates = await db.listCandidateRunbooks(tenantId, incident.type);
    if (candidates.length === 0) throw new Error(`no runbooks for ${incident.type}`);
    let runbook: Runbook;
    let steps;
    let selectDetail: string;
    if (opts.forceRunbookId) {
      // Replay: run the runbook's current version verbatim, no Claude call.
      runbook = (await db.getRunbook(tenantId, opts.forceRunbookId))!;
      steps = runbook.versions.find((v) => v.version === runbook.current_version)!.steps;
      selectDetail = `replay with ${runbook.name} v${runbook.current_version}`;
    } else {
      const sel = await callStructured({
        name: "select_and_adapt_runbook",
        schema: SelectAndAdaptSchema,
        system: SELECT_SYSTEM,
        user: selectUser({ tenant, incident, similar, candidates }),
      });
      const chosen = candidates.find((c) => c._id === sel.data.runbook_id) ?? candidates[0];
      // Global templates are read-only: adapting one forks a tenant-owned copy.
      runbook = chosen.tenant_id === "global" ? await db.forkRunbook(tenantId, chosen._id, sel.data.steps, `adapted from global template for incident ${incidentId}`) : chosen;
      steps = sel.data.steps;
      selectDetail = `${runbook.name} v${runbook.current_version}: ${sel.data.selection_notes}${sel.retried ? " (schema retry)" : ""}`;
    }
    await step("select", "done", selectDetail);

    // 5. execute in the simulator (state persisted in Atlas)
    await step("execute", "running");
    const before = (await db.getSimState(tenantId)) ?? injectFault(initialState(env, hiddenFor(tenantId)), incident.type);
    const run = runSteps(before, steps, env);
    await db.saveSimState(tenantId, run.state);
    await step("execute", "done", run.results.map((r, i) => `${i + 1}. ${r.step.action} ${r.ok ? "ok" : "FAILED"}`).join("; "));

    // 6. verify (hard signal) + record the attempt
    await step("verify", "running");
    const verification = verify(run.state, incident.type, env);
    await step("verify", verification.passed ? "done" : "failed", `${verification.check_name}: ${verification.detail}`);

    await step("record", "running");
    const attemptId = await db.insertAttempt(tenantId, {
      incident_id: incidentId,
      runbook_id: runbook._id,
      runbook_version: runbook.current_version,
      steps_executed: run.results,
      verification,
      phase: opts.phase ?? "live",
    });
    await db.setIncidentStatus(tenantId, incidentId, verification.passed ? "resolved" : "failed");
    // 7. stats + metric point, rolling rate and trigger computed in Mongo
    const rolling = await db.updateRunbookStatsAfterAttempt(tenantId, runbook._id, { passed: verification.passed, runbook_version: runbook.current_version, created_at: new Date() });
    await step("record", "done", `attempt ${attemptId}; rolling ${rolling.rate} over ${rolling.n}${rolling.trigger ? " → REVISION TRIGGERED" : ""}`);

    // 8+9. revision trigger + replay
    await step("revise", "running");
    const revision = rolling.trigger && !opts.forceRunbookId ? await maybeRevise(tenantId, runbook._id, rolling) : null;
    await step("revise", "done", revision ? `v${revision.revision.from_version} → v${revision.revision.to_version}; replay ${revision.replay.filter((r) => r.passed).length}/${revision.replay.length} passed` : rolling.trigger ? "trigger hit during replay; skipped" : "not triggered");

    await db.finishAgentRun(tenantId, runId, revision ? "revised" : verification.passed ? "passed" : "failed", { chosen_runbook_id: runbook._id, runbook_version: runbook.current_version });
    const attempt = (await db.listAttempts(tenantId, { attemptIds: [attemptId] }))[0];
    return { runId, incidentId, attempt, runbook, rolling, revision };
  } catch (e) {
    await db.finishAgentRun(tenantId, runId, "error");
    throw e;
  }
}
