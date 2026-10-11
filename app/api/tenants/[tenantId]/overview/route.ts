import { NextResponse } from "next/server";
import * as db from "@/db/tenantScoped";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Everything one tenant's panels need on first paint; change streams keep it live afterwards.
export async function GET(_req: Request, ctx: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await ctx.params;
  try {
    const [tenant, runbooks, runs, revisions, attempts, incidents] = await Promise.all([
      db.getTenant(tenantId),
      db.listCandidateRunbooks(tenantId),
      db.listAgentRuns(tenantId, 12),
      db.listRevisions(tenantId, { limit: 10 }),
      db.listAttempts(tenantId, { limit: 30 }),
      db.listIncidents(tenantId, { limit: 30 }),
    ]);
    if (!tenant) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
    return NextResponse.json({ tenant, runbooks: runbooks.filter((r) => r.tenant_id === tenantId), runs, revisions, attempts, incidents });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
