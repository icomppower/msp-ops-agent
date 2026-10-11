// Which embedding provider is active, decided once from the environment.
// Everything that depends on the vector size (validators, the Atlas Vector
// Search index definition) reads `dims` from here instead of hardcoding it.
// Voyage (via Atlas AI Model APIs) is primary; the local model is only a
// fallback for when VOYAGE_API_KEY is empty.
import "@/lib/env";

// Default output dimension per Voyage model. voyage-4 family supports Matryoshka
// sizes, but we always request the default and verify it in scripts/embed-smoke.ts.
const VOYAGE_DIMS: Record<string, number> = {
  "voyage-4-large": 1024,
  "voyage-4": 1024,
  "voyage-4-lite": 1024,
  "voyage-3.5": 1024,
  "voyage-3.5-lite": 1024,
  "voyage-3-large": 1024,
  "voyage-code-3": 1024,
};

export type EmbeddingProvider =
  | { name: "voyage"; model: string; dims: number; baseUrl: string }
  | { name: "local"; model: "Xenova/all-MiniLM-L6-v2"; dims: 384 };

function resolve(): EmbeddingProvider {
  // EMBED_PROVIDER=local forces the fallback even when a Voyage key is present.
  const forced = process.env.EMBED_PROVIDER;
  if (forced && forced !== "local" && forced !== "voyage" && forced !== "auto") throw new Error(`EMBED_PROVIDER must be voyage|local|auto, got ${forced}`);
  if (forced === "voyage" && !process.env.VOYAGE_API_KEY) throw new Error("EMBED_PROVIDER=voyage but VOYAGE_API_KEY is empty");
  if (process.env.VOYAGE_API_KEY && forced !== "local") {
    const model = process.env.VOYAGE_MODEL ?? "voyage-4-large";
    const dims = VOYAGE_DIMS[model];
    if (!dims) throw new Error(`Unknown Voyage model ${model}; add it to VOYAGE_DIMS in lib/embedConfig.ts`);
    return { name: "voyage", model, dims, baseUrl: (process.env.VOYAGE_BASE_URL ?? "https://ai.mongodb.com").replace(/\/$/, "") };
  }
  return { name: "local", model: "Xenova/all-MiniLM-L6-v2", dims: 384 };
}

export const embeddingProvider: EmbeddingProvider = resolve();
export const EMBEDDING_DIMS: number = embeddingProvider.dims;
