import test from "node:test";
import assert from "node:assert/strict";
import type {
  DurableActivateResult,
  DurableMemoryAdapter,
  DurableSubscribeRequest,
  DurableSubscription,
  DurableWriteResult,
  NormalizedMemoryEvent,
  TransportCapability,
} from "../src/memory/contracts.js";
import { MemoryBroker } from "../src/memory/broker.js";
import type { MemoryConfig } from "../src/types.js";

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
      enabled: true,
      restBaseUrl: "http://127.0.0.1:8475",
      grpcTarget: "127.0.0.1:8477",
      grpcProtoPath: "/tmp/service.proto",
      grpcTls: false,
      mcpEnabled: false,
      vault: "pi",
      recallMaxResults: 5,
      injectionMaxItems: 3,
      capabilityProbeTimeoutMs: 2500,
      capabilityCacheTtlMs: 60_000,
    },
    extraction: {
      enabled: false,
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
      minConfidence: 0,
      minTopScore: 0,
      tokenBudgetChars: 2000,
      maxItems: 5,
      recencyHalfLifeDays: 7,
    },
    hybridInjection: {
      enabled: true,
      maxChars: 2000,
      lnkMaxChars: 1000,
      muninnMaxChars: 1000,
      maxTotalItems: 6,
      minCombinedConfidence: 0,
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

class FakeAdapter implements DurableMemoryAdapter {
  rememberCalls = 0;
  activateCalls = 0;
  subscribeCalls = 0;

  constructor(
    public readonly kind: "grpc" | "rest" | "mcp",
    private readonly capability: TransportCapability,
  ) {}

  async health(): Promise<boolean> {
    return this.capability.available;
  }

  async probeCapabilities(): Promise<TransportCapability> {
    return this.capability;
  }

  async activate(): Promise<DurableActivateResult> {
    this.activateCalls += 1;
    return {
      activations: [{ id: "1", concept: "c", content: "grpc activation", score: 0.9, transport: this.kind }],
      confidence: 0.9,
      transport: this.kind,
    };
  }

  async rememberBatch(): Promise<DurableWriteResult[]> {
    this.rememberCalls += 1;
    return [{ index: 0, status: "ok", transport: this.kind }];
  }

  async subscribe(
    _request: DurableSubscribeRequest,
    onEvent: (event: NormalizedMemoryEvent) => void,
  ): Promise<DurableSubscription> {
    this.subscribeCalls += 1;
    onEvent({
      type: "new_write",
      priority: "low",
      transport: this.kind,
      content: "pushed memory",
      receivedAt: new Date().toISOString(),
    });
    return { close: async () => undefined };
  }
}

test("memory broker prefers grpc for activation and falls back to rest for writes", async () => {
  const grpc = new FakeAdapter("grpc", {
    configured: true,
    available: true,
    operations: { health: true, activate: true, write: false, subscribe: true },
  });
  const rest = new FakeAdapter("rest", {
    configured: true,
    available: true,
    operations: { health: true, activate: true, write: true, subscribe: false },
  });

  const broker = new MemoryBroker(cfg(), { grpc, rest });
  const capabilities = await broker.getCapabilities(true);
  assert.equal(capabilities.preferredTransport, "grpc");

  const hybrid = await broker.activateHybrid({
    query: "login flow",
    transcript: { candidates: [], confidence: 0 },
  });
  assert.equal(hybrid.durable.transport, "grpc");
  assert.equal(grpc.activateCalls, 1);

  const write = await broker.rememberBatch([{ concept: "auth", content: "use refresh tokens" }]);
  assert.equal(write.transport, "rest");
  assert.equal(rest.rememberCalls, 1);
  assert.equal(grpc.rememberCalls, 0);

  let pushed = 0;
  const sub = await broker.subscribe({ context: ["auth"] }, () => {
    pushed += 1;
  });
  assert.ok(sub);
  assert.equal(grpc.subscribeCalls, 1);
  assert.equal(pushed, 1);
});
