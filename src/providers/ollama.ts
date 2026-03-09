import type { MemoryConfig } from "../types.js";

export class OllamaEmbedClient {
  constructor(private readonly cfg: MemoryConfig) {}

  async embed(input: string[]): Promise<{ model: string; vectors: number[][] }> {
    const models = [this.cfg.ollama.model, ...this.cfg.ollama.fallbackModels].filter(Boolean);
    let lastError: Error | null = null;

    for (const model of models) {
      try {
        const result = await this.embedWithModel(model, input);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("No embedding model succeeded");
  }

  private async embedWithModel(model: string, input: string[]): Promise<{ model: string; vectors: number[][] }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.ollama.timeoutMs);

    try {
      const response = await fetch(`${this.cfg.ollama.baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input, truncate: true }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama embed failed (${response.status})`);
      }

      const json = (await response.json()) as { embeddings?: number[][] };
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== input.length) {
        throw new Error("Invalid embedding response from Ollama");
      }

      return { model, vectors: json.embeddings };
    } finally {
      clearTimeout(timeout);
    }
  }
}
