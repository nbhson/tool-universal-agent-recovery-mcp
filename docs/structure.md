universal-agent-recovery/
├── bin/                    # CLI shims: uar-mcp, uar-watchdog, uar-state
├── src/
│   ├── mcp/                # MCP server (stdio) + entry point
│   │   ├── server.ts       # 7 tools: register_task, report_progress, save_checkpoint,
│   │   │                   #   report_interruption, get_task_status, mark_completed, cancel_task
│   │   └── main.ts
│   ├── watchdog/           # Independent recovery supervisor
│   │   ├── main.ts         # Entry point
│   │   ├── supervisor.ts   # Tick loop, leader lock usage, recovery execution
│   │   ├── monitor.ts      # Liveness evaluation (stale heartbeat, dead pid)
│   │   ├── recovery-policy.ts  # Backoff, retry budget, due-for-recovery
│   │   └── recovery-instruction.ts
│   ├── adapters/           # Agent adapters
│   │   ├── adapter.interface.ts
│   │   ├── registry.ts
│   │   ├── opencode.adapter.ts
│   │   ├── claude-code.adapter.ts
│   │   ├── generic-cli.adapter.ts
│   │   ├── mock.adapter.ts     # Deterministic adapter for tests/demo
│   │   ├── process-runner.ts
│   │   ├── process-health.ts
│   │   └── command-resolve.ts
│   ├── storage/            # SQLite via node:sqlite (zero native deps)
│   │   ├── database.ts     # WAL + busy_timeout + migrations + friendly errors
│   │   ├── task.repository.ts   # Atomic state transitions + recovery leases
│   │   ├── event.repository.ts  # Append-only audit log
│   │   ├── recovery-attempt.repository.ts
│   │   ├── leader-lock.ts  # Watchdog leader lease (atomic renew/release)
│   │   └── json.ts         # Corrupt-JSON-safe parsing, DuplicateTaskError
│   ├── cli/
│   │   └── dump-state.ts   # uar-state: read-only JSON snapshot for debugging
│   ├── core/
│   │   ├── task.ts         # Types + ACTIVE_STATES
│   │   ├── state-machine.ts
│   │   ├── error-classifier.ts
│   │   └── logger.ts       # Structured JSON logs + secret redaction
│   ├── config.ts           # Env loading, validation, warnings
│   └── examples/
│       └── demo.ts
├── tests/                  # Vitest unit + integration tests
│   └── fixtures/           # Plain-JS child-process workers (race tests)
├── docs/                   # Design documents
├── launchd/                # macOS launchd plist
├── package.json
├── tsconfig.json
└── README.md
