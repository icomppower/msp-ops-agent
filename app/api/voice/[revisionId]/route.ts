import { readFile } from "node:fs/promises";
import { speakRevision } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ revisionId: string }> }) {
  const { revisionId } = await ctx.params;
  const tenant = new URL(req.url).searchParams.get("tenant");
  if (!tenant) return new Response("missing tenant", { status: 400 });

  const result = await speakRevision(tenant, revisionId);
  if (!result) return new Response(null, { status: 404 });

  try {
    const bytes = await readFile(result.filePath);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "private, max-age=3600",
        "x-voice-text": result.text.replace(/[^\x20-\x7E]/g, ""),
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
