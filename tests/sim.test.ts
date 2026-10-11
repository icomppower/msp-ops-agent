// Pure simulator tests — no database. The Atlas round-trip of sim_state is
// covered in tests/sim-db.test.ts once the cluster is reachable.
import { describe, expect, it } from "vitest";
import { INCIDENT_TYPES } from "@/db/jsonSchemas";
import { StepSchema } from "@/lib/schemas";
import { initialState, injectFault, runSteps, verify } from "@/sim/engine";
import { GLOBAL_RUNBOOKS, GPO_AWARE_DNS_STEPS, adaptTemplate } from "@/sim/runbooks";
import { GPO_QUIRK_TENANT, TENANTS, hiddenFor, tenantById } from "@/sim/tenants";

const tpl = (type: string) => GLOBAL_RUNBOOKS.find((r) => r.incident_type === type)!;

describe("simulator", () => {
  it("has exactly 4 tenants and one GPO-quirk tenant", () => {
    expect(TENANTS).toHaveLength(4);
    const quirky = TENANTS.filter((t) => initialState(t.environment, hiddenFor(t._id)).dns.gpo_pinned).map((t) => t._id);
    // The visible environment must NOT reveal the hidden GPO root cause.
    expect(tenantById(GPO_QUIRK_TENANT).environment.quirks.join(" ")).not.toMatch(/DNS|GPO/i);
    expect(quirky).toEqual([GPO_QUIRK_TENANT]);
  });

  it("every global runbook step is in the Zod vocabulary", () => {
    for (const rb of GLOBAL_RUNBOOKS) for (const s of rb.steps) expect(StepSchema.safeParse(s).success).toBe(true);
  });

  it("healthy state verifies green for every incident type", () => {
    for (const t of TENANTS) for (const type of INCIDENT_TYPES) expect(verify(initialState(t.environment, hiddenFor(t._id)), type, t.environment).passed).toBe(true);
  });

  it("injected fault verifies red for every tenant and type", () => {
    for (const t of TENANTS) for (const type of INCIDENT_TYPES) expect(verify(injectFault(initialState(t.environment, hiddenFor(t._id)), type), type, t.environment).passed).toBe(false);
  });

  it("generic runbooks fix every type on the three normal tenants", () => {
    for (const t of TENANTS.filter((x) => x._id !== GPO_QUIRK_TENANT)) {
      for (const type of INCIDENT_TYPES) {
        const faulty = injectFault(initialState(t.environment, hiddenFor(t._id)), type);
        const { state } = runSteps(faulty, adaptTemplate(tpl(type).steps, t.environment), t.environment);
        expect(verify(state, type, t.environment).passed, `${t._id}/${type}`).toBe(true);
      }
    }
  });

  it("the generic DNS runbook FAILS on the GPO-quirk tenant and the step output explains why", () => {
    const t = tenantById(GPO_QUIRK_TENANT);
    const faulty = injectFault(initialState(t.environment, hiddenFor(t._id)), "dns_misconfig");
    const { state, results } = runSteps(faulty, adaptTemplate(tpl("dns_misconfig").steps, t.environment), t.environment);
    const v = verify(state, "dns_misconfig", t.environment);
    expect(v.passed).toBe(false);
    expect(results.map((r) => r.detail).join("\n")).toMatch(/Group Policy|re-pinned/);
  });

  it("every other generic runbook still passes on the GPO-quirk tenant", () => {
    const t = tenantById(GPO_QUIRK_TENANT);
    for (const type of INCIDENT_TYPES.filter((x) => x !== "dns_misconfig")) {
      const { state } = runSteps(injectFault(initialState(t.environment, hiddenFor(t._id)), type), adaptTemplate(tpl(type).steps, t.environment), t.environment);
      expect(verify(state, type, t.environment).passed, type).toBe(true);
    }
  });

  it("the GPO-aware DNS fix passes on the GPO-quirk tenant", () => {
    const t = tenantById(GPO_QUIRK_TENANT);
    const { state } = runSteps(injectFault(initialState(t.environment, hiddenFor(t._id)), "dns_misconfig"), GPO_AWARE_DNS_STEPS(t.environment), t.environment);
    expect(verify(state, "dns_misconfig", t.environment).passed).toBe(true);
  });

  it("is deterministic: same inputs → identical state and results", () => {
    const t = tenantById(GPO_QUIRK_TENANT);
    const run = () => runSteps(injectFault(initialState(t.environment, hiddenFor(t._id)), "dns_misconfig"), adaptTemplate(tpl("dns_misconfig").steps, t.environment), t.environment);
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it("does not mutate its inputs", () => {
    const t = tenantById("acme-dental");
    const s0 = initialState(t.environment, hiddenFor(t._id));
    const snapshot = JSON.stringify(s0);
    injectFault(s0, "disk_full");
    runSteps(s0, adaptTemplate(tpl("disk_full").steps, t.environment), t.environment);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});
