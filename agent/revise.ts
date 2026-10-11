// Revision trigger (computed in Mongo by rollingStats) → Claude proposes a new
// version → version + revision record committed in one transaction → replay of
// the failed incidents against the new version (the before/after metric).
import * as db from "@/db/tenantScoped";
import { callStructured } from "@/lib/claude";
import { embedOne } from "@/lib/embed";
import { ProposeRevisionSchema, REVISION_WINDOW, type Step } from "@/lib/schemas";
import type { Attempt, Incident, Revision, RollingStats } from "@/lib/types";
import { injectFault } from "@/sim/engine";
import { REVISE_SYSTEM, reviseUser } from "./prompts";

export type ReplayResult = { incident_id: string; attempt_id: string; passed: boolean; before_passed: boolean };
export type RevisionOutcome = { revision: Revision; replay: ReplayResult[]; rate_before: number; rate_after: number };

const key = (s: Step) => JSON.stringify(s);
export function diffSteps(from: Step[], to: Step[]) {
  const a = new Set(from.map(key)), b = new Set(to.map(key));
  return { added: to.filter((s) => !a.has(key(s))), removed: from.filter((s) => !b.has(key(s))) };
}

export async function maybeRevise(tenantId: string, runbookId: string, rolling: RollingStats): Promise<RevisionOutcome | null> {
  if (!rolling.trigger) return null;
  const tenant = (await db.getTenant(tenantId))!;
  const runbook = (await db.getRunbook(tenantId, runbookId))!;
  if (runbook.tenant_id === "global") throw new Error("global templates are never revised in place");

  const failedAttempts = await db.listAttempts(tenantId, { attemptIds: rolling.failed_attempt_ids });
  const failed: { incident: Incident; attempt: Attempt }[] = [];
  for (const a of failedAttempts) {
    const incident = await db.getIncident(tenantId, a.incident_id);
    if (incident) failed.push({ incident, attempt: a });
  }
  if (failed.length === 0) return null;

  // Similar incidents that did verify, as positive examples (tenant-filtered hybrid search).
  const probe = failed[0].incident;
  const vector = (await db.getIncidentEmbedding(tenantId, probe._id)) ?? (await embedOne(`${probe.title}. ${probe.symptoms.join(". ")}`, "query"));
  const similar = await db.searchSimilarIncidents(tenantId, vector, `${probe.title} ${probe.symptoms.join(" ")}`, 8);
  const simAttempts = await db.listAttempts(tenantId, { incidentIds: similar.map((s) => s._id), limit: 40 });
  const successes = similar
    .map((s) => ({ incident: s, attempts: simAttempts.filter((a) => a.incident_id === s._id && a.verification.passed) }))
    .filter((s) => s.attempts.length > 0)
    .slice(0, 3);

  const proposal = await callStructured({
    name: "propose_revision",
    schema: ProposeRevisionSchema,
    system: REVISE_SYSTEM,
    user: reviseUser({ tenant, runbook, failed, successes, rate: rolling.rate, window: REVISION_WINDOW }),
  });

  const current = runbook.versions.find((v) => v.version === runbook.current_version)!.steps;
  const { added, removed } = diffSteps(current, proposal.data.steps);
  // Claude occasionally returns empty prose fields; the record must still explain itself.
  const describe = (s: Step) => Object.values(s).map((v) => (Array.isArray(v) ? v.join(",") : String(v))).join(" ");
  const evidence = failed.flatMap((f) => f.attempt.steps_executed.map((s) => s.detail)).find((d) => /Group Policy|re-pinned|managed by/i.test(d));
  const fallbackRationale =
    `Verified failures on ${tenant.name}: ${failed.map((f) => f.attempt.verification.detail).join(" | ")}. ` +
    (evidence ? `Step output showed: "${evidence}". ` : "") +
    `New version adds ${added.map(describe).join("; ") || "no steps"} and removes ${removed.map(describe).join("; ") || "no steps"}.`;
  const fallbackSummary = `${added.length} step(s) added, ${removed.length} removed${added.length ? `: ${added.map((s) => s.action).join(", ")}` : ""}`;
  const revision = await db.commitRevision(tenantId, runbookId, {
    steps: proposal.data.steps,
    rationale: proposal.data.root_cause_analysis.trim() || fallbackRationale,
    diff: { added, removed, summary: proposal.data.diff_summary.trim() || fallbackSummary },
    trigger: { failed_attempt_ids: rolling.failed_attempt_ids, success_rate: rolling.rate, window: REVISION_WINDOW },
    reason: `auto-revision: rolling success ${rolling.rate} < threshold over ${REVISION_WINDOW} attempts`,
  });

  const replay = await replayFailed(tenantId, runbookId, failed);
  const after = await db.rollingStats(tenantId, runbookId);
  return { revision, replay, rate_before: rolling.rate, rate_after: after.rate };
}

/** Re-inject each failed incident's fault and run the new version against it. */
export async function replayFailed(tenantId: string, runbookId: string, failed: { incident: Incident; attempt: Attempt }[]): Promise<ReplayResult[]> {
  // Lazy import avoids a module cycle (handleIncident imports revise).
  const { handleIncident } = await import("./handleIncident");
  const tenant = (await db.getTenant(tenantId))!;
  const out: ReplayResult[] = [];
  for (const f of failed) {
    const state = (await db.getSimState(tenantId))!;
    await db.saveSimState(tenantId, injectFault(state, f.incident.type));
    const res = await handleIncident(tenantId, f.incident._id, { phase: "replay", forceRunbookId: runbookId });
    out.push({ incident_id: f.incident._id, attempt_id: res.attempt._id, passed: res.attempt.verification.passed, before_passed: f.attempt.verification.passed });
    void tenant;
  }
  return out;
}
