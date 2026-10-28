universal-agent-recovery/
├── src/
│   ├── mcp/
│   │   ├── server.ts
│   │   └── tools/
│   │       ├── register-task.ts
│   │       ├── checkpoint.ts
│   │       ├── report-progress.ts
│   │       └── task-status.ts
│   ├── watchdog/
│   │   ├── supervisor.ts
│   │   ├── monitor.ts
│   │   ├── recovery-policy.ts
│   │   └── scheduler.ts
│   ├── adapters/
│   │   ├── adapter.interface.ts
│   │   ├── opencode.adapter.ts
│   │   ├── claude-code.adapter.ts
│   │   └── generic-cli.adapter.ts
│   ├── storage/
│   │   ├── database.ts
│   │   ├── task.repository.ts
│   │   └── event.repository.ts
│   ├── core/
│   │   ├── task.ts
│   │   ├── state-machine.ts
│   │   └── error-classifier.ts
│   └── index.ts
├── tests/
├── data/
├── logs/
├── package.json
├── tsconfig.json
├── .env.example
└── README.md