import { readFileSync } from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { parseGlobalMemoryEntries, readGlobalMemoryRaw } from "./global-memory.js";
import { hashText, createChunkId } from "./storage/local-state.js";
import type { GlobalMemoryEntry, MemoryChunk, MemoryConfig } from "./types.js";

function toIso(value: unknown): string {
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "number") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;

    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }

    if (rec.type === "toolCall") {
      const name = typeof rec.name === "string" ? rec.name : "tool";
      const args = rec.arguments ? JSON.stringify(rec.arguments) : "{}";
      parts.push(`[toolCall ${name} args=${args}]`);
      continue;
    }
  }

  return parts.join("\n");
}

function maybeSplitText(text: string, chunkChars: number, overlap: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= chunkChars) return [clean];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length) {
    const end = Math.min(clean.length, cursor + chunkChars);
    chunks.push(clean.slice(cursor, end));
    if (end >= clean.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

function recencyScore(timestamp: string, halfLifeDays: number): number {
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts)) return 0.2;

  const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  const lambda = Math.log(2) / Math.max(1, halfLifeDays);
  return Math.exp(-lambda * Math.max(0, ageDays));
}

function lineToChunkBase(
  cfg: MemoryConfig,
  sourcePath: string,
  entryId: string,
  entryType: string,
  sourceRole: string | undefined,
  timestamp: string,
  text: string,
  splitIndex: number,
  sourceKind: "session" | "global-memory",
  cwd?: string,
): MemoryChunk {
  const chunkId = createChunkId([
    sourceKind,
    sourcePath,
    entryId,
    entryType,
    sourceRole ?? "",
    String(splitIndex),
  ]);

  return {
    chunkId,
    sourceKind,
    sourcePath,
    sessionPath: sourceKind === "session" ? sourcePath : undefined,
    cwd,
    entryId,
    entryType,
    sourceRole,
    text,
    timestamp,
    recencyScore: recencyScore(timestamp, cfg.retrieval.recencyHalfLifeDays),
    contentHash: hashText(text),
    indexedAt: new Date().toISOString(),
    extensionVersion: cfg.extensionVersion,
  };
}

export async function listAllSessionPaths(): Promise<string[]> {
  const sessions = await SessionManager.listAll();
  return sessions.map((s) => s.path);
}

export function parseSessionFileChunks(
  cfg: MemoryConfig,
  sessionPath: string,
  cwdHint?: string,
): MemoryChunk[] {
  const raw = readFileSync(sessionPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const chunks: MemoryChunk[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = typeof obj.type === "string" ? obj.type : "unknown";

    // header line
    if (entryType === "session") continue;

    const entryId = typeof obj.id === "string" ? obj.id : `line-${i + 1}`;
    const timestamp = toIso(obj.timestamp);

    if (entryType === "custom_message") {
      const customType = typeof obj.customType === "string" ? obj.customType : "";
      if (customType.startsWith("lnk-memory")) continue;
      const txt = textFromContent(obj.content);
      const parts = maybeSplitText(txt, cfg.indexing.chunkChars, cfg.indexing.chunkOverlap);
      parts.forEach((part, idx) => {
        chunks.push(
          lineToChunkBase(
            cfg,
            sessionPath,
            entryId,
            entryType,
            customType || "custom",
            timestamp,
            part,
            idx,
            "session",
            cwdHint,
          ),
        );
      });
      continue;
    }

    if (entryType === "compaction" || entryType === "branch_summary") {
      const summary = typeof obj.summary === "string" ? obj.summary : "";
      const parts = maybeSplitText(summary, cfg.indexing.chunkChars, cfg.indexing.chunkOverlap);
      parts.forEach((part, idx) => {
        chunks.push(
          lineToChunkBase(
            cfg,
            sessionPath,
            entryId,
            entryType,
            "summary",
            timestamp,
            part,
            idx,
            "session",
            cwdHint,
          ),
        );
      });
      continue;
    }

    if (entryType !== "message") continue;

    const message = (obj.message ?? {}) as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "unknown";

    // Skip our own injected memory if persisted by any path
    if (role === "custom") {
      const customType = typeof message.customType === "string" ? message.customType : "";
      if (customType.startsWith("lnk-memory")) continue;
    }

    let text = textFromContent(message.content);

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
      const details = message.details ? JSON.stringify(message.details) : "";
      text = `[toolResult:${toolName}]\n${text}\n${details}`;
    } else if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      text = `[bash]\n${command}\n${output}`;
    }

    const parts = maybeSplitText(text, cfg.indexing.chunkChars, cfg.indexing.chunkOverlap);
    parts.forEach((part, idx) => {
      chunks.push(
        lineToChunkBase(
          cfg,
          sessionPath,
          entryId,
          entryType,
          role,
          timestamp,
          part,
          idx,
          "session",
          cwdHint,
        ),
      );
    });
  }

  return chunks;
}

function globalEntryToChunk(cfg: MemoryConfig, entry: GlobalMemoryEntry, idx: number): MemoryChunk {
  return lineToChunkBase(
    cfg,
    cfg.globalMemoryPath,
    `global-${idx}`,
    "global_memory",
    "global",
    toIso(entry.timestamp),
    entry.text,
    0,
    "global-memory",
    undefined,
  );
}

export function globalEntriesToChunks(cfg: MemoryConfig, entries: GlobalMemoryEntry[]): MemoryChunk[] {
  return entries.map((entry, idx) => globalEntryToChunk(cfg, entry, idx));
}

export function parseGlobalMemoryChunks(cfg: MemoryConfig): MemoryChunk[] {
  const raw = readGlobalMemoryRaw(cfg.globalMemoryPath);
  const entries = parseGlobalMemoryEntries(raw, "manual");
  return globalEntriesToChunks(cfg, entries);
}
