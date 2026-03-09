import type { LocalIndexState, MemoryConfig, RetrievalCandidate } from "../types.js";
import { OllamaEmbedClient } from "../providers/ollama.js";
import { QdrantClient } from "../providers/qdrant.js";

export async function vectorRetrieve(
  cfg: MemoryConfig,
  state: LocalIndexState,
  ollama: OllamaEmbedClient,
  qdrant: QdrantClient,
  query: string,
): Promise<RetrievalCandidate[]> {
  const embed = await ollama.embed([query]);
  const vector = embed.vectors[0];
  const hits = await qdrant.search(vector, cfg.retrieval.vectorLimit);

  const out: RetrievalCandidate[] = [];
  for (const hit of hits) {
    const chunk = state.chunks[hit.id];
    if (!chunk) continue;

    const base = Math.max(0, Math.min(1, hit.score));
    const score = base + chunk.recencyScore * 0.2 + (chunk.sourceKind === "global-memory" ? 0.1 : 0);

    out.push({
      chunk,
      vectorScore: score,
      combinedScore: score,
      reasons: [`vector:${hit.score.toFixed(3)}`, `embed-model:${embed.model}`],
    });
  }

  return out;
}
