// Loads .env.local for scripts and tests (Next.js loads it itself for the app).
// Uses Node's built-in loader; no dotenv dependency.
import fs from "node:fs";

if (!process.env.MONGODB_URI && fs.existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} — add it to .env.local`);
  return v;
}

export const env = {
  mongoUri: () => required("MONGODB_URI"),
  mongoDb: () => process.env.MONGODB_DB ?? "msp_ops",
  qeMasterKey: () => Buffer.from(required("QE_LOCAL_MASTER_KEY"), "base64"),
  voyageKey: () => required("VOYAGE_API_KEY"),
  claudeModel: () => process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
  elevenLabsKey: () => process.env.ELEVENLABS_API_KEY ?? "",
  voiceEnabled: () => process.env.VOICE_ENABLED === "true" && Boolean(process.env.ELEVENLABS_API_KEY),
  isProduction: process.env.NODE_ENV === "production",
};
