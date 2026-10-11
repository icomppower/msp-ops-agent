// Four fictional MSP clients. Everything here is synthetic.
import type { Tenant, TenantEnvironment } from "@/lib/types";
import type { HiddenConfig } from "./engine";

type TenantSeed = Omit<Tenant, "created_at">;

const base = (
  id: string,
  name: string,
  env: Omit<TenantEnvironment, "domain" | "web_host" | "print_server"> & Partial<TenantEnvironment>,
): TenantSeed => ({
  _id: id,
  tenant_id: id,
  name,
  environment: {
    domain: `${id.replace(/-/g, "")}.local`,
    web_host: `portal.${id}.example`,
    print_server: `PRINT01.${id.replace(/-/g, "")}.local`,
    ...env,
  },
});

export const TENANTS: TenantSeed[] = [
  base("acme-dental", "Acme Dental Group", {
    os_mix: ["Windows 11 Pro", "Windows Server 2022"],
    rmm: "NinjaOne",
    edr: "SentinelOne",
    network_gear: ["Meraki MX68", "Meraki MS120"],
    quirks: [],
    dns_servers: ["10.10.0.10", "10.10.0.11"],
    vpn_mtu: 1400,
  }),
  // The GPO-quirk tenant: the client's in-house IT linked a GPO two days ago that
  // pins DNS client settings — the MSP does not know yet (see HIDDEN below), so a
  // local DNS fix is reverted the moment policy refreshes.
  base("harbor-law", "Harbor & Finch LLP", {
    os_mix: ["Windows 10 Pro", "Windows 11 Pro", "Windows Server 2019"],
    rmm: "Datto RMM",
    edr: "Huntress",
    network_gear: ["FortiGate 60F", "Aruba 2930F"],
    quirks: ["Client has an in-house IT admin who manages Active Directory alongside the MSP"],
    dns_servers: ["10.20.0.5", "10.20.0.6"],
    vpn_mtu: 1400,
  }),
  base("northwind-cpa", "Northwind CPA Partners", {
    os_mix: ["macOS 15", "Windows 11 Pro", "Windows Server 2022"],
    rmm: "NinjaOne",
    edr: "CrowdStrike Falcon",
    network_gear: ["UniFi Dream Machine Pro", "UniFi USW-24"],
    quirks: ["Site-to-site VPN rides an LTE backup link during outages (MTU-sensitive)"],
    dns_servers: ["10.30.0.2", "10.30.0.3"],
    vpn_mtu: 1340,
  }),
  base("summit-mfg", "Summit Manufacturing", {
    os_mix: ["Windows 10 LTSC", "Windows Server 2016"],
    rmm: "Kaseya VSA",
    edr: "Defender for Business",
    network_gear: ["Cisco ISR 1100", "Cisco Catalyst 9200"],
    quirks: ["Shop-floor label printers share one Server 2016 print server"],
    dns_servers: ["10.40.0.10", "10.40.0.11"],
    vpn_mtu: 1400,
  }),
];

export const GPO_QUIRK_TENANT = "harbor-law";
export const TENANT_IDS = TENANTS.map((t) => t._id);

// Hidden root-cause configuration: lives only in the simulator (sim_state),
// never in the tenants collection, so the agent has to discover it from
// verified failures and step output — that is what forces the runbook rewrite.
export const HIDDEN: Record<string, HiddenConfig> = {
  [GPO_QUIRK_TENANT]: { dnsPinnedByGpo: true },
};
export const hiddenFor = (tenantId: string): HiddenConfig => HIDDEN[tenantId] ?? { dnsPinnedByGpo: false };

export function tenantById(id: string): TenantSeed {
  const t = TENANTS.find((x) => x._id === id);
  if (!t) throw new Error(`unknown tenant ${id}`);
  return t;
}
