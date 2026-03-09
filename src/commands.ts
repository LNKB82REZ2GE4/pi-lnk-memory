import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface CommandHandlers {
  status: () => Promise<string>;
  incremental: () => Promise<string>;
  reindex: () => Promise<string>;
  prune: () => Promise<string>;
  search: (query: string) => Promise<string>;
  backfillScan: (selector?: string) => Promise<string>;
  backfillReview: (ctx: ExtensionCommandContext) => Promise<string>;
  backfillSync: (ctx: ExtensionCommandContext) => Promise<string>;
  globalReview: (ctx: ExtensionCommandContext) => Promise<string>;
  globalAdd: (text: string) => Promise<string>;
  globalOpen: (ctx: ExtensionCommandContext) => Promise<string>;
  globalDedupe: () => Promise<string>;
  gatewayStatus: () => Promise<string>;
  gatewayStart: (args?: string) => Promise<string>;
  gatewayStop: () => Promise<string>;
  gatewayPrompt: (message: string) => Promise<string>;
  gatewaySubscribe: (args?: string) => Promise<string>;
  gatewayUnsubscribe: () => Promise<string>;
  gatewaySmoke: (args?: string) => Promise<string>;
}

export function registerCommands(pi: ExtensionAPI, handlers: CommandHandlers): void {
  pi.registerCommand("lnk-memory-status", {
    description: "Show memory index status",
    handler: async (_args, ctx) => {
      const text = await handlers.status();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-index", {
    description: "Run incremental memory indexing now",
    handler: async (_args, ctx) => {
      const text = await handlers.incremental();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-reindex", {
    description: "Run full memory reindex",
    handler: async (_args, ctx) => {
      const text = await handlers.reindex();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-prune", {
    description: "Enforce disk cap and prune old memory chunks",
    handler: async (_args, ctx) => {
      const text = await handlers.prune();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-search", {
    description: "Debug memory retrieval for a query",
    handler: async (args, ctx) => {
      const query = args?.trim();
      if (!query) {
        const help = "Usage: /lnk-memory-search <query>";
        if (ctx.hasUI) ctx.ui.notify(help, "warning");
        else console.log(help);
        return;
      }
      const text = await handlers.search(query);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-backfill-scan", {
    description: "Dry-run scan of session history. Default: latest session only. Use 'all' or a path fragment to target others.",
    handler: async (args, ctx) => {
      const text = await handlers.backfillScan(args?.trim());
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-backfill-review", {
    description: "Open the latest backfill scan markdown report",
    handler: async (_args, ctx) => {
      const text = await handlers.backfillReview(ctx);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-backfill-sync", {
    description: "Review and then sync the latest backfill scan results into Muninn and global memory.md",
    handler: async (_args, ctx) => {
      const text = await handlers.backfillSync(ctx);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-global-review", {
    description: "Review and selectively accept candidate global memories into memory.md",
    handler: async (_args, ctx) => {
      const text = await handlers.globalReview(ctx);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });

  pi.registerCommand("lnk-memory-global-add", {
    description: "Append text to global memory.md",
    handler: async (args, ctx) => {
      const text = args?.trim();
      if (!text) {
        const help = "Usage: /lnk-memory-global-add <text>";
        if (ctx.hasUI) ctx.ui.notify(help, "warning");
        else console.log(help);
        return;
      }
      const result = await handlers.globalAdd(text);
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-global-open", {
    description: "Open global memory.md in editor",
    handler: async (_args, ctx) => {
      const result = await handlers.globalOpen(ctx);
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-global-dedupe", {
    description: "Run global memory dedupe/reconciliation now",
    handler: async (_args, ctx) => {
      const result = await handlers.globalDedupe();
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-status", {
    description: "Show local Pi RPC gateway status",
    handler: async (_args, ctx) => {
      const result = await handlers.gatewayStatus();
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-start", {
    description: "Start the local Pi RPC worker. Optional args: injection=worker|gateway provider=<name> model=<id> cli=<command> nosession=true|false. Defaults to zai/glm-4.7.",
    handler: async (args, ctx) => {
      const result = await handlers.gatewayStart(args?.trim());
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-stop", {
    description: "Stop the local Pi RPC worker",
    handler: async (_args, ctx) => {
      const result = await handlers.gatewayStop();
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-prompt", {
    description: "Send a prompt through the local Pi RPC gateway worker",
    handler: async (args, ctx) => {
      const message = args?.trim();
      if (!message) {
        const help = "Usage: /lnk-memory-gateway-prompt <message>";
        if (ctx.hasUI) ctx.ui.notify(help, "warning");
        else console.log(help);
        return;
      }
      const result = await handlers.gatewayPrompt(message);
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-subscribe", {
    description: "Attach durable memory push subscription to the local worker. Args: optional context text",
    handler: async (args, ctx) => {
      const result = await handlers.gatewaySubscribe(args?.trim());
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-unsubscribe", {
    description: "Detach durable memory push subscription from the local worker",
    handler: async (_args, ctx) => {
      const result = await handlers.gatewayUnsubscribe();
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });

  pi.registerCommand("lnk-memory-gateway-smoke", {
    description: "Run a local Pi RPC smoke test using the gateway worker. Optional arg: plain|memory",
    handler: async (args, ctx) => {
      const result = await handlers.gatewaySmoke(args?.trim());
      if (ctx.hasUI) ctx.ui.notify(result, "info");
      else console.log(result);
    },
  });
}
