import { PiRpcGateway } from "./gateway.js";
import type { GatewayInjectionOwner } from "./types.js";

export interface LocalGatewaySmokeResult {
  workerId: string;
  ok: boolean;
  response: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  modelLabel?: string;
  stderrTail?: string;
}

export class LocalGatewayManager {
  private defaultWorkerId: string | null = null;

  constructor(private readonly gateway: PiRpcGateway) {}

  async ensureDefaultWorker(options?: {
    cwd?: string;
    injectionOwner?: GatewayInjectionOwner;
    provider?: string;
    model?: string;
    cliCommand?: string;
    cliArgs?: string[];
  }): Promise<string> {
    if (this.defaultWorkerId) return this.defaultWorkerId;

    const worker = await this.gateway.createWorker({
      id: "local-default",
      cwd: options?.cwd,
      injectionOwner: options?.injectionOwner ?? "worker",
      memoryScope: {
        mode: "local",
      },
      provider: options?.provider,
      model: options?.model,
      cliCommand: options?.cliCommand,
      cliArgs: options?.cliArgs,
    });

    this.defaultWorkerId = worker.id;
    return worker.id;
  }

  getDefaultWorkerId(): string | null {
    return this.defaultWorkerId;
  }

  async stopDefaultWorker(): Promise<boolean> {
    if (!this.defaultWorkerId) return false;
    await this.gateway.stopWorker(this.defaultWorkerId);
    this.defaultWorkerId = null;
    return true;
  }

  async promptDefault(message: string, options?: { bypassGatewayMemory?: boolean }): Promise<string> {
    if (!this.defaultWorkerId) throw new Error("Local gateway worker is not running. Start it first.");
    return await this.gateway.runPromptWorker(this.defaultWorkerId, message, options);
  }

  async subscribeDefault(context: string[]): Promise<void> {
    if (!this.defaultWorkerId) throw new Error("Local gateway worker is not running. Start it first.");
    await this.gateway.attachDurablePush(this.defaultWorkerId, {
      context,
      threshold: 0.2,
      pushOnWrite: true,
      rateLimit: 20,
      ttlSeconds: 3600,
      deltaThreshold: 0.01,
    });
  }

  async unsubscribeDefault(): Promise<void> {
    if (!this.defaultWorkerId) return;
    await this.gateway.detachDurablePush(this.defaultWorkerId);
  }

  async smokeDefault(mode: "plain" | "memory" = "plain"): Promise<LocalGatewaySmokeResult> {
    if (!this.defaultWorkerId) throw new Error("Local gateway worker is not running. Start it first.");

    const sentinel = mode === "memory" ? "GATEWAY_MEMORY_OK" : "GATEWAY_LOCAL_OK";
    const prompt = mode === "memory"
      ? `Reply with exactly ${sentinel} on the first line. On the second line, in under 12 words, say whether hybrid memory context seems present.`
      : `Reply with exactly ${sentinel} and nothing else.`;

    const response = await this.gateway.runPromptWorker(this.defaultWorkerId, prompt, {
      bypassGatewayMemory: mode === "plain",
    });
    const status = await this.gateway.getStatus();
    const worker = status.workers.find((item) => item.id === this.defaultWorkerId);

    return {
      workerId: this.defaultWorkerId,
      ok: response.includes(sentinel),
      response,
      sessionFile: worker?.sessionFile,
      sessionId: worker?.sessionId,
      sessionName: worker?.sessionName,
      modelLabel: worker?.modelLabel,
      stderrTail: worker?.stderrTail,
    };
  }
}
