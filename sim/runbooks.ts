// Global runbook templates (read-only). Steps carry template placeholders that
// `adaptTemplate` fills deterministically from the tenant environment — used by
// the seed script; the live agent lets Claude do the adaptation instead.
import type { IncidentType } from "@/db/jsonSchemas";
import type { Step } from "@/lib/schemas";
import type { TenantEnvironment } from "@/lib/types";

export type RunbookTemplate = { name: string; incident_type: IncidentType; steps: Step[] };

export const GLOBAL_RUNBOOKS: RunbookTemplate[] = [
  {
    name: "DNS resolution failure — standard",
    incident_type: "dns_misconfig",
    steps: [
      { action: "flush_dns" },
      { action: "set_dns_servers", servers: ["{{dns.primary}}", "{{dns.secondary}}"] },
      { action: "gpupdate_force" },
      { action: "verify_resolution", host: "{{domain}}" },
    ],
  },
  {
    name: "Expired TLS certificate — renew and reload",
    incident_type: "expired_cert",
    steps: [{ action: "renew_cert", host: "{{web_host}}" }, { action: "restart_service", name: "W3SVC" }],
  },
  {
    name: "System drive full — reclaim space",
    incident_type: "disk_full",
    steps: [{ action: "clear_temp_files" }, { action: "restart_service", name: "wuauserv" }],
  },
  {
    name: "Print spooler stuck — restart and purge",
    incident_type: "print_spooler",
    steps: [{ action: "restart_service", name: "Spooler" }, { action: "clear_print_queue" }],
  },
  {
    name: "VPN fragmentation — set tunnel MTU",
    incident_type: "vpn_mtu",
    steps: [{ action: "set_mtu", interface: "tun0", value: 1400 }, { action: "restart_service", name: "RasMan" }],
  },
  {
    name: "GPO conflict — identify and unlink",
    incident_type: "gpo_conflict",
    steps: [{ action: "check_gpo", setting: "all" }, { action: "unlink_gpo", name: "Legacy-Proxy-Settings" }, { action: "gpupdate_force" }],
  },
];

export function adaptTemplate(steps: Step[], env: TenantEnvironment): Step[] {
  const fill = (s: string) =>
    s
      .replace("{{dns.primary}}", env.dns_servers[0])
      .replace("{{dns.secondary}}", env.dns_servers[1] ?? env.dns_servers[0])
      .replace("{{domain}}", env.domain)
      .replace("{{web_host}}", env.web_host);
  return steps.map((step) => {
    switch (step.action) {
      case "set_dns_servers":
      case "set_gpo_dns":
        return { ...step, servers: step.servers.map(fill) };
      case "verify_resolution":
        return { ...step, host: step.host ? fill(step.host) : undefined };
      case "renew_cert":
        return { ...step, host: fill(step.host) };
      case "set_mtu":
        return { ...step, value: env.vpn_mtu };
      default:
        return step;
    }
  });
}

// The GPO-aware DNS fix a correct revision should converge on (used by tests).
export const GPO_AWARE_DNS_STEPS = (env: TenantEnvironment): Step[] => [
  { action: "check_gpo", setting: "dns" },
  { action: "set_gpo_dns", servers: env.dns_servers },
  { action: "flush_dns" },
  { action: "gpupdate_force" },
  { action: "verify_resolution", host: env.domain },
];
