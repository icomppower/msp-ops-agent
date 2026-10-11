import { NextResponse } from "next/server";
import * as db from "@/db/tenantScoped";
import { TENANT_IDS } from "@/sim/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Success-rate series from the runbook_metrics time series collection plus the
// revision timestamps to mark on the chart.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenant") ?? "";
  const runbookId = url.searchParams.get("runbook") ?? "";
  if (!TENANT_IDS.includes(tenantId) || !runbookId) return NextResponse.json({ error: "tenant and runbook required" }, { status: 400 });
  const [series, revisions, runbook] = await Promise.all([db.metricsSeries(tenantId, runbookId), db.listRevisions(tenantId, { runbookId }), db.getRunbook(tenantId, runbookId)]);
  return NextResponse.json({ runbook, series, revisions: revisions.map((r) => ({ at: r.created_at, to_version: r.to_version })) });
}
