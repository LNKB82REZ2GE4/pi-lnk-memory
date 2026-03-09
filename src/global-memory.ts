import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GlobalMemoryEntry } from "./types.js";

export function ensureGlobalMemoryFile(globalMemoryPath: string): void {
  mkdirSync(path.dirname(globalMemoryPath), { recursive: true });
  if (!existsSync(globalMemoryPath)) {
    const header = [
      "# LNK Global Memory",
      "",
      "Append-only user profile memory managed by pi-lnk-memory.",
      "You can edit this file manually. Extension commands append new entries.",
      "",
    ].join("\n");
    writeFileSync(globalMemoryPath, `${header}\n`);
  }
}

export function appendGlobalMemory(globalMemoryPath: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  ensureGlobalMemoryFile(globalMemoryPath);
  const line = `- [${new Date().toISOString()}] ${trimmed.replace(/\s+/g, " ")}\n`;
  appendFileSync(globalMemoryPath, line);
}

export function readGlobalMemoryRaw(globalMemoryPath: string): string {
  ensureGlobalMemoryFile(globalMemoryPath);
  return readFileSync(globalMemoryPath, "utf8");
}

export function writeGlobalMemoryRaw(globalMemoryPath: string, raw: string): void {
  ensureGlobalMemoryFile(globalMemoryPath);
  writeFileSync(globalMemoryPath, raw);
}

export function parseGlobalMemoryEntries(raw: string, source: "append" | "manual"): GlobalMemoryEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: GlobalMemoryEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const matched = trimmed.match(/^-\s*\[(?<ts>[^\]]+)]\s*(?<text>.+)$/);
    if (matched?.groups?.ts && matched.groups.text) {
      const ts = new Date(matched.groups.ts).toISOString();
      entries.push({ timestamp: ts, text: matched.groups.text.trim(), source });
      continue;
    }

    // Fallback for manual edits: accept only bullet-style lines without timestamp
    if (/^[-*]\s+/.test(trimmed)) {
      entries.push({
        timestamp: new Date().toISOString(),
        text: trimmed.replace(/^[-*]\s+/, "").trim(),
        source: "manual",
      });
    }
  }

  return entries;
}

export function globalMemoryMtimeMs(globalMemoryPath: string): number {
  ensureGlobalMemoryFile(globalMemoryPath);
  return statSync(globalMemoryPath).mtimeMs;
}
