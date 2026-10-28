/** MCP server entry point: `node dist/mcp/main.js` (exposed as `uar-mcp` bin). */
import { loadConfig } from "../config.js";
import { createLogger } from "../core/logger.js";
import { runMcpServer } from "./server.js";

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, logFile: config.logFile, component: "mcp" });

runMcpServer(config, logger).catch((err) => {
  // Never write to stdout: it carries the MCP JSON-RPC protocol.
  process.stderr.write(`mcp server fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
