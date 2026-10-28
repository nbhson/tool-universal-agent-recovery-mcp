/** Adapter registry: builds adapters from configuration. */
import type { AgentAdapter } from "./adapter.interface.js";
import { MockAdapter } from "./mock.adapter.js";
import { OpenCodeAdapter } from "./opencode.adapter.js";
import { ClaudeCodeAdapter } from "./claude-code.adapter.js";
import { GenericCliAdapter } from "./generic-cli.adapter.js";
import type { Logger } from "../core/logger.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  constructor(private readonly logger?: Logger) {}

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): AgentAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`Unknown adapter '${adapterId}'. Registered: ${[...this.adapters.keys()].join(", ")}`);
    }
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** Default production registry. Generic CLI only when templates are configured. */
  static fromEnv(
    env: NodeJS.ProcessEnv,
    logger?: Logger,
  ): AdapterRegistry {
    const registry = new AdapterRegistry(logger);
    registry.register(new OpenCodeAdapter({ bin: env.OPENCODE_BIN || undefined }));
    registry.register(new ClaudeCodeAdapter({ bin: env.CLAUDE_CODE_BIN || undefined }));
    if (env.RECOVERY_GENERIC_CLI_RESUME || env.RECOVERY_GENERIC_CLI_NEW) {
      registry.register(
        new GenericCliAdapter({
          resumeTemplate: env.RECOVERY_GENERIC_CLI_RESUME || undefined,
          newTemplate: env.RECOVERY_GENERIC_CLI_NEW || undefined,
        }),
      );
      logger?.info("generic-cli adapter enabled from environment");
    }
    return registry;
  }

  /** Test registry with a mock adapter only. */
  static forTests(mock?: MockAdapter): { registry: AdapterRegistry; mock: MockAdapter } {
    const instance = mock ?? new MockAdapter();
    const registry = new AdapterRegistry();
    registry.register(instance);
    return { registry, mock: instance };
  }
}

export { MockAdapter, OpenCodeAdapter, ClaudeCodeAdapter, GenericCliAdapter };
export type { AgentAdapter };
