import type { RetrievalResult } from "../types.js";

export type DurableTransportKind = "grpc" | "rest" | "mcp" | "none";
export type MemoryOperatingMode = "local" | "orchestrated";
export type MemoryTriggerType = "new_write" | "threshold_crossed" | "contradiction_detected" | "unknown";
export type MemoryTriggerPriority = "low" | "medium" | "high";

export interface MemoryScope {
  vault?: string;
  project?: string;
  workflowId?: string;
  agentId?: string;
  mode?: MemoryOperatingMode;
}

export interface DurableMemoryWrite {
  concept: string;
  content: string;
  tags?: string[];
  confidence?: number;
  createdAt?: string;
  typeLabel?: string;
  idempotentId?: string;
  provenance?: Record<string, unknown>;
}

export interface DurableActivation {
  id: string;
  concept: string;
  content: string;
  score: number;
  tags?: string[];
  why?: string;
  transport: Exclude<DurableTransportKind, "none">;
}

export interface DurableActivateResult {
  activations: DurableActivation[];
  confidence: number;
  transport: DurableTransportKind;
}

export interface DurableWriteResult {
  index: number;
  id?: string;
  status: "ok" | "error";
  error?: string;
  transport: DurableTransportKind;
}

export interface TransportOperations {
  health: boolean;
  activate: boolean;
  write: boolean;
  subscribe: boolean;
}

export interface TransportCapability {
  configured: boolean;
  available: boolean;
  operations: TransportOperations;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface DurableMemoryCapabilities {
  preferredTransport: DurableTransportKind;
  transports: {
    grpc: TransportCapability;
    rest: TransportCapability;
    mcp: TransportCapability;
  };
  lastProbedAt: string;
}

export interface DurableSubscribeRequest {
  context: string[];
  threshold?: number;
  ttlSeconds?: number;
  rateLimit?: number;
  pushOnWrite?: boolean;
  deltaThreshold?: number;
  scope?: MemoryScope;
}

export interface DurableSubscription {
  close(): Promise<void>;
}

export interface DurableMemoryAdapter {
  readonly kind: Exclude<DurableTransportKind, "none">;
  health(): Promise<boolean>;
  probeCapabilities(): Promise<TransportCapability>;
  activate(query: string, scope?: MemoryScope): Promise<DurableActivateResult>;
  rememberBatch(memories: DurableMemoryWrite[], scope?: MemoryScope): Promise<DurableWriteResult[]>;
  subscribe?(
    request: DurableSubscribeRequest,
    onEvent: (event: NormalizedMemoryEvent) => void,
  ): Promise<DurableSubscription>;
}

export interface NormalizedMemoryEvent {
  type: MemoryTriggerType;
  priority: MemoryTriggerPriority;
  transport: DurableTransportKind;
  scope?: MemoryScope;
  concept?: string;
  content?: string;
  receivedAt: string;
  raw?: unknown;
}

export interface HybridRecallResult {
  transcript: RetrievalResult;
  durable: DurableActivateResult;
  combinedConfidence: number;
  injectionText?: string;
  sections: {
    durableItems: number;
    transcriptItems: number;
  };
}

export interface BrokerRememberBatchResult {
  attempted: number;
  written: number;
  failed: number;
  transport: DurableTransportKind;
  results: DurableWriteResult[];
}

export interface MemoryBrokerStatus {
  durableEnabled: boolean;
  durableHealthy: boolean;
  preferredTransport: DurableTransportKind;
  capabilities: DurableMemoryCapabilities;
}
