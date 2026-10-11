// Synthetic incident wording per type, shared by the seed script and the
// "Fire incident" route so live incidents read like the seeded history.
import type { IncidentType } from "@/db/jsonSchemas";
import type { TenantEnvironment } from "@/lib/types";

export const TEXT: Record<IncidentType, { titles: string[]; symptoms: string[][] }> = {
  dns_misconfig: {
    titles: ["Workstations cannot resolve internal hostnames", "DNS lookups failing on {host}", "Users unable to reach file server by name"],
    symptoms: [
      ["nslookup {domain} times out on {host}", "Ping by IP works, by name fails", "RMM alert: DNS resolution check failed"],
      ["Outlook stuck on 'Trying to connect'", "Mapped drives show red X", "Event ID 1014 DNS Client Events"],
    ],
  },
  expired_cert: {
    titles: ["TLS certificate expired on {web_host}", "Browser certificate warnings on portal", "HTTPS binding serving expired cert"],
    symptoms: [["NET::ERR_CERT_DATE_INVALID in Chrome", "Monitoring: certificate expired 3 days ago", "Clients refuse to log in to portal"]],
  },
  disk_full: {
    titles: ["System drive critically full on {host}", "Disk space alert: C: at 97% on {host}", "Server unresponsive — low disk space"],
    symptoms: [["RMM alert: free space below 5%", "Windows Update failing with 0x80070070", "Temp folder tens of GB"]],
  },
  print_spooler: {
    titles: ["Print jobs stuck in queue on {print_server}", "Spooler service stopped on {print_server}", "Nobody can print to shared printers"],
    symptoms: [["Jobs sit at 'Spooling' indefinitely", "Print Spooler service shows Stopped", "Users report printing worked yesterday"]],
  },
  vpn_mtu: {
    titles: ["VPN connects but large transfers stall", "Site-to-site tunnel: web pages half-load", "VPN users cannot open SharePoint"],
    symptoms: [["Small pings succeed, large pings fail", "RDP freezes over VPN", "ping -f -l 1472 reports fragmentation needed"]],
  },
  gpo_conflict: {
    titles: ["Proxy settings keep reverting on workstations", "GPO conflict: Legacy-Proxy-Settings re-applied", "gpresult shows conflicting policies"],
    symptoms: [["Users lose internet after gpupdate", "gpresult /r lists two policies setting proxy", "Helpdesk fix reverts within 90 minutes"]],
  },
};

export function fill(s: string, env: TenantEnvironment, host: string) {
  return s.replace("{host}", host).replace("{domain}", env.domain).replace("{web_host}", env.web_host).replace("{print_server}", env.print_server);
}

export type IncidentText = { title: string; symptoms: string[] };

/** Variant `n` of the wording for a type (deterministic). */
export function incidentText(type: IncidentType, env: TenantEnvironment, host: string, n = 0): IncidentText {
  const t = TEXT[type];
  return { title: fill(t.titles[n % t.titles.length], env, host), symptoms: t.symptoms[n % t.symptoms.length].map((s) => fill(s, env, host)) };
}

/** A fresh live incident for the "Fire incident" button. */
export function liveIncident(type: IncidentType, env: TenantEnvironment, n: number) {
  const host = `WS-${200 + (n % 50)}`;
  return {
    type,
    ...incidentText(type, env, host, n),
    env_snapshot: {
      hostname: host,
      os: env.os_mix[n % env.os_mix.length],
      site: ["HQ", "Branch-2", "Remote"][n % 3],
      credentials: `svc_rmm@${env.domain}:live-${n.toString(36)}!Aa`,
      ips: `10.77.${n % 20}.${10 + (n % 200)}`,
    },
  };
}
