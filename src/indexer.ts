import { statSync } from "node:fs";
import { parseGlobalMemoryEntries, readGlobalMemoryRaw } from "./global-memory.js";
import { reconcileGlobalMemory } from "./global-memory-dedupe.js";
import { globalEntriesToChunks, listAllSessionPaths, parseSessionFileChunks } from "./session-source.js";
import { loadState, removeChunks, saveState, upsertChunks } from "./storage/local-state.js";
import type { LocalIndexState, MemoryChunk, MemoryConfig, SessionIndexRecord } from "./types.js";
import { OllamaEmbedClient } from "./providers/ollama.js";
import { QdrantClient } from "./providers/qdrant.js";

const EMBED_BATCH = 64;

export interface IndexRunResult {
  sessionsScanned: number;
  sessionsUpdated: number;
  chunksAdded: number;
  chunksUpdated: number;
  chunksRemoved: number;
  pruned: number;
  errors: string[];
}

export class MemoryIndexer {
  private state: LocalIndexState;

  constructor(
    private readonly cfg: MemoryConfig,
    private readonly ollama: OllamaEmbedClient,
    private readonly qdrant: QdrantClient,
  ) {
    this.state = loadState(cfg.statePath);
  }

  getState(): LocalIndexState {
    return this.state;
  }

  async runIncremental(targetSessionPaths?: string[]): Promise<IndexRunResult> {
    const result: IndexRunResult = {
      sessionsScanned: 0,
      sessionsUpdated: 0,
      chunksAdded: 0,
      chunksUpdated: 0,
      chunksRemoved: 0,
      pruned: 0,
      errors: [],
    };

    const paths = targetSessionPaths && targetSessionPaths.length > 0
      ? targetSessionPaths
      : await listAllSessionPaths();

    for (const sessionPath of paths) {
      result.sessionsScanned += 1;
      try {
        const stat = statSync(sessionPath);
        const prev = this.state.sessions[sessionPath];

        if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
          continue;
        }

        const chunks = parseSessionFileChunks(this.cfg, sessionPath);

        const record: SessionIndexRecord = {
          path: sessionPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          chunkIds: [],
          indexedAt: new Date().toISOString(),
        };

        const delta = upsertChunks(this.state, record, chunks);
        result.sessionsUpdated += 1;
        result.chunksAdded += delta.added;
        result.chunksUpdated += delta.updated;
        result.chunksRemoved += delta.removed;

        if (delta.upsertedIds.length > 0) {
          await this.upsertChunkVectors(delta.upsertedIds.map((id) => this.state.chunks[id]).filter(Boolean));
        }
        if (delta.removedIds.length > 0) {
          await this.qdrant.deletePoints(delta.removedIds);
        }
      } catch (error) {
        result.errors.push(`session ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await this.refreshGlobalMemory();
    } catch (error) {
      result.errors.push(`global-memory: ${error instanceof Error ? error.message : String(error)}`);
    }

    const prunedIds = await this.enforceDiskCap();
    if (prunedIds.length > 0) {
      result.pruned = prunedIds.length;
      result.chunksRemoved += prunedIds.length;
    }

    saveState(this.cfg.statePath, this.state);
    return result;
  }

  async runFullReindex(): Promise<IndexRunResult> {
    const existingIds = Object.keys(this.state.chunks);
    if (existingIds.length > 0) {
      await this.qdrant.deletePoints(existingIds);
    }

    this.state.chunks = {};
    this.state.sessions = {};
    this.state.totalBytes = 0;
    return this.runIncremental();
  }

  async refreshGlobalOnly(): Promise<void> {
    await this.refreshGlobalMemory();
    await this.enforceDiskCap();
    saveState(this.cfg.statePath, this.state);
  }

  async runGlobalDedupe(): Promise<void> {
    await this.refreshGlobalOnly();
  }

  private async refreshGlobalMemory(): Promise<void> {
    const raw = readGlobalMemoryRaw(this.cfg.globalMemoryPath);
    const entries = parseGlobalMemoryEntries(raw, "manual");
    const resolved = await reconcileGlobalMemory(this.cfg, entries);

    const prefix = "global::";
    const existingGlobal = Object.keys(this.state.chunks).filter((id) => id.startsWith(prefix));
    if (existingGlobal.length > 0) {
      removeChunks(this.state, existingGlobal);
      await this.qdrant.deletePoints(existingGlobal);
    }

    const chunks = globalEntriesToChunks(this.cfg, resolved.entries).map((chunk, idx) => ({
      ...chunk,
      chunkId: `${prefix}${idx}-${chunk.chunkId}`,
    }));

    for (const chunk of chunks) {
      this.state.chunks[chunk.chunkId] = chunk;
      this.state.totalBytes += Buffer.byteLength(chunk.text, "utf8");
    }

    await this.upsertChunkVectors(chunks);
    this.state.lastDedupeAt = new Date().toISOString();
  }

  private async upsertChunkVectors(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const vectors: Array<{ chunk: MemoryChunk; vector: number[] }> = [];

    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const embed = await this.ollama.embed(batch.map((c) => c.text));

      for (let j = 0; j < batch.length; j += 1) {
        vectors.push({ chunk: batch[j], vector: embed.vectors[j] });
      }

      if (vectors.length > 0) {
        await this.qdrant.ensureCollection(vectors[0].vector.length);
      }
    }

    await this.qdrant.upsert(
      vectors.map(({ chunk, vector }) => ({
        id: chunk.chunkId,
        vector,
        payload: {
          chunkId: chunk.chunkId,
          sourceKind: chunk.sourceKind,
          sourcePath: chunk.sourcePath,
          timestamp: chunk.timestamp,
          recencyScore: chunk.recencyScore,
          entryType: chunk.entryType,
          sourceRole: chunk.sourceRole,
          textPreview: chunk.text.slice(0, 240),
        },
      })),
    );
  }

  async enforceDiskCap(): Promise<string[]> {
    if (this.state.totalBytes <= this.cfg.indexing.diskCapBytes) return [];

    const chunks = Object.values(this.state.chunks).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const removed: string[] = [];

    for (const chunk of chunks) {
      if (this.state.totalBytes <= this.cfg.indexing.diskCapBytes) break;
      removed.push(chunk.chunkId);
      this.state.totalBytes -= Buffer.byteLength(chunk.text, "utf8");
      delete this.state.chunks[chunk.chunkId];
    }

    if (removed.length > 0) {
      for (const session of Object.values(this.state.sessions)) {
        session.chunkIds = session.chunkIds.filter((id) => !removed.includes(id));
      }
      await this.qdrant.deletePoints(removed);
    }

    return removed;
  }
}
