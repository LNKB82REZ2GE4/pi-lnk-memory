import { MemoryBroker } from "../memory/broker.js";
import type { DurableSubscribeRequest, DurableSubscription, NormalizedMemoryEvent } from "../memory/contracts.js";
import { PiRpcWorker } from "./worker.js";
import type { DurablePushRoute, GatewayPromptOptions, GatewayStatus, GatewayWorkerOptions, GatewayWorkerSummary } from "./types.js";

export class PiRpcGateway {
  private readonly workers = new Map<string, PiRpcWorker>();
  private readonly pushSubscriptions = new Map<string, DurableSubscription>();
  private readonly recentRoutes: DurablePushRoute[] = [];

  constructor(private readonly broker: MemoryBroker) {}

  async createWorker(options: GatewayWorkerOptions): Promise<PiRpcWorker> {
    const worker = new PiRpcWorker(this.broker, options);
    if (this.workers.has(worker.id)) {
      throw new Error(`Worker ${worker.id} already exists`);
    }

    this.workers.set(worker.id, worker);
    if (options.autoStart !== false) await worker.start();
    return worker;
  }

  async stopWorker(workerId: string): Promise<void> {
    const worker = this.getWorker(workerId);
    const sub = this.pushSubscriptions.get(workerId);
    if (sub) {
      await sub.close();
      this.pushSubscriptions.delete(workerId);
    }
    await worker.stop();
    this.workers.delete(workerId);
  }

  listWorkers(): GatewayWorkerSummary[] {
    return [...this.workers.values()].map((worker) => ({ ...worker.summary }));
  }

  async getStatus(forceProbe = false): Promise<GatewayStatus> {
    await Promise.all([...this.workers.values()].map((worker) => worker.syncState().catch(() => undefined)));
    return {
      broker: await this.broker.getStatus(forceProbe),
      workers: this.listWorkers(),
      recentRoutes: [...this.recentRoutes],
    };
  }

  async promptWorker(workerId: string, message: string, options?: GatewayPromptOptions): Promise<void> {
    await this.getWorker(workerId).prompt(message, options);
  }

  async runPromptWorker(workerId: string, message: string, options?: GatewayPromptOptions): Promise<string> {
    return await this.getWorker(workerId).runPrompt(message, options);
  }

  async steerWorker(workerId: string, message: string): Promise<void> {
    await this.getWorker(workerId).steer(message);
  }

  async followUpWorker(workerId: string, message: string): Promise<void> {
    await this.getWorker(workerId).followUp(message);
  }

  async attachDurablePush(workerId: string, request: Omit<DurableSubscribeRequest, "scope">): Promise<void> {
    const worker = this.getWorker(workerId);
    const previous = this.pushSubscriptions.get(workerId);
    if (previous) {
      await previous.close();
      this.pushSubscriptions.delete(workerId);
    }

    const subscription = await this.broker.subscribe({
      ...request,
      scope: worker.summary.memoryScope,
    }, async (event) => {
      await this.routeDurablePush(workerId, event);
    });

    if (!subscription) {
      throw new Error(`No durable subscription transport available for worker ${workerId}`);
    }

    this.pushSubscriptions.set(workerId, subscription);
  }

  async detachDurablePush(workerId: string): Promise<void> {
    const subscription = this.pushSubscriptions.get(workerId);
    if (!subscription) return;
    await subscription.close();
    this.pushSubscriptions.delete(workerId);
  }

  async shutdown(): Promise<void> {
    const ids = [...this.workers.keys()];
    for (const id of ids) {
      await this.stopWorker(id);
    }
  }

  private getWorker(workerId: string): PiRpcWorker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown worker: ${workerId}`);
    return worker;
  }

  private async routeDurablePush(workerId: string, event: NormalizedMemoryEvent): Promise<DurablePushRoute> {
    const worker = this.getWorker(workerId);
    const line = this.renderEvent(event);

    if (!line) {
      const route = { workerId, event, deliveredVia: "ignored" as const };
      this.recordRoute(route);
      return route;
    }

    try {
      if (event.priority === "high") {
        await worker.steer(line);
        const route = { workerId, event, deliveredVia: "steer" as const };
        this.recordRoute(route);
        return route;
      }

      if (worker.summary.status !== "streaming") {
        await worker.runPrompt(line, { bypassGatewayMemory: true });
        const route = { workerId, event, deliveredVia: "prompt" as const };
        this.recordRoute(route);
        return route;
      }

      await worker.followUp(line);
      const route = { workerId, event, deliveredVia: "follow_up" as const };
      this.recordRoute(route);
      return route;
    } catch {
      const route = { workerId, event, deliveredVia: "ignored" as const };
      this.recordRoute(route);
      return route;
    }
  }

  private recordRoute(route: DurablePushRoute): void {
    this.recentRoutes.unshift(route);
    if (this.recentRoutes.length > 20) this.recentRoutes.length = 20;
  }

  private renderEvent(event: NormalizedMemoryEvent): string | undefined {
    if (!event.content?.trim()) return undefined;

    if (event.type === "contradiction_detected") {
      return [
        "<durable-memory-warning>",
        `Contradiction detected in durable memory${event.concept ? ` for ${event.concept}` : ""}.`,
        event.content,
        "Use caution and verify before relying on this memory.",
        "</durable-memory-warning>",
      ].join("\n");
    }

    return [
      "<durable-memory-push>",
      `Triggered durable memory (${event.type})${event.concept ? `: ${event.concept}` : ""}`,
      event.content,
      "Queue this only if relevant to the current task.",
      "</durable-memory-push>",
    ].join("\n");
  }
}
