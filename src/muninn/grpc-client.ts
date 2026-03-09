import * as grpc from "@grpc/grpc-js";
import type { MemoryConfig } from "../types.js";
import type {
  DurableActivateResult,
  DurableMemoryAdapter,
  DurableMemoryWrite,
  DurableSubscribeRequest,
  DurableSubscription,
  DurableWriteResult,
  MemoryScope,
  NormalizedMemoryEvent,
  TransportCapability,
} from "../memory/contracts.js";

type UnaryCallback<T> = (error: grpc.ServiceError | null, response: T) => void;

type GrpcHelloResponse = Record<string, unknown>;

type GrpcActivationItem = Record<string, unknown>;

type GrpcActivateResponse = Record<string, unknown>;

type GrpcActivationPush = Record<string, unknown>;

type GrpcClient = grpc.Client & {
  Hello(request: object, metadata: grpc.Metadata, callback: UnaryCallback<GrpcHelloResponse>): void;
  Activate(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<GrpcActivateResponse>;
  Subscribe(metadata: grpc.Metadata): grpc.ClientDuplexStream<object, GrpcActivationPush>;
};

function serializeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function deserializeJson<T>(buffer: Buffer): T {
  return JSON.parse(buffer.toString("utf8")) as T;
}

const JSON_GRPC_SERVICE_DEFINITION: grpc.ServiceDefinition = {
  Hello: {
    path: "/muninn.v1.MuninnDB/Hello",
    requestStream: false,
    responseStream: false,
    requestSerialize: serializeJson,
    requestDeserialize: deserializeJson,
    responseSerialize: serializeJson,
    responseDeserialize: deserializeJson,
  },
  Activate: {
    path: "/muninn.v1.MuninnDB/Activate",
    requestStream: false,
    responseStream: true,
    requestSerialize: serializeJson,
    requestDeserialize: deserializeJson,
    responseSerialize: serializeJson,
    responseDeserialize: deserializeJson,
  },
  Subscribe: {
    path: "/muninn.v1.MuninnDB/Subscribe",
    requestStream: true,
    responseStream: true,
    requestSerialize: serializeJson,
    requestDeserialize: deserializeJson,
    responseSerialize: serializeJson,
    responseDeserialize: deserializeJson,
  },
};

const JsonGrpcClientConstructor = grpc.makeGenericClientConstructor(
  JSON_GRPC_SERVICE_DEFINITION,
  "MuninnDB",
) as unknown as new (address: string, credentials: grpc.ChannelCredentials) => GrpcClient;

function field<T = unknown>(value: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (key in value) return value[key] as T;
  }
  return undefined;
}

function probePriority(trigger?: string): "low" | "medium" | "high" {
  if (trigger === "contradiction_detected") return "high";
  if (trigger === "threshold_crossed") return "medium";
  return "low";
}

function probeType(trigger?: string): "new_write" | "threshold_crossed" | "contradiction_detected" | "unknown" {
  if (trigger === "new_write") return "new_write";
  if (trigger === "threshold_crossed") return "threshold_crossed";
  if (trigger === "contradiction_detected") return "contradiction_detected";
  return "unknown";
}

function toIsoFromUnixNanos(value?: number | string): string {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!numeric || !Number.isFinite(numeric)) return new Date().toISOString();
  return new Date(Math.floor(Number(numeric) / 1_000_000)).toISOString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class MuninnGrpcClient implements DurableMemoryAdapter {
  readonly kind = "grpc" as const;
  private clientPromise: Promise<GrpcClient> | null = null;

  constructor(private readonly cfg: MemoryConfig) {}

  private resolveVault(scope?: MemoryScope): string {
    return scope?.vault?.trim() || this.cfg.muninn.vault;
  }

  private metadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();
    if (this.cfg.muninn.apiKey) {
      metadata.set("authorization", `Bearer ${this.cfg.muninn.apiKey}`);
      metadata.set("x-api-key", this.cfg.muninn.apiKey);
    }
    return metadata;
  }

  private credentials(): grpc.ChannelCredentials {
    return this.cfg.muninn.grpcTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  }

  private async getClient(): Promise<GrpcClient> {
    if (!this.cfg.muninn.grpcTarget?.trim()) {
      throw new Error("Muninn gRPC target is not configured");
    }

    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const client = new JsonGrpcClientConstructor(this.cfg.muninn.grpcTarget as string, this.credentials());
        await withTimeout(new Promise<void>((resolve, reject) => {
          client.waitForReady(Date.now() + this.cfg.muninn.capabilityProbeTimeoutMs, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }), this.cfg.muninn.capabilityProbeTimeoutMs + 250, "gRPC waitForReady");
        return client;
      })().catch((error) => {
        this.clientPromise = null;
        throw error;
      });
    }

    return this.clientPromise;
  }

  private async hello(): Promise<GrpcHelloResponse> {
    const client = await this.getClient();
    return await withTimeout(new Promise<GrpcHelloResponse>((resolve, reject) => {
      client.Hello({
        Version: "1",
        Client: "pi-lnk-memory",
        Vault: this.cfg.muninn.vault,
        Capabilities: ["activate", "subscribe"],
      }, this.metadata(), (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    }), this.cfg.muninn.capabilityProbeTimeoutMs, "Muninn gRPC Hello");
  }

  async health(): Promise<boolean> {
    if (!this.cfg.muninn.enabled || !this.cfg.muninn.grpcTarget) return false;
    try {
      await this.hello();
      return true;
    } catch {
      return false;
    }
  }

  private async probeActivate(scope?: MemoryScope): Promise<{ supported: boolean; reason?: string }> {
    try {
      await this.activate("lnk-memory capability probe", scope);
      return { supported: true };
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeSubscribe(scope?: MemoryScope): Promise<{ supported: boolean; reason?: string }> {
    try {
      const subscription = await withTimeout(this.subscribe({
        context: ["lnk-memory capability probe"],
        threshold: 1,
        ttlSeconds: 1,
        rateLimit: 1,
        pushOnWrite: false,
        scope,
      }, () => undefined), this.cfg.muninn.capabilityProbeTimeoutMs, "Muninn gRPC Subscribe probe");
      await subscription.close();
      return { supported: true };
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async probeCapabilities(): Promise<TransportCapability> {
    if (!this.cfg.muninn.enabled) {
      return {
        configured: false,
        available: false,
        operations: { health: false, activate: false, write: false, subscribe: false },
        reason: "Muninn disabled",
      };
    }
    if (!this.cfg.muninn.grpcTarget) {
      return {
        configured: false,
        available: false,
        operations: { health: false, activate: false, write: false, subscribe: false },
        reason: "gRPC target not configured",
      };
    }

    try {
      const hello = await this.hello();
      const activate = await this.probeActivate({ mode: "local" });
      const subscribe = await this.probeSubscribe({ mode: "local" });

      return {
        configured: true,
        available: true,
        operations: {
          health: true,
          activate: activate.supported,
          write: false,
          subscribe: subscribe.supported,
        },
        reason: activate.reason ?? subscribe.reason,
        details: {
          target: this.cfg.muninn.grpcTarget,
          codec: "json",
          tls: this.cfg.muninn.grpcTls,
          hello,
        },
      };
    } catch (error) {
      return {
        configured: true,
        available: false,
        operations: { health: false, activate: false, write: false, subscribe: false },
        reason: error instanceof Error ? error.message : String(error),
        details: {
          target: this.cfg.muninn.grpcTarget,
          codec: "json",
          tls: this.cfg.muninn.grpcTls,
        },
      };
    }
  }

  async rememberBatch(_memories: DurableMemoryWrite[], _scope?: MemoryScope): Promise<DurableWriteResult[]> {
    throw new Error("Muninn gRPC batch write scaffold is not enabled yet; use REST for durable writes");
  }

  async activate(query: string, scope?: MemoryScope): Promise<DurableActivateResult> {
    if (!query.trim()) {
      return { activations: [], confidence: 0, transport: "none" };
    }

    const client = await this.getClient();
    const stream = client.Activate({
      Vault: this.resolveVault(scope),
      Context: [query],
      Threshold: 0.2,
      MaxResults: this.cfg.muninn.recallMaxResults,
      IncludeWhy: true,
      MaxHops: 0,
    }, this.metadata());

    const responses = await withTimeout(new Promise<GrpcActivateResponse[]>((resolve, reject) => {
      const chunks: GrpcActivateResponse[] = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(chunks));
      stream.on("error", reject);
    }), 30_000, "Muninn gRPC Activate");

    const activations = responses.flatMap((response) => field<GrpcActivationItem[]>(response, "Activations", "activations") ?? []).map((item) => ({
      id: field<string>(item, "ID", "id") ?? "",
      concept: field<string>(item, "Concept", "concept") ?? "",
      content: field<string>(item, "Content", "content") ?? "",
      score: Number(field<number | string>(item, "Score", "score") ?? 0),
      why: field<string>(item, "Why", "why"),
      transport: "grpc" as const,
    }));
    const confidence = Math.max(0, Math.min(1, activations[0]?.score ?? 0));

    return {
      activations,
      confidence,
      transport: "grpc",
    };
  }

  async subscribe(
    request: DurableSubscribeRequest,
    onEvent: (event: NormalizedMemoryEvent) => void,
  ): Promise<DurableSubscription> {
    const client = await this.getClient();
    const stream = client.Subscribe(this.metadata());
    const seenActivationIds = new Set<string>();
    let closed = false;

    const emit = (push: GrpcActivationPush) => {
      const trigger = field<string>(push, "Trigger", "trigger");
      const activation = field<Record<string, unknown>>(push, "Activation", "activation") ?? {};
      const activationId = field<string>(activation, "ID", "id");
      if (activationId) seenActivationIds.add(activationId);
      onEvent({
        type: probeType(trigger),
        priority: probePriority(trigger),
        transport: "grpc",
        scope: request.scope,
        concept: field<string>(activation, "Concept", "concept"),
        content: field<string>(activation, "Content", "content"),
        receivedAt: toIsoFromUnixNanos(field<number | string>(push, "At", "at")),
        raw: push,
      });
    };

    const ready = withTimeout(new Promise<void>((resolve, reject) => {
      const onBootstrap = (push: GrpcActivationPush) => {
        emit(push);
        stream.off("data", onBootstrap);
        resolve();
      };

      stream.on("data", onBootstrap);
      stream.on("error", reject);
      stream.on("end", () => resolve());
    }), this.cfg.muninn.capabilityProbeTimeoutMs, "Muninn gRPC subscription bootstrap");

    stream.write({
      SubscriptionID: `lnk-memory-${Date.now()}`,
      Context: request.context,
      Threshold: request.threshold ?? 0.6,
      Vault: this.resolveVault(request.scope),
      TTL: request.ttlSeconds ?? 300,
      RateLimit: request.rateLimit ?? 20,
      PushOnWrite: request.pushOnWrite ?? true,
      DeltaThreshold: request.deltaThreshold ?? 0.05,
    });

    await ready;
    stream.on("data", emit);

    const pollIntervalMs = 5_000;
    const joinedContext = request.context.join("\n").trim();
    const interval = joinedContext
      ? setInterval(async () => {
          if (closed) return;
          try {
            const result = await this.activate(joinedContext, request.scope);
            for (const activation of result.activations.slice(0, 5)) {
              if (!activation.id || seenActivationIds.has(activation.id)) continue;
              seenActivationIds.add(activation.id);
              onEvent({
                type: "threshold_crossed",
                priority: "medium",
                transport: "grpc",
                scope: request.scope,
                concept: activation.concept,
                content: activation.content,
                receivedAt: new Date().toISOString(),
                raw: {
                  source: "activate-fallback",
                  activation,
                },
              });
            }
          } catch {
            // ignore refresh errors; the primary stream remains authoritative when it emits
          }
        }, pollIntervalMs)
      : null;

    return {
      close: async () => {
        closed = true;
        if (interval) clearInterval(interval);
        stream.end();
        stream.cancel();
      },
    };
  }
}
