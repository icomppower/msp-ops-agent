// End-to-end against the live cluster and live Claude: the demo script as a test.
// Fire DNS on the GPO-quirk tenant twice → second failure trips the trigger →
// Claude revises → replay passes. Then a normal tenant incident passes with no
// revision. Everything the test creates is rolled back afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "@/db/tenantScoped";
import { fireIncident, type HandleResult } from "@/agent/handleIncident";
import { initialState } from "@/sim/engine";
import { liveIncident } from "@/sim/incidentText";
import { GPO_QUIRK_TENANT, hiddenFor, tenantById } from "@/sim/tenants";

const GPO = GPO_QUIRK_TENANT;
const NORMAL = "acme-dental";
const since = new Date();
let first: HandleResult, second: HandleResult, normal: HandleResult;

beforeAll(async () => {
  await db.admin.waitForSearchIndexes();
  for (const t of [GPO, NORMAL]) await db.saveSimState(t, initialState(tenantById(t).environment, hiddenFor(t)));
});

afterAll(async () => {
  for (const t of [GPO, NORMAL]) {
    await db.rollbackTenantSince(t, since);
    await db.saveSimState(t, initialState(tenantById(t).environment, hiddenFor(t)));
  }
  await db.admin.close();
});

describe("agent loop + revision + replay (live Claude)", () => {
  it("fire #1 on the GPO tenant: generic DNS fix fails verification, rate 0.67, no revision yet", async () => {
    first = await fireIncident(GPO, liveIncident("dns_misconfig", tenantById(GPO).environment, 1));
    expect(first.attempt.verification.passed).toBe(false);
    expect(first.attempt.verification.check_name).toBe("dns_internal_resolution");
    expect(first.runbook.tenant_id).toBe(GPO);
    expect(first.rolling.rate).toBe(0.67);
    expect(first.rolling.trigger).toBe(false);
    expect(first.revision).toBeNull();
    const run = await db.getAgentRun(GPO, first.runId);
    expect(run?.status).toBe("failed");
    expect(run?.steps.map((s) => s.status)).toEqual(["done", "done", "done", "done", "failed", "done", "done"]);
  }, 300_000);

  it("fire #2: fails again, rate 0.33 < 0.67 → revision committed transactionally and replay passes", async () => {
    second = await fireIncident(GPO, liveIncident("dns_misconfig", tenantById(GPO).environment, 2));
    expect(second.attempt.verification.passed).toBe(false);
    expect(second.rolling.rate).toBe(0.33);
    expect(second.rolling.trigger).toBe(true);
    expect(second.revision).not.toBeNull();
    const rev = second.revision!;
    expect(rev.revision.from_version).toBe(1);
    expect(rev.revision.to_version).toBe(2);
    expect(rev.revision.trigger.failed_attempt_ids.sort()).toEqual([first.attempt._id, second.attempt._id].sort());
    expect(rev.revision.rationale.length).toBeGreaterThan(20);

    // Transaction: the new version and the revision record exist together.
    const rb = (await db.getRunbook(GPO, second.runbook._id))!;
    expect(rb.current_version).toBe(2);
    expect(rb.versions.map((v) => v.version)).toEqual([1, 2]);
    const revisions = await db.listRevisions(GPO, { runbookId: rb._id });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]._id).toBe(rev.revision._id);
    // The fix must act on the GPO, not just the local client setting.
    expect(rb.versions[1].steps.some((s) => s.action === "set_gpo_dns")).toBe(true);

    // Replay = the before/after metric.
    expect(rev.replay).toHaveLength(2);
    expect(rev.replay.every((r) => r.before_passed === false)).toBe(true);
    expect(rev.replay.every((r) => r.passed)).toBe(true);
    expect(rev.rate_after).toBeGreaterThan(rev.rate_before);
    const replays = await db.listAttempts(GPO, { runbookId: rb._id, limit: 10 });
    expect(replays.filter((a) => a.phase === "replay" && a.runbook_version === 2)).toHaveLength(2);
    console.log(`revision: ${rev.revision.diff.summary}\nrationale: ${rev.revision.rationale}\nrate ${rev.rate_before} → ${rev.rate_after}`);
  }, 600_000);

  it("a normal tenant's incident passes first time with no revision", async () => {
    normal = await fireIncident(NORMAL, liveIncident("print_spooler", tenantById(NORMAL).environment, 3));
    expect(normal.attempt.verification.passed).toBe(true);
    expect(normal.revision).toBeNull();
    expect(normal.rolling.rate).toBe(1);
  }, 300_000);

  it("nothing leaked across tenants during the run", async () => {
    const normalRuns = await db.listAgentRuns(NORMAL, 50);
    expect(normalRuns.every((r) => r.tenant_id === NORMAL)).toBe(true);
    const gpoRevisions = await db.listRevisions(NORMAL);
    expect(gpoRevisions.filter((r) => r.created_at > since)).toHaveLength(0);
  });
});
