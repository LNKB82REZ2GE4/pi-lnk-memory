import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcileGlobalMemory } from "../src/global-memory-dedupe.js";
import type { MemoryConfig } from "../src/types.js";

function makeConfig(dir: string): MemoryConfig {
  return {
    enabled: true,
    extensionVersion: "test",
    storageDir: dir,
    statePath: path.join(dir, "state.json"),
    globalMemoryPath: path.join(dir, "memory.md"),
    globalResolvedPath: path.join(dir, "memory.resolved.json"),
    backfillReportPath: path.join(dir, "backfill-scan.latest.json"),
    backfillReportMarkdownPath: path.join(dir, "backfill-scan.latest.md"),
    backfillSyncReportPath: path.join(dir, "backfill-sync.latest.json"),
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
      hybridLimit: 5,
      minConfidence: 0.1,
      minTopScore: 0.1,
      tokenBudgetChars: 1000,
      maxItems: 3,
      recencyHalfLifeDays: 7,
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
      chunkOverlap: 50,
      diskCapBytes: 10_000_000,
    },
    dedupe: {
      intervalMs: 1000,
      llmAssist: false,
      llmEndpoint: "http://127.0.0.1:8080",
    },
  };
}

test("global dedupe keeps newest duplicate", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lnk-memory-test-"));
  const cfg = makeConfig(dir);

  const resolved = await reconcileGlobalMemory(cfg, [
    { timestamp: "2026-01-01T00:00:00.000Z", text: "I prefer 2-space indentation", source: "append" },
    { timestamp: "2026-02-01T00:00:00.000Z", text: "I prefer 2 space indentation", source: "append" },
    { timestamp: "2026-03-01T00:00:00.000Z", text: "Use concise responses", source: "append" },
  ]);

  assert.equal(resolved.strategy, "heuristic");
  assert.equal(resolved.entries.length, 2);
  assert.ok(resolved.entries.some((e) => e.text.toLowerCase().includes("2 space")));
  assert.ok(existsSync(cfg.globalResolvedPath));

  const persisted = JSON.parse(readFileSync(cfg.globalResolvedPath, "utf8")) as { entries: Array<{ text: string }> };
  assert.equal(persisted.entries.length, 2);

  rmSync(dir, { recursive: true, force: true });
});
