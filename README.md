# Universal Agent Recovery System

**MCP server + independent watchdog** that automatically resumes interrupted coding-agent tasks.

## What it does

```
Agent doing work ─── crash ─── watchdog detects ─── resumes from checkpoint
                                         │
                    ┌────────────────────┘
                    ▼
              recovered → continues work
```

## Components

| Component | Command | Role |
|-----------|---------|------|
| **MCP Server** | `npm run start:mcp` | Tools for task registration, progress, checkpoints, interruption reporting |
| **Watchdog** | `npm run start:watchdog` | Independent background process that detects interruptions and triggers recovery |
| **Demo** | `npm run demo` | End-to-end demonstration with a scripted mock agent |

## Supported agents

| Agent | Resume flag | Session inspection | Completion detection | Status |
|-------|------------|-------------------|---------------------|--------|
| **OpenCode** | `--session <id>` | `session list --format json` | No (verified by MCP call) | ✅ Tier 1 validated |
| **Claude Code** | `--resume <id> --print` | No documented CLI | `--output-format json` | ✅ Tier 1 validated |
| **Generic CLI** | Template-driven | No | No | ✅ Available |

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `RECOVERY_DB_PATH` | `./data/recovery.db` | SQLite database shared by MCP + watchdog |
| `RECOVERY_ALLOWED_DIRS` | *(empty)* | Comma-separated root dirs; tasks outside are rejected |
| `RECOVERY_ENABLED` | `true` | Global recovery on/off switch |
| `RECOVERY_STALE_MS` | `600000` | Heartbeat considered stale after 10 minutes |
| `RECOVERY_MAX_ATTEMPTS` | `5` | Retry budget per task |
| `RECOVERY_BACKOFF_BASE_MS` | `30000` | Initial backoff between retries |
| `RECOVERY_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `OPENCODE_BIN` | `opencode` | Path to binary (use absolute on Windows) |
| `CLAUDE_CODE_BIN` | `claude` | Path to binary |

### Windows note

npm shims (`opencode.cmd`, `claude.cmd`) cannot be spawned directly by Node with `shell:false`. Either set the env to the resolved `.exe` path, or rely on the auto-discovery documented above. Example:

```bash
set OPENCODE_BIN=C:\path\to\nodejs\node_modules\@opencode\cli\bin\opencode.exe
```

## Startup

**MCP Server** (stdio transport — configured in OpenCode/Claude Code MCP settings):

```bash
npm run start:mcp
```

**Watchdog** (background, recommended via launchd/systemd):

```bash
npm run start:watchdog
```

Both must share the same `RECOVERY_DB_PATH`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `register_task` | Register a task for monitoring |
| `report_progress` | Heartbeat / progress report |
| `save_checkpoint` | Persist verified progress |
| `report_interruption` | Report an error or crash |
| `get_task_status` | Query full task state + event log |
| `mark_completed` | Mark task complete (requires evidence) |
| `cancel_task` | Cancel and stop recovery |

## Task state machine

```
REGISTERED → RUNNING → INTERRUPTED
     ↓          ↓           ↓
     └──────────┴──→ RECOVERING → RUNNING
                                   ↓
                              COMPLETED
                                   or BLOCKED (exhausted)
                                   or CANCELLED (human)
```

## Recovery lifecycle

1. **Register** — agent calls `register_task` with session id, adapter, working directory.
2. **Progress** — agent calls `report_progress` / `save_checkpoint` as work proceeds.
3. **Detect** — watchdog sees stale heartbeat + no process alive → `INTERRUPTED`.
4. **Verify** — watchdog checks session still exists (when adapter supports it).
5. **Resume** — watchdog calls `resumeSession` with the session id + recovery instruction.
6. **Fallback** — if resume fails, watchdog starts a new session from the persisted checkpoint.
7. **Verify** — recovery succeeds when the agent makes progress (MCP heartbeat) or the adapter reports completion.
8. **Repeat** — watchdog continues monitoring until `COMPLETED`, `BLOCKED`, or `CANCELLED`.

## macOS background service

```bash
# Copy the plist
cp launchd/com.github.universal-agent-recovery.plist ~/Library/LaunchAgents/

# Edit the WorkingDirectory and Program arguments to match your install path
$EDITOR ~/Library/LaunchAgents/com.github.universal-agent-recovery.plist

# Load
launchctl load ~/Library/LaunchAgents/com.github.universal-agent-recovery.plist

# View logs
log stream --predicate 'process == "node" && subsystem contains "universal-agent-recovery"'
```

## Running the demo

```bash
npm run demo
```

Expected output:

```
=== Universal Agent Recovery — automatic recovery demo ===

[time] task registered: demo-refactor (session sess-demo-1)
[time] agent interrupted (heartbeat stale)
[time] final state: RUNNING
recovery attempts recorded: 2

--- event log ---
  task_registered        mcp
  interruption_detected  watchdog
  recovery_claimed       watchdog
  recovery_launched      watchdog
  recovery_failed        watchdog   ← first attempt failed (expected)
  recovery_claimed       watchdog
  recovery_launched      watchdog
  recovery_succeeded     watchdog   ← second attempt succeeded
```

## Tests

```bash
npm test              # all 71 tests (1 skipped: live E2E with credentials)
npm test -- --watch  # watch mode
```

Integration tests against the real OpenCode binary run automatically (Tier 1). The end-to-end live recovery test (Tier 2) requires provider API credentials — set `UAR_INTEGRATION=1` to activate it.

```bash
UAR_INTEGRATION=1 npm test
```

## Security notes

- Working directories are validated against `RECOVERY_ALLOWED_DIRS`.
- Agent processes use argument arrays (no shell strings) — no command injection from task metadata.
- Credential-like environment variables (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*API_KEY*`, ...) are stripped from child-process environments. Provider keys agent CLIs need to run (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AWS session keys) are preserved via an allowlist — see `PROVIDER_API_KEY_ALLOWLIST` in `src/adapters/process-runner.ts`.
- Internal config (`RECOVERY_DB_PATH`, `RECOVERY_LOG_FILE`) never reaches agent processes.
- API keys / tokens are never logged.
- Process cancellation kills the whole process tree (`taskkill /T /F` on Windows, `SIGTERM`→`SIGKILL` escalation on POSIX).
- `RECOVERY_ENABLED=false` is the global killswitch.

## Project structure

```
universal-agent-recovery/
├── src/
│   ├── core/           # Types, state machine, error classifier, logger
│   ├── storage/       # SQLite, task/event/attempt repositories, leader lock
│   ├── adapters/      # OpenCode, Claude Code, Generic CLI, Mock (testing)
│   ├── mcp/           # MCP server (7 tools, stdio transport)
│   ├── watchdog/       # Supervisor, monitor, recovery policy, instructions
│   └── examples/      # Demo script
├── tests/             # 71 unit + integration tests
├── .env.example       # Configuration template
├── package.json
├── tsconfig.json
├── launchd/            # macOS launchd plist
└── README.md
```

## Known limitations

- **Claude Code session inspection**: no documented non-interactive command to list sessions. Resume falls back to new session when the session id is invalid.
- **Process health on Windows**: uses `tasklist` as a fallback; on some Windows SKUs this requires admin.
- **Session inspection failure vs. missing session**: when the agent CLI fails during session inspection (transient error), the watchdog defers recovery instead of falling back to a new session — it never drops session context on a CLI hiccup.
- **Completion detection**: OpenCode has no structured output; completion is verified via MCP `mark_completed` calls (not process exit).
- **Generic CLI adapter**: disabled unless templates are explicitly configured.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|------------|-----|
| Task not recovered | `RECOVERY_ENABLED=false` | Set to `true` |
| "Recovery disabled" in logs | Global switch off | `RECOVERY_ENABLED=true` |
| Task stuck in RECOVERING | Watchdog died mid-recovery | `reconcileStaleOwners()` runs every tick; next watchdog tick recovers it |
| `ECONNREFUSED` on MCP connect | Server not running | `npm run start:mcp` first |
| Agent process never exits | `maxRecoveryDurationMs` not set | Set per-task or via `RECOVERY_MAX_RUNTIME_MS` |
| Slow agents restarted | Heartbeat `staleMs` too short | Increase `RECOVERY_STALE_MS` |
