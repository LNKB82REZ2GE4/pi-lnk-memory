import test from "node:test";
import assert from "node:assert/strict";
import { hybridRetrieve } from "../src/retrieval/hybrid.js";
import type { MemoryChunk, MemoryConfig, RetrievalCandidate } from "../src/types.js";

function cfg(): MemoryConfig {
  return {
    enabled: true,
    extensionVersion: "test",
    storageDir: "/tmp",
    statePath: "/tmp/state.json",
    globalMemoryPath: "/tmp/memory.md",
    globalResolvedPath: "/tmp/memory.resolved.json",
    backfillReportPath: "/tmp/backfill-scan.latest.json",
    backfillReportMarkdownPath: "/tmp/backfill-scan.latest.md",
    backfillSyncReportPath: "/tmp/backfill-sync.latest.json",
    ollama: { baseUrl: "", model: "", fallbackModels: [], timeoutMs: 1000 },
    qdrant: { baseUrl: "", collection: "", timeoutMs: 1000, distance: "Cosine" },
    muninn: {
      enabled: false,
      restBaseUrl: "http://127.0.0.1:8475",
      grpcTarget: undefined,
      grpcProtoPath: undefined,
      grpcTls: false,
      mcpEnabled: false,
      vault: "pi",
      recallMaxResults: 5,
      injectionMaxItems: 3,
      capabilityProbeTimeoutMs: 2500,
      capabilityCacheTtlMs: 60_000,
    },
    extraction: {
      enabled: true,
      baseUrl: "http://127.0.0.1:8080",
      model: "auto",
      timeoutMs: 1000,
      batchSize: 2,
      turnCapture: false,
      backfill: {
        includeBranchSummaries: true,
        includeCompactions: true,
        excludeToolResults: true,
        excludeBash: true,
        minHeuristicScore: 2,
        maxCandidateWindows: 10,
        sampleLimit: 5,
        maxMemoriesPerWindow: 2,
        maxWindowChars: 1000,
      },
    },
    retrieval: {
      lexicalLimit: 10,
      vectorLimit: 10,
      hybridLimit: 10,
      minConfidence: 0,
      minTopScore: 0,
      tokenBudgetChars: 5000,
      maxItems: 5,
      recencyHalfLifeDays: 14,
    },
    hybridInjection: {
      enabled: true,
      maxChars: 3000,
      lnkMaxChars: 1800,
      muninnMaxChars: 1200,
      maxTotalItems: 6,
      minCombinedConfidence: 0.4,
    },
    indexing: {
      autoIncremental: false,
      debounceMs: 0,
      chunkChars: 1000,
      chunkOverlap: 100,
      diskCapBytes: 1_000_000,
    },
    dedupe: {
      intervalMs: 1000,
      llmAssist: false,
      llmEndpoint: "http://127.0.0.1:8080",
    },
  };
}

function mkChunk(id: string, text: string): MemoryChunk {
  return {
    chunkId: id,
    sourceKind: "session",
    sourcePath: "/tmp/session.jsonl",
    entryType: "message",
    sourceRole: "assistant",
    text,
    timestamp: "2026-03-06T00:00:00.000Z",
    recencyScore: 1,
    contentHash: id,
    indexedAt: "2026-03-06T00:00:00.000Z",
    extensionVersion: "test",
  };
}

function cand(chunk: MemoryChunk): RetrievalCandidate {
  return {
    chunk,
    lexicalScore: 3,
    vectorScore: 0.8,
    combinedScore: 0,
    reasons: [],
  };
}

test("noise filter down-ranks harness chatter without dropping it", () => {
  const clean = cand(mkChunk("clean", "I prefer explicit file paths and concrete command examples."));
  const noisy = cand(mkChunk("noisy", "[E2E] Step 4 /lnk-memory-search explicit file paths command examples"));

  const result = hybridRetrieve(cfg(), [clean, noisy], [clean, noisy]);

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].chunk.chunkId, "clean");
  assert.equal(result.candidates[1].chunk.chunkId, "noisy");
  assert.ok(result.candidates[1].combinedScore > 0, "noisy chunk should still be retained");
  assert.ok(result.candidates[1].reasons.some((r) => r.startsWith("noise:")));
});
