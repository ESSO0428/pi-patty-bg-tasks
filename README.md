# pi-patty-bg-tasks — Background Tasks Extension for pi

Background tasks, agent-loop backgrounding, and background agents for the
[pi](https://github.com/earendil-works/pi-mono) coding agent. Modelled after
Claude Code's `ASSISTANT_BLOCKING_BUDGET_MS` and `bash_bg` semantics.

Extracted from the [pi-tau](https://github.com/Mearman/tau) extension; this
package contains only the background-tasks feature set.

## Features

### Background Tasks

- **Ctrl+B** — background running bash, background the agent loop, or resume a backgrounded agent
- **15-second auto-background** — long-running commands are automatically backgrounded with agent confirmation
- **Agent loop backgrounding** — Ctrl+B during agent processing blocks further tool calls and yields control back to you
- **Disk-based output** — all background job output written to `/tmp/pi-bg-<jobId>.log`, not memory
- **Process-group kill** — `process.kill(-pid)` terminates entire process trees
- **Stall detection** — detects interactive prompts (`(y/n)`, `Press any key`) in background jobs after 45s of stagnant output
- **Size watchdog** — kills background jobs exceeding 100 MiB output
- **Background hint** — `⏱ Ctrl+B to background` appears after 2s of bash activity
- **Pill bar** — `◐ job-1: cmd (12s) · ◐ agent (backgrounded)` in the status area
- **Task management UI** — Shift+Down or Ctrl+J opens grouped task list with detail views
- **Ctrl+X** — kill most recent running background task
- **Session persistence** — job history survives pi restarts

### Background Agent (`agent_bg`)

- Spawns a separate `pi -p` process in the background for autonomous task execution
- Constructs a continuation prompt from the current conversation context (original task + last assistant summary)
- Output streamed to `/tmp/pi-bg-<jobId>.log`; agent notified on completion

## Tools

| Tool | Purpose |
|------|---------|
| `bash` | Standard bash, enhanced with 15s auto-background timeout and Ctrl+B support |
| `bash_bg` | Start a command in the background immediately |
| `jobs` | `list`, `output`, `kill`, or `attach` to background jobs |
| `job_decide` | Decide what to do with a timed-out background job |
| `agent_bg` | Spawn a background `pi -p` process for autonomous task execution |

## Commands

| Command | Purpose |
|---------|---------|
| `/bg` | Same as Ctrl+B — background bash/agent or resume |
| `/fg` | Attach to a background job, optionally with `--snapshot` |
| `/jobs` | Open task management interface |

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+B` | Background running bash + agent, or resume backgrounded agent |
| `Ctrl+X` | Kill most recent running background task |
| `Ctrl+J` / `Shift+Down` | Open task management interface |

## Design Decisions

### Disk over Memory

Output goes to files (`/tmp/pi-bg-<jobId>.log`), not in-memory buffers. Survives
crashes, no memory pressure on long-running tasks. Tail-reads use
`statSync` + `readSync` to read the last N bytes without loading the whole file.

### Process Groups over tree-kill

`process.kill(-pid)` kills the entire group when the child is spawned with
`detached: true`. No external dependency needed. Falls back to killing the
parent PID if the process group kill fails.

### Block over Pause

The agent loop can't be truly backgrounded (it runs in-process). Tool call
blocking is the closest approximation: when `state.agentBackgrounded` is set,
the `tool_call` event handler returns `{ block: true, reason: "" }` and the
agent sees an empty block reason and stops cleanly. A second Ctrl+B resumes
by clearing the flag and posting a `Continuing where you left off.` follow-up
message that re-triggers the agent turn.

### 15s Bash Timeout

Matches Claude Code's `ASSISTANT_BLOCKING_BUDGET_MS`. Commands that need
longer should use `bash_bg`. The timeout is skipped entirely in
non-interactive mode (`-p`/`--print` or non-TTY stdin) because there is no
agent loop to answer the `job_decide` follow-up.

### 2s Quick-Completion Window

Commands that finish within 2 s of spawn are returned directly without going
through the backgrounded path. Avoids sending 14-second commands through the
`job_decide` flow.

### Stall Watchdog

A 5 s `setInterval` checks the log file size and last 1024 bytes of output:

- **Size**: if file exceeds 100 MiB, the job is SIGTERM'd and a `bg-stall`
  warning is sent.
- **Stall**: if the file hasn't grown for 45 s and the tail matches a known
  interactive prompt pattern (`(y/n)`, `Press any key`, `Continue?`, etc.),
  a `bg-stall` warning is sent.

### Session Persistence

On `session_shutdown`, the current background-jobs map is written to the
session as a `background-tasks-state` custom entry (with `proc` /
`donePromise` / `resolveDone` stripped). On `session_start`, the entry is
read back; running jobs are re-validated against the OS (PID alive or tmux
exit-code sentinel present) and stale entries are marked `completed`.

### Tmux Backend

When tmux is available, bash commands are spawned inside a per-git-root tmux
session. This eliminates the foreground→background output race window
(tmux owns the process lifecycle) and lets users attach to running commands
with `tmux attach`. Falls back to direct child-process spawning when tmux
is absent. The session is kept alive between windows to avoid
fork+waitpid deadlocks that arise from accumulating tmux server state
across hundreds of create/destroy cycles.

## Architecture

```
src/
  index.ts                Entry point — registers all features, cross-cutting event handlers
  state.ts                TauState class — shared mutable state
  types.ts                Shared type definitions (BackgroundJob, RunningProcess, UiContext)
  utils.ts                Shared utilities (DEFAULT_TIMEOUT_MS, killProcessGroup, formatDuration, …)
  tmux.ts                 Tmux utilities (session management, window creation, output capture)
  features/
    background.ts         bash override, bash_bg, jobs, job_decide tools
    background-commands.ts  /bg, /fg, /jobs commands, Ctrl+B/X/J shortcuts, task UI
    agent-background.ts   agent_bg tool — spawn detached pi -p process
    bash-tmux.ts          Tmux-backed bash execution backend
```

## Installation

### From npm (once published)

```bash
pi install npm:pi-patty-bg-tasks
```

Or add to `~/.pi/agent/settings.json`:

```json
{
    "packages": ["npm:pi-patty-bg-tasks"]
}
```

### From GitHub

```bash
pi install github:patrickrho-patty/pi-patty-bg-tasks
```

Or clone directly into the extensions directory:

```bash
git clone https://github.com/patrickrho-patty/pi-patty-bg-tasks.git ~/.pi/agent/extensions/pi-patty-bg-tasks
cd ~/.pi/agent/extensions/pi-patty-bg-tasks && pnpm install
```

## Known Limitations

These require changes to pi core:

1. **Agent doesn't keep running in background** — tool calls are blocked, the loop pauses. True background execution needs an `AgentLoopHandle` API in pi core.
2. **Tmux backend requires a git repository** — session names are derived from the git root. Falls back to direct process management outside git repos.

## License

MIT — [github.com/patrickrho-patty/pi-patty-bg-tasks](https://github.com/patrickrho-patty/pi-patty-bg-tasks)
