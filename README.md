# MSP Ops Agent — self-improving runbooks on MongoDB Atlas

A hackathon demo (MongoDB "Harness Engineering & Model Wrangling", SF Tech Week 2026) of an MSP operations agent that **learns from hard metric signals**. It stores incidents and fixes in Atlas, recalls similar past incidents with tenant-filtered hybrid search, has Claude pick and adapt a runbook, executes it against a deterministic simulator, verifies the fix with a hard check — and when a runbook's verified success rate drops, Claude rewrites it, the new version is committed in a transaction, and the failed incidents are replayed as the before/after metric.

Tenant isolation is enforced in the database layer (`db/tenantScoped.ts`), not in prompts. All data is synthetic.

## The demo (≈3 min)

1. Pick **Harbor & Finch LLP** (the tenant with a hidden quirk: their in-house IT linked a GPO that pins DNS servers) and fire a `dns_misconfig` incident. The generic DNS runbook runs, `gpupdate` re-applies the bad servers, verification **fails** (rolling 0.67).
2. Fire again. Fails again → rolling 0.33 < 0.67 → the **revision trigger** (an aggregation pipeline) fires. Claude reads the failed attempts' step output ("DNS client settings are managed by Group Policy…"), proposes v2 with `check_gpo` + `set_gpo_dns`, and the version + revision record are written in one **transaction**.
3. The two failed incidents are **replayed** against v2 and pass; the success-rate chart jumps.
4. **Isolation proof**: plants a near-duplicate of this tenant's incident inside another tenant and runs the search as this tenant — zero cross-tenant results, with the `$vectorSearch` pipeline (filter included) shown.

Reset between takes: `pnpm demo:reset` (or `pnpm demo:reset harbor-law`).

## Run it

Requirements: Node ≥ 22, pnpm 12, an Atlas cluster (M10+, MongoDB 8.0) with Atlas Search enabled, an Anthropic API key, and optionally a Voyage AI key from Atlas AI Model APIs.

```bash
pnpm install
cp .env.example .env.local            # fill in MONGODB_URI, ANTHROPIC_API_KEY, VOYAGE_API_KEY, QE_LOCAL_MASTER_KEY
pnpm setup:atlas --wait               # idempotent: collections, validators, indexes, QE keys; waits for search indexes
pnpm seed                             # 3 weeks of backdated synthetic history for 4 tenants (--reset to rebuild)
pnpm dev                              # http://localhost:3000
```

Tests (against the live cluster): `pnpm test:isolation`, `pnpm test:sim`, `pnpm test:e2e` (live Claude), or `pnpm test`.

## Architecture

```
app/                 Next.js App Router — one page, 4 panels; API routes (Node runtime)
  api/stream         SSE fed by a tenant-filtered change stream (attempts, revisions, agent_runs)
  api/incidents/fire runs the agent loop for one synthetic incident
  api/isolation-proof plants a cross-tenant near-duplicate and searches as tenant A
agent/               handleIncident.ts (loop), revise.ts (trigger → Claude → transaction → replay), prompts.ts
db/tenantScoped.ts   the ONLY module that imports the Mongo driver (ESLint no-restricted-imports enforces it);
                     every export takes tenantId first and injects it into every filter and $vectorSearch
db/pipelines.ts      aggregation pipelines: rolling success + trigger, hybrid search (RRF), metrics series
db/jsonSchemas.ts    $jsonSchema validators (tenant_id required), index definitions
sim/                 4 tenants, deterministic executeStep/verify, global runbook templates
lib/claude.ts        every Claude call: structured JSON output → Zod → one retry on validation failure
lib/embed.ts         embed(): Voyage AI via Atlas AI Model APIs, local MiniLM fallback; dims drive the index
scripts/             atlas-setup, seed, demo-reset, verify-seed, embed-smoke
```

MongoDB features used:

| Feature | Where |
|---|---|
| Atlas Vector Search with `tenant_id` filter | `incidents_vector` index; every `$vectorSearch` carries `filter: { tenant_id }` |
| Hybrid search | `$vectorSearch` ∪ `$search` (Atlas Search on title/symptoms) fused with reciprocal rank fusion inside the aggregation (`$rankFusion` needs 8.1; cluster is 8.0) |
| `$jsonSchema` validation | every collection, `tenant_id` required (the time-series collection cannot carry a validator on 8.0 — type-guarded at the single write site) |
| Multi-document transaction | new runbook version + revision record in `commitRevision` |
| Change streams | `watchTenant` → SSE → live UI |
| Time series collection | `runbook_metrics` (meta `{tenant_id, runbook_id}`) feeds the success-rate chart |
| Aggregation pipelines | rolling success rate and the revision trigger are computed in Mongo, not JS |
| Queryable Encryption | `incidents.env_snapshot.credentials` / `.ips` (one DEK per field, local KMS for the demo); encrypted fields never reach Claude or the UI |

Agent memory — incidents, attempts, runbooks (versioned), revisions, per-incident agent working state (`agent_runs`) and simulator state — all live in Atlas; nothing that matters is in process memory.
