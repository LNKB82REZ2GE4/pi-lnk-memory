import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MemoryBroker } from "../memory/broker.js";
import type { DurableMemoryWrite } from "../memory/contracts.js";
import { createChunkId } from "../storage/local-state.js";
import type { BackfillExtractedMemory, MemoryConfig } from "../types.js";
import { ensureGlobalMemoryFile, parseGlobalMemoryEntries, readGlobalMemoryRaw } from "../global-memory.js";

interface StoredBackfillReport {
  memories?: BackfillExtractedMemory[];
  samples?: BackfillExtractedMemory[];
  [key: string]: unknown;
}

export interface BackfillSyncPreviewItem {
  concept: string;
  typeLabel: string;
  sessionPath: string;
  entryIds: string[];
  toMuninn: boolean;
  toGlobal: boolean;
}

export interface BackfillSyncPlan {
  loaded: number;
  unique: number;
  muninnCandidates: BackfillExtractedMemory[];
  globalCandidates: BackfillExtractedMemory[];
  preview: BackfillSyncPreviewItem[];
}

export interface BackfillSyncResult {
  loaded: number;
  unique: number;
  muninnCandidates: number;
  muninnWritten: number;
  muninnErrors: number;
  globalCandidates: number;
  globalWritten: number;
  reportPath: string;
  preview: BackfillSyncPreviewItem[];
  errors: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function sessionTag(sessionPath: string): string {
  const base = path.basename(sessionPath, path.extname(sessionPath));
  return `source_session:${base.slice(0, 96)}`;
}

function entryTags(entryIds: string[]): string[] {
  return entryIds.slice(0, 3).map((id) => `source_entry:${id.slice(0, 40)}`);
}

function buildIdempotentId(memory: BackfillExtractedMemory): string {
  return createChunkId([
    "muninn-backfill",
    memory.sessionPath,
    memory.sourceWindowId,
    memory.concept,
    memory.content,
  ]);
}

function loadReport(cfg: MemoryConfig): BackfillExtractedMemory[] {
  if (!existsSync(cfg.backfillReportPath)) {
    throw new Error(`No backfill scan JSON found at ${cfg.backfillReportPath}; run /lnk-memory-backfill-scan first`);
  }

  const parsed = JSON.parse(readFileSync(cfg.backfillReportPath, "utf8")) as StoredBackfillReport;
  const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
  return memories.filter((item): item is BackfillExtractedMemory => {
    return Boolean(item && typeof item.concept === "string" && typeof item.content === "string");
  });
}

function dedupeMemories(memories: BackfillExtractedMemory[]): BackfillExtractedMemory[] {
  const map = new Map<string, BackfillExtractedMemory>();

  for (const memory of memories) {
    const key = `${normalize(memory.concept)}::${normalize(memory.content)}`;
    const prev = map.get(key);
    if (!prev || (memory.confidence ?? 0) >= (prev.confidence ?? 0)) {
      map.set(key, memory);
    }
  }

  return [...map.values()];
}

function globalExistingSet(cfg: MemoryConfig): Set<string> {
  const raw = readGlobalMemoryRaw(cfg.globalMemoryPath);
  const entries = parseGlobalMemoryEntries(raw, "manual");
  return new Set(entries.map((entry) => normalize(entry.text)));
}

function appendGlobalEntries(cfg: MemoryConfig, memories: BackfillExtractedMemory[]): number {
  const existing = globalExistingSet(cfg);
  ensureGlobalMemoryFile(cfg.globalMemoryPath);
  let written = 0;

  for (const memory of memories) {
    const text = (memory.globalMemoryText ?? "").trim();
    if (!text) continue;
    const key = normalize(text);
    if (!key || existing.has(key)) continue;

    const line = `- [${memory.timestamp}] ${text.replace(/\s+/g, " ")}\n`;
    appendFileSync(cfg.globalMemoryPath, line);
    existing.add(key);
    written += 1;
  }

  return written;
}

function toDurableWrite(memory: BackfillExtractedMemory): DurableMemoryWrite {
  const tags = [
    ...memory.tags,
    "source:pi-backfill",
    sessionTag(memory.sessionPath),
    ...entryTags(memory.sourceEntryIds),
  ].slice(0, 50);

  return {
    concept: memory.concept,
    content: memory.content,
    tags,
    confidence: memory.confidence,
    createdAt: memory.timestamp,
    typeLabel: memory.typeLabel,
    idempotentId: buildIdempotentId(memory),
    provenance: {
      source: "pi-backfill",
      sessionPath: memory.sessionPath,
      sourceWindowId: memory.sourceWindowId,
      sourceEntryIds: memory.sourceEntryIds,
    },
  };
}

export function prepareLatestBackfillSync(cfg: MemoryConfig): BackfillSyncPlan {
  const loaded = loadReport(cfg);
  const unique = dedupeMemories(loaded);

  const globalCandidates = unique.filter((memory) => memory.writeToGlobalMemory && (memory.globalMemoryText ?? "").trim().length > 0);
  const muninnCandidates = unique.filter((memory) => memory.writeToMuninn);

  return {
    loaded: loaded.length,
    unique: unique.length,
    muninnCandidates,
    globalCandidates,
    preview: unique.slice(0, 20).map((memory) => ({
      concept: memory.concept,
      typeLabel: memory.typeLabel,
      sessionPath: memory.sessionPath,
      entryIds: memory.sourceEntryIds,
      toMuninn: memory.writeToMuninn,
      toGlobal: memory.writeToGlobalMemory,
    })),
  };
}

export function formatBackfillSyncPlan(plan: BackfillSyncPlan): string {
  const lines = [
    "# LNK Memory Backfill Sync Review",
    "",
    `- Loaded memories: ${plan.loaded}`,
    `- Unique after dedupe: ${plan.unique}`,
    `- Will write to Muninn: ${plan.muninnCandidates.length}`,
    `- Will append to global memory: ${plan.globalCandidates.length}`,
    "",
    "## Preview",
    "",
  ];

  if (plan.preview.length === 0) {
    lines.push("_No memories available for sync._");
    return lines.join("\n");
  }

  plan.preview.forEach((item, index) => {
    lines.push(`### ${index + 1}. ${item.concept}`);
    lines.push(`- Type: ${item.typeLabel}`);
    lines.push(`- Muninn: ${item.toMuninn ? "yes" : "no"}`);
    lines.push(`- Global: ${item.toGlobal ? "yes" : "no"}`);
    lines.push(`- Session: ${item.sessionPath}`);
    lines.push(`- Entry IDs: ${item.entryIds.join(", ")}`);
    lines.push("");
  });

  return lines.join("\n");
}

export async function syncLatestBackfillPlan(
  cfg: MemoryConfig,
  broker: MemoryBroker,
  plan: BackfillSyncPlan,
  options?: { includeGlobal?: boolean },
): Promise<BackfillSyncResult> {
  const errors: string[] = [];
  const includeGlobal = options?.includeGlobal ?? false;

  let globalWritten = 0;
  if (includeGlobal) {
    try {
      globalWritten = appendGlobalEntries(cfg, plan.globalCandidates);
    } catch (error) {
      errors.push(`global memory sync: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let muninnWritten = 0;
  let muninnErrors = 0;
  if (plan.muninnCandidates.length > 0) {
    try {
      const result = await broker.rememberBatch(plan.muninnCandidates.map(toDurableWrite));
      muninnWritten = result.written;
      muninnErrors = result.failed;
      if (result.failed > 0) {
        const firstError = result.results.find((entry) => entry.status !== "ok" && entry.error)?.error;
        errors.push(`muninn sync: ${result.failed} durable writes failed${firstError ? ` (${firstError})` : ""}`);
      }
    } catch (error) {
      muninnErrors = plan.muninnCandidates.length;
      errors.push(`muninn sync: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const out: BackfillSyncResult = {
    loaded: plan.loaded,
    unique: plan.unique,
    muninnCandidates: plan.muninnCandidates.length,
    muninnWritten,
    muninnErrors,
    globalCandidates: includeGlobal ? plan.globalCandidates.length : 0,
    globalWritten,
    reportPath: cfg.backfillSyncReportPath,
    preview: plan.preview.slice(0, 12),
    errors,
  };

  writeFileSync(cfg.backfillSyncReportPath, JSON.stringify(out, null, 2));
  return out;
}

export function prepareGlobalReviewCandidates(cfg: MemoryConfig): Array<{ code: string; memory: BackfillExtractedMemory }> {
  const plan = prepareLatestBackfillSync(cfg);
  return plan.globalCandidates.map((memory, index) => ({
    code: `G${String(index + 1).padStart(3, "0")}`,
    memory,
  }));
}

export function formatGlobalReviewDocument(
  candidates: Array<{ code: string; memory: BackfillExtractedMemory }>,
): string {
  const lines = [
    "# LNK Memory Global Review",
    "",
    "Mark accepted items by changing `[ ]` to `[x]`, then close the editor.",
    "Only accepted items will be appended to memory.md.",
    "",
  ];

  if (candidates.length === 0) {
    lines.push("_No global-memory candidates available from the latest backfill scan._");
    return lines.join("\n");
  }

  for (const { code, memory } of candidates) {
    lines.push(`- [ ] ${code} | ${memory.concept}`);
    lines.push(`  type: ${memory.typeLabel}`);
    lines.push(`  session: ${memory.sessionPath}`);
    lines.push(`  entries: ${memory.sourceEntryIds.join(", ")}`);
    lines.push(`  text: ${(memory.globalMemoryText ?? memory.content).replace(/\s+/g, " ")}`);
    if (memory.why) lines.push(`  why: ${memory.why}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function parseApprovedGlobalReview(
  document: string,
  candidates: Array<{ code: string; memory: BackfillExtractedMemory }>,
): BackfillExtractedMemory[] {
  const approved = new Set<string>();
  for (const line of document.split(/\r?\n/)) {
    const match = line.match(/^-\s*\[(?<mark>[xX])\]\s*(?<code>G\d{3})\b/);
    if (match?.groups?.code) approved.add(match.groups.code);
  }
  return candidates.filter((item) => approved.has(item.code)).map((item) => item.memory);
}

export function applyApprovedGlobalMemories(cfg: MemoryConfig, memories: BackfillExtractedMemory[]): number {
  return appendGlobalEntries(cfg, memories);
}

export function formatBackfillSyncSummary(result: BackfillSyncResult): string {
  const lines = [
    `backfill sync: loaded=${result.loaded}, unique=${result.unique}, muninn=${result.muninnWritten}/${result.muninnCandidates}, global=${result.globalWritten}/${result.globalCandidates}, errors=${result.errors.length + result.muninnErrors}`,
    `report=${result.reportPath}`,
  ];

  if (result.preview.length > 0) {
    lines.push("preview:");
    result.preview.slice(0, 6).forEach((item, index) => {
      lines.push(`${index + 1}. [${item.typeLabel}] muninn=${item.toMuninn ? "y" : "n"} global=${item.toGlobal ? "y" : "n"} :: ${item.concept} | ${path.basename(item.sessionPath)} | entries=${item.entryIds.join(",")}`);
    });
  }

  if (result.errors.length > 0) {
    lines.push("errors:");
    result.errors.forEach((error) => lines.push(`- ${error}`));
  }

  return lines.join("\n");
}
