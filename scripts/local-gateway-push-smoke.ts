import { loadConfig } from "../src/config.js";
import { DEFAULT_GATEWAY_TEST_MODEL, DEFAULT_GATEWAY_TEST_PROVIDER } from "../src/gateway/defaults.js";
import { PiRpcGateway } from "../src/gateway/gateway.js";
import { MemoryBroker } from "../src/memory/broker.js";
import { MuninnClient } from "../src/muninn/client.js";
import { MuninnGrpcClient } from "../src/muninn/grpc-client.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rest = new MuninnClient(cfg);
  const broker = new MemoryBroker(cfg, {
    rest,
    grpc: new MuninnGrpcClient(cfg),
  });
  const gateway = new PiRpcGateway(broker);

  const sentinel = `PUSH_SENTINEL_${Date.now()}`;
  const vault = `pi-push-smoke-${Date.now().toString(36)}`;
  const concept = `gateway-push-smoke-${Date.now()}`;
  const content = `This durable memory engram contains ${sentinel} and should be surfaced automatically.`;

  try {
    const worker = await gateway.createWorker({
      id: "push-smoke-worker",
      cwd: process.cwd(),
      injectionOwner: "worker",
      provider: DEFAULT_GATEWAY_TEST_PROVIDER,
      model: DEFAULT_GATEWAY_TEST_MODEL,
      cliArgs: ["--no-session"],
      memoryScope: {
        mode: "local",
        vault,
      },
    });

    await gateway.attachDurablePush(worker.id, {
      context: [content, concept],
      threshold: 0.2,
      pushOnWrite: true,
      rateLimit: 20,
      ttlSeconds: 120,
      deltaThreshold: 0.01,
    });

    const writeResult = await broker.rememberBatch([
      {
        concept,
        content,
        tags: ["push-smoke", sentinel.toLowerCase()],
        confidence: 0.92,
        createdAt: new Date().toISOString(),
        typeLabel: "fact",
        idempotentId: `push-smoke-${sentinel}`,
      },
    ], { vault, mode: "local" });

    let routeMatch = false;
    let deliveredVia: string | undefined;
    let routeType: string | undefined;
    for (let i = 0; i < 12; i += 1) {
      const status = await gateway.getStatus(true);
      const match = status.recentRoutes.find((route) => route.event.content?.includes(sentinel));
      if (match) {
        routeMatch = true;
        deliveredVia = match.deliveredVia;
        routeType = match.event.type;
        break;
      }
      await sleep(5_000);
    }

    const response = await gateway.runPromptWorker(
      worker.id,
      `Briefly summarize whether a durable memory push for ${sentinel} was observed.`,
      { bypassGatewayMemory: true },
    );

    const ok = routeMatch && routeType === "new_write";
    console.log(JSON.stringify({
      ok,
      vault,
      sentinel,
      concept,
      content,
      writeResult,
      routeMatch,
      routeType,
      deliveredVia,
      response,
      gateway: await gateway.getStatus(true),
    }, null, 2));

    if (!ok) process.exitCode = 1;
  } finally {
    await gateway.shutdown().catch(() => undefined);
  }
}

await main();
