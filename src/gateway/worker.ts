import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { MemoryBroker } from "../memory/broker.js";
import type { RetrievalResult } from "../types.js";
import { PiRpcProcess, type PiRpcSessionState } from "./rpc-process.js";
import type { GatewayPromptOptions, GatewayWorkerOptions, GatewayWorkerSummary } from "./types.js";

function emptyTranscript(): RetrievalResult {
  return { candidates: [], confidence: 0 };
}

export class PiRpcWorker {
  readonly id: string;
  readonly process: PiRpcProcess;
  readonly summary: GatewayWorkerSummary;

  constructor(
    private readonly broker: MemoryBroker,
    private readonly options: GatewayWorkerOptions,
  ) {
    this.id = options.id ?? `worker-${Date.now().toString(36)}`;
    this.process = new PiRpcProcess({
      cliCommand: options.cliCommand,
      cliArgs: options.cliArgs,
      cwd: options.cwd,
      env: options.env,
      provider: options.provider,
      model: options.model,
    });
    this.summary = {
      id: this.id,
      cwd: options.cwd ?? process.cwd(),
      status: "starting",
      injectionOwner: options.injectionOwner ?? "worker",
      memoryScope: options.memoryScope,
    };

    this.process.onEvent((event) => this.observeEvent(event));
  }

  async start(): Promise<void> {
    this.summary.status = "starting";
    try {
      await this.process.start();
      this.summary.status = "ready";
      this.summary.startedAt = new Date().toISOString();
      await this.syncState();
    } catch (error) {
      this.summary.status = "error";
      this.summary.lastError = error instanceof Error ? error.message : String(error);
      this.summary.stderrTail = this.process.getStderrTail();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.summary.stderrTail = this.process.getStderrTail();
    await this.process.stop();
    this.summary.status = "stopped";
  }

  async prompt(message: string, options: GatewayPromptOptions = {}): Promise<void> {
    const nextMessage = await this.preparePrompt(message, options);
    await this.process.prompt(nextMessage, options.streamingBehavior);
    this.summary.status = "streaming";
  }

  async runPrompt(message: string, options: GatewayPromptOptions = {}): Promise<string> {
    const before = this.process.getAgentCounters();
    await this.prompt(message, options);
    await this.process.waitForAgentCompletion(before.endCount);
    await this.process.waitForIdle();
    await this.syncState();
    return (await this.process.getLastAssistantText()) ?? "";
  }

  async steer(message: string): Promise<void> {
    await this.process.steer(message);
  }

  async followUp(message: string): Promise<void> {
    await this.process.followUp(message);
  }

  async abort(): Promise<void> {
    await this.process.abort();
  }

  async getState(): Promise<PiRpcSessionState> {
    return await this.process.getState();
  }

  async syncState(): Promise<GatewayWorkerSummary> {
    try {
      const state = await this.process.getState();
      this.summary.sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
      this.summary.sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
      this.summary.sessionName = typeof state.sessionName === "string" ? state.sessionName : undefined;
      this.summary.pendingMessageCount = typeof state.pendingMessageCount === "number" ? state.pendingMessageCount : undefined;
      this.summary.modelLabel = state.model?.provider && state.model?.id ? `${state.model.provider}/${state.model.id}` : undefined;
      this.summary.stderrTail = this.process.getStderrTail();
      if (state.isStreaming === true) this.summary.status = "streaming";
      return this.summary;
    } catch (error) {
      this.summary.lastError = error instanceof Error ? error.message : String(error);
      this.summary.stderrTail = this.process.getStderrTail();
      return this.summary;
    }
  }

  private async preparePrompt(message: string, options: GatewayPromptOptions): Promise<string> {
    if (options.bypassGatewayMemory || this.summary.injectionOwner !== "gateway") return message;

    const hybrid = await this.broker.activateHybrid({
      query: message,
      transcript: emptyTranscript(),
      scope: this.summary.memoryScope,
    });

    if (!hybrid.injectionText) return message;
    return `${hybrid.injectionText}\n\n${message}`;
  }

  private observeEvent(event: AgentEvent): void {
    this.summary.lastEventAt = new Date().toISOString();
    this.summary.stderrTail = this.process.getStderrTail();

    if (event.type === "agent_end") {
      this.summary.status = "ready";
      void this.syncState();
      return;
    }

    if (event.type === "agent_start") {
      this.summary.status = "streaming";
    }
  }
}
