// Document shapes as they leave db/tenantScoped.ts (ids already stringified
// where they cross into UI/Claude context). Driver types never leak past db/.
import type { IncidentType } from "@/db/jsonSchemas";
import type { Step } from "./schemas";

export type TenantEnvironment = {
  os_mix: string[];
  rmm: string;
  edr: string;
  network_gear: string[];
  quirks: string[];
  domain: string;
  dns_servers: string[]; // the correct ones
  vpn_mtu: number;
  print_server: string;
  web_host: string;
};

export type Tenant = { _id: string; tenant_id: string; name: string; environment: TenantEnvironment; created_at: Date };

// What the agent/UI may see of an incident's environment snapshot.
// credentials/ips are encrypted at rest and stripped by tenantScoped before use.
export type EnvSnapshotPublic = { hostname: string; os: string; site: string };

export type Incident = {
  _id: string;
  tenant_id: string;
  type: IncidentType;
  title: string;
  symptoms: string[];
  env_snapshot: EnvSnapshotPublic;
  status: "open" | "resolved" | "failed";
  created_at: Date;
  rrf_score?: number;
};

export type RunbookVersion = { version: number; steps: Step[]; created_at: Date; reason: string };
export type RunbookStats = { attempts: number; verified_successes: number; rolling_success_rate: number };
export type Runbook = {
  _id: string;
  tenant_id: string; // "global" for templates
  name: string;
  incident_type: IncidentType;
  current_version: number;
  forked_from?: string;
  versions: RunbookVersion[];
  stats: RunbookStats;
  created_at: Date;
};

export type StepResult = { step: Step; ok: boolean; detail: string };
export type Verification = { passed: boolean; check_name: string; detail: string };
export type AttemptPhase = "seed" | "live" | "replay";
export type Attempt = {
  _id: string;
  tenant_id: string;
  incident_id: string;
  runbook_id: string;
  runbook_version: number;
  steps_executed: StepResult[];
  verification: Verification;
  phase: AttemptPhase;
  created_at: Date;
};

export type Revision = {
  _id: string;
  tenant_id: string;
  runbook_id: string;
  from_version: number;
  to_version: number;
  trigger: { failed_attempt_ids: string[]; success_rate: number; window: number };
  diff: { added: Step[]; removed: Step[]; summary: string };
  rationale: string;
  created_at: Date;
};

export type AgentRunStatus = "running" | "passed" | "failed" | "revised" | "error";
export type AgentStepStatus = "pending" | "running" | "done" | "failed";
export type AgentRunStep = { name: string; status: AgentStepStatus; detail?: string; at: Date };
export type AgentRun = {
  _id: string;
  tenant_id: string;
  incident_id: string;
  status: AgentRunStatus;
  steps: AgentRunStep[];
  chosen_runbook_id?: string;
  runbook_version?: number;
  created_at: Date;
  updated_at: Date;
};

export type MetricPoint = { timestamp: Date; passed: boolean; rolling_success_rate: number; runbook_version: number };

export type RollingStats = { n: number; rate: number; trigger: boolean; failed_attempt_ids: string[] };
