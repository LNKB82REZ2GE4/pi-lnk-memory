import type { MemoryChunk, MemoryConfig, RetrievalCandidate, RetrievalResult } from "../types.js";

function rrf(rank: number, k = 60): number {
  return 1 / (k + rank + 1);
}

function noiseScore(chunk: MemoryChunk): { score: number; tags: string[] } {
  const text = chunk.text.toLowerCase();
  let score = 0;
  const tags: string[] = [];

  if (chunk.sourceRole === "toolResult" && /\[tool(result|call)/.test(text)) {
    score += 0.25;
    tags.push("tool-serialization");
  }

  if (/interactive_shell|session .* exited|\[e2e]|\/lnk-memory-/.test(text)) {
    score += 0.35;
    tags.push("harness-chatter");
  }

  if (/timeout\s+\d+\s+pi\s+--offline|set -euo pipefail/.test(text)) {
    score += 0.2;
    tags.push("script-artifact");
  }

  if (/^\s*(\[toolcall|\[toolresult|\/lnk-memory-)/.test(text.trim())) {
    score += 0.15;
    tags.push("command-heavy");
  }

  return { score: Math.max(0, Math.min(1, score)), tags };
}

function dedupeMerge(
  lexical: RetrievalCandidate[],
  vector: RetrievalCandidate[],
): RetrievalCandidate[] {
  const out = new Map<string, RetrievalCandidate>();

  lexical.forEach((item, idx) => {
    const rankBoost = rrf(idx) * 4;
    const lexicalBase = Math.min(1, (item.lexicalScore ?? 0) / 4);

    out.set(item.chunk.chunkId, {
      ...item,
      combinedScore: lexicalBase * 0.55 + rankBoost,
      reasons: [...item.reasons, `lex-rank:${idx + 1}`],
    });
  });

  vector.forEach((item, idx) => {
    const rankBoost = rrf(idx) * 4;
    const vectorBase = Math.max(0, Math.min(1, item.vectorScore ?? 0));
    const existing = out.get(item.chunk.chunkId);

    if (!existing) {
      out.set(item.chunk.chunkId, {
        ...item,
        combinedScore: vectorBase * 0.75 + rankBoost,
        reasons: [...item.reasons, `vec-rank:${idx + 1}`],
      });
      return;
    }

    existing.vectorScore = item.vectorScore;
    existing.combinedScore += vectorBase * 0.55 + rankBoost;
    existing.reasons = [...existing.reasons, ...item.reasons, `vec-rank:${idx + 1}`];
  });

  return [...out.values()]
    .map((c) => {
      const base = c.combinedScore + c.chunk.recencyScore * 0.2 + (c.chunk.sourceKind === "global-memory" ? 0.05 : 0);
      const noise = noiseScore(c.chunk);
      const factor = 1 - noise.score * 0.55; // down-rank but never fully remove
      return {
        ...c,
        combinedScore: base * factor,
        reasons: noise.tags.length > 0 ? [...c.reasons, ...noise.tags.map((t) => `noise:${t}`)] : c.reasons,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);
}

function formatContext(cfg: MemoryConfig, candidates: RetrievalCandidate[]): string {
  const selected = candidates.slice(0, cfg.retrieval.maxItems);
  const lines: string[] = [
    "<lnk-memory-context>",
    "Use only when relevant. Prefer recent entries when conflicts exist.",
    "",
  ];

  for (const [index, item] of selected.entries()) {
    const ts = item.chunk.timestamp;
    const src = item.chunk.sourceKind === "global-memory" ? "global-memory" : item.chunk.sourcePath;
    const head = `[${index + 1}] ${ts} | ${src} | score=${item.combinedScore.toFixed(3)}`;
    lines.push(head);
    lines.push(item.chunk.text.trim());
    lines.push("");
  }

  lines.push("</lnk-memory-context>");
  let text = lines.join("\n");

  if (text.length > cfg.retrieval.tokenBudgetChars) {
    text = `${text.slice(0, cfg.retrieval.tokenBudgetChars)}\n\n[truncated to memory token budget]`;
  }

  return text;
}

export function hybridRetrieve(
  cfg: MemoryConfig,
  lexical: RetrievalCandidate[],
  vector: RetrievalCandidate[],
): RetrievalResult {
  const merged = dedupeMerge(lexical, vector).slice(0, cfg.retrieval.hybridLimit);
  const top = merged[0]?.combinedScore ?? 0;

  const confidence = Math.max(0, Math.min(1, top));
  const shouldInject = merged.length > 0 && confidence >= cfg.retrieval.minConfidence && top >= cfg.retrieval.minTopScore;

  return {
    candidates: merged,
    confidence,
    injectedText: shouldInject ? formatContext(cfg, merged) : undefined,
  };
}
