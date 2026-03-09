import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { MemoryBrokerStatus, MemoryScope, NormalizedMemoryEvent } from "../memory/contracts.js";

export type GatewayWorkerStatus = "starting" | "ready" | "streaming" | "stopped" | "error";
export type GatewayInjectionOwner = "worker" | "gateway";

export interface GatewayWorkerOptions {
  id?: string;
  cwd?: string;
  cliCommand?: string;
  cliArgs?: string[];
  env?: Record<string, string>;
  provider?: string;
  model?: string;
  memoryScope?: MemoryScope;
  injectionOwner?: GatewayInjectionOwner;
  autoStart?: boolean;
}

export interface GatewayWorkerSummary {
  id: string;
  cwd: string;
  status: GatewayWorkerStatus;
  injectionOwner: GatewayInjectionOwner;
  memoryScope?: MemoryScope;
  startedAt?: string;
  lastEventAt?: string;
  lastError?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  pendingMessageCount?: number;
  modelLabel?: string;
  stderrTail?: string;
}

export interface GatewayPromptOptions {
  streamingBehavior?: "steer" | "followUp";
  bypassGatewayMemory?: boolean;
}

export interface GatewayStatus {
  broker: MemoryBrokerStatus;
  workers: GatewayWorkerSummary[];
  recentRoutes: DurablePushRoute[];
}

export interface GatewayWorkerEvent {
  workerId: string;
  event: AgentEvent;
}

export interface DurablePushRoute {
  workerId: string;
  event: NormalizedMemoryEvent;
  deliveredVia: "prompt" | "steer" | "follow_up" | "ignored";
}
