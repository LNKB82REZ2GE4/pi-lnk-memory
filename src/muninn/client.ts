import type { MemoryConfig } from "../types.js";
import type {
  DurableActivateResult,
  DurableMemoryAdapter,
  DurableMemoryWrite,
  DurableWriteResult,
  MemoryScope,
  TransportCapability,
} from "../memory/contracts.js";

export interface MuninnBatchResult {
  index: number;
  id?: string;
  status: string;
  error?: string;
}

export interface MuninnActivation {
  id: string;
  concept: string;
  content: string;
  score: number;
  tags?: string[];
  why?: string;
}

function truncate(text: string, max = 180): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class MuninnClient implements DurableMemoryAdapter {
  readonly kind = "rest" as const;

  constructor(private readonly cfg: MemoryConfig) {}

  private resolveVault(scope?: MemoryScope): string {
    return scope?.vault?.trim() || this.cfg.muninn.vault;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.muninn.apiKey) headers.Authorization = `Bearer ${this.cfg.muninn.apiKey}`;
    return headers;
  }

  private async request(path: string, init?: RequestInit, timeoutMs = 15_000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(`${this.cfg.muninn.restBaseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          ...this.headers(),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<boolean> {
    if (!this.cfg.muninn.enabled) return false;

    try {
      const response = await this.request("/api/health", { method: "GET" }, this.cfg.muninn.capabilityProbeTimeoutMs);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async probeSubscribe(): Promise<{ supported: boolean; reason?: string; details?: Record<string, unknown> }> {
    try {
      const url = new URL(`${this.cfg.muninn.restBaseUrl.replace(/\/$/, "")}/api/subscribe`);
      url.searchParams.set("vault", this.cfg.muninn.vault);
      url.searchParams.set("context", "lnk-memory capability probe");
      url.searchParams.set("threshold", "1");
      url.searchParams.set("push_on_write", "false");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.cfg.muninn.capabilityProbeTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: this.headers(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (response.ok) {
        if (contentType.includes("text/event-stream")) {
          await response.body?.cancel().catch(() => undefined);
          return {
            supported: true,
            details: {
              status: response.status,
              contentType,
            },
          };
        }

        const body = truncate(await response.text());
        return {
          supported: true,
          reason: body || `HTTP ${response.status}`,
          details: {
            status: response.status,
            contentType,
          },
        };
      }

      const body = truncate(await response.text());
      if (/streaming not supported/i.test(body)) {
        return {
          supported: false,
          reason: "runtime reported streaming not supported",
          details: {
            status: response.status,
            body,
          },
        };
      }

      return {
        supported: false,
        reason: `HTTP ${response.status}: ${body || response.statusText}`,
        details: {
          status: response.status,
          body,
        },
      };
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
        operations: {
          health: false,
          activate: false,
          write: false,
          subscribe: false,
        },
        reason: "Muninn disabled",
      };
    }

    const healthy = await this.health();
    const subscribe = healthy ? await this.probeSubscribe() : { supported: false, reason: "health check failed" };

    return {
      configured: true,
      available: healthy,
      operations: {
        health: healthy,
        activate: healthy,
        write: healthy,
        subscribe: healthy && subscribe.supported,
      },
      reason: healthy ? subscribe.reason : "Muninn REST health check failed",
      details: {
        baseUrl: this.cfg.muninn.restBaseUrl,
        vault: this.cfg.muninn.vault,
        subscribe: subscribe.details,
      },
    };
  }

  async rememberBatch(memories: DurableMemoryWrite[], scope?: MemoryScope): Promise<DurableWriteResult[]> {
    if (!this.cfg.muninn.enabled) throw new Error("Muninn is disabled in config");
    if (memories.length === 0) return [];

    const payload = {
      engrams: memories.map((memory) => ({
        concept: memory.concept,
        content: memory.content,
        tags: memory.tags,
        confidence: memory.confidence,
        created_at: memory.createdAt,
        type_label: memory.typeLabel,
        idempotent_id: memory.idempotentId,
        vault: this.resolveVault(scope),
      })),
    };

    const response = await this.request(
      "/api/engrams/batch",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      30_000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Muninn batch write failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { results?: MuninnBatchResult[] };
    const results = Array.isArray(json.results) ? json.results : [];
    return results.map((result, index) => ({
      index: result.index ?? index,
      id: result.id,
      status: result.status === "ok" ? "ok" : "error",
      error: result.error,
      transport: "rest",
    }));
  }

  async activate(query: string, scope?: MemoryScope): Promise<DurableActivateResult> {
    if (!this.cfg.muninn.enabled || !query.trim()) {
      return { activations: [], confidence: 0, transport: "none" };
    }

    const payload = {
      vault: this.resolveVault(scope),
      context: [query],
      max_results: this.cfg.muninn.recallMaxResults,
      threshold: 0.2,
      brief_mode: "",
      include_why: true,
    };

    const response = await this.request(
      "/api/activate",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      30_000,
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Muninn activate failed (${response.status}): ${text}`);
    }

    const json = (await response.json()) as { activations?: MuninnActivation[] };
    const activations = Array.isArray(json.activations) ? json.activations : [];
    const confidence = Math.max(0, Math.min(1, activations[0]?.score ?? 0));
    return {
      activations: activations.map((activation) => ({
        ...activation,
        transport: "rest",
      })),
      confidence,
      transport: "rest",
    };
  }
}
