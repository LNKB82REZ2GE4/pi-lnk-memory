import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { MemoryConfig } from "./types.js";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function readSettings(): Record<string, unknown> {
  const settingsPath = path.join(homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadConfig(): MemoryConfig {
  const raw = readSettings();
  const ext = asObject(raw["pi-lnk-memory"]);
  const ollama = asObject(ext.ollama);
  const qdrant = asObject(ext.qdrant);
  const muninn = asObject(ext.muninn);
  const extraction = asObject(ext.extraction);
  const extractionBackfill = asObject(extraction.backfill);
  const retrieval = asObject(ext.retrieval);
  const hybridInjection = asObject(ext.hybridInjection);
  const indexing = asObject(ext.indexing);
  const dedupe = asObject(ext.dedupe);

  const storageDir = expandHome(
    str(ext.storageDir, path.join(homedir(), ".pi", "agent", "lnk-memory")),
  );
  const globalMemoryPath = expandHome(
    str(ext.globalMemoryPath, path.join(storageDir, "memory.md")),
  );

  const cfg: MemoryConfig = {
    enabled: bool(ext.enabled, true),
    extensionVersion: "0.1.0",
    storageDir,
    statePath: path.join(storageDir, "state.json"),
    globalMemoryPath,
    globalResolvedPath: path.join(storageDir, "memory.resolved.json"),
    backfillReportPath: path.join(storageDir, "backfill-scan.latest.json"),
    backfillReportMarkdownPath: path.join(storageDir, "backfill-scan.latest.md"),
    backfillSyncReportPath: path.join(storageDir, "backfill-sync.latest.json"),
    ollama: {
      baseUrl: str(process.env.LNK_MEMORY_OLLAMA_URL, str(ollama.baseUrl, "http://127.0.0.1:11434")),
      model: str(process.env.LNK_MEMORY_OLLAMA_MODEL, str(ollama.model, "nomic-embed-text")),
      fallbackModels: Array.isArray(ollama.fallbackModels)
        ? ollama.fallbackModels.filter((v): v is string => typeof v === "string")
        : ["all-minilm", "mxbai-embed-large"],
      timeoutMs: num(ollama.timeoutMs, 45_000),
    },
    qdrant: {
      baseUrl: str(process.env.LNK_MEMORY_QDRANT_URL, str(qdrant.baseUrl, "http://127.0.0.1:6333")),
      collection: str(process.env.LNK_MEMORY_QDRANT_COLLECTION, str(qdrant.collection, "pi_lnk_memory_chunks")),
      apiKey: str(process.env.LNK_MEMORY_QDRANT_API_KEY, str(qdrant.apiKey, "")) || undefined,
      timeoutMs: num(qdrant.timeoutMs, 45_000),
      distance: str(qdrant.distance, "Cosine") as "Cosine" | "Dot" | "Euclid",
    },
    muninn: {
      enabled: bool(muninn.enabled, false),
      restBaseUrl: str(process.env.LNK_MEMORY_MUNINN_URL, str(muninn.restBaseUrl, "http://127.0.0.1:8475")),
      grpcTarget: str(process.env.LNK_MEMORY_MUNINN_GRPC_TARGET, str(muninn.grpcTarget, "127.0.0.1:8477")) || undefined,
      grpcProtoPath: str(process.env.LNK_MEMORY_MUNINN_GRPC_PROTO, str(muninn.grpcProtoPath, "")) || undefined,
      grpcTls: bool(muninn.grpcTls, false),
      mcpEnabled: bool(muninn.mcpEnabled, false),
      vault: str(process.env.LNK_MEMORY_MUNINN_VAULT, str(muninn.vault, "pi")),
      apiKey: str(process.env.LNK_MEMORY_MUNINN_API_KEY, str(muninn.apiKey, "")) || undefined,
      recallMaxResults: num(muninn.recallMaxResults, 5),
      injectionMaxItems: num(muninn.injectionMaxItems, 3),
      capabilityProbeTimeoutMs: num(muninn.capabilityProbeTimeoutMs, 2500),
      capabilityCacheTtlMs: num(muninn.capabilityCacheTtlMs, 5 * 60 * 1000),
    },
    extraction: {
      enabled: bool(extraction.enabled, true),
      baseUrl: str(process.env.LNK_MEMORY_EXTRACTION_URL, str(extraction.baseUrl, "http://127.0.0.1:8080")),
      model: str(process.env.LNK_MEMORY_EXTRACTION_MODEL, str(extraction.model, "auto")),
      timeoutMs: num(extraction.timeoutMs, 60_000),
      batchSize: num(extraction.batchSize, 8),
      turnCapture: bool(extraction.turnCapture, false),
      backfill: {
        includeBranchSummaries: bool(extractionBackfill.includeBranchSummaries, true),
        includeCompactions: bool(extractionBackfill.includeCompactions, true),
        excludeToolResults: bool(extractionBackfill.excludeToolResults, true),
        excludeBash: bool(extractionBackfill.excludeBash, true),
        minHeuristicScore: num(extractionBackfill.minHeuristicScore, 2.25),
        maxCandidateWindows: num(extractionBackfill.maxCandidateWindows, 60),
        sampleLimit: num(extractionBackfill.sampleLimit, 24),
        maxMemoriesPerWindow: num(extractionBackfill.maxMemoriesPerWindow, 3),
        maxWindowChars: num(extractionBackfill.maxWindowChars, 1800),
      },
    },
    retrieval: {
      lexicalLimit: num(retrieval.lexicalLimit, 24),
      vectorLimit: num(retrieval.vectorLimit, 24),
      hybridLimit: num(retrieval.hybridLimit, 12),
      minConfidence: num(retrieval.minConfidence, 0.35),
      minTopScore: num(retrieval.minTopScore, 0.25),
      tokenBudgetChars: num(retrieval.tokenBudgetChars, 6000),
      maxItems: num(retrieval.maxItems, 8),
      recencyHalfLifeDays: num(retrieval.recencyHalfLifeDays, 21),
    },
    hybridInjection: {
      enabled: bool(hybridInjection.enabled, true),
      maxChars: num(hybridInjection.maxChars, 3500),
      lnkMaxChars: num(hybridInjection.lnkMaxChars, 2200),
      muninnMaxChars: num(hybridInjection.muninnMaxChars, 1300),
      maxTotalItems: num(hybridInjection.maxTotalItems, 6),
      minCombinedConfidence: num(hybridInjection.minCombinedConfidence, 0.4),
    },
    indexing: {
      autoIncremental: bool(indexing.autoIncremental, true),
      debounceMs: num(indexing.debounceMs, 3000),
      chunkChars: num(indexing.chunkChars, 1600),
      chunkOverlap: num(indexing.chunkOverlap, 180),
      diskCapBytes: num(indexing.diskCapBytes, 20 * 1024 * 1024 * 1024),
    },
    dedupe: {
      intervalMs: num(dedupe.intervalMs, 30 * 60 * 1000),
      llmAssist: bool(dedupe.llmAssist, false),
      llmEndpoint: str(dedupe.llmEndpoint, "http://127.0.0.1:8080"),
    },
  };

  mkdirSync(cfg.storageDir, { recursive: true });
  return cfg;
}
