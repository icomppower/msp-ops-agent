import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRunbook, getTenant, listRevisions } from "@/db/tenantScoped";

const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";

function enabled(): boolean {
  return process.env.VOICE_ENABLED === "true" && !!process.env.ELEVENLABS_API_KEY;
}

export async function speakRevision(
  tenantId: string,
  revisionId: string,
): Promise<{ filePath: string; text: string } | null> {
  if (!enabled()) return null;
  try {
    const revisions = await listRevisions(tenantId, { limit: 100 });
    const rev = revisions.find((r) => r._id === revisionId);
    if (!rev) return null;
    const [runbook, tenant] = await Promise.all([getRunbook(tenantId, rev.runbook_id), getTenant(tenantId)]);
    if (!runbook || !tenant) return null;

    const pct = Math.round(rev.trigger.success_rate * 100);
    const summary = rev.diff.summary?.trim();
    const text =
      `For ${tenant.name}, runbook "${runbook.name}" moved from version ${rev.from_version} to ${rev.to_version} ` +
      `because its verified success rate fell to ${pct} percent` +
      (summary ? `; ${summary.replace(/[.\s]+$/, "")}` : "") +
      `. Replay of the failed incidents now passes.`;

    const dir = path.join(os.tmpdir(), "msp-ops-voice");
    const filePath = path.join(dir, `${revisionId}.mp3`);
    const cached = await stat(filePath).then((s) => s.size > 0, () => false);
    if (!cached) {
      await mkdir(dir, { recursive: true });
      const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
      const stream = await client.textToSpeech.convert(VOICE_ID, {
        text,
        modelId: "eleven_flash_v2_5",
        outputFormat: "mp3_44100_128",
      });
      const bytes = Buffer.from(await new Response(stream as unknown as ReadableStream).arrayBuffer());
      if (bytes.length === 0) return null;
      await writeFile(filePath, bytes);
    }
    return { filePath, text };
  } catch (err) {
    console.warn("[voice] speakRevision failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function readVoiceFile(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
