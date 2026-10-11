// Deterministic simulator. Pure functions over a SimState value; persistence
// (Atlas sim_state collection) is handled by db/tenantScoped.ts so this module
// can be unit-tested without a database.
import type { IncidentType } from "@/db/jsonSchemas";
import type { Step } from "@/lib/schemas";
import type { StepResult, TenantEnvironment, Verification } from "@/lib/types";

export type SimState = {
  dns: { servers: string[]; cache_stale: boolean; gpo_pinned: boolean; gpo_servers: string[]; gpo_name: string };
  cert: { host: string; days_left: number; iis_running: boolean };
  disk: { used_pct: number; temp_gb: number };
  spooler: { running: boolean; queue_stuck: boolean };
  vpn: { interface: string; mtu: number; required_mtu: number };
  gpo: { conflicting: string[] };
};

const DECOMMISSIONED_DNS = "10.0.0.250";

export type HiddenConfig = { dnsPinnedByGpo: boolean };

export function initialState(env: TenantEnvironment, hidden: HiddenConfig = { dnsPinnedByGpo: false }): SimState {
  return {
    dns: { servers: [...env.dns_servers], cache_stale: false, gpo_pinned: hidden.dnsPinnedByGpo, gpo_servers: [...env.dns_servers], gpo_name: "HL-Network-Baseline" },
    cert: { host: env.web_host, days_left: 300, iis_running: true },
    disk: { used_pct: 55, temp_gb: 2 },
    spooler: { running: true, queue_stuck: false },
    vpn: { interface: "tun0", mtu: env.vpn_mtu, required_mtu: env.vpn_mtu },
    gpo: { conflicting: [] },
  };
}

// Hidden root cause for each incident type. The GPO quirk: policy itself points
// at a decommissioned DNS server, so any local fix is reverted on refresh.
export function injectFault(state: SimState, type: IncidentType): SimState {
  const s = structuredClone(state);
  switch (type) {
    case "dns_misconfig":
      s.dns.servers = [DECOMMISSIONED_DNS];
      s.dns.cache_stale = true;
      if (s.dns.gpo_pinned) s.dns.gpo_servers = [DECOMMISSIONED_DNS];
      break;
    case "expired_cert":
      s.cert.days_left = -3;
      break;
    case "disk_full":
      s.disk.used_pct = 97;
      s.disk.temp_gb = 38;
      break;
    case "print_spooler":
      s.spooler.running = false;
      s.spooler.queue_stuck = true;
      break;
    case "vpn_mtu":
      s.vpn.mtu = 1500;
      break;
    case "gpo_conflict":
      s.gpo.conflicting = ["Legacy-Proxy-Settings"];
      break;
  }
  return s;
}

const sameServers = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function effectiveDns(s: SimState): string[] {
  return s.dns.gpo_pinned ? s.dns.gpo_servers : s.dns.servers;
}

export function applyStep(state: SimState, step: Step, env: TenantEnvironment): { state: SimState; result: StepResult } {
  const s = structuredClone(state);
  let ok = true;
  let detail = "";
  switch (step.action) {
    case "flush_dns":
      s.dns.cache_stale = false;
      detail = "ipconfig /flushdns: resolver cache flushed";
      break;
    case "set_dns_servers":
      s.dns.servers = [...step.servers];
      detail = s.dns.gpo_pinned
        ? `Set DNS to ${step.servers.join(", ")}. Warning: DNS client settings on this host are managed by Group Policy (${s.dns.gpo_name}); local changes are reverted at the next policy refresh.`
        : `Set DNS to ${step.servers.join(", ")}`;
      break;
    case "gpupdate_force":
      if (s.dns.gpo_pinned) {
        s.dns.servers = [...s.dns.gpo_servers];
        detail = `gpupdate /force: policy applied; DNS re-pinned to ${s.dns.gpo_servers.join(", ")} by ${s.dns.gpo_name}`;
      } else {
        detail = "gpupdate /force: policy refreshed, no DNS settings managed by policy";
      }
      break;
    case "check_gpo":
      detail = s.dns.gpo_pinned
        ? `GPO ${s.dns.gpo_name} pins DNS client servers to ${s.dns.gpo_servers.join(", ")}; conflicting policies: ${s.gpo.conflicting.join(", ") || "none"}`
        : `No GPO manages DNS client settings; conflicting policies: ${s.gpo.conflicting.join(", ") || "none"}`;
      break;
    case "set_gpo_dns":
      if (!s.dns.gpo_pinned) {
        ok = false;
        detail = "No DNS-managing GPO exists for this tenant; nothing to edit";
      } else {
        s.dns.gpo_servers = [...step.servers];
        s.dns.servers = [...step.servers];
        detail = `Edited ${s.dns.gpo_name}: DNS servers now ${step.servers.join(", ")}; applied to endpoints`;
      }
      break;
    case "unlink_gpo": {
      const before = s.gpo.conflicting.length;
      s.gpo.conflicting = s.gpo.conflicting.filter((g) => g !== step.name);
      ok = s.gpo.conflicting.length < before;
      detail = ok ? `Unlinked GPO ${step.name}` : `GPO ${step.name} is not linked here`;
      break;
    }
    case "restart_service": {
      const name = step.name.toLowerCase();
      if (name.includes("spool")) {
        s.spooler.running = true;
        detail = s.spooler.queue_stuck ? "Spooler restarted; stuck jobs still in queue" : "Spooler restarted";
      } else if (name.includes("iis") || name.includes("w3svc")) {
        s.cert.iis_running = true;
        detail = "IIS restarted, new binding loaded";
      } else {
        detail = `Service ${step.name} restarted`;
      }
      break;
    }
    case "renew_cert":
      if (step.host !== s.cert.host) {
        ok = false;
        detail = `No certificate for ${step.host} on this tenant (expected ${s.cert.host})`;
      } else {
        s.cert.days_left = 365;
        detail = `Renewed certificate for ${step.host}, valid 365 days`;
      }
      break;
    case "clear_temp_files": {
      const freed = s.disk.temp_gb;
      s.disk.used_pct = Math.max(40, s.disk.used_pct - Math.round(freed * 1.2));
      s.disk.temp_gb = 0;
      detail = `Cleared ${freed} GB of temp files; disk now ${s.disk.used_pct}% used`;
      break;
    }
    case "clear_print_queue":
      s.spooler.queue_stuck = false;
      detail = "Purged spool directory; queue cleared";
      break;
    case "set_mtu":
      s.vpn.mtu = step.value;
      detail = `MTU on ${step.interface} set to ${step.value}`;
      break;
    case "verify_resolution": {
      const eff = effectiveDns(s);
      ok = sameServers(eff, env.dns_servers) && !s.dns.cache_stale;
      detail = ok
        ? `nslookup ${step.host ?? env.domain}: resolved via ${eff.join(", ")}`
        : `nslookup ${step.host ?? env.domain}: timed out (effective servers ${eff.join(", ")})`;
      break;
    }
  }
  return { state: s, result: { step, ok, detail } };
}

// The hard success signal: passes only when the hidden root cause is fixed.
export function verify(state: SimState, type: IncidentType, env: TenantEnvironment): Verification {
  switch (type) {
    case "dns_misconfig": {
      const eff = effectiveDns(state);
      const passed = sameServers(eff, env.dns_servers) && !state.dns.cache_stale;
      return { passed, check_name: "dns_internal_resolution", detail: passed ? `Endpoints resolve ${env.domain} via ${eff.join(", ")}` : `Effective DNS ${eff.join(", ")} — internal names still fail to resolve` };
    }
    case "expired_cert": {
      const passed = state.cert.days_left > 14 && state.cert.iis_running;
      return { passed, check_name: "tls_cert_valid", detail: passed ? `${state.cert.host} serves a certificate valid ${state.cert.days_left} days` : `${state.cert.host} certificate days_left=${state.cert.days_left}` };
    }
    case "disk_full": {
      const passed = state.disk.used_pct < 85;
      return { passed, check_name: "disk_usage_below_85", detail: `System drive ${state.disk.used_pct}% used` };
    }
    case "print_spooler": {
      const passed = state.spooler.running && !state.spooler.queue_stuck;
      return { passed, check_name: "print_queue_flowing", detail: passed ? "Spooler running, test page printed" : `running=${state.spooler.running} queue_stuck=${state.spooler.queue_stuck}` };
    }
    case "vpn_mtu": {
      const passed = state.vpn.mtu <= state.vpn.required_mtu && state.vpn.mtu >= 1200;
      return { passed, check_name: "vpn_large_packet_pass", detail: `MTU ${state.vpn.mtu} (max usable ${state.vpn.required_mtu})` };
    }
    case "gpo_conflict": {
      const passed = state.gpo.conflicting.length === 0;
      return { passed, check_name: "gpresult_no_conflicts", detail: passed ? "gpresult shows no conflicting policies" : `Conflicting: ${state.gpo.conflicting.join(", ")}` };
    }
  }
}

export function runSteps(state: SimState, steps: Step[], env: TenantEnvironment): { state: SimState; results: StepResult[] } {
  const results: StepResult[] = [];
  let s = state;
  for (const step of steps) {
    const r = applyStep(s, step, env);
    s = r.state;
    results.push(r.result);
  }
  return { state: s, results };
}
