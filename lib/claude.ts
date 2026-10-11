// Every Claude call goes through callStructured: structured JSON output
// constrained to a Zod schema, validated, retried once on a validation failure.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "./env";

let _client: Anthropic | null = null;
function client(): Anthropic {
  // ANTHROPIC_API_KEY from the environment; org-level keys also need the workspace header.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  _client ??= new Anthropic({ defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined });
  return _client;
}

export class ClaudeOutputError extends Error {}

export type StructuredCall<S extends z.ZodType> = {
  name: "select_and_adapt_runbook" | "propose_revision";
  schema: S;
  system: string;
  user: string;
  maxTokens?: number;
};

export type StructuredResult<T> = { data: T; usage: { input: number; output: number; cached: number }; retried: boolean };

export async function callStructured<S extends z.ZodType>(call: StructuredCall<S>): Promise<StructuredResult<z.infer<S>>> {
  const once = async (correction?: string) => {
    // messages.create + our own JSON.parse/Zod pass (rather than messages.parse) so
    // that every validation failure is a ClaudeOutputError and hits the retry below.
    // Server-side refusal fallback: if the safety classifier declines (false positives
    // on benign IT-ops text do happen), the API re-runs the request on a fallback model.
    const res = await client().beta.messages.create({
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      model: env.claudeModel(),
      max_tokens: call.maxTokens ?? 8000,
      // Stable system prompt first so it caches across incidents; the per-incident context is in the user turn.
      system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium", format: zodOutputFormat(call.schema) },
      messages: [{ role: "user", content: correction ? `${call.user}\n\n${correction}` : call.user }],
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Claude declined ${call.name}: ${res.stop_details?.category ?? "unknown"} — ${res.stop_details?.explanation ?? ""}`);
    }
    if (res.stop_reason === "max_tokens") throw new ClaudeOutputError(`${call.name}: output truncated at max_tokens`);
    const servedBy = res.content.some((b) => b.type === "fallback") ? ` (served by fallback ${res.model})` : "";
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (servedBy) console.warn(`[claude] ${call.name}${servedBy}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ClaudeOutputError(`${call.name}: response was not valid JSON`);
    }
    const checked = call.schema.safeParse(json);
    if (!checked.success) throw new ClaudeOutputError(`${call.name}: ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return {
      data: checked.data as z.infer<S>,
      usage: {
        input: res.usage.input_tokens,
        output: res.usage.output_tokens,
        cached: res.usage.cache_read_input_tokens ?? 0,
      },
    };
  };

  try {
    return { ...(await once()), retried: false };
  } catch (e) {
    if (!(e instanceof ClaudeOutputError)) throw e;
    const correction = `Your previous answer failed validation (${e.message}). Return JSON that matches the schema exactly, using only the allowed step actions.`;
    return { ...(await once(correction)), retried: true };
  }
}
