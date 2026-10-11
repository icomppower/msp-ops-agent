// The single swappable embedding function. Provider is chosen in embedConfig.ts:
// Voyage AI when VOYAGE_API_KEY is set, otherwise a local sentence-transformer
// via @huggingface/transformers (ONNX, runs in-process, deterministic).
import { env } from "@/lib/env";
import { embeddingProvider } from "./embedConfig";

export type EmbedInputType = "document" | "query";

export async function embed(texts: string[], inputType: EmbedInputType = "document"): Promise<number[][]> {
  if (texts.length === 0) return [];
  const vectors = embeddingProvider.name === "voyage" ? await embedVoyage(texts, inputType) : await embedLocal(texts);
  for (const v of vectors) {
    if (v.length !== embeddingProvider.dims) {
      throw new Error(`embedding has ${v.length} dims, expected ${embeddingProvider.dims} (${embeddingProvider.model})`);
    }
  }
  return vectors;
}

export async function embedOne(text: string, inputType: EmbedInputType = "document"): Promise<number[]> {
  const [v] = await embed([text], inputType);
  return v;
}

// --- Voyage AI via Atlas AI Model APIs (Embedding and Reranking API) ------------
// Same request/response shape as api.voyageai.com; only the base URL differs.

const VOYAGE_BATCH = 128;

async function embedVoyage(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  if (embeddingProvider.name !== "voyage") throw new Error("voyage provider not active");
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
    const batch = texts.slice(i, i + VOYAGE_BATCH);
    const res = await fetch(`${embeddingProvider.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.voyageKey()}` },
      body: JSON.stringify({ input: batch, model: embeddingProvider.model, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    out.push(...sorted.map((d) => d.embedding));
  }
  return out;
}

// --- Local (@huggingface/transformers) ---------------------------------------

type Extractor = (
  input: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  extractorPromise ??= (async () => {
    // Dynamic import keeps the ONNX runtime out of any bundle that never embeds locally.
    const { pipeline } = await import("@huggingface/transformers");
    const p = await pipeline("feature-extraction", embeddingProvider.model, { dtype: "fp32" });
    return p as unknown as Extractor;
  })();
  return extractorPromise;
}

async function embedLocal(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const out: number[][] = [];
  // Small batches keep peak memory flat when seeding a few hundred incidents.
  for (let i = 0; i < texts.length; i += 32) {
    const tensor = await extractor(texts.slice(i, i + 32), { pooling: "mean", normalize: true });
    out.push(...tensor.tolist());
  }
  return out;
}
