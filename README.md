# Universal Agent Recovery

[![CI](https://github.com/nbhson/tool-universal-agent-recovery-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nbhson/tool-universal-agent-recovery-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/universal-agent-recovery.svg)](https://www.npmjs.com/package/universal-agent-recovery)
[![npm downloads](https://img.shields.io/npm/dm/universal-agent-recovery.svg)](https://www.npmjs.com/package/universal-agent-recovery)

**Your coding agent crashed at 80% of the task. Who restarts it?** This package does.

`universal-agent-recovery` is an **MCP server + independent watchdog** that automatically detects when a coding agent task is interrupted (crash, timeout, lost session) and resumes it — from the same session when possible, or from a saved checkpoint otherwise.

```
Agent doing work ── crash ──> watchdog detects ──> resumes from checkpoint
                                        │
                    ┌───────────────────┘
                    ▼
              recovered → agent continues the task
```

| Component | CLI | Role |
|-----------|-----|------|
| **MCP Server** | `uar-mcp` | Tools for the agent to register tasks, report progress, save checkpoints |
| **Watchdog** | `uar-watchdog` | Independent process that detects interruptions and launches recovery |

- Works with **OpenCode**, **Claude Code**, and any agent via a **generic CLI** template adapter.
- **No native dependencies** — uses Node's built-in SQLite (`node >= 22.5`).
- The watchdog never depends on the agent being alive to perform recovery.

---

## Quick start

```bash
npm install -g universal-agent-recovery
```

### 1. Register the MCP server in your MCP client

**OpenCode** — add to `~/.config/opencode/opencode.json` (or project `opencode.json`):

```json
{
  "mcp": {
    "universal-agent-recovery": {
      "type": "local",
      "command": ["uar-mcp"],
      "enabled": true
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add universal-agent-recovery -- uar-mcp
```

**Any other MCP client** — command `uar-mcp`, transport `stdio`.

### 2. Start the watchdog in the background

```bash
uar-watchdog
```

That's it. From now on, whenever the agent calls `register_task` at the start of significant work, the task is monitored and auto-resumed on interruption.

### 3. Optional: try the demo

```bash
npm run demo   # scripted end-to-end recovery with a mock agent
```

---

## How it works

The agent (via MCP tools) records what it is doing; the watchdog watches the record and recovers when the record goes stale.

```
                 ┌─────────────────────────┐
                 │   SQLite state store    │
                 │  (shared, WAL mode)     │
                 └──────────┬──────────────┘
        register/heartbeat  │  poll + claim
   ┌────────────────────────┴──────────────────────┐
   │                                               │
MCP Server (uar-mcp)                      Watchdog (uar-watchdog)
- register_task                           - detects stale heartbeat / dead pid
- report_progress / save_checkpoint       - verifies the session still exists
- report_interruption                     - resumes: same session → checkpoint fallback
- mark_completed / cancel_task            - retry budget + backoff + single-owner lock
```

### Recovery lifecycle

1. **Register** — agent calls `register_task` (session id, adapter, working directory).
2. **Progress** — agent calls `report_progress` / `save_checkpoint` as work proceeds.
3. **Detect** — watchdog sees a stale heartbeat (and/or dead pid) → task is `INTERRUPTED`.
4. **Verify** — watchdog checks the session still exists (adapters that support it).
5. **Resume** — watchdog launches the agent with the same session id + a self-contained recovery instruction.
6. **Fallback** — resume failed? A fresh session is started from the persisted checkpoint.
7. **Verify** — recovery succeeded only when the agent resumes making progress or reports completion.
8. **Repeat** — until `COMPLETED`, `BLOCKED` (retry budget exhausted), or `CANCELLED`.

### Interruption scenarios → when recovery triggers

| Scenario | Detected by | Resumed? |
|----------|-------------|----------|
| Network loss → agent CLI crashes → process dies | `isPidAlive` check | ✅ ≤ ~30s (next poll) |
| Network loss → CLI hangs, process alive, **no pid known** | stale heartbeat (`RECOVERY_STALE_MS`) | ✅ after 10 min (default) |
| Agent retries internally, then **exits** | dead pid | ✅ ≤ ~30s |
| Agent retries internally, then **goes silent with process still alive** | heartbeat stale but pid alive | ❌ classified `IDLE` — never resumed (by design) |
| Agent reports `report_interruption` before going silent | tool call | ✅ immediately (next poll) |

> **Design note:** a live process with a stale heartbeat is deliberately classified as
> `IDLE`, not `INTERRUPTED`. From the outside, "running a 15-minute test suite",
> "stuck waiting for the network", and "waiting for the user to type the next
> instruction" look identical — so the watchdog only resumes when it can prove the
> agent is gone (dead pid), or when the agent itself reports the interruption.
> The agent's own contract: try to recover on your own first, and call
> `report_interruption` when you give up — the watchdog then takes over with its
> own retry budget and backoff.

### Task state machine

```
REGISTERED → RUNNING → INTERRUPTED
     ↓          ↓           ↓
     └──────────┴──→ RECOVERING → RUNNING
                                   ↓
                              COMPLETED
                                   or BLOCKED (exhausted)
                                   or CANCELLED (human)
```

### MCP tools (7)

| Tool | Description |
|------|-------------|
| `register_task` | Register a task for monitoring |
| `report_progress` | Heartbeat / progress report |
| `save_checkpoint` | Persist verified progress (files touched, steps done, next steps) |
| `report_interruption` | Report an error or crash |
| `get_task_status` | Query full task state + event log |
| `mark_completed` | Mark complete — requires evidence of work |
| `cancel_task` | Cancel and stop recovery |

---

## Configuration

All settings are environment variables (copy `.env.example` → `.env` if you use a dotenv loader; both `uar-mcp` and `uar-watchdog` must see the same values):

| Variable | Default | Description |
|----------|---------|-------------|
| `RECOVERY_DB_PATH` | `./data/recovery.db` | SQLite database shared by MCP + watchdog (**must match** between the two processes) |
| `RECOVERY_ALLOWED_DIRS` | *(empty = unrestricted)* | Comma-separated root dirs; tasks outside are rejected |
| `RECOVERY_ENABLED` | `true` | Global recovery killswitch |
| `RECOVERY_STALE_MS` | `600000` | Heartbeat considered stale after 10 minutes |
| `RECOVERY_MAX_CONCURRENT` | `2` | Max simultaneous recoveries |
| `RECOVERY_MAX_RUNTIME_MS` | `3600000` | Hard runtime cap per recovery launch |
| `RECOVERY_MAX_ATTEMPTS` | `5` | Retry budget per task |
| `RECOVERY_BACKOFF_BASE_MS` | `30000` | Initial backoff between retries |
| `RECOVERY_BACKOFF_MAX_MS` | `1800000` | Backoff cap |
| `RECOVERY_OWNER_LEASE_MS` | `300000` | Recovery ownership lease |
| `RECOVERY_POLL_MS` | `30000` | Watchdog polling interval |
| `RECOVERY_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `RECOVERY_LOG_FILE` | *(none)* | Optional JSON log file |
| `OPENCODE_BIN` | `opencode` | OpenCode binary path |
| `CLAUDE_CODE_BIN` | `claude` | Claude Code binary path |
| `RECOVERY_GENERIC_CLI_RESUME` | *(empty)* | Resume template, e.g. `myagent run --resume {session} "{prompt}"` |
| `RECOVERY_GENERIC_CLI_NEW` | *(empty)* | New-session template, e.g. `myagent run "{prompt}"` |

### Running the watchdog as a service

- **macOS (launchd)**: copy `launchd/com.github.universal-agent-recovery.plist` to `~/Library/LaunchAgents/`, adjust the paths, then `launchctl load ...`.
- **Linux (systemd)**: create a user unit running `uar-watchdog` with the desired `RECOVERY_*` environment.
- **Windows**: use a scheduled task (`schtasks /create ... /sc onstart`) or a service wrapper.

### Windows notes

- npm shims (`opencode.cmd`, `claude.cmd`) cannot be spawned directly by Node. Point the env at the real `.exe`:

```powershell
setx OPENCODE_BIN "C:\path\to\nodejs\node_modules\@opencode\cli\bin\opencode.exe"
```

- Process-tree cancellation uses `taskkill /T /F` automatically; `tasklist` is the process-health fallback.

---

## Supported agents

| Agent | Resume flag | Session inspection | Completion detection | Status |
|-------|------------|-------------------|---------------------|--------|
| **OpenCode** | `--session <id>` | `session list --format json` | No (verified via MCP) | ✅ Tier 1 validated |
| **Claude Code** | `--resume <id> --print` | No documented CLI | `--output-format json` | ✅ Tier 1 validated |
| **Generic CLI** | Template-driven | No | No | ✅ Available |

---

## Security

- Working directories are validated against `RECOVERY_ALLOWED_DIRS`.
- Agent processes are launched with argument arrays only (`shell: false`) — no command injection from task metadata.
- Credential-like environment variables (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*API_KEY*`, ...) are stripped from agent processes; provider keys agent CLIs need (e.g. `ANTHROPIC_API_KEY`) are preserved via an explicit allowlist.
- API keys / tokens are never logged (structured logger redacts secrets).
- `RECOVERY_ENABLED=false` is the global killswitch.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|------------|-----|
| Task not recovered | `RECOVERY_ENABLED=false` | Set to `true` |
| "Recovery disabled" in logs | Global switch off | `RECOVERY_ENABLED=true` |
| Task stuck in RECOVERING | Watchdog died mid-recovery | `reconcileStaleOwners()` runs every tick; the next watchdog tick recovers it |
| Agent resumes but task stays INTERRUPTED | Watchdog not running | Start `uar-watchdog` |
| Slow agents restarted | `RECOVERY_STALE_MS` too short | Increase it (default 10 min) |
| `ENOENT` spawning the agent | Binary not resolvable | Set `OPENCODE_BIN` / `CLAUDE_CODE_BIN` to an absolute `.exe` path |

## Known limitations

- **Claude Code session inspection**: no documented non-interactive command to list sessions; an invalid session id falls back to a new session.
- **Session inspection failure vs. missing session**: a CLI failure during inspection makes the watchdog defer (never drop session context on a hiccup).
- **Completion detection (OpenCode)**: no structured output; completion is verified via MCP `mark_completed`, not process exit.
- **Generic CLI adapter**: disabled unless templates are explicitly configured.

---

## Documentation

| Document | Content |
|----------|---------|
| [docs/architecture.md](docs/architecture.md) | System architecture and design principles |
| [docs/tool-design.md](docs/tool-design.md) | MCP tool contracts and schemas |
| [docs/usecase.md](docs/usecase.md) | Use cases and scenarios |
| [docs/workflow.md](docs/workflow.md) | Recovery workflow details |
| [docs/structure.md](docs/structure.md) | Source code structure guide |

## Development

```bash
npm install
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm test            # 78 unit + integration tests
npm run build       # compile to dist/
```

Integration tests against a real OpenCode binary run automatically when the binary exists; the live end-to-end test (needs provider credentials) is opt-in:

```bash
UAR_INTEGRATION=1 npm test
```

## Project structure

```
universal-agent-recovery/
├── bin/                 # CLI shims: uar-mcp, uar-watchdog
├── src/
│   ├── core/            # Types, state machine, error classifier, logger
│   ├── storage/         # SQLite, task/event/attempt repositories, leader lock
│   ├── adapters/        # OpenCode, Claude Code, Generic CLI, Mock (testing)
│   ├── mcp/             # MCP server (7 tools, stdio transport) + entry point
│   ├── watchdog/        # Supervisor, monitor, recovery policy, instructions
│   └── examples/        # Demo script
├── docs/                # Design documents
├── tests/               # Unit + integration tests
└── launchd/             # macOS launchd plist
```

## License

[MIT](LICENSE)
