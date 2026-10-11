// $jsonSchema validators are enforced server-side with tenant_id required.
import { afterAll, describe, expect, it } from "vitest";
import * as db from "@/db/tenantScoped";

afterAll(() => db.admin.close());

const expectValidationError = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ code: 121 }); // DocumentValidationFailure
};

describe("schema validation", () => {
  it("rejects an attempt without tenant_id", async () => {
    await expectValidationError(
      db.admin.withRaw((raw) =>
        raw.collection("attempts").insertOne({
          incident_id: "x",
          runbook_id: "y",
          runbook_version: 1,
          steps_executed: [],
          verification: { passed: true, check_name: "c", detail: "d" },
          phase: "seed",
          created_at: new Date(),
        }),
      ),
    );
  });

  it("rejects an incident with a wrong-length embedding", async () => {
    await expectValidationError(
      db.admin.withRaw((raw) =>
        raw.collection("incidents").insertOne({
          tenant_id: "acme-dental",
          type: "dns_misconfig",
          title: "t",
          symptoms: ["s"],
          env_snapshot: {},
          embedding: [0.1, 0.2],
          status: "open",
          created_at: new Date(),
        }),
      ),
    );
  });

  it("rejects a runbook with an unknown incident_type", async () => {
    await expectValidationError(
      db.admin.withRaw((raw) =>
        raw.collection("runbooks").insertOne({
          tenant_id: "acme-dental",
          name: "n",
          incident_type: "haunted_printer",
          current_version: 1,
          versions: [{ version: 1, steps: [{ action: "flush_dns" }], created_at: new Date(), reason: "r" }],
          stats: { attempts: 0, verified_successes: 0, rolling_success_rate: 1 },
          created_at: new Date(),
        }),
      ),
    );
  });

  it("every non-time-series collection has a validator; the time series one carries tenant_id in meta", async () => {
    const h = await db.admin.health();
    for (const [name, c] of Object.entries(h.collections)) {
      if (name === "__keyVault") continue;
      if (c.timeseries) expect(c.validator).toBe(false); // server refuses validators on time series (8.0)
      else expect(c.validator, name).toBe(true);
    }
  });
});
