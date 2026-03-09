import type { AgentMessage } from "@mariozechner/pi-agent-core";

export class PendingInjection {
  private pending: string | null = null;

  set(text: string | undefined): void {
    this.pending = text?.trim() ? text : null;
  }

  clear(): void {
    this.pending = null;
  }

  hasPending(): boolean {
    return Boolean(this.pending);
  }

  consumeInto(messages: AgentMessage[]): AgentMessage[] {
    if (!this.pending) return messages;

    const injected = this.pending;
    this.pending = null;

    const userMessage: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: injected }],
      timestamp: Date.now(),
    } as AgentMessage;

    return [...messages, userMessage];
  }
}
