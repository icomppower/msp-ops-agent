import { NextResponse } from "next/server";
import { z } from "zod";
import { fireIncident } from "@/agent/handleIncident";
import { IncidentTypeSchema } from "@/lib/schemas";
import { liveIncident } from "@/sim/incidentText";
import { tenantById, TENANT_IDS } from "@/sim/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Claude + replay can take a minute or two

const Body = z.object({ tenantId: z.enum(TENANT_IDS as [string, ...string[]]), type: IncidentTypeSchema });

// Fire a synthetic incident and run the full agent loop. Progress streams to the
// UI through the change stream on agent_runs; this response carries the final result.
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  const { tenantId, type } = parsed.data;
  try {
    const n = Math.floor(Date.now() / 1000) % 1000;
    const result = await fireIncident(tenantId, liveIncident(type, tenantById(tenantId).environment, n));
    return NextResponse.json(result);
  } catch (e) {
    console.error("[fire]", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
