# Build Instructions — Claude Code Spec

Source: Notion "🛠️ Build Instructions — Claude Code Spec" (parent: MongoDB Hackathon — MSP Ops Agent Plan), fetched 2026-10-11.

## Goal
Build a hackathon demo of a self-improving MSP operations agent. It stores incidents and fixes in MongoDB Atlas, recalls similar past incidents with Atlas Vector Search, verifies every fix against a hard success signal, and rewrites its own runbooks when their verified success rate drops. Tenant isolation is enforced in the database layer, not the prompt.

## Stack
- Next.js (App Router) + TypeScript, deployed to Vercel
- MongoDB Atlas (free/M0 or hackathon credits) with Atlas Vector Search
- Claude API for reasoning: runbook selection, adaptation, and revision
- Voyage AI embeddings (or any 1024-dim embedding model; keep it swappable behind one function)
- No real client data. Everything is synthetic.

## Data model (collections)
- **tenants**: `_id`, `name`, `environment` (OS mix, RMM, EDR, network gear, quirks)
- **incidents**: `_id`, `tenant_id`, `title`, `symptoms`, `env_snapshot`, `embedding`, `status`, `created_at`
- **runbooks**: `_id`, `tenant_id` (or `"global"`), `name`, `current_version`, `versions[]` (each: `version`, `steps[]`, `created_at`, `reason`), `stats` (`attempts`, `verified_successes`, `rolling_success_rate`)
- **attempts**: `_id`, `tenant_id`, `incident_id`, `runbook_id`, `runbook_version`, `steps_executed[]`, `verification` (`passed`, `check_name`, `detail`), `created_at`
- **revisions**: `_id`, `tenant_id`, `runbook_id`, `from_version`, `to_version`, `trigger` (failed attempt IDs + success rate), `diff`, `rationale`, `created_at`

## Vector index
An Atlas Vector Search index on `incidents.embedding` with `tenant_id` declared as a **filter** field. Every `$vectorSearch` must include `filter: { tenant_id }`.

## Tenant isolation (non-negotiable)
- All DB access goes through one `db/tenantScoped.ts` module. Every exported function takes `tenantId` as a required first argument and injects it into every query and every `$vectorSearch` filter.
- No route or agent code imports the raw Mongo client directly. Add an ESLint `no-restricted-imports` rule to enforce it.
- Global runbooks are read-only templates. When a tenant adapts one, fork it into a tenant-owned copy.
- Write a test that inserts a near-duplicate incident into tenant B and confirms a tenant A search never returns it.

## Simulator (the hard metric signal)
- `sim/` holds 3–4 fictional tenants with environment state and hidden root causes per incident type, such as a DNS misconfig, an expired cert, a disk full, a stuck print spooler, a VPN MTU issue, or a GPO conflict.
- `executeStep(tenantId, step)` mutates simulated state.
- `verify(tenantId, incident)` is **deterministic**. It passes only if the hidden root cause is actually fixed, the same way an RMM alert clears in production.
- Seed some tenant quirks so a generic runbook fails for one tenant. For example, one tenant pins DNS through a GPO, so flushing DNS alone doesn't stick. This is what forces a runbook rewrite.
- Seed script: generate about 3 weeks of backdated incident history per tenant, including embeddings, attempts, and outcomes.

## Agent loop (`agent/handleIncident.ts`)
1. Embed the incident.
2. Run a tenant-filtered vector search for the top-k similar past incidents plus their attempts and outcomes.
3. Load candidate runbooks for the tenant (tenant-owned first, then global).
4. Have Claude pick a runbook and adapt the steps to this tenant's environment, returning structured JSON.
5. Execute the steps in the simulator.
6. Verify and record the attempt.
7. Update the runbook stats.
8. **Revision trigger:** if the rolling success rate over the last N attempts (N=3) falls below the threshold (0.67), call Claude with the failing attempts, verification details, tenant environment, and similar successful incidents. It proposes a new runbook version with a rationale. Save the version and a revision record.
9. **Replay:** rerun the failed incidents against the new version and record the results, which are the before/after metric.

## Claude calls
- Use tool use / structured JSON output for `select_and_adapt_runbook` and `propose_revision`. Validate with Zod and retry once on a validation failure.
- Prompts receive only tenant-scoped context assembled by `tenantScoped.ts`. Never pass in raw collection dumps.

## UI (one page, 4 panels)
1. **Incident feed:** a "Fire incident" button per tenant, with a live status for each step.
2. **Runbook evolution:** version timeline and a side-by-side diff of the selected revision, with its rationale and trigger.
3. **Metrics:** verified success rate per runbook over time, with the revision point marked.
4. **Isolation proof:** a button that runs a cross-tenant query and shows zero results, alongside the query showing the injected filter.

## Build order (spec)
1. Atlas cluster, collections, vector index, and `tenantScoped.ts` with the isolation test passing
2. Simulator and deterministic verifier
3. Seed script with backdated history
4. Agent loop without revision, working end to end
5. Revision trigger and replay
6. UI panels
7. Deploy to Vercel and rehearse the demo

## Demo script (about 3 min)
1. Fire a DNS incident for the GPO-quirk tenant. The generic runbook runs and verification fails.
2. Fire it again. It fails again, the success rate drops below the threshold, and the revision fires.
3. Show the diff: the new version adds a GPO check and an override step, with Claude's rationale.
4. Replay. Verification passes and the metric chart jumps.
5. Click the isolation proof to show the cross-tenant search returns nothing, with the filter visible.
6. Close on the pitch line.

## Done criteria
- Isolation test passes
- At least one runbook revision triggered by verified failures, with a measurable success-rate improvement on replay
- Deployed URL and seeded data, demo runs reliably 3 times in a row

---

# MongoDB Requirements (override the spec above wherever the two conflict)

MONGODB REQUIRED — Atlas is the only datastore. No Postgres, no Redis, no local JSON, no in-memory state that matters.

- **Agent memory:** incidents, attempts, runbooks, revisions, and the agent's working state per incident all live in Atlas.
- **Atlas Vector Search:** index on `incidents.embedding` with `tenant_id` as a filter field. Every `$vectorSearch` must pass that filter.
- **Hybrid search:** combine an Atlas Search (full-text) index on `title`/`symptoms` with vector search, using `$rankFusion` if the cluster version supports it. Fall back to vector-only if it doesn't.
- **Schema validation:** `$jsonSchema` validators on every collection, with `tenant_id` required.
- **Transactions:** writing a new runbook version and its revision record happens in one multi-document transaction.
- **Change streams:** the UI updates live from change streams on `attempts` and `revisions` (stream them to the client via SSE).
- **Time series collection:** `runbook_metrics` (meta: `tenant_id`, `runbook_id`) for the success-rate chart.
- **Aggregation pipelines:** compute rolling success rate and the revision trigger in Mongo, not in JS.
- **Security first:** use Queryable Encryption (or CSFLE if QE isn't available on the tier) for sensitive tenant fields such as `env_snapshot` credentials and IPs. Use a least-privilege database user for the app.

## Build order (authoritative)
1. Atlas setup script: collections, validators, indexes (vector, search, time series). Make it idempotent.
2. `db/tenantScoped.ts` plus the ESLint import rule. Pass the cross-tenant isolation test first.
3. `sim/` with 4 tenants and a deterministic `verify()`. The GPO-quirk tenant makes the generic DNS runbook fail.
4. Seed 3 weeks of backdated history.
5. Agent loop, then the revision trigger (N=3, threshold 0.67) and replay.
6. UI with 4 panels driven by change streams.

## Rules
- No raw Mongo client outside `tenantScoped.ts`.
- Structured JSON plus Zod for every Claude call.
- Synthetic data only.
- Use plan mode first, and stop after each step to show test results.
