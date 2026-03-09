import { loadConfig } from "../src/config.js";
import { PiRpcGateway } from "../src/gateway/gateway.js";
import { DEFAULT_GATEWAY_TEST_MODEL, DEFAULT_GATEWAY_TEST_PROVIDER } from "../src/gateway/defaults.js";
import { LocalGatewayManager } from "../src/gateway/local-manager.js";
import { MemoryBroker } from "../src/memory/broker.js";
import { MuninnClient } from "../src/muninn/client.js";
import { MuninnGrpcClient } from "../src/muninn/grpc-client.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    if (!key || rest.length === 0) continue;
    out[key.toLowerCase()] = rest.join("=");
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode === "memory" ? "memory" : "plain";
  const provider = args.provider || DEFAULT_GATEWAY_TEST_PROVIDER;
  const model = args.model || DEFAULT_GATEWAY_TEST_MODEL;
  const injectionOwner = args.injection === "gateway" ? "gateway" : "worker";
  const cliCommand = args.cli || "pi";
  const noSession = args.nosession !== "false";

  const cfg = loadConfig();
  const broker = new MemoryBroker(cfg, {
    rest: new MuninnClient(cfg),
    grpc: new MuninnGrpcClient(cfg),
  });
  const gateway = new PiRpcGateway(broker);
  const localGateway = new LocalGatewayManager(gateway);

  try {
    await localGateway.ensureDefaultWorker({
      cwd: process.cwd(),
      injectionOwner,
      provider,
      model,
      cliCommand,
      cliArgs: noSession ? ["--no-session"] : undefined,
    });

    const result = await localGateway.smokeDefault(mode);
    const status = await gateway.getStatus();

    console.log(JSON.stringify({
      ok: result.ok,
      mode,
      provider,
      model,
      injectionOwner,
      worker: result,
      gateway: status,
    }, null, 2));

    if (!result.ok) process.exitCode = 1;
  } finally {
    await gateway.shutdown().catch(() => undefined);
  }
}

await main();
