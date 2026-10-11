import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const stream = await client.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
  text: "Runbook updated.",
  modelId: "eleven_flash_v2_5",
  outputFormat: "mp3_44100_128",
});
const buf = Buffer.from(await new Response(stream as unknown as ReadableStream).arrayBuffer());
const out = path.join(tmpdir(), "voice-smoke.mp3");
writeFileSync(out, buf);
console.log(`wrote ${out}: ${buf.length} bytes`);
