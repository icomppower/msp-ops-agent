// Seed ~3 weeks of backdated, synthetic incident history per tenant. Outcomes
// are not faked: every attempt is produced by running the tenant's adapted
// runbook through the simulator, so the recorded stats are real verify() results.
//
//   pnpm seed            # add missing tenants/templates, skip tenants that already have incidents
//   pnpm seed --reset    # wipe all four tenants' data first (global templates are kept)
import "@/lib/env";
import { INCIDENT_TYPES, type IncidentType } from "@/db/jsonSchemas";
import * as db from "@/db/tenantScoped";
import { embed } from "@/lib/embed";
import { embeddingProvider } from "@/lib/embedConfig";
import type { Runbook, TenantEnvironment } from "@/lib/types";
import { initialState, injectFault, runSteps, verify, type SimState } from "@/sim/engine";
import { GLOBAL_RUNBOOKS, adaptTemplate } from "@/sim/runbooks";
import { GPO_QUIRK_TENANT, TENANTS, hiddenFor } from "@/sim/tenants";
import { TEXT, fill } from "@/sim/incidentText";

const RESET = process.argv.includes("--reset");
const DAYS = 21;
const PER_TENANT = 24;
const GPO_LINKED_DAYS_AGO = 2; // harbor-law's DNS GPO was linked 2 days ago → older DNS history passed
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// Deterministic PRNG so re-seeding yields the same history.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const pick = <T>(rng: () => number, xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];

const TYPE_WEIGHTS: Record<IncidentType, number> = { dns_misconfig: 5, expired_cert: 2, disk_full: 4, print_spooler: 4, vpn_mtu: 2, gpo_conflict: 2 };
function pickType(rng: () => number): IncidentType {
  const total = Object.values(TYPE_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const t of INCIDENT_TYPES) if ((r -= TYPE_WEIGHTS[t]) < 0) return t;
  return "dns_misconfig";
}

type PlannedIncident = { type: IncidentType; title: string; symptoms: string[]; created_at: Date; host: string; os: string; site: string };

function planIncidents(tenantId: string, env: TenantEnvironment, now: Date): PlannedIncident[] {
  const rng = mulberry32(hash(tenantId));
  const out: PlannedIncident[] = [];
  for (let i = 0; i < PER_TENANT; i++) {
    const daysAgo = DAYS - (i / PER_TENANT) * DAYS - rng() * (DAYS / PER_TENANT);
    let type = pickType(rng);
    // The GPO was linked 2 days ago: no DNS incidents since, so the demo's failures are the first.
    if (tenantId === GPO_QUIRK_TENANT && type === "dns_misconfig" && daysAgo < GPO_LINKED_DAYS_AGO + 0.5) type = "print_spooler";
    const host = `WS-${100 + Math.floor(rng() * 80)}`;
    const t = TEXT[type];
    out.push({
      type,
      title: fill(pick(rng, t.titles), env, host),
      symptoms: pick(rng, t.symptoms).map((s) => fill(s, env, host)),
      created_at: new Date(now.getTime() - daysAgo * DAY - Math.floor(rng() * 8) * 60 * MIN),
      host,
      os: pick(rng, env.os_mix),
      site: pick(rng, ["HQ", "Branch-2", "Remote"]),
    });
  }
  return out.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
}

async function seedTenant(tenantId: string, globalIds: Record<IncidentType, string>, now: Date) {
  const tenant = TENANTS.find((t) => t._id === tenantId)!;
  const env = tenant.environment;
  await db.upsertTenant(tenantId, tenant);

  if ((await db.countIncidents(tenantId)) > 0) {
    console.log(`  ${tenantId}: already seeded, skipping (use --reset to rebuild)`);
    return;
  }

  const plan = planIncidents(tenantId, env, now);
  const vectors = await embed(plan.map((p) => `${p.title}. ${p.symptoms.join(". ")}`), "document");

  // Forks are dated before the first incident so a demo reset (which removes
  // everything created after the seeded history) leaves them in place.
  const onboardedAt = new Date(plan[0].created_at.getTime() - DAY);
  const forks: Partial<Record<IncidentType, Runbook>> = {};
  const forkFor = async (type: IncidentType) => {
    forks[type] ??= await db.forkRunbook(tenantId, globalIds[type], adaptTemplate(GLOBAL_RUNBOOKS.find((r) => r.incident_type === type)!.steps, env), "adapted from global template at onboarding", onboardedAt);
    return forks[type]!;
  };

  let state: SimState = initialState(env, hiddenFor(tenantId));
  const rng = mulberry32(hash(tenantId) ^ 0x5eed);
  let passed = 0;
  for (const [i, p] of plan.entries()) {
    const incidentId = await db.insertIncident(tenantId, {
      type: p.type,
      title: p.title,
      symptoms: p.symptoms,
      env_snapshot: {
        hostname: p.host,
        os: p.os,
        site: p.site,
        credentials: `svc_rmm@${env.domain}:${hash(`${tenantId}${i}`).toString(36)}!Aa`,
        ips: `10.${20 + hash(tenantId) % 60}.${Math.floor(rng() * 20)}.${10 + Math.floor(rng() * 200)}`,
      },
      embedding: vectors[i],
      created_at: p.created_at,
    });

    const rb = await forkFor(p.type);
    // Before the GPO existed, harbor-law's DNS behaved like everyone else's.
    const preGpo = tenantId === GPO_QUIRK_TENANT && now.getTime() - p.created_at.getTime() > GPO_LINKED_DAYS_AGO * DAY;
    const era: SimState = preGpo ? { ...state, dns: { ...state.dns, gpo_pinned: false } } : state;
    const faulty = injectFault(era, p.type);
    const run = runSteps(faulty, rb.versions[0].steps, env);
    const v = verify(run.state, p.type, env);
    const attemptAt = new Date(p.created_at.getTime() + (7 + Math.floor(rng() * 35)) * MIN);

    await db.insertAttempt(tenantId, {
      incident_id: incidentId,
      runbook_id: rb._id,
      runbook_version: 1,
      steps_executed: run.results,
      verification: v,
      phase: "seed",
      created_at: attemptAt,
    });
    await db.updateRunbookStatsAfterAttempt(tenantId, rb._id, { passed: v.passed, runbook_version: 1, created_at: attemptAt });
    await db.setIncidentStatus(tenantId, incidentId, v.passed ? "resolved" : "failed");
    if (v.passed) passed++;

    // Carry the healed state forward, restoring the present-day GPO flag.
    state = { ...run.state, dns: { ...run.state.dns, gpo_pinned: state.dns.gpo_pinned } };
  }
  await db.saveSimState(tenantId, state);

  const first = plan[0].created_at, last = plan[plan.length - 1].created_at;
  console.log(
    `  ${tenantId}: ${plan.length} incidents, ${passed}/${plan.length} attempts passed, ${Object.keys(forks).length} runbooks forked, ` +
      `span ${((last.getTime() - first.getTime()) / DAY).toFixed(1)} days, dims ${vectors[0].length}`,
  );
}

const now = new Date();
console.log(`seeding with embeddings from ${embeddingProvider.name}/${embeddingProvider.model} (${embeddingProvider.dims} dims)`);

if (RESET) {
  for (const t of TENANTS) console.log(`  reset ${t._id}:`, JSON.stringify(await db.deleteTenantData(t._id)));
}

const globalIds = {} as Record<IncidentType, string>;
for (const tpl of GLOBAL_RUNBOOKS) globalIds[tpl.incident_type] = await db.upsertGlobalRunbook("global", tpl);
console.log(`  global templates: ${Object.keys(globalIds).length}`);

for (const t of TENANTS) await seedTenant(t._id, globalIds, now);

await db.admin.close();
