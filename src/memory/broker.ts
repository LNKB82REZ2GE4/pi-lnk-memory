import type { MemoryChunk, MemoryConfig, RetrievalResult } from "../types.js";
import type {
  BrokerRememberBatchResult,
  DurableActivateResult,
  DurableMemoryAdapter,
  DurableMemoryCapabilities,
  DurableMemoryWrite,
  DurableSubscribeRequest,
  DurableSubscription,
  DurableTransportKind,
  HybridRecallResult,
  MemoryBrokerStatus,
  MemoryScope,
  NormalizedMemoryEvent,
  TransportCapability,
} from "./contracts.js";

interface ActivateHybridRequest {
  query: string;
  transcript: RetrievalResult;
  scope?: MemoryScope;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function unavailableCapability(reason: string, details?: Record<string, unknown>): TransportCapability {
  return {
    configured: false,
    available: false,
    operations: {
      health: false,
      activate: false,
      write: false,
      subscribe: false,
    },
    reason,
    details,
  };
}

function choosePreferredTransport(capabilities: DurableMemoryCapabilities): DurableTransportKind {
  if (capabilities.transports.grpc.available && capabilities.transports.grpc.operations.activate) return "grpc";
  if (capabilities.transports.rest.available && capabilities.transports.rest.operations.activate) return "rest";
  if (capabilities.transports.mcp.available && capabilities.transports.mcp.operations.activate) return "mcp";
  return "none";
}

export class MemoryBroker {
  private capabilityCache: { value: DurableMemoryCapabilities; cachedAt: number } | null = null;

  constructor(
    private readonly cfg: MemoryConfig,
    private readonly adapters: Partial<Record<Exclude<DurableTransportKind, "none">, DurableMemoryAdapter>>,
  ) {}

  private async probeTransport(
    kind: Exclude<DurableTransportKind, "none">,
    fallback: TransportCapability,
  ): Promise<TransportCapability> {
    const adapter = this.adapters[kind];
    if (!adapter) return fallback;

    try {
      return await adapter.probeCapabilities();
    } catch (error) {
      return {
        configured: true,
        available: false,
        operations: {
          health: false,
          activate: false,
          write: false,
          subscribe: false,
        },
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getCapabilities(force = false): Promise<DurableMemoryCapabilities> {
    const ttlMs = this.cfg.muninn.capabilityCacheTtlMs;
    if (!force && this.capabilityCache && Date.now() - this.capabilityCache.cachedAt < ttlMs) {
      return this.capabilityCache.value;
    }

    const grpc = await this.probeTransport(
      "grpc",
      unavailableCapability(
        this.cfg.muninn.grpcTarget ? "gRPC adapter scaffolded but not implemented yet" : "gRPC not configured",
        this.cfg.muninn.grpcTarget ? { target: this.cfg.muninn.grpcTarget } : undefined,
      ),
    );
    const rest = await this.probeTransport(
      "rest",
      unavailableCapability(this.cfg.muninn.enabled ? "REST adapter unavailable" : "Muninn disabled"),
    );
    const mcp = await this.probeTransport(
      "mcp",
      unavailableCapability(
        this.cfg.muninn.mcpEnabled ? "MCP adapter scaffolded but not implemented yet" : "MCP compatibility layer disabled",
      ),
    );

    const value: DurableMemoryCapabilities = {
      preferredTransport: "none",
      transports: { grpc, rest, mcp },
      lastProbedAt: new Date().toISOString(),
    };
    value.preferredTransport = choosePreferredTransport(value);

    this.capabilityCache = { value, cachedAt: Date.now() };
    return value;
  }

  async getStatus(forceProbe = false): Promise<MemoryBrokerStatus> {
    const capabilities = await this.getCapabilities(forceProbe);
    const preferred = capabilities.preferredTransport;
    const adapter = preferred === "none" ? undefined : this.adapters[preferred];
    const durableHealthy = adapter ? await adapter.health().catch(() => false) : false;

    return {
      durableEnabled: this.cfg.muninn.enabled,
      durableHealthy,
      preferredTransport: preferred,
      capabilities,
    };
  }

  private async activateDurable(query: string, scope?: MemoryScope): Promise<DurableActivateResult> {
    if (!this.cfg.muninn.enabled || !query.trim()) {
      return { activations: [], confidence: 0, transport: "none" };
    }

    const capabilities = await this.getCapabilities();
    const ordered: Array<Exclude<DurableTransportKind, "none">> = [
      capabilities.preferredTransport,
      "grpc",
      "rest",
      "mcp",
    ].filter((kind, index, array): kind is Exclude<DurableTransportKind, "none"> => kind !== "none" && array.indexOf(kind) === index);

    for (const kind of ordered) {
      const adapter = this.adapters[kind];
      const capability = capabilities.transports[kind];
      if (!adapter || !capability.available || !capability.operations.activate) continue;

      try {
        return await adapter.activate(query, scope);
      } catch {
        continue;
      }
    }

    return { activations: [], confidence: 0, transport: "none" };
  }

  async rememberBatch(memories: DurableMemoryWrite[], scope?: MemoryScope): Promise<BrokerRememberBatchResult> {
    const cleaned = memories.filter((memory) => memory.concept.trim() && memory.content.trim());
    if (cleaned.length === 0) {
      return {
        attempted: 0,
        written: 0,
        failed: 0,
        transport: "none",
        results: [],
      };
    }

    const capabilities = await this.getCapabilities();
    const ordered: Array<Exclude<DurableTransportKind, "none">> = [
      capabilities.preferredTransport,
      "grpc",
      "rest",
      "mcp",
    ].filter((kind, index, array): kind is Exclude<DurableTransportKind, "none"> => kind !== "none" && array.indexOf(kind) === index);

    let lastFailure: { transport: DurableTransportKind; error: string } | null = null;

    for (const kind of ordered) {
      const adapter = this.adapters[kind];
      const capability = capabilities.transports[kind];
      if (!adapter || !capability.available || !capability.operations.write) continue;

      try {
        const results = await adapter.rememberBatch(cleaned, scope);
        const written = results.filter((result) => result.status === "ok").length;
        return {
          attempted: cleaned.length,
          written,
          failed: cleaned.length - written,
          transport: kind,
          results,
        };
      } catch (error) {
        lastFailure = {
          transport: kind,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      attempted: cleaned.length,
      written: 0,
      failed: cleaned.length,
      transport: lastFailure?.transport ?? "none",
      results: cleaned.map((_, index) => ({
        index,
        status: "error",
        error: lastFailure?.error ?? "No durable memory transport available",
        transport: lastFailure?.transport ?? "none",
      })),
    };
  }

  async subscribe(
    request: DurableSubscribeRequest,
    onEvent: (event: NormalizedMemoryEvent) => void,
  ): Promise<DurableSubscription | null> {
    const capabilities = await this.getCapabilities();
    const ordered: Array<Exclude<DurableTransportKind, "none">> = [
      capabilities.preferredTransport,
      "grpc",
      "rest",
      "mcp",
    ].filter((kind, index, array): kind is Exclude<DurableTransportKind, "none"> => kind !== "none" && array.indexOf(kind) === index);

    for (const kind of ordered) {
      const adapter = this.adapters[kind];
      const capability = capabilities.transports[kind];
      if (!adapter?.subscribe || !capability.available || !capability.operations.subscribe) continue;

      try {
        return await adapter.subscribe(request, onEvent);
      } catch {
        continue;
      }
    }

    return null;
  }

  async activateHybrid(request: ActivateHybridRequest): Promise<HybridRecallResult> {
    const durable = await this.activateDurable(request.query, request.scope).catch(() => ({
      activations: [],
      confidence: 0,
      transport: "none" as const,
    }));

    const seen = new Set<string>();
    const durableLines: string[] = [];
    const transcriptLines: string[] = [];
    let durableChars = 0;
    let transcriptChars = 0;

    for (const item of durable.activations.slice(0, this.cfg.muninn.injectionMaxItems)) {
      const key = `${normalize(item.concept)}::${normalize(item.content)}`;
      if (!item.content.trim() || seen.has(key)) continue;
      const line = `- ${item.concept}: ${item.content.replace(/\s+/g, " ")}${item.why ? ` (${item.why})` : ""}`;
      if (durableChars + line.length > this.cfg.hybridInjection.muninnMaxChars) break;
      seen.add(key);
      durableLines.push(line);
      durableChars += line.length + 1;
    }

    for (const item of request.transcript.candidates) {
      const key = normalize(item.chunk.text);
      if (!item.chunk.text.trim() || seen.has(key)) continue;
      const line = this.transcriptLine(item.chunk);
      if (transcriptChars + line.length > this.cfg.hybridInjection.lnkMaxChars) break;
      seen.add(key);
      transcriptLines.push(line);
      transcriptChars += line.length + 1;
      if (transcriptLines.length >= Math.max(1, this.cfg.hybridInjection.maxTotalItems - durableLines.length)) break;
    }

    const combinedConfidence = Math.max(request.transcript.confidence, durable.confidence);
    const shouldInject = combinedConfidence >= this.cfg.hybridInjection.minCombinedConfidence
      && (durableLines.length > 0 || transcriptLines.length > 0);

    return {
      transcript: request.transcript,
      durable,
      combinedConfidence,
      injectionText: shouldInject ? this.formatInjectionText(durableLines, transcriptLines) : undefined,
      sections: {
        durableItems: durableLines.length,
        transcriptItems: transcriptLines.length,
      },
    };
  }

  private transcriptLine(chunk: MemoryChunk): string {
    const src = chunk.sourceKind === "global-memory" ? "global-memory" : chunk.sourcePath.split("/").slice(-1)[0];
    return `- ${chunk.timestamp} | ${src}: ${chunk.text.replace(/\s+/g, " ")}`;
  }

  private formatInjectionText(durableLines: string[], transcriptLines: string[]): string {
    const lines: string[] = [
      "<hybrid-memory-context>",
      "Use only when relevant. Prefer durable structured memory for facts and transcript memory for recent context.",
      "",
    ];

    if (durableLines.length > 0) {
      lines.push("[Structured memory]");
      lines.push(...durableLines);
      lines.push("");
    }

    if (transcriptLines.length > 0) {
      lines.push("[Prior session context]");
      lines.push(...transcriptLines);
      lines.push("");
    }

    lines.push("</hybrid-memory-context>");
    let text = lines.join("\n");
    if (text.length > this.cfg.hybridInjection.maxChars) {
      text = `${text.slice(0, this.cfg.hybridInjection.maxChars)}\n\n[truncated to hybrid memory budget]`;
    }
    return text;
  }
}
