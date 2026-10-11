// Zod schemas shared by the simulator, the agent and every Claude call.
// Claude may only emit steps from this vocabulary — the simulator executes
// nothing else, which keeps verification deterministic.
import { z } from "zod";
import { INCIDENT_TYPES } from "@/db/jsonSchemas";

export const IncidentTypeSchema = z.enum(INCIDENT_TYPES);

export const StepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("flush_dns") }),
  z.object({ action: z.literal("set_dns_servers"), servers: z.array(z.string()).min(1).max(3) }),
  z.object({ action: z.literal("gpupdate_force") }),
  z.object({ action: z.literal("check_gpo"), setting: z.enum(["dns", "proxy", "firewall", "all"]) }),
  z.object({ action: z.literal("set_gpo_dns"), servers: z.array(z.string()).min(1).max(3) }),
  z.object({ action: z.literal("unlink_gpo"), name: z.string() }),
  z.object({ action: z.literal("restart_service"), name: z.string() }),
  z.object({ action: z.literal("renew_cert"), host: z.string() }),
  z.object({ action: z.literal("clear_temp_files") }),
  z.object({ action: z.literal("clear_print_queue") }),
  z.object({ action: z.literal("set_mtu"), interface: z.string(), value: z.number().int().min(576).max(1500) }),
  z.object({ action: z.literal("verify_resolution"), host: z.string().optional() }),
]);
export type Step = z.infer<typeof StepSchema>;
export type StepAction = Step["action"];

export const STEP_ACTIONS = StepSchema.options.map((o) => o.shape.action.value) as StepAction[];

// Claude call 1: pick a runbook and adapt its steps to this tenant.
export const SelectAndAdaptSchema = z.object({
  runbook_id: z.string().describe("_id of the chosen candidate runbook"),
  steps: z.array(StepSchema).min(1).max(10).describe("Adapted steps, in execution order"),
  selection_notes: z.string().describe("Technician-facing note: which runbook was chosen and what was adapted for this tenant; 1-3 sentences"),
});
export type SelectAndAdapt = z.infer<typeof SelectAndAdaptSchema>;

// Claude call 2: propose a new runbook version after repeated verified failures.
export const ProposeRevisionSchema = z.object({
  steps: z.array(StepSchema).min(1).max(10).describe("Complete new step list for the next version"),
  root_cause_analysis: z.string().describe("Technician-facing write-up of what the recorded step outputs show about the root cause on this tenant and how the new steps address it; one short paragraph"),
  diff_summary: z.string().describe("One sentence: what changed"),
});
export type ProposeRevision = z.infer<typeof ProposeRevisionSchema>;

export const REVISION_WINDOW = 3;
export const REVISION_THRESHOLD = 0.67;
