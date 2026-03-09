import { readFileSync, writeFileSync } from "node:fs";
import { listAllSessionPaths } from "../session-source.js";
import { createChunkId } from "../storage/local-state.js";
import type {
  BackfillCandidateWindow,
  BackfillExtractedMemory,
  BackfillScanReport,
  BackfillSessionSummary,
  MemoryConfig,
} from "../types.js";
import { LocalLlmClient } from "../providers/local-llm.js";

interface SessionTextEntry {
  entryId: string;
  timestamp: string;
  role: string;
  sourceType: "message" | "branch_summary" | "compaction";
  text: string;
}

const HEURISTICS: Array<{ tag: string; score: number; pattern: RegExp }> = [
  {
    tag: "preference",
    score: 3.2,
    pattern: /\b(i prefer|prefer to|please use|always use|never use|do not use|don't use|keep responses|be concise|be brief|be verbose|2-space|two-space|indentation|tabs)\b/i,
  },
  {
    tag: "decision",
    score: 3.1,
    pattern: /\b(we decided|decision|we chose|go with|standardize on|default to|the approach is|we will use|settled on)\b/i,
  },
  {
    tag: "issue",
    score: 2.8,
    pattern: /\b(root cause|caused by|bug was|issue was|problem was|resolved by|fixed by|workaround|double-charge|incident)\b/i,
  },
  {
    tag: "procedure",
    score: 2.5,
    pattern: /\b(workflow|procedure|steps?:|run this|first[, ]|then[, ]|finally[, ]|to do this|the command is)\b/i,
  },
  {
    tag: "identity",
    score: 2.2,
    pattern: /\b(i use|my setup|my machine|my workflow|local llm|ollama|qdrant|muninn|pi plugin|working directory)\b/i,
  },
  {
    tag: "constraint",
    score: 2.2,
    pattern: /\b(must|should not|cannot|can't|need to avoid|budget|limit|constraint|required)\b/i,
  },
];

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
    }
  }
  return parts.join("\n");
}

function cleanText(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…`;
}

function heuristicScore(
  text: string,
  sourceType: BackfillCandidateWindow["sourceType"],
  timestamp: string,
): { score: number; tags: string[] } {
  let score = 0;
  const tags: string[] = [];

  for (const rule of HEURISTICS) {
    if (!rule.pattern.test(text)) continue;
    score += rule.score;
    tags.push(rule.tag);
  }

  if (sourceType === "branch_summary" || sourceType === "compaction") score += 0.9;

  const len = text.length;
  if (len >= 120 && len <= 1200) score += 0.4;
  if (len > 1200) score -= 0.25;

  const ageMs = Math.max(0, Date.now() - Date.parse(timestamp));
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (Number.isFinite(ageDays)) {
    if (ageDays < 30) score += 0.35;
    else if (ageDays < 180) score += 0.15;
  }

  return { score, tags: [...new Set(tags)] };
}

function parseEntries(cfg: MemoryConfig, sessionPath: string): SessionTextEntry[] {
  const raw = readFileSync(sessionPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const entries: SessionTextEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = typeof obj.type === "string" ? obj.type : "unknown";
    const entryId = typeof obj.id === "string" ? obj.id : `line-${i + 1}`;
    const timestamp = toIso(obj.timestamp);

    if (entryType === "branch_summary" && cfg.extraction.backfill.includeBranchSummaries) {
      const summary = cleanText(typeof obj.summary === "string" ? obj.summary : "", cfg.extraction.backfill.maxWindowChars);
      if (summary) entries.push({ entryId, timestamp, role: "summary", sourceType: "branch_summary", text: summary });
      continue;
    }

    if (entryType === "compaction" && cfg.extraction.backfill.includeCompactions) {
      const summary = cleanText(typeof obj.summary === "string" ? obj.summary : "", cfg.extraction.backfill.maxWindowChars);
      if (summary) entries.push({ entryId, timestamp, role: "summary", sourceType: "compaction", text: summary });
      continue;
    }

    if (entryType !== "message") continue;

    const message = (obj.message ?? {}) as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "unknown";

    if (role === "toolResult" && cfg.extraction.backfill.excludeToolResults) continue;
    if (role === "bashExecution" && cfg.extraction.backfill.excludeBash) continue;
    if (!["user", "assistant"].includes(role)) continue;

    const text = cleanText(textFromContent(message.content), cfg.extraction.backfill.maxWindowChars);
    if (!text) continue;

    entries.push({
      entryId,
      timestamp,
      role,
      sourceType: "message",
      text,
    });
  }

  return entries;
}

export function scanSessionFileForBackfill(cfg: MemoryConfig, sessionPath: string): BackfillCandidateWindow[] {
  const entries = parseEntries(cfg, sessionPath);
  const windows: BackfillCandidateWindow[] = [];
  const seen = new Set<string>();
  let pendingUser: SessionTextEntry | null = null;

  const pushWindow = (
    sourceType: BackfillCandidateWindow["sourceType"],
    roleHint: string,
    timestamp: string,
    text: string,
    entryIds: string[],
  ) => {
    const { score, tags } = heuristicScore(text, sourceType, timestamp);
    if (score < cfg.extraction.backfill.minHeuristicScore) return;

    const id = createChunkId(["backfill", sessionPath, timestamp, sourceType, roleHint, text]);
    if (seen.has(id)) return;
    seen.add(id);

    windows.push({
      id,
      sessionPath,
      timestamp,
      sourceType,
      roleHint,
      heuristicScore: score,
      heuristicTags: tags,
      entryIds,
      text,
    });
  };

  for (const entry of entries) {
    if (entry.sourceType === "branch_summary" || entry.sourceType === "compaction") {
      pushWindow(entry.sourceType, entry.role, entry.timestamp, entry.text, [entry.entryId]);
      pendingUser = null;
      continue;
    }

    if (entry.role === "user") {
      pendingUser = entry;
      pushWindow("message", "user", entry.timestamp, `User: ${entry.text}`, [entry.entryId]);
      continue;
    }

    if (entry.role === "assistant") {
      pushWindow("message", "assistant", entry.timestamp, `Assistant: ${entry.text}`, [entry.entryId]);

      if (pendingUser) {
        const combined = cleanText(
          `User (${pendingUser.timestamp}): ${pendingUser.text}\n\nAssistant (${entry.timestamp}): ${entry.text}`,
          cfg.extraction.backfill.maxWindowChars,
        );
        pushWindow("exchange", "user+assistant", entry.timestamp, combined, [pendingUser.entryId, entry.entryId]);
        pendingUser = null;
      }
    }
  }

  return windows.sort((a, b) => {
    if (b.heuristicScore !== a.heuristicScore) return b.heuristicScore - a.heuristicScore;
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
  });
}

function chunkArray<T>(input: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < input.length; i += size) out.push(input.slice(i, i + size));
  return out;
}

function clamp01(value: unknown, fallback = 0.5): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeForPolicy(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTypeLabel(typeLabel: string): string {
  return typeLabel.toLowerCase().replace(/[_\s]+/g, "-").trim();
}

function sanitizeConcept(concept: string): string {
  const trimmed = concept.trim();
  if (/^[a-z0-9_]+$/.test(trimmed) && trimmed.includes("_")) {
    return trimmed.replace(/_/g, " ");
  }
  return trimmed;
}

function isStableGlobalMemory(memory: BackfillExtractedMemory): boolean {
  const type = normalizeTypeLabel(memory.typeLabel);
  const text = normalizeForPolicy(`${memory.globalMemoryText ?? ""} ${memory.content}`);

  if (!text) return false;
  if (/(bug|fix|issue|regression|rollback|commit|debug|validation|test session|backfill|sync report)/.test(text)) return false;
  if (/(if you want|we should|next step|plan to|could|might|let s|let us|review mode)/.test(text)) return false;

  const stablePattern = /(i prefer|prefer |always |never |please |response style|be concise|be brief|be verbose|my setup|my machine|my workflow|workspace write|on request|local llm|ollama|qdrant|working directory|default to|authoritative workflow|promotion workflow|recovery procedure)/;
  const allowedTypes = new Set(["preference", "identity", "constraint", "environment", "workflow", "procedure", "configuration"]);

  return allowedTypes.has(type) || stablePattern.test(text);
}

function isDurableMuninnMemory(memory: BackfillExtractedMemory): boolean {
  const type = normalizeTypeLabel(memory.typeLabel);
  const text = normalizeForPolicy(`${memory.concept} ${memory.content}`);
  const blockedTypes = new Set(["user-intent", "validation", "session-note", "planning-note"]);

  if (memory.confidence < 0.68) return false;
  if (memory.content.trim().length < 40) return false;
  if (blockedTypes.has(type)) return false;
  if (/(if you want|we should|next step|plan to|todo|to do|could consider|might consider)/.test(text)) return false;
  if (/(current conversation|this session only|save plan as)/.test(text)) return false;

  return true;
}

function applyStoragePolicy(memory: BackfillExtractedMemory): BackfillExtractedMemory {
  const next: BackfillExtractedMemory = {
    ...memory,
    concept: sanitizeConcept(memory.concept),
    tags: [...new Set(memory.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 12),
  };

  next.writeToGlobalMemory = next.writeToGlobalMemory && isStableGlobalMemory(next);
  if (!next.writeToGlobalMemory) next.globalMemoryText = undefined;

  next.writeToMuninn = next.writeToMuninn && isDurableMuninnMemory(next);
  return next;
}

function toMarkdown(report: BackfillScanReport): string {
  const lines: string[] = [
    "# LNK Memory Backfill Scan",
    "",
    `- Generated: ${report.generatedAt}`,
    `- LLM model: ${report.llmModel}`,
    `- Sessions scanned: ${report.sessionCount}`,
    `- Candidate windows: ${report.totalCandidateWindows}`,
    `- Selected windows: ${report.selectedWindowCount}`,
    `- Extracted memories: ${report.extractedCount}`,
    `- Errors: ${report.errors.length}`,
    "",
    "## Session Summary",
    "",
  ];

  for (const session of report.sessions.slice(0, 20)) {
    lines.push(`- ${session.sessionPath}: candidates=${session.candidateWindows}, selected=${session.selectedWindows}`);
  }

  lines.push("", "## Sample Extracted Memories", "");

  if (report.samples.length === 0) {
    lines.push("_No extracted memories in this dry run._");
  } else {
    report.samples.forEach((sample, index) => {
      lines.push(`### ${index + 1}. ${sample.concept}`);
      lines.push(`- Type: ${sample.typeLabel}`);
      lines.push(`- Confidence: ${sample.confidence.toFixed(2)}`);
      lines.push(`- Muninn: ${sample.writeToMuninn ? "yes" : "no"}`);
      lines.push(`- Global memory: ${sample.writeToGlobalMemory ? "yes" : "no"}`);
      lines.push(`- Session: ${sample.sessionPath}`);
      lines.push(`- Entry IDs: ${sample.sourceEntryIds.join(", ") || "(none)"}`);
      lines.push(`- Timestamp: ${sample.timestamp}`);
      lines.push(`- Tags: ${sample.tags.join(", ") || "(none)"}`);
      if (sample.why) lines.push(`- Why: ${sample.why}`);
      lines.push("", sample.content, "");
      if (sample.globalMemoryText) {
        lines.push(`Global memory text: ${sample.globalMemoryText}`, "");
      }
    });
  }

  if (report.errors.length > 0) {
    lines.push("## Errors", "");
    report.errors.forEach((error) => lines.push(`- ${error}`));
  }

  return lines.join("\n");
}

async function extractBatch(
  cfg: MemoryConfig,
  client: LocalLlmClient,
  windows: BackfillCandidateWindow[],
): Promise<{ model: string; memories: BackfillExtractedMemory[] }> {
  const system = [
    "You extract durable high-signal memories from Pi coding-agent session history.",
    "Ignore tool chatter, bash output, serialized arguments, UI/harness chatter, and transient debugging noise.",
    "Return only durable facts, decisions, preferences, issues, procedures, constraints, goals, or identity/profile items.",
    "Do NOT create memories about the planning conversation itself unless it establishes a durable workflow, stable preference, or environment fact.",
    "Each memory must be atomic and useful in a future session.",
    "Use short human-readable concept names; avoid snake_case placeholders unless the source itself is a canonical identifier.",
    "Set writeToGlobalMemory=true ONLY for stable user preferences, identity/profile, environment defaults, or assistant-behavior instructions.",
    "Do NOT send bugs, commit references, regression notes, or temporary plans to global memory.",
    "Return strict JSON object: {\"memories\": [{...}]}.",
    "Each memory object must include:",
    "sourceWindowId, concept, content, typeLabel, tags, confidence, writeToMuninn, writeToGlobalMemory, globalMemoryText, why",
    `Do not return more than ${cfg.extraction.backfill.maxMemoriesPerWindow} memories per source window.`,
  ].join(" ");

  const user = JSON.stringify({
    windows: windows.map((window) => ({
      id: window.id,
      sessionPath: window.sessionPath,
      timestamp: window.timestamp,
      sourceType: window.sourceType,
      heuristicScore: window.heuristicScore,
      heuristicTags: window.heuristicTags,
      entryIds: window.entryIds,
      text: window.text,
    })),
  });

  const response = await client.chatJson([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);

  const byWindow = new Map(windows.map((window) => [window.id, window]));
  const rawMemories = Array.isArray(response.json.memories) ? response.json.memories : [];
  const dedupe = new Set<string>();
  const memories: BackfillExtractedMemory[] = [];

  for (const raw of rawMemories) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const sourceWindowId = typeof rec.sourceWindowId === "string"
      ? rec.sourceWindowId
      : typeof rec.source_window_id === "string"
        ? rec.source_window_id
        : "";
    if (!sourceWindowId) continue;

    const source = byWindow.get(sourceWindowId);
    if (!source) continue;

    const concept = typeof rec.concept === "string" ? rec.concept.trim() : "";
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (!concept || !content) continue;

    const dedupeKey = `${concept.toLowerCase()}::${content.toLowerCase()}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    memories.push(applyStoragePolicy({
      sourceWindowId,
      sourceEntryIds: source.entryIds,
      sessionPath: source.sessionPath,
      timestamp: source.timestamp,
      concept,
      content,
      typeLabel: typeof rec.typeLabel === "string"
        ? rec.typeLabel.trim()
        : typeof rec.type_label === "string"
          ? rec.type_label.trim()
          : "observation",
      tags: normalizeStringArray(rec.tags),
      confidence: clamp01(rec.confidence, 0.55),
      writeToMuninn: typeof rec.writeToMuninn === "boolean"
        ? rec.writeToMuninn
        : typeof rec.write_to_muninn === "boolean"
          ? rec.write_to_muninn
          : true,
      writeToGlobalMemory: typeof rec.writeToGlobalMemory === "boolean"
        ? rec.writeToGlobalMemory
        : typeof rec.write_to_global_memory === "boolean"
          ? rec.write_to_global_memory
          : false,
      globalMemoryText: typeof rec.globalMemoryText === "string"
        ? rec.globalMemoryText.trim()
        : typeof rec.global_memory_text === "string"
          ? rec.global_memory_text.trim()
          : undefined,
      why: typeof rec.why === "string" ? rec.why.trim() : undefined,
    }));
  }

  return { model: response.model, memories };
}

export async function runBackfillScan(
  cfg: MemoryConfig,
  targetSessionPaths?: string[],
): Promise<BackfillScanReport> {
  const paths = targetSessionPaths && targetSessionPaths.length > 0
    ? targetSessionPaths
    : await listAllSessionPaths();

  const sessions: BackfillSessionSummary[] = [];
  const errors: string[] = [];
  const allWindows: BackfillCandidateWindow[] = [];
  const allSelected: BackfillCandidateWindow[] = [];
  const extracted: BackfillExtractedMemory[] = [];
  let llmModel = "not-run";
  const client = cfg.extraction.enabled ? new LocalLlmClient(cfg) : null;

  for (const sessionPath of paths) {
    try {
      const windows = scanSessionFileForBackfill(cfg, sessionPath);
      const selected = windows
        .sort((a, b) => {
          if (b.heuristicScore !== a.heuristicScore) return b.heuristicScore - a.heuristicScore;
          return Date.parse(b.timestamp) - Date.parse(a.timestamp);
        })
        .slice(0, cfg.extraction.backfill.maxCandidateWindows);

      sessions.push({
        sessionPath,
        candidateWindows: windows.length,
        selectedWindows: selected.length,
      });
      allWindows.push(...windows);
      allSelected.push(...selected);

      if (!client || selected.length === 0) continue;

      const batches = chunkArray(selected, Math.max(1, cfg.extraction.batchSize));
      for (const batch of batches) {
        try {
          const result = await extractBatch(cfg, client, batch);
          llmModel = result.model;
          extracted.push(...result.memories);
        } catch (error) {
          errors.push(`extract batch session=${sessionPath} start=${batch[0]?.id ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);

          if (batch.length > 1) {
            for (const window of batch) {
              try {
                const single = await extractBatch(cfg, client, [window]);
                llmModel = single.model;
                extracted.push(...single.memories);
              } catch (singleError) {
                errors.push(`extract single session=${sessionPath} window=${window.id}: ${singleError instanceof Error ? singleError.message : String(singleError)}`);
              }
            }
          }
        }
      }
    } catch (error) {
      errors.push(`session ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const samples = extracted
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, cfg.extraction.backfill.sampleLimit);

  const report: BackfillScanReport = {
    generatedAt: new Date().toISOString(),
    llmModel,
    sessionCount: paths.length,
    totalCandidateWindows: allWindows.length,
    selectedWindowCount: allSelected.length,
    extractedCount: extracted.length,
    reportPath: cfg.backfillReportPath,
    markdownPath: cfg.backfillReportMarkdownPath,
    sessions,
    samples,
    errors,
  };

  writeFileSync(cfg.backfillReportPath, JSON.stringify({ ...report, selectedWindows: allSelected, memories: extracted }, null, 2));
  writeFileSync(cfg.backfillReportMarkdownPath, toMarkdown(report));

  return report;
}

export function formatBackfillScanSummary(report: BackfillScanReport): string {
  const lines = [
    `backfill scan: sessions=${report.sessionCount}, candidateWindows=${report.totalCandidateWindows}, selected=${report.selectedWindowCount}, extracted=${report.extractedCount}, model=${report.llmModel}, errors=${report.errors.length}`,
    `json=${report.reportPath}`,
    `markdown=${report.markdownPath}`,
  ];

  if (report.samples.length > 0) {
    lines.push("samples:");
    report.samples.slice(0, 5).forEach((sample, index) => {
      lines.push(
        `${index + 1}. [${sample.typeLabel}] c=${sample.confidence.toFixed(2)} muninn=${sample.writeToMuninn ? "y" : "n"} global=${sample.writeToGlobalMemory ? "y" : "n"} :: ${sample.concept} — ${sample.content.slice(0, 120).replace(/\s+/g, " ")}`,
      );
    });
  }

  return lines.join("\n");
}
