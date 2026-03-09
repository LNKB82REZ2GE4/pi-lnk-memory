import type { MemoryConfig } from "../types.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function parsePossiblyFencedJson(content: string): Record<string, unknown> {
  const trimmed = content.trim();

  const direct = () => JSON.parse(trimmed) as Record<string, unknown>;
  try {
    return direct();
  } catch {
    // continue to recovery paths
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate) as Record<string, unknown>;
  }

  return JSON.parse(trimmed) as Record<string, unknown>;
}

export class LocalLlmClient {
  private resolvedModel: string | null = null;

  constructor(private readonly cfg: MemoryConfig) {}

  private async request(path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.extraction.timeoutMs);

    try {
      const response = await fetch(`${this.cfg.extraction.baseUrl.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Local LLM ${path} failed (${response.status}): ${text}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;

    if (this.cfg.extraction.model !== "auto") {
      this.resolvedModel = this.cfg.extraction.model;
      return this.resolvedModel;
    }

    const json = await this.request("/v1/models");
    const data = Array.isArray(json?.data) ? json.data : [];
    const firstId = data.find((item: any) => typeof item?.id === "string")?.id;
    if (!firstId) throw new Error("No model found at local LLM /v1/models");

    this.resolvedModel = firstId;
    return firstId;
  }

  async chatJson(messages: ChatMessage[]): Promise<{ model: string; json: Record<string, unknown> }> {
    const model = await this.resolveModel();
    const payload = {
      model,
      temperature: 0,
      messages,
      response_format: { type: "json_object" },
    };

    const json = await this.request("/v1/chat/completions", payload);
    const choices = Array.isArray(json?.choices) ? json.choices : [];
    const content = choices[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Local LLM returned empty JSON response content");
    }

    const parsed = parsePossiblyFencedJson(content);
    return { model, json: parsed };
  }
}
