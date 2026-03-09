import { existsSync, readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import type { LocalIndexState, MemoryChunk, SessionIndexRecord } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function hashText(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function createChunkId(parts: string[]): string {
  return hashText(parts.join("::"));
}

export function emptyState(): LocalIndexState {
  return {
    version: 1,
    updatedAt: nowIso(),
    chunks: {},
    sessions: {},
    totalBytes: 0,
  };
}

export function loadState(path: string): LocalIndexState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LocalIndexState;
    if (!parsed || parsed.version !== 1) return emptyState();
    parsed.chunks ||= {};
    parsed.sessions ||= {};
    parsed.totalBytes ||= 0;
    return parsed;
  } catch {
    return emptyState();
  }
}

export function saveState(path: string, state: LocalIndexState): void {
  state.updatedAt = nowIso();
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function upsertChunks(
  state: LocalIndexState,
  session: SessionIndexRecord,
  chunks: MemoryChunk[],
): { added: number; updated: number; removed: number; removedIds: string[]; upsertedIds: string[] } {
  const previousIds = new Set(state.sessions[session.path]?.chunkIds ?? []);
  const nextIds = new Set(chunks.map((c) => c.chunkId));

  let added = 0;
  let updated = 0;
  const upsertedIds: string[] = [];

  for (const chunk of chunks) {
    const prev = state.chunks[chunk.chunkId];
    if (!prev) {
      state.chunks[chunk.chunkId] = chunk;
      state.totalBytes += Buffer.byteLength(chunk.text, "utf8");
      added += 1;
      upsertedIds.push(chunk.chunkId);
      continue;
    }

    if (prev.contentHash !== chunk.contentHash) {
      state.totalBytes -= Buffer.byteLength(prev.text, "utf8");
      state.totalBytes += Buffer.byteLength(chunk.text, "utf8");
      state.chunks[chunk.chunkId] = chunk;
      updated += 1;
      upsertedIds.push(chunk.chunkId);
    }
  }

  const removedIds: string[] = [];
  for (const oldId of previousIds) {
    if (nextIds.has(oldId)) continue;
    const old = state.chunks[oldId];
    if (old) {
      state.totalBytes -= Buffer.byteLength(old.text, "utf8");
      delete state.chunks[oldId];
      removedIds.push(oldId);
    }
  }

  state.sessions[session.path] = {
    ...session,
    chunkIds: [...nextIds],
  };

  return { added, updated, removed: removedIds.length, removedIds, upsertedIds };
}

export function removeChunks(state: LocalIndexState, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;

  const toRemove = new Set(chunkIds);

  for (const chunkId of toRemove) {
    const old = state.chunks[chunkId];
    if (!old) continue;
    state.totalBytes -= Buffer.byteLength(old.text, "utf8");
    delete state.chunks[chunkId];
  }

  for (const session of Object.values(state.sessions)) {
    session.chunkIds = session.chunkIds.filter((id) => !toRemove.has(id));
  }
}
