// Browser-side fetch helpers and the shapes the panels consume. Dates arrive as ISO strings.
import type { AgentRun, Attempt, Incident, MetricPoint, Revision, Runbook, Tenant } from "@/lib/types";

type Iso<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };
export type RunbookJ = Omit<Iso<Runbook>, "versions"> & { versions: Array<Iso<Runbook["versions"][number]>> };
export type AgentRunJ = Omit<Iso<AgentRun>, "steps"> & { steps: Array<Iso<AgentRun["steps"][number]>> };
export type AttemptJ = Iso<Attempt>;
export type RevisionJ = Iso<Revision>;
export type IncidentJ = Iso<Incident>;
export type MetricJ = Iso<MetricPoint>;

export type Overview = { tenant: Iso<Tenant>; runbooks: RunbookJ[]; runs: AgentRunJ[]; revisions: RevisionJ[]; attempts: AttemptJ[]; incidents: IncidentJ[] };
export type Roster = { tenants: { id: string; name: string; rmm: string; quirk: boolean }[]; incidentTypes: string[] };
export type Health = {
  serverVersion: string;
  encryption: string;
  hybridSearch: string;
  embeddings: { provider: string; model: string; dims: number };
  claudeModel: string;
  searchIndexes: { name: string; status: string; queryable: boolean }[];
};
export type Metrics = { runbook: RunbookJ | null; series: MetricJ[]; revisions: { at: string; to_version: number }[] };
export type Proof = {
  tenantA: string;
  tenantB: string;
  source: { id: string; title: string };
  planted: { id: string; tenant_id: string; indexed_visible_to_B: boolean };
  tenantA_vector_hits: { id: string; tenant_id: string; title: string }[];
  tenantA_hybrid_hits: { id: string; tenant_id: string; title: string; rrf_score?: number }[];
  cross_tenant_results: number;
  pipeline: unknown[];
};
export type FireResult = { runId: string; incidentId: string; attempt: AttemptJ; runbook: RunbookJ; rolling: { n: number; rate: number; trigger: boolean }; revision: { revision: RevisionJ; replay: { passed: boolean }[]; rate_before: number; rate_after: number } | null };

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

export const api = {
  roster: () => fetch("/api/tenants").then((r) => j<Roster>(r)),
  health: () => fetch("/api/health").then((r) => j<Health>(r)),
  overview: (tenantId: string) => fetch(`/api/tenants/${tenantId}/overview`).then((r) => j<Overview>(r)),
  metrics: (tenantId: string, runbookId: string) => fetch(`/api/metrics?tenant=${tenantId}&runbook=${runbookId}`).then((r) => j<Metrics>(r)),
  fire: (tenantId: string, type: string) => fetch("/api/incidents/fire", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId, type }) }).then((r) => j<FireResult>(r)),
  proof: (tenantA: string, tenantB: string) => fetch("/api/isolation-proof", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantA, tenantB }) }).then((r) => j<Proof>(r)),
};

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
