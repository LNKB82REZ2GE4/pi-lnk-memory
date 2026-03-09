import type { LocalIndexState, MemoryChunk, MemoryConfig, RetrievalCandidate } from "../types.js";

function tokens(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function lexicalScore(query: string, chunk: MemoryChunk): number {
  const qTokens = tokens(query);
  if (qTokens.length === 0) return 0;

  const text = chunk.text.toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (!text.includes(t)) continue;
    score += 1;
    const occurrences = text.split(t).length - 1;
    score += Math.min(3, occurrences) * 0.25;
  }

  const phrase = query.trim().toLowerCase();
  if (phrase.length > 3 && text.includes(phrase)) {
    score += 1.5;
  }

  score += chunk.recencyScore * 0.5;
  if (chunk.sourceKind === "global-memory") score += 0.25;

  return score;
}

export function lexicalRetrieve(
  cfg: MemoryConfig,
  state: LocalIndexState,
  query: string,
): RetrievalCandidate[] {
  const out: RetrievalCandidate[] = [];
  for (const chunk of Object.values(state.chunks)) {
    const score = lexicalScore(query, chunk);
    if (score <= 0) continue;
    out.push({
      chunk,
      lexicalScore: score,
      combinedScore: score,
      reasons: ["lexical-match"],
    });
  }

  out.sort((a, b) => (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0));
  return out.slice(0, cfg.retrieval.lexicalLimit);
}
