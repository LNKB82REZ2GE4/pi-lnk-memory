import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as readline from "node:readline";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

interface RpcResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

export interface PiRpcProcessOptions {
  cliCommand?: string;
  cliArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  provider?: string;
  model?: string;
}

export interface PiRpcSessionState {
  isStreaming?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  pendingMessageCount?: number;
  model?: {
    provider?: string;
    id?: string;
  } | null;
  [key: string]: unknown;
}

export class PiRpcProcess {
  private process: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private stderr = "";
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(event: AgentEvent) => void>();
  private agentStartCount = 0;
  private agentEndCount = 0;

  constructor(private readonly options: PiRpcProcessOptions = {}) {}

  async start(): Promise<void> {
    if (this.process) throw new Error("RPC worker already started");

    const args = ["--mode", "rpc"];
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.cliArgs?.length) args.push(...this.options.cliArgs);

    this.process = spawn(this.options.cliCommand ?? "pi", args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr.on("data", (data) => {
      this.stderr += data.toString();
    });

    this.rl = readline.createInterface({
      input: this.process.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => this.handleLine(line));

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.process.exitCode !== null) {
      throw new Error(`Pi RPC exited immediately with code ${this.process.exitCode}: ${this.stderr}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.process) return;

    this.rl?.close();
    const proc = this.process;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 1000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill("SIGTERM");
    });

    this.process = null;
    this.rl = null;
    this.pending.clear();
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<void> {
    await this.send({ type: "prompt", message, streamingBehavior });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: "steer", message });
  }

  async followUp(message: string): Promise<void> {
    await this.send({ type: "follow_up", message });
  }

  async abort(): Promise<void> {
    await this.send({ type: "abort" });
  }

  async getState(): Promise<PiRpcSessionState> {
    const response = await this.send<PiRpcSessionState>({ type: "get_state" });
    return response.data ?? {};
  }

  async getLastAssistantText(): Promise<string | undefined> {
    const response = await this.send<{ text?: string | null }>({ type: "get_last_assistant_text" });
    const text = response.data?.text;
    return typeof text === "string" ? text : undefined;
  }

  getAgentCounters(): { startCount: number; endCount: number } {
    return {
      startCount: this.agentStartCount,
      endCount: this.agentEndCount,
    };
  }

  async waitForAgentCompletion(afterEndCount: number, timeoutMs = 300_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (this.agentEndCount > afterEndCount) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`RPC worker did not complete a turn within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async waitForIdle(timeoutMs = 300_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      const state = await this.getState();
      if (!state.isStreaming) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`RPC worker did not become idle within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  getStderr(): string {
    return this.stderr;
  }

  getStderrTail(maxChars = 600): string {
    return this.stderr.length <= maxChars ? this.stderr : this.stderr.slice(-maxChars);
  }

  private async send<T = unknown>(command: Record<string, unknown>): Promise<RpcResponse<T>> {
    if (!this.process?.stdin.writable) throw new Error("RPC worker is not running");

    const id = `rpc-${++this.requestId}`;
    const payload = { ...command, id };

    const promise = new Promise<RpcResponse<T>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (response: RpcResponse) => void, reject });
    });

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    const response = await promise;
    if (!response.success) {
      throw new Error(response.error ?? `${response.command} failed`);
    }
    return response;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse | AgentEvent;
    try {
      parsed = JSON.parse(line) as RpcResponse | AgentEvent;
    } catch {
      return;
    }

    if ((parsed as RpcResponse).type === "response") {
      const response = parsed as RpcResponse;
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      pending.resolve(response);
      return;
    }

    const event = parsed as AgentEvent;
    if (event.type === "agent_start") this.agentStartCount += 1;
    if (event.type === "agent_end") this.agentEndCount += 1;

    for (const listener of this.listeners) listener(event);
  }
}
