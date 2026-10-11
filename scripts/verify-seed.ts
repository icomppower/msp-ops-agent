// Post-seed report: per-tenant counts by type, runbook stats vs recount, metric
// points, date span, and proof that encrypted fields are ciphertext at rest.
import "@/lib/env";
import * as db from "@/db/tenantScoped";
import { TENANTS, GPO_QUIRK_TENANT } from "@/sim/tenants";

const DAY = 86_400_000;

for (const t of TENANTS) {
  const incidents = await db.listIncidents(t._id, { limit: 500 });
  const byType = incidents.reduce<Record<string, number>>((m, i) => ((m[i.type] = (m[i.type] ?? 0) + 1), m), {});
  const attempts = await db.listAttempts(t._id, { limit: 500 });
  const runbooks = (await db.listCandidateRunbooks(t._id)).filter((r) => r.tenant_id === t._id);
  const span = (Math.max(...incidents.map((i) => +i.created_at)) - Math.min(...incidents.map((i) => +i.created_at))) / DAY;
  let metricPoints = 0;
  for (const rb of runbooks) metricPoints += (await db.metricsSeries(t._id, rb._id)).length;
  console.log(`${t._id}: incidents=${incidents.length} ${JSON.stringify(byType)} attempts=${attempts.length} passed=${attempts.filter((a) => a.verification.passed).length} forks=${runbooks.length} metric_points=${metricPoints} span=${span.toFixed(1)}d`);
  for (const rb of runbooks) {
    const rolling = await db.rollingStats(t._id, rb._id);
    const ok = rb.stats.attempts === attempts.filter((a) => a.runbook_id === rb._id).length;
    console.log(`   ${rb.incident_type.padEnd(14)} v${rb.current_version} stats ${rb.stats.verified_successes}/${rb.stats.attempts} rolling=${rolling.rate} trigger=${rolling.trigger} ${ok ? "" : "STATS MISMATCH"}`);
  }
}

const gpo = (await db.listCandidateRunbooks(GPO_QUIRK_TENANT, "dns_misconfig")).find((r) => r.tenant_id === GPO_QUIRK_TENANT);
console.log(`\n${GPO_QUIRK_TENANT} has a tenant-owned DNS runbook: ${gpo ? `yes (v${gpo.current_version}, ${gpo.stats.verified_successes}/${gpo.stats.attempts})` : "NO — demo would not trigger"}`);
const sim = await db.getSimState(GPO_QUIRK_TENANT);
console.log(`${GPO_QUIRK_TENANT} sim_state: gpo_pinned=${sim?.dns.gpo_pinned} effective_dns=${(sim?.dns.gpo_pinned ? sim.dns.gpo_servers : sim?.dns.servers)?.join(",")}`);

// Encryption at rest: the server evaluates $type on stored bytes (no client decryption involved).
const enc = await db.admin.withRaw(async (raw) => ({
  total: await raw.collection("incidents").countDocuments(),
  credentials_binData: await raw.collection("incidents").countDocuments({ "env_snapshot.credentials": { $type: "binData" } }),
  ips_binData: await raw.collection("incidents").countDocuments({ "env_snapshot.ips": { $type: "binData" } }),
  plaintext_creds: await raw.collection("incidents").countDocuments({ "env_snapshot.credentials": { $type: "string" } }),
}));
console.log(`encryption at rest: ${JSON.stringify(enc)}`);
const sample = await db.getIncident(TENANTS[0]._id, (await db.listIncidents(TENANTS[0]._id, { limit: 1 }))[0]._id);
console.log(`public incident view keys: env_snapshot=${JSON.stringify(Object.keys(sample!.env_snapshot))}`);

await db.admin.close();
