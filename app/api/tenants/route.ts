import { NextResponse } from "next/server";
import { TENANTS, GPO_QUIRK_TENANT } from "@/sim/tenants";
import { INCIDENT_TYPES } from "@/db/jsonSchemas";

export const dynamic = "force-dynamic";

// Static roster for the dashboard; per-tenant data comes from tenant-scoped routes.
export function GET() {
  return NextResponse.json({
    tenants: TENANTS.map((t) => ({ id: t._id, name: t.name, rmm: t.environment.rmm, quirk: t._id === GPO_QUIRK_TENANT })),
    incidentTypes: INCIDENT_TYPES,
  });
}
