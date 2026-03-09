export type SourceKind = "session" | "global-memory";

export interface MemoryChunk {
  chunkId: string;
  sourceKind: SourceKind;
  sourcePath: string;
  sessionPath?: string;
  cwd?: string;
  entryId?: string;
  entryType: string;
  sourceRole?: string;
  text: string;
  timestamp: string;
  recencyScore: number;
  contentHash: string;
  indexedAt: string;
  extensionVersion: string;
}

export interface SessionIndexRecord {
  path: string;
  mtimeMs: number;
  size: number;
  chunkIds: string[];
  indexedAt: string;
}

export interface LocalIndexState {
  version: number;
  updatedAt: string;
  chunks: Record<string, MemoryChunk>;
  sessions: Record<string, SessionIndexRecord>;
  totalBytes: number;
  globalMemoryHash?: string;
  lastDedupeAt?: string;
}

export interface RetrievalCandidate {
  chunk: MemoryChunk;
  lexicalScore?: number;
  vectorScore?: number;
  combinedScore: number;
  reasons: string[];
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[];
  confidence: number;
  injectedText?: string;
}

export interface MemoryConfig {
  enabled: boolean;
  extensionVersion: string;
  storageDir: string;
  statePath: string;
  globalMemoryPath: string;
  globalResolvedPath: string;
  backfillReportPath: string;
  backfillReportMarkdownPath: string;
  backfillSyncReportPath: string;
  ollama: {
    baseUrl: string;
    model: string;
    fallbackModels: string[];
    timeoutMs: number;
  };
  qdrant: {
    baseUrl: string;
    collection: string;
    apiKey?: string;
    timeoutMs: number;
    distance: "Cosine" | "Dot" | "Euclid";
  };
  muninn: {
    enabled: boolean;
    restBaseUrl: string;
    grpcTarget?: string;
    grpcProtoPath?: string;
    grpcTls: boolean;
    mcpEnabled: boolean;
    vault: string;
    apiKey?: string;
    recallMaxResults: number;
    injectionMaxItems: number;
    capabilityProbeTimeoutMs: number;
    capabilityCacheTtlMs: number;
  };
  extraction: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    batchSize: number;
    turnCapture: boolean;
    backfill: {
      includeBranchSummaries: boolean;
      includeCompactions: boolean;
      excludeToolResults: boolean;
      excludeBash: boolean;
      minHeuristicScore: number;
      maxCandidateWindows: number;
      sampleLimit: number;
      maxMemoriesPerWindow: number;
      maxWindowChars: number;
    };
  };
  retrieval: {
    lexicalLimit: number;
    vectorLimit: number;
    hybridLimit: number;
    minConfidence: number;
    minTopScore: number;
    tokenBudgetChars: number;
    maxItems: number;
    recencyHalfLifeDays: number;
  };
  hybridInjection: {
    enabled: boolean;
    maxChars: number;
    lnkMaxChars: number;
    muninnMaxChars: number;
    maxTotalItems: number;
    minCombinedConfidence: number;
  };
  indexing: {
    autoIncremental: boolean;
    debounceMs: number;
    chunkChars: number;
    chunkOverlap: number;
    diskCapBytes: number;
  };
  dedupe: {
    intervalMs: number;
    llmAssist: boolean;
    llmEndpoint: string;
  };
}

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface GlobalMemoryEntry {
  timestamp: string;
  text: string;
  source: "append" | "manual";
}

export interface BackfillCandidateWindow {
  id: string;
  sessionPath: string;
  timestamp: string;
  sourceType: "exchange" | "branch_summary" | "compaction" | "message";
  roleHint: string;
  heuristicScore: number;
  heuristicTags: string[];
  entryIds: string[];
  text: string;
}

export interface BackfillExtractedMemory {
  sourceWindowId: string;
  sourceEntryIds: string[];
  sessionPath: string;
  timestamp: string;
  concept: string;
  content: string;
  typeLabel: string;
  tags: string[];
  confidence: number;
  writeToMuninn: boolean;
  writeToGlobalMemory: boolean;
  globalMemoryText?: string;
  why?: string;
}

export interface BackfillSessionSummary {
  sessionPath: string;
  candidateWindows: number;
  selectedWindows: number;
}

export interface BackfillScanReport {
  generatedAt: string;
  llmModel: string;
  sessionCount: number;
  totalCandidateWindows: number;
  selectedWindowCount: number;
  extractedCount: number;
  reportPath: string;
  markdownPath: string;
  sessions: BackfillSessionSummary[];
  samples: BackfillExtractedMemory[];
  errors: string[];
}
