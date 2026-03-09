import { writeFileSync } from "node:fs";
import type { GlobalMemoryEntry, MemoryConfig } from "./types.js";

interface ResolvedGlobalMemory {
  generatedAt: string;
  strategy: "heuristic" | "llm-assisted";
  entries: GlobalMemoryEntry[];
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_>#\-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

function heuristicDedupe(entries: GlobalMemoryEntry[]): GlobalMemoryEntry[] {
  const byKey = new Map<string, GlobalMemoryEntry>();

  // Newest wins by design
  const sorted = [...entries].sort((a, b) => parseTs(a.timestamp) - parseTs(b.timestamp));

  for (const entry of sorted) {
    const key = normalize(entry.text);
    if (!key) continue;

    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, entry);
      continue;
    }

    if (parseTs(entry.timestamp) >= parseTs(prev.timestamp)) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()].sort((a, b) => parseTs(b.timestamp) - parseTs(a.timestamp));
}

async function maybeLlmAssist(
  cfg: MemoryConfig,
  deduped: GlobalMemoryEntry[],
): Promise<GlobalMemoryEntry[] | null> {
  if (!cfg.dedupe.llmAssist || deduped.length <= 1) return null;

  // Hard requirement from user: LLM-assisted dedupe must use local endpoint.
  const endpoint = cfg.dedupe.llmEndpoint;
  if (!endpoint.includes("127.0.0.1") && !endpoint.includes("localhost")) {
    return null;
  }

  const payload = {
    model: "local-fast",
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You deduplicate preference/profile notes. Return only JSON array of objects {timestamp,text}. Keep latest in conflicts.",
      },
      {
        role: "user",
        content: JSON.stringify(deduped),
      },
    ],
    response_format: { type: "json_object" },
  };

  try {
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;

    const raw = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(raw.choices) ? raw.choices : [];
    const content = (choices[0] as any)?.message?.content;
    if (typeof content !== "string") return null;

    const parsed = JSON.parse(content) as { entries?: Array<{ timestamp?: string; text?: string }> };
    if (!Array.isArray(parsed.entries)) return null;

    const out: GlobalMemoryEntry[] = parsed.entries
      .filter((e) => typeof e?.text === "string" && e.text.trim().length > 0)
      .map((e) => ({
        timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
        text: (e.text as string).trim(),
        source: "manual",
      }));

    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function reconcileGlobalMemory(
  cfg: MemoryConfig,
  entries: GlobalMemoryEntry[],
): Promise<ResolvedGlobalMemory> {
  const heuristicallyDeduped = heuristicDedupe(entries);
  const llmResolved = await maybeLlmAssist(cfg, heuristicallyDeduped);

  const resolved: ResolvedGlobalMemory = {
    generatedAt: new Date().toISOString(),
    strategy: llmResolved ? "llm-assisted" : "heuristic",
    entries: llmResolved ?? heuristicallyDeduped,
  };

  writeFileSync(cfg.globalResolvedPath, JSON.stringify(resolved, null, 2));
  return resolved;
}
