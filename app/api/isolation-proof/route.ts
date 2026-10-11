import { NextResponse } from "next/server";
import { z } from "zod";
import * as db from "@/db/tenantScoped";
import { TENANT_IDS } from "@/sim/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ tenantA: z.enum(TENANT_IDS as [string, ...string[]]), tenantB: z.enum(TENANT_IDS as [string, ...string[]]) });

// Plants a near-duplicate of tenant A's latest DNS incident inside tenant B
// (identical vector, identical title), then searches as A. A must get zero hits
// for it; B sees it once Atlas Search has indexed it. The exact pipeline — with
// the injected tenant filter — is returned for display.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || parsed.data.tenantA === parsed.data.tenantB) return NextResponse.json({ error: "two different tenants required" }, { status: 400 });
  const { tenantA, tenantB } = parsed.data;

  await db.deleteProbeIncidents(tenantB);
  const [src] = await db.listIncidents(tenantA, { limit: 1, type: "dns_misconfig" });
  if (!src) return NextResponse.json({ error: `${tenantA} has no DNS incidents` }, { status: 404 });
  const vector = (await db.getIncidentEmbedding(tenantA, src._id))!;
  const plantedId = await db.insertIncident(tenantB, {
    type: src.type,
    title: src.title,
    symptoms: src.symptoms,
    env_snapshot: { hostname: "WS-PROBE", os: "Windows 11 Pro", site: "ISOLATION-PROBE", credentials: "probe:probe", ips: "10.99.99.99" },
    embedding: vector,
  });

  // Wait (bounded) until tenant B's own search can see the planted document.
  let bSeesIt = false;
  const start = Date.now();
  while (!bSeesIt && Date.now() - start < 20_000) {
    const b = await db.vectorSearchWithPipeline(tenantB, vector, 10);
    bSeesIt = b.results.some((r) => r._id === plantedId);
    if (!bSeesIt) await new Promise((r) => setTimeout(r, 1500));
  }

  const a = await db.vectorSearchWithPipeline(tenantA, vector, 10);
  const hybridA = await db.searchSimilarIncidents(tenantA, vector, `${src.title} ${src.symptoms.join(" ")}`, 10);
  const leaked = [...a.results, ...hybridA].filter((r) => r._id === plantedId || r.tenant_id !== tenantA);

  return NextResponse.json({
    tenantA,
    tenantB,
    source: { id: src._id, title: src.title },
    planted: { id: plantedId, tenant_id: tenantB, indexed_visible_to_B: bSeesIt },
    tenantA_vector_hits: a.results.map((r) => ({ id: r._id, tenant_id: r.tenant_id, title: r.title })),
    tenantA_hybrid_hits: hybridA.map((r) => ({ id: r._id, tenant_id: r.tenant_id, title: r.title, rrf_score: r.rrf_score })),
    cross_tenant_results: leaked.length,
    pipeline: a.pipeline,
  });
}
