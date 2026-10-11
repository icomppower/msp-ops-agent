import { NextResponse } from "next/server";
import { admin } from "@/db/tenantScoped";
import { embeddingProvider } from "@/lib/embedConfig";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await admin.health();
  return NextResponse.json({
    ...health,
    hybridSearch: health.rankFusionSupported ? "$rankFusion" : "manual reciprocal rank fusion ($vectorSearch ∪ $search, fused in aggregation)",
    embeddings: { provider: embeddingProvider.name, model: embeddingProvider.model, dims: embeddingProvider.dims },
    claudeModel: env.claudeModel(),
    voice: env.voiceEnabled(),
  });
}
