// Prompts for the two structured Claude calls. Context is assembled only from
// tenant-scoped reads; encrypted snapshot fields never reach these strings.
import { STEP_ACTIONS } from "@/lib/schemas";
import type { Attempt, Incident, Runbook, Tenant } from "@/lib/types";

const STEP_VOCAB = `Allowed step actions (emit nothing else):
- flush_dns
- set_dns_servers {servers: string[]}        — sets DNS client servers on the endpoint (local setting)
- gpupdate_force                              — forces a Group Policy refresh
- check_gpo {setting: dns|proxy|firewall|all} — reads which GPOs manage the setting (read-only)
- set_gpo_dns {servers: string[]}             — edits the DNS servers inside the GPO that pins them
- unlink_gpo {name}                           — unlinks a conflicting GPO
- restart_service {name}                      — Windows service restart (Spooler, W3SVC, RasMan, wuauserv ...)
- renew_cert {host}                           — renews and rebinds the TLS certificate for host
- clear_temp_files                            — reclaims temp space on the system drive
- clear_print_queue                           — purges the spool directory
- set_mtu {interface, value}                  — sets tunnel MTU (576..1500)
- verify_resolution {host?}                   — nslookup check of effective DNS
(Machine-readable list: ${STEP_ACTIONS.join(", ")})`;

export const SELECT_SYSTEM = `You are the runbook-selection step of an MSP operations agent. Given one incident, this tenant's environment, the tenant's similar past incidents with their verified outcomes, and candidate runbooks, choose the best runbook and adapt its steps to this tenant. Prefer the tenant's own runbooks over global templates when both fit. Fill every placeholder with concrete values from the tenant environment (DNS servers, domain, web host, MTU). Keep the step list short and in execution order. Adapt, don't redesign: return the chosen runbook's existing steps in order with their parameters filled for this tenant. Do not add, remove or reorder actions — runbooks only change through the separate revision process, which is triggered by verified failures. Verification is performed by an external hard check after your steps run — you cannot declare success yourself.

${STEP_VOCAB}`;

export const REVISE_SYSTEM = `You are the runbook-revision step of an MSP operations agent. A runbook's verified success rate on this tenant has dropped below threshold. You receive the failing attempts (every executed step with its output, plus the verification failure), the tenant environment and quirks, and similar incidents that did verify successfully. Propose the complete step list for the next version of this runbook so that it fixes the hidden root cause on this tenant. Read the step outputs literally: if the system reported that a setting is managed by Group Policy, a local change will not stick and the policy itself must be corrected. Keep steps that were harmless and necessary; remove steps that undo the fix. In root_cause_analysis, write the technician-facing summary of what the step outputs show and how the new version addresses it.

${STEP_VOCAB}`;

function fmtTenant(t: Tenant) {
  const e = t.environment;
  return [
    `Tenant: ${t.name} (${t._id})`,
    `OS mix: ${e.os_mix.join(", ")}; RMM: ${e.rmm}; EDR: ${e.edr}; Network: ${e.network_gear.join(", ")}`,
    `AD domain: ${e.domain}; correct DNS servers: ${e.dns_servers.join(", ")}; web host: ${e.web_host}; print server: ${e.print_server}; usable VPN MTU: ${e.vpn_mtu}`,
    `Known quirks: ${e.quirks.length ? e.quirks.join(" | ") : "none recorded"}`,
  ].join("\n");
}

function fmtIncident(i: Incident) {
  return `[${i.type}] ${i.title}\n  symptoms: ${i.symptoms.join("; ")}\n  host: ${i.env_snapshot.hostname} (${i.env_snapshot.os}, ${i.env_snapshot.site})`;
}

function fmtAttempt(a: Attempt) {
  const steps = a.steps_executed.map((s, n) => `    ${n + 1}. ${JSON.stringify(s.step)} → ${s.ok ? "ok" : "FAILED"}: ${s.detail}`).join("\n");
  return `  attempt ${a._id} (runbook ${a.runbook_id} v${a.runbook_version}, ${a.phase}) verification ${a.verification.passed ? "PASSED" : "FAILED"} [${a.verification.check_name}]: ${a.verification.detail}\n${steps}`;
}

function fmtRunbook(r: Runbook) {
  const cur = r.versions.find((v) => v.version === r.current_version)!;
  const owner = r.tenant_id === "global" ? "GLOBAL TEMPLATE (read-only; adapting it forks a tenant copy)" : "tenant-owned";
  return `runbook_id ${r._id} — "${r.name}" [${r.incident_type}] ${owner}, v${r.current_version}, stats: ${r.stats.verified_successes}/${r.stats.attempts} verified, rolling ${r.stats.rolling_success_rate}\n  steps: ${JSON.stringify(cur.steps)}`;
}

export function selectUser(args: { tenant: Tenant; incident: Incident; similar: { incident: Incident; attempts: Attempt[] }[]; candidates: Runbook[] }) {
  const similar = args.similar.length
    ? args.similar.map((s) => `${fmtIncident(s.incident)}\n${s.attempts.map(fmtAttempt).join("\n") || "  (no attempts recorded)"}`).join("\n\n")
    : "(none found)";
  return [
    fmtTenant(args.tenant),
    "",
    "## Incident to resolve",
    fmtIncident(args.incident),
    "",
    "## Similar past incidents for this tenant (hybrid search) with verified outcomes",
    similar,
    "",
    "## Candidate runbooks",
    args.candidates.map(fmtRunbook).join("\n"),
    "",
    "Choose one runbook_id from the candidates and return the adapted steps with brief selection_notes.",
  ].join("\n");
}

export function reviseUser(args: { tenant: Tenant; runbook: Runbook; failed: { incident: Incident; attempt: Attempt }[]; successes: { incident: Incident; attempts: Attempt[] }[]; rate: number; window: number }) {
  return [
    fmtTenant(args.tenant),
    "",
    `## Runbook under revision (rolling success ${args.rate} over last ${args.window} attempts)`,
    fmtRunbook(args.runbook),
    "",
    "## Failing attempts (verified failures)",
    args.failed.map((f) => `${fmtIncident(f.incident)}\n${fmtAttempt(f.attempt)}`).join("\n\n"),
    "",
    "## Similar incidents that DID verify successfully",
    args.successes.length ? args.successes.map((s) => `${fmtIncident(s.incident)}\n${s.attempts.map(fmtAttempt).join("\n")}`).join("\n\n") : "(none)",
    "",
    "Return the complete new step list, the root_cause_analysis, and a one-sentence diff_summary.",
  ].join("\n");
}
