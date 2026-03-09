import { existsSync, readFileSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { loadConfig } from "./src/config.js";
import { registerCommands } from "./src/commands.js";
import { appendGlobalMemory, ensureGlobalMemoryFile, readGlobalMemoryRaw, writeGlobalMemoryRaw } from "./src/global-memory.js";
import { PendingInjection } from "./src/injection.js";
import { MemoryIndexer } from "./src/indexer.js";
import { runBackfillScan, formatBackfillScanSummary } from "./src/backfill/scanner.js";
import {
  applyApprovedGlobalMemories,
  formatBackfillSyncPlan,
  formatBackfillSyncSummary,
  formatGlobalReviewDocument,
  parseApprovedGlobalReview,
  prepareGlobalReviewCandidates,
  prepareLatestBackfillSync,
  syncLatestBackfillPlan,
} from "./src/backfill/sync.js";
import { LocalLlmClient } from "./src/providers/local-llm.js";
import { OllamaEmbedClient } from "./src/providers/ollama.js";
import { QdrantClient } from "./src/providers/qdrant.js";
import { hybridRetrieve } from "./src/retrieval/hybrid.js";
import { lexicalRetrieve } from "./src/retrieval/lexical.js";
import { vectorRetrieve } from "./src/retrieval/vector.js";
import { DEFAULT_GATEWAY_TEST_MODEL, DEFAULT_GATEWAY_TEST_PROVIDER } from "./src/gateway/defaults.js";
import { PiRpcGateway } from "./src/gateway/gateway.js";
import { LocalGatewayManager } from "./src/gateway/local-manager.js";
import { MemoryBroker } from "./src/memory/broker.js";
import { MuninnClient } from "./src/muninn/client.js";
import { MuninnGrpcClient } from "./src/muninn/grpc-client.js";
import { listAllSessionPaths } from "./src/session-source.js";

export default function activate(pi: ExtensionAPI): void {
  const cfg = loadConfig();
  const ollama = new OllamaEmbedClient(cfg);
  const qdrant = new QdrantClient(cfg);
  const muninn = new MuninnClient(cfg);
  const muninnGrpc = new MuninnGrpcClient(cfg);
  const broker = new MemoryBroker(cfg, { rest: muninn, grpc: muninnGrpc });
  const localLlm = new LocalLlmClient(cfg);
  const indexer = new MemoryIndexer(cfg, ollama, qdrant);
  const pending = new PendingInjection();
  const gateway = new PiRpcGateway(broker);
  const localGateway = new LocalGatewayManager(gateway);

  let indexTimer: NodeJS.Timeout | null = null;
  let dedupeTimer: NodeJS.Timeout | null = null;
  let indexing = false;

  const scheduleIndex = async (sessionPath?: string) => {
    if (!cfg.enabled || !cfg.indexing.autoIncremental) return;
    if (indexTimer) clearTimeout(indexTimer);

    indexTimer = setTimeout(async () => {
      if (indexing) return;
      indexing = true;
      try {
        await indexer.runIncremental(sessionPath ? [sessionPath] : undefined);
      } catch {
        // ignore background errors
      } finally {
        indexing = false;
      }
    }, cfg.indexing.debounceMs);
  };

  const runRetrieval = async (query: string) => {
    const state = indexer.getState();
    const lexical = lexicalRetrieve(cfg, state, query);

    let vector: import("./src/types.js").RetrievalCandidate[] = [];
    try {
      vector = await vectorRetrieve(cfg, state, ollama, qdrant, query);
    } catch {
      vector = [];
    }

    return hybridRetrieve(cfg, lexical, vector);
  };

  const statusText = async (): Promise<string> => {
    const state = indexer.getState();
    const qdrantHealthy = await qdrant.health();
    const brokerStatus = await broker.getStatus();
    const restOps = brokerStatus.capabilities.transports.rest.operations;
    const grpcOps = brokerStatus.capabilities.transports.grpc.operations;
    const extractorModel = cfg.extraction.enabled
      ? await localLlm.resolveModel().catch(() => "unresolved")
      : "disabled";
    const gb = (state.totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    const durableLabel = !cfg.muninn.enabled
      ? "disabled"
      : `${brokerStatus.durableHealthy ? "ok" : "down"}/${brokerStatus.preferredTransport}`;

    return [
      `lnk-memory status`,
      `chunks=${Object.keys(state.chunks).length}`,
      `sessions=${Object.keys(state.sessions).length}`,
      `storage=${gb}GB / ${(cfg.indexing.diskCapBytes / (1024 * 1024 * 1024)).toFixed(0)}GB`,
      `qdrant=${qdrantHealthy ? "ok" : "down"}`,
      `durable=${durableLabel}`,
      `restOps=write:${restOps.write ? "y" : "n"},activate:${restOps.activate ? "y" : "n"},subscribe:${restOps.subscribe ? "y" : "n"}`,
      `grpcOps=write:${grpcOps.write ? "y" : "n"},activate:${grpcOps.activate ? "y" : "n"},subscribe:${grpcOps.subscribe ? "y" : "n"}`,
      `grpc=${brokerStatus.capabilities.transports.grpc.reason ?? "unconfigured"}`,
      `extractor=${cfg.extraction.enabled ? extractorModel : "disabled"}`,
      `lastDedupe=${state.lastDedupeAt ?? "never"}`,
      `retrievalExtraLlmCalls=disabled(default)`,
    ].join(" | ");
  };

  const resolveBackfillTargets = async (selector?: string): Promise<string[]> => {
    const allPaths = await listAllSessionPaths();
    const sorted = [...allPaths].sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return b.localeCompare(a);
      }
    });

    const arg = selector?.trim();
    if (!arg || arg === "latest") {
      if (sorted.length === 0) throw new Error("No session files found");
      return [sorted[0]];
    }

    if (arg === "all") return sorted;

    const exact = sorted.find((path) => path === arg);
    if (exact) return [exact];

    const matches = sorted.filter((path) => path.includes(arg));
    if (matches.length === 0) {
      throw new Error(`No session path matched selector: ${arg}`);
    }

    return [matches[0]];
  };

  const parseKeyValueArgs = (input?: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const part of input?.split(/\s+/).filter(Boolean) ?? []) {
      const [key, ...rest] = part.split("=");
      if (!key || rest.length === 0) continue;
      out[key.toLowerCase()] = rest.join("=").trim();
    }
    return out;
  };

  const gatewayStatusText = async (): Promise<string> => {
    const status = await gateway.getStatus();
    const workerId = localGateway.getDefaultWorkerId() ?? "none";
    const lines = [
      "local gateway status",
      `defaultWorker=${workerId}`,
      `preferredTransport=${status.broker.preferredTransport}`,
      `durableHealthy=${status.broker.durableHealthy ? "yes" : "no"}`,
      `workerCount=${status.workers.length}`,
    ];

    if (status.workers.length === 0) {
      lines.push("workers=none");
      return lines.join(" | ");
    }

    for (const worker of status.workers) {
      lines.push([
        `worker=${worker.id}`,
        `status=${worker.status}`,
        `injection=${worker.injectionOwner}`,
        `model=${worker.modelLabel ?? "unknown"}`,
        `session=${worker.sessionFile ?? "none"}`,
        `sessionId=${worker.sessionId ?? "unknown"}`,
        `pending=${worker.pendingMessageCount ?? 0}`,
      ].join(" | "));
      if (worker.stderrTail?.trim()) {
        lines.push(`stderrTail=${worker.stderrTail.replace(/\s+/g, " ").slice(-240)}`);
      }
    }

    if (status.recentRoutes.length > 0) {
      const latest = status.recentRoutes[0];
      lines.push([
        `recentRoutes=${status.recentRoutes.length}`,
        `latestRoute=${latest.deliveredVia}`,
        `latestType=${latest.event.type}`,
        `latestConcept=${latest.event.concept ?? "n/a"}`,
      ].join(" | "));
    }

    return lines.join("\n");
  };

  const buildHybridInjection = async (query: string): Promise<string | undefined> => {
    const transcript = await runRetrieval(query);
    const hybrid = await broker.activateHybrid({
      query,
      transcript,
      scope: { mode: "local" },
    });
    return hybrid.injectionText;
  };

  registerCommands(pi, {
    status: statusText,
    incremental: async () => {
      const res = await indexer.runIncremental();
      return `incremental done: sessionsUpdated=${res.sessionsUpdated}, +${res.chunksAdded}/~${res.chunksUpdated}/-${res.chunksRemoved}, pruned=${res.pruned}, errors=${res.errors.length}`;
    },
    reindex: async () => {
      const res = await indexer.runFullReindex();
      return `reindex done: sessionsUpdated=${res.sessionsUpdated}, chunks=${Object.keys(indexer.getState().chunks).length}, errors=${res.errors.length}`;
    },
    prune: async () => {
      const removed = await indexer.enforceDiskCap();
      return `prune done: removed=${removed.length}`;
    },
    search: async (query) => {
      const out = await runRetrieval(query);
      const rows = out.candidates.slice(0, 5).map((c, i) => {
        const src = c.chunk.sourceKind === "global-memory" ? "global" : c.chunk.sourcePath;
        return `${i + 1}. score=${c.combinedScore.toFixed(3)} ts=${c.chunk.timestamp} src=${src} :: ${c.chunk.text.slice(0, 120).replace(/\s+/g, " ")}`;
      });
      return `confidence=${out.confidence.toFixed(3)} hits=${out.candidates.length}\n${rows.join("\n")}`;
    },
    backfillScan: async (selector) => {
      const targets = await resolveBackfillTargets(selector);
      const report = await runBackfillScan(cfg, targets);
      const scope = selector?.trim() === "all" ? "all sessions" : targets[0];
      return `target=${scope}\n${formatBackfillScanSummary(report)}`;
    },
    backfillReview: async (ctx: ExtensionCommandContext) => {
      if (!existsSync(cfg.backfillReportMarkdownPath)) return `no backfill report yet: run /lnk-memory-backfill-scan first`;
      if (!ctx.hasUI) return `open this file: ${cfg.backfillReportMarkdownPath}`;
      const current = readFileSync(cfg.backfillReportMarkdownPath, "utf8");
      await ctx.ui.editor("LNK Memory Backfill Review", current);
      return `opened ${cfg.backfillReportMarkdownPath}`;
    },
    backfillSync: async (ctx: ExtensionCommandContext) => {
      const plan = prepareLatestBackfillSync(cfg);
      const review = formatBackfillSyncPlan(plan);

      if (!ctx.hasUI) {
        return `review required before sync. Open report: ${cfg.backfillReportPath}`;
      }

      await ctx.ui.editor("Review Muninn Backfill Sync", review);
      const ok = await ctx.ui.confirm(
        "Sync to Muninn?",
        `Write ${plan.muninnCandidates.length} memories to Muninn vault \"${cfg.muninn.vault}\"? Global memory entries are NOT written by this command. Use /lnk-memory-global-review for memory.md approval.`,
      );
      if (!ok) return "muninn sync cancelled";

      const result = await syncLatestBackfillPlan(cfg, broker, plan, { includeGlobal: false });
      return formatBackfillSyncSummary(result);
    },
    globalReview: async (ctx: ExtensionCommandContext) => {
      const candidates = prepareGlobalReviewCandidates(cfg);
      if (candidates.length === 0) return "no global-memory candidates available from the latest backfill scan";
      if (!ctx.hasUI) return `interactive review required. Run /lnk-memory-global-review in Pi and review candidates before writing ${cfg.globalMemoryPath}`;

      const initial = formatGlobalReviewDocument(candidates);
      const edited = await ctx.ui.editor("Review Global Memory Candidates", initial);
      if (typeof edited !== "string") return "global memory review cancelled";

      const approved = parseApprovedGlobalReview(edited, candidates);
      if (approved.length === 0) return "no global memories approved";

      const ok = await ctx.ui.confirm(
        "Append approved memories?",
        `Append ${approved.length} approved entries to ${cfg.globalMemoryPath}?`,
      );
      if (!ok) return "global memory append cancelled";

      const written = applyApprovedGlobalMemories(cfg, approved);
      await indexer.refreshGlobalOnly();
      return `global memory review complete: approved=${approved.length}, appended=${written}`;
    },
    globalAdd: async (text) => {
      appendGlobalMemory(cfg.globalMemoryPath, text);
      await indexer.refreshGlobalOnly();
      return "global memory appended";
    },
    globalOpen: async (ctx: ExtensionCommandContext) => {
      ensureGlobalMemoryFile(cfg.globalMemoryPath);
      if (!ctx.hasUI) return `open this file: ${cfg.globalMemoryPath}`;

      const current = readGlobalMemoryRaw(cfg.globalMemoryPath);
      const edited = await ctx.ui.editor("Edit global memory", current);
      if (typeof edited === "string" && edited !== current) {
        writeGlobalMemoryRaw(cfg.globalMemoryPath, edited);
        await indexer.refreshGlobalOnly();
        return "global memory updated";
      }
      return "global memory unchanged";
    },
    globalDedupe: async () => {
      await indexer.runGlobalDedupe();
      return "global memory dedupe/reconciliation complete";
    },
    gatewayStatus: gatewayStatusText,
    gatewayStart: async (args) => {
      const opts = parseKeyValueArgs(args);
      const provider = opts.provider || DEFAULT_GATEWAY_TEST_PROVIDER;
      const model = opts.model || DEFAULT_GATEWAY_TEST_MODEL;
      const workerId = await localGateway.ensureDefaultWorker({
        cwd: process.cwd(),
        injectionOwner: opts.injection === "gateway" ? "gateway" : "worker",
        provider,
        model,
        cliCommand: opts.cli,
        cliArgs: opts.nosession === "false" ? undefined : ["--no-session"],
      });
      const status = await gatewayStatusText();
      return `local gateway worker ready: id=${workerId} | injection=${opts.injection === "gateway" ? "gateway" : "worker"} | model=${provider}/${model}\n${status}`;
    },
    gatewayStop: async () => {
      const stopped = await localGateway.stopDefaultWorker();
      return stopped ? "local gateway worker stopped" : "local gateway worker was not running";
    },
    gatewayPrompt: async (message) => {
      const text = await localGateway.promptDefault(message);
      return text.trim() ? text : "local gateway worker completed with no assistant text";
    },
    gatewaySubscribe: async (args) => {
      const context = args?.trim() ? [args.trim()] : ["current local Pi work", "hybrid memory routing"];
      await localGateway.subscribeDefault(context);
      return `durable push attached to local gateway worker | context=${context.join("; ")}`;
    },
    gatewayUnsubscribe: async () => {
      await localGateway.unsubscribeDefault();
      return "durable push detached from local gateway worker";
    },
    gatewaySmoke: async (args) => {
      const mode = args?.trim() === "memory" ? "memory" : "plain";
      if (!localGateway.getDefaultWorkerId()) {
        await localGateway.ensureDefaultWorker({
          cwd: process.cwd(),
          injectionOwner: "worker",
          provider: DEFAULT_GATEWAY_TEST_PROVIDER,
          model: DEFAULT_GATEWAY_TEST_MODEL,
          cliArgs: ["--no-session"],
        });
      }
      const result = await localGateway.smokeDefault(mode);
      return [
        `gateway smoke ${result.ok ? "ok" : "failed"}`,
        `mode=${mode}`,
        `workerId=${result.workerId}`,
        `model=${result.modelLabel ?? "unknown"}`,
        `sessionFile=${result.sessionFile ?? "none"}`,
        `sessionId=${result.sessionId ?? "unknown"}`,
        `response=${result.response.replace(/\s+/g, " ").trim() || "<empty>"}`,
        result.stderrTail?.trim() ? `stderrTail=${result.stderrTail.replace(/\s+/g, " ").slice(-240)}` : undefined,
      ].filter(Boolean).join("\n");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!cfg.enabled) {
      ctx.ui.setStatus("lnk-memory", "memory:off");
      return;
    }

    ensureGlobalMemoryFile(cfg.globalMemoryPath);
    ctx.ui.setStatus("lnk-memory", "memory:indexing...");

    scheduleIndex();

    if (dedupeTimer) clearInterval(dedupeTimer);
    dedupeTimer = setInterval(async () => {
      try {
        await indexer.runGlobalDedupe();
      } catch {
        // no-op
      }
    }, cfg.dedupe.intervalMs);

    const status = await broker.getStatus().catch(() => ({ durableHealthy: false, preferredTransport: "none" as const }));
    ctx.ui.setStatus("lnk-memory", status.durableHealthy ? `memory:ready+durable:${status.preferredTransport}` : "memory:ready");
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!cfg.enabled || !cfg.indexing.autoIncremental) return;
    const sessionPath = ctx.sessionManager.getSessionFile();
    if (sessionPath) await scheduleIndex(sessionPath);
  });

  pi.on("before_agent_start", async (event) => {
    if (!cfg.enabled) return;

    try {
      if (cfg.hybridInjection.enabled) {
        const injected = await buildHybridInjection(event.prompt);
        pending.set(injected);
      } else {
        const retrieved = await runRetrieval(event.prompt);
        pending.set(retrieved.injectedText);
      }
    } catch {
      pending.clear();
    }
  });

  pi.on("context", async (event) => {
    if (!cfg.enabled || !pending.hasPending()) return;
    const nextMessages = pending.consumeInto(event.messages as AgentMessage[]);
    return { messages: nextMessages };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (indexTimer) clearTimeout(indexTimer);
    if (dedupeTimer) clearInterval(dedupeTimer);
    await gateway.shutdown().catch(() => undefined);
    ctx.ui.setStatus("lnk-memory", undefined);
  });
}
