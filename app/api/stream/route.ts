import { watchTenant } from "@/db/tenantScoped";
import { TENANT_IDS } from "@/sim/tenants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Server-Sent Events fed by a tenant-filtered change stream on attempts,
// revisions and agent_runs. The browser's EventSource reconnects on its own and
// sends Last-Event-ID, which we hand back to Mongo as the resume token.
export async function GET(req: Request) {
  const tenantId = new URL(req.url).searchParams.get("tenant") ?? "";
  if (!TENANT_IDS.includes(tenantId)) return new Response("unknown tenant", { status: 400 });
  const resumeAfter = req.headers.get("last-event-id") ?? undefined;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(encoder.encode(s));
      send(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ tenant: tenantId, resumed: Boolean(resumeAfter) })}\n\n`);
      const heartbeat = setInterval(() => send(`: ping ${Date.now()}\n\n`), 15_000);
      try {
        for await (const ev of watchTenant(tenantId, resumeAfter, abort.signal)) {
          send(`id: ${ev.token}\nevent: ${ev.coll}\ndata: ${JSON.stringify({ op: ev.op, doc: ev.doc })}\n\n`);
        }
      } catch (e) {
        if (!abort.signal.aborted) send(`event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`);
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
