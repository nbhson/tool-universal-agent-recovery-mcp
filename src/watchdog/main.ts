/** Watchdog entry point: `node dist/watchdog/main.js`. */
import { loadConfig } from "../config.js";
import { createLogger } from "../core/logger.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { WatchdogSupervisor } from "./supervisor.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, logFile: config.logFile, component: "watchdog" });

  const registry = AdapterRegistry.fromEnv(process.env, logger);

  // Validate configured adapters once at startup (never blocks on failure).
  for (const adapter of registry.list()) {
    const available = await adapter.detect().catch(() => false);
    if (!available) {
      logger.warn("adapter not detected on this machine", { adapterId: adapter.id });
    }
  }

  const supervisor = new WatchdogSupervisor(config, registry, logger);
  await supervisor.start();

  // Keep the Node.js event loop alive. The supervisor's internal tickTimer is
  // unref'd so this process can also be used as a cron-style one-shot (via
  // runOnce / tests). As a long-running daemon the entry point holds a live
  // handle instead.
  const keepAlive = setInterval(() => {}, 60_000);

  const shutdown = (): void => {
    clearInterval(keepAlive);
    void supervisor.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`watchdog fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
