import crypto from "node:crypto";
import type { MemoryConfig, QdrantPoint } from "../types.js";

interface SearchHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

function stableUuidFromId(id: string): string {
  const hex = crypto.createHash("sha1").update(id).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class QdrantClient {
  constructor(private readonly cfg: MemoryConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.qdrant.apiKey) headers["api-key"] = this.cfg.qdrant.apiKey;
    return headers;
  }

  private async request(
    method: string,
    urlPath: string,
    body?: unknown,
    allow404 = false,
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.qdrant.timeoutMs);

    try {
      const response = await fetch(`${this.cfg.qdrant.baseUrl.replace(/\/$/, "")}${urlPath}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (allow404 && response.status === 404) return null;
        const text = await response.text();
        throw new Error(`Qdrant ${method} ${urlPath} failed (${response.status}): ${text}`);
      }

      return response.status === 204 ? null : response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async ensureCollection(vectorSize: number): Promise<void> {
    const collection = this.cfg.qdrant.collection;
    const existing = await this.request("GET", `/collections/${collection}`, undefined, true);
    if (existing) return;

    await this.request("PUT", `/collections/${collection}`, {
      vectors: {
        size: vectorSize,
        distance: this.cfg.qdrant.distance,
      },
    });
  }

  async upsert(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;

    const normalized = points.map((point) => ({
      ...point,
      id: stableUuidFromId(point.id),
    }));

    await this.request("PUT", `/collections/${this.cfg.qdrant.collection}/points`, {
      points: normalized,
      wait: true,
    });
  }

  async deletePoints(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request("POST", `/collections/${this.cfg.qdrant.collection}/points/delete`, {
      points: ids.map(stableUuidFromId),
      wait: true,
    });
  }

  async search(vector: number[], limit: number): Promise<SearchHit[]> {
    const result = await this.request("POST", `/collections/${this.cfg.qdrant.collection}/points/search`, {
      vector,
      limit,
      with_payload: true,
      with_vector: false,
    });

    const out = (result?.result ?? []) as Array<Record<string, unknown>>;
    return out
      .map((item) => {
        const payload = (item.payload as Record<string, unknown>) || undefined;
        const payloadChunkId = typeof payload?.chunkId === "string" ? payload.chunkId : undefined;
        return {
          id: payloadChunkId ?? String(item.id),
          score: typeof item.score === "number" ? item.score : 0,
          payload,
        };
      })
      .filter((hit) => hit.id);
  }

  async health(): Promise<boolean> {
    try {
      await this.request("GET", "/collections", undefined, false);
      return true;
    } catch {
      return false;
    }
  }
}
