// Cross-tenant isolation against the live cluster: a near-duplicate incident in
// tenant B (identical vector + title) must never surface in tenant A's vector or
// hybrid search, even though tenant B's own search does return it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as db from "@/db/tenantScoped";

const A = "acme-dental";
const B = "harbor-law";
let planted: string | null = null;
let vector: number[];
let title: string;
let symptoms: string[];

async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

beforeAll(async () => {
  await db.admin.waitForSearchIndexes();
  const [src] = await db.listIncidents(A, { limit: 1, type: "dns_misconfig" });
  vector = (await db.getIncidentEmbedding(A, src._id))!;
  title = src.title;
  symptoms = src.symptoms;
  planted = await db.insertIncident(B, {
    type: src.type,
    title,
    symptoms,
    env_snapshot: { hostname: "WS-PLANTED", os: "Windows 11 Pro", site: "HQ", credentials: "svc:planted", ips: "10.99.0.1" },
    embedding: vector,
  });
  // Atlas Search indexes asynchronously: wait until tenant B can see its own planted doc.
  const seen = await pollUntil(
    () => db.vectorSearchWithPipeline(B, vector, 10),
    (r) => r.results.some((d) => d._id === planted),
  );
  expect(seen.results.map((d) => d._id)).toContain(planted);
});

afterAll(async () => {
  if (planted) await db.admin.withRaw((raw) => raw.collection("incidents").deleteOne({ tenant_id: B, title, "env_snapshot.hostname": "WS-PLANTED" }));
  await db.admin.close();
});

describe("tenant isolation", () => {
  it("vector search as tenant A never returns tenant B's near-duplicate", async () => {
    const { results, pipeline } = await db.vectorSearchWithPipeline(A, vector, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((d) => d.tenant_id === A)).toBe(true);
    expect(results.map((d) => d._id)).not.toContain(planted);
    expect(JSON.stringify(pipeline)).toContain(`"filter":{"tenant_id":"${A}"}`);
  });

  it("hybrid (vector ∪ text, RRF) search as tenant A never returns it either", async () => {
    const results = await db.searchSimilarIncidents(A, vector, `${title} ${symptoms.join(" ")}`, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((d) => d.tenant_id === A)).toBe(true);
    expect(results.map((d) => d._id)).not.toContain(planted);
    expect(results[0].rrf_score).toBeGreaterThan(0);
  });

  it("tenant-scoped reads cannot cross tenants by id", async () => {
    expect(await db.getIncident(A, planted!)).toBeNull();
    expect(await db.getIncident(B, planted!)).not.toBeNull();
  });

  it("rejects an empty or 'global' tenant id on data access", async () => {
    await expect(db.listIncidents("")).rejects.toThrow(/tenantId/);
    await expect(db.listIncidents("global")).rejects.toThrow(/global/);
  });

  it("strips encrypted snapshot fields from everything that leaves the db layer", async () => {
    const doc = await db.getIncident(B, planted!);
    expect(Object.keys(doc!.env_snapshot).sort()).toEqual(["hostname", "os", "site"]);
    const atRest = await db.admin.withRaw((raw) => raw.collection("incidents").countDocuments({ _id: { $exists: true }, tenant_id: B, "env_snapshot.hostname": "WS-PLANTED", "env_snapshot.credentials": { $type: "binData" } }));
    expect(atRest).toBe(1);
  });
});
