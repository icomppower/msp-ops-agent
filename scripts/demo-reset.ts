// Put the demo tenants back to their post-seed state: remove live/replay
// incidents, attempts, revisions, agent runs and metric points created after the
// seed; roll runbooks back to the versions that existed then; heal sim state.
//   pnpm demo:reset            # all tenants
//   pnpm demo:reset harbor-law # one tenant
import "@/lib/env";
import * as db from "@/db/tenantScoped";
import { initialState } from "@/sim/engine";
import { TENANTS, hiddenFor } from "@/sim/tenants";

const only = process.argv[2];
for (const t of TENANTS) {
  if (only && t._id !== only) continue;
  const attempts = await db.listAttempts(t._id, { limit: 1000 });
  const seedTimes = attempts.filter((a) => a.phase === "seed").map((a) => a.created_at.getTime());
  if (seedTimes.length === 0) {
    console.log(`${t._id}: no seed data — run pnpm seed first`);
    continue;
  }
  const since = new Date(Math.max(...seedTimes) + 1000);
  const out = await db.rollbackTenantSince(t._id, since);
  await db.deleteProbeIncidents(t._id);
  await db.saveSimState(t._id, initialState(t.environment, hiddenFor(t._id)));
  console.log(`${t._id}: rolled back to ${since.toISOString()} ${JSON.stringify(out)}`);
}
await db.admin.close();
