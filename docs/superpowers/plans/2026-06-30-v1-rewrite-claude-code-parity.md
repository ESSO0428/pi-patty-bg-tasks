# pi-patty-bg-tasks v1.0 Rewrite — Claude Code Parity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the background tasks extension to achieve feature parity with Claude Code's background task system, eliminating the tmux dependency and fixing all known issues with timers, monitors, cooperative steering, and process lifecycle management.

**Architecture:** Drop the tmux backend entirely. Use direct Node.js `child_process.spawn()` with file-descriptor I/O (stdout/stderr written directly to a file fd, progress extracted by polling the file tail). Align with Claude Code's three backgrounding triggers (explicit `run_in_background`, timeout auto-background, manual Ctrl+Shift+B), proper cooperative steering via Pi's `input` event + `sendUserMessage(deliverAs: "followUp")` (since `waitForIdle()` is only available on `ExtensionCommandContext`, not in `input` event handlers). Simplified TUI task manager using `select()`/`editor()` (available in all contexts).

**Tech Stack:** TypeScript, Node.js child_process, Pi Extension API (`@earendil-works/pi-coding-agent`), Pi TUI primitives (Box, Text, SelectList), node:test for unit tests.

## Global Constraints

- Pi v0.37+ required (for `ctx.ui.custom()`, `ctx.waitForIdle()`, `input` event)
- No tmux dependency — pure Node.js process management
- No npm runtime dependencies beyond Pi's peer deps
- Keyboard shortcuts: Ctrl+Shift+B (background), Ctrl+Shift+J / Shift+Down (task manager), Ctrl+Shift+X (kill latest)
- Slash commands: /bg, /bg-list, /bg-version
- Default auto-background timeout: 120s (matching Claude Code), configurable per-call
- Max output file size: 100 MiB (kill on exceed)
- Output truncation for tool results: 12,000 chars tail
- Max concurrent background jobs: 16
- Tool names: `bash` (override), `bash_bg`, `jobs`, `job_decide`, `agent_bg`
- All comments in English (no Korean comments in new code)
- Tests: node:test with `--experimental-strip-types`

## Reference Implementations

- **Claude Code source:** `/Users/patrickrho/projects/claude-code-source-build/source/src/tasks/` — task framework, LocalShellTask, notification queue, output handling
- **Pi built-in bash:** `/Users/patrickrho/projects/pi/packages/coding-agent/src/core/tools/bash.ts` — createBashTool, BashOperations, OutputAccumulator
- **Pi extension API:** `/Users/patrickrho/projects/pi/packages/coding-agent/src/core/extensions/types.ts` — ExtensionAPI, ExtensionContext, events
- **Pi TUI:** `/Users/patrickrho/projects/pi/packages/tui/src/tui.ts` — Component, Container, Box, Text, SelectList

## Current Issues Being Fixed

1. **Tmux dependency** — eliminates external tool requirement and all tmux-related code (sentinel files, window management, session naming)
2. **Broken cooperative steering** — replaces polling sleep loop with `sendUserMessage(deliverAs: "followUp")` (note: `waitForIdle()` is only on `ExtensionCommandContext`, not available in `input` event handlers)
3. **Timer/monitor accumulation** — centralizes cleanup via AbortController per job instead of scattered cleanup sets
4. **Missing abort signal cleanup** — proper addEventListener/removeEventListener lifecycle
5. **ForegroundSlot type hack** — `proc: { pid: -1 } as never` eliminated
6. **No job limit** — adds max concurrent jobs guard
7. **No progress streaming for agent_bg** — adds watchProgress
8. **Fragile session state** — proper appendEntry with schema versioning
9. **Dead code in statusLabel** — foreground vs background distinction
10. **`/tmp` directory scan** — scoped cleanup to known prefixes only
11. **`resubmitAfterIdle` busy-wait** — replaced with `sendUserMessage(deliverAs: "followUp")` which natively waits for idle
12. **`streamingBehavior` field usage** — `streamingBehavior` IS documented on `InputEvent` (set to `"steer"|"followUp"` when streaming, `undefined` when idle); keep using it for context but don't use it as the sole gating check
13. **No cleanup of running processes on session reload** — `session_shutdown` handler should kill running jobs when reason is `"quit"`, preserve on `"reload"`/`"resume"`
13. **Missing `run_in_background` parameter** — explicit background flag on bash tool (Claude Code parity)

---

## File Structure

### Files to Create (new)
| File | Responsibility |
|------|---------------|
| `src/spawn.ts` | Process spawning with file-fd I/O, process tree killing, output file management |
| `src/output.ts` | File-tail polling for progress, bounded tail reads, output truncation |
| `src/tools/bash-params.ts` | Shared bash parameter schema (TypeBox) used by both bash and bash_bg |
| `src/__tests__/spawn.test.ts` | Tests for spawn, kill, file-fd I/O |
| `src/__tests__/output.test.ts` | Tests for tail polling, truncation |

### Files to Rewrite (delete old, write new)
| File | What Changes |
|------|-------------|
| `src/proc.ts` | Remove ALL tmux code. Keep only: `killProcessTree()`, `processExists()`, `clearTimer()`. Add: file-fd spawn. |
| `src/tools/bash.ts` | Remove tmux backend, remove dual-path. Single backend: file-fd spawn with race(exit, pause). Add `run_in_background` param. |
| `src/tools/bash-bg.ts` | Remove tmux backend. Use same file-fd spawn. Simplify to thin wrapper over spawn+monitor. |
| `src/tools/agent-bg.ts` | Add progress streaming via watchProgress. Resolve pi binary path. |
| `src/input.ts` | Replace polling sleep loop with `sendUserMessage(deliverAs: "followUp")`. Simplify event checks. |
| `src/ui.ts` | Simplify to English-only. Remove Korean locale. Remove dynamic import of lifecycle. Keep select()/editor() pattern (works in both command and shortcut contexts). |

### Files to Modify (incremental changes)
| File | What Changes |
|------|-------------|
| `src/types.ts` | Remove `TmuxContext`, `TMUX_*` constants. Add `MAX_CONCURRENT_JOBS`. Simplify `Job` (remove tmux field). |
| `src/state.ts` | Add `jobAborts` map (AbortController per job). Keep `foreground` map (still needed for Ctrl+Shift+B). Remove `jobCleanups` map, `tmuxAvailable`, `tmuxWarningShown`. |
| `src/lifecycle.ts` | Remove all tmux references. Simplify `terminateJob()`. Use AbortController per job for cleanup. |
| `src/registry.ts` | Remove `capturePane` import. Simplify `readLogTail` (file-only, no tmux fallback). |
| `src/monitoring.ts` | Keep watchProgress/watchStalls. No tmux references to remove (already file-only). |
| `src/lifecycle.ts` | Remove `watchProgress`/`watchStalls` re-export (callers import from monitoring.ts directly). Remove all tmux imports. Replace `registerJobCleanup`/`runJobCleanup` with `createJobAbort`/`abortJob`. |
| `src/format.ts` | Fix dead `statusLabel` branches. |
| `src/shortcuts.ts` | No changes needed. |
| `src/commands.ts` | No changes needed. |
| `src/log-search.ts` | Remove tmux pane fallback in scanText. |
| `src/tools/jobs.ts` | Update imports after lifecycle.ts API change (`ensureCompletionPromise`, `markTerminal` stay; `registerJobCleanup` removed). Remove any `TmuxContext` references from type casts. |
| `src/tools/job-decide.ts` | No structural changes needed (already tmux-free). Verify imports compile after lifecycle.ts changes. |
| `src/index.ts` | Remove `isTmuxAvailable()` call. Simplify session_start. Add process cleanup on `session_shutdown` with `event.reason === "quit"`. |

### Files to Delete
| File | Reason |
|------|--------|
| (none — all files are rewritten in place) | |

---

### Task 1: Strip Tmux and Simplify Core Types

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state.ts`
- Modify: `src/format.ts`
- Test: `src/__tests__/format.test.ts`

**Interfaces:**
- Produces: `Job` type (without `tmux` field), `ForegroundSlot` (without proc hack), `MAX_CONCURRENT_JOBS`, `BackgroundRegistry` (with `abortControllers` map)

- [ ] **Step 1: Rewrite `src/types.ts` — remove tmux, add job limit**

```typescript
// src/types.ts
import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const PERSISTED_STATE_SCHEMA_VERSION = 2;

// --- Configuration constants ---
export const DEFAULT_TIMEOUT_MS = 120_000;
export const QUICK_COMPLETION_MS = 2_000;
export const FOREGROUND_TAIL_BYTES = 4_096;
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_LOG_BYTES = 100 * 1024 * 1024;
export const OUTPUT_PREVIEW_CHARS = 12_000;
export const RECENT_TERMINAL_KEEP = 20;
export const MAX_CONCURRENT_JOBS = 16;

export const PREVIEW_CHARS = {
    sidebar: 25,
    taskList: 40,
    detail: 50,
    line: 80,
} as const;

// --- Domain types ---
export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface Job {
    id: string;
    name?: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    proc?: ChildProcess;
    toolCallId: string;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    outputConsumed?: boolean;
    isBackgrounded: boolean;
}

export type BackgroundReason = "manual" | "timeout";

export interface ForegroundSlot {
    toolCallId: string;
    command: string;
    logPath: string;
    pid: number;
    requestPause: (reason: BackgroundReason) => void;
}

// --- Event types ---
export const EVENT = {
    state: "background-tasks-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    attach: "bg-attach",
    background: "bg-manual",
    agentResume: "agent-resume",
    jobFinished: "job-finished",
} as const;

export type EventName = (typeof EVENT)[keyof typeof EVENT];

// --- UI context ---
export interface UiContext {
    ui: {
        notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}

export type ToolResult = AgentToolResult<unknown>;
```

- [ ] **Step 2: Rewrite `src/state.ts` — add AbortController map, remove foreground map**

```typescript
// src/state.ts
import type { Job, ForegroundSlot } from "./types.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    foreground = new Map<string, ForegroundSlot>();
    counter = 0;
    activeToolCallId: string | null = null;
    pendingDecisionJobId: string | undefined;

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];
}
```

- [ ] **Step 3: Fix dead `statusLabel` branches in `src/format.ts`**

Replace the `statusLabel` function:

```typescript
export function statusLabel(job: Job, duration?: string): string {
    const dur = duration ?? formatDuration(Date.now() - job.startTime);
    switch (job.status) {
        case "running":
            return job.isBackgrounded ? `▶ bg (${dur})` : `▶ fg (${dur})`;
        case "completed":
            return "✓ completed";
        case "failed":
            return "✗ failed";
        case "killed":
            return "✗ killed";
    }
}
```

- [ ] **Step 4: Update format test to cover fg/bg distinction**

Add to `src/__tests__/format.test.ts`:

```typescript
test("statusLabel distinguishes foreground and background", () => {
    const base = { id: "j1", command: "ls", pid: 1, startTime: Date.now(), logPath: "/tmp/x", toolCallId: "t1" };
    const fg = { ...base, status: "running" as const, isBackgrounded: false };
    const bg = { ...base, status: "running" as const, isBackgrounded: true };
    assert.ok(statusLabel(fg).includes("fg"));
    assert.ok(statusLabel(bg).includes("bg"));
});
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/format.test.ts'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/state.ts src/format.ts src/__tests__/format.test.ts
git commit -m "refactor: strip tmux types, add job limit constant, fix statusLabel"
```

---

### Task 2: Rewrite Process Spawning — File-FD I/O Backend

**Files:**
- Create: `src/spawn.ts`
- Create: `src/__tests__/spawn.test.ts`
- Modify: `src/proc.ts` (gut and simplify)

**Interfaces:**
- Produces: `spawnWithFileOutput(command, cwd, logPath, signal?)` returning `{ pid, exit: Promise<number|null>, logPath }`, `killProcessTree(pid, signal?)`, `processExists(pid)`
- Consumed by: Task 3 (bash tool), Task 4 (bash_bg tool), Task 5 (agent_bg tool)

- [ ] **Step 1: Write failing tests for `src/spawn.ts`**

```typescript
// src/__tests__/spawn.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Will import from spawn.ts once created
// import { spawnWithFileOutput, killProcessTree, processExists } from "../spawn.ts";

const testDir = join(tmpdir(), `pi-bg-test-${process.pid}`);

describe("spawnWithFileOutput", () => {
    test("captures stdout to log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stdout.log");
        const result = spawnWithFileOutput({
            command: 'echo "hello world"',
            cwd: process.cwd(),
            logPath,
        });
        assert.ok(result.pid > 0);
        const code = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("hello world"));
        unlinkSync(logPath);
    });

    test("captures stderr to same log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stderr.log");
        const result = spawnWithFileOutput({
            command: 'echo "err msg" >&2',
            cwd: process.cwd(),
            logPath,
        });
        const code = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("err msg"));
        unlinkSync(logPath);
    });

    test("returns non-zero exit code on failure", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-fail.log");
        const result = spawnWithFileOutput({
            command: "exit 42",
            cwd: process.cwd(),
            logPath,
        });
        const code = await result.exit;
        assert.equal(code, 42);
        try { unlinkSync(logPath); } catch {}
    });

    test("respects AbortSignal", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-abort.log");
        const ac = new AbortController();
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
            signal: ac.signal,
        });
        // Give process time to start
        await new Promise((r) => setTimeout(r, 200));
        ac.abort();
        const code = await result.exit;
        // Killed process returns non-zero or null
        assert.ok(code !== 0);
        try { unlinkSync(logPath); } catch {}
    });
});

describe("killProcessTree", () => {
    test("kills a running process", async () => {
        const { spawnWithFileOutput, killProcessTree, processExists } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-kill.log");
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
        });
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(processExists(result.pid));
        killProcessTree(result.pid);
        await result.exit;
        // After exit, process should be gone (give OS a moment)
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!processExists(result.pid));
        try { unlinkSync(logPath); } catch {}
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/spawn.test.ts'`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/spawn.ts`**

```typescript
// src/spawn.ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<number | null>;
}

/**
 * Spawn `bash -c <command>` with stdout+stderr written directly to a file
 * descriptor. The child is detached so we can SIGTERM the whole process group.
 *
 * This is the Claude Code pattern: the kernel writes output to disk with zero
 * JS involvement. Progress is extracted by polling the file tail separately.
 */
export function spawnWithFileOutput(args: {
    command: string;
    cwd: string;
    logPath: string;
    signal?: AbortSignal;
}): SpawnResult {
    mkdirSync(dirname(args.logPath), { recursive: true });
    const logFd = openSync(args.logPath, "w");

    const proc = spawn("bash", ["-c", args.command], {
        stdio: ["ignore", logFd, logFd],
        cwd: args.cwd,
        detached: true,
        env: { ...process.env },
    });
    closeSync(logFd);

    if (!proc.pid) throw new Error("Failed to spawn process");
    const pid = proc.pid;

    // AbortSignal handling — kill process tree on abort.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) {
            onAbort();
        } else {
            args.signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    const exit = new Promise<number | null>((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    }).finally(() => {
        args.signal?.removeEventListener("abort", onAbort);
    });

    proc.unref();

    return { pid, logPath: args.logPath, exit };
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
```

- [ ] **Step 4: Gut `src/proc.ts` — keep only shell helpers, remove all tmux code**

Replace the entire file:

```typescript
// src/proc.ts — minimal shell helpers (tmux removed)
export { spawnWithFileOutput, killProcessTree, processExists } from "./spawn.ts";

/** Idempotent clearTimeout that accepts null/undefined. */
export function clearTimer(timer: NodeJS.Timeout | null | undefined): void {
    if (timer) clearTimeout(timer);
}
```

- [ ] **Step 5: Run tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/spawn.test.ts'`
Expected: PASS (all 5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/spawn.ts src/proc.ts src/__tests__/spawn.test.ts
git commit -m "feat: file-fd spawn backend, remove all tmux code"
```

---

### Task 3: Rewrite Output Polling and Truncation

**Files:**
- Create: `src/output.ts`
- Create: `src/__tests__/output.test.ts`
- Modify: `src/monitoring.ts` (simplify — remove tmux references)
- Modify: `src/registry.ts` (simplify readLogTail — file-only)
- Modify: `src/log-search.ts` (remove tmux pane fallback)

**Interfaces:**
- Produces: `pollFileTail(logPath, onUpdate, intervalMs?)` returning `{ stop() }`, `readBoundedTail(logPath, maxChars)` returning `string`
- Consumed by: Task 4 (bash tool), Task 5 (bash_bg), Task 6 (agent_bg)

- [ ] **Step 1: Write failing tests for `src/output.ts`**

```typescript
// src/__tests__/output.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `pi-bg-output-test-${process.pid}`);

describe("readBoundedTail", () => {
    test("reads small file entirely", async () => {
        const { readBoundedTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "small.log");
        writeFileSync(p, "hello\nworld\n");
        const result = readBoundedTail(p, 1000);
        assert.equal(result, "hello\nworld\n");
        unlinkSync(p);
    });

    test("truncates large file to tail", async () => {
        const { readBoundedTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "large.log");
        const content = "x".repeat(10_000);
        writeFileSync(p, content);
        const result = readBoundedTail(p, 100);
        assert.ok(result.length <= 200); // truncation marker + 100 chars
        assert.ok(result.includes("truncated"));
        unlinkSync(p);
    });

    test("returns fallback for missing file", async () => {
        const { readBoundedTail } = await import("../output.ts");
        const result = readBoundedTail("/nonexistent/file.log", 1000);
        assert.equal(result, "(no output yet)");
    });
});

describe("pollFileTail", () => {
    test("calls onUpdate when file grows", async () => {
        const { pollFileTail } = await import("../output.ts");
        mkdirSync(testDir, { recursive: true });
        const p = join(testDir, "poll.log");
        writeFileSync(p, "");

        const updates: string[] = [];
        const poller = pollFileTail(p, (text) => updates.push(text), 50);

        appendFileSync(p, "line 1\n");
        await new Promise((r) => setTimeout(r, 200));
        appendFileSync(p, "line 2\n");
        await new Promise((r) => setTimeout(r, 200));

        poller.stop();
        assert.ok(updates.length >= 1, `expected updates, got ${updates.length}`);
        unlinkSync(p);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/output.test.ts'`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/output.ts`**

```typescript
// src/output.ts
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { FOREGROUND_TAIL_BYTES } from "./types.ts";

/**
 * Read the tail of a log file, bounded by maxChars.
 * For large files, only the last maxChars bytes are read (O(maxChars), not O(fileSize)).
 */
export function readBoundedTail(logPath: string, maxChars: number): string {
    try {
        const { size } = statSync(logPath);
        if (size === 0) return "(no output yet)";
        if (size <= maxChars) return readFileSync(logPath, "utf-8");
        const fd = openSync(logPath, "r");
        try {
            const buf = Buffer.alloc(maxChars);
            readSync(fd, buf, 0, maxChars, Math.max(0, size - maxChars));
            return `...[truncated, showing last ${maxChars} chars]\n${buf.toString("utf-8")}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return "(no output yet)";
    }
}

/**
 * Poll a log file tail at `intervalMs` (default 1000ms). Calls `onUpdate`
 * only when content changes. Returns a handle with `stop()`.
 *
 * This is the Claude Code pattern: the file is written to by the child
 * process via file descriptor. We poll the tail for progress display.
 */
export function pollFileTail(
    logPath: string,
    onUpdate: (text: string) => void,
    intervalMs = 1_000
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    let stopped = false;

    const timer = setTimeout(function tick() {
        if (stopped) return;
        try {
            const { size } = statSync(logPath);
            if (size === lastSize) {
                timer.refresh();
                return;
            }
            lastSize = size;
            const fd = openSync(logPath, "r");
            try {
                const readStart = Math.max(0, size - FOREGROUND_TAIL_BYTES);
                const toRead = Math.min(size, FOREGROUND_TAIL_BYTES);
                const buf = Buffer.alloc(toRead);
                readSync(fd, buf, 0, toRead, readStart);
                const content = buf.toString("utf-8", 0, toRead);
                if (content && content !== lastContent) {
                    lastContent = content;
                    onUpdate(content);
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            // File not yet created or locked — retry next tick.
        }
        if (!stopped) timer.refresh();
    }, intervalMs);
    (timer as NodeJS.Timeout).unref();

    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
        },
    };
}
```

- [ ] **Step 4: Simplify `src/registry.ts` — remove tmux capturePane fallback**

Replace the `readLogTail` function:

```typescript
export function readLogTail(job: Job, maxChars: number): string {
    return readBoundedTail(job.logPath, maxChars);
}
```

Add the import at the top:

```typescript
import { readBoundedTail } from "./output.ts";
```

Remove the `capturePane` import and `TMUX_PANE_LINES` import.

- [ ] **Step 5: Simplify `src/log-search.ts` — remove tmux pane fallback**

In `searchLogs`, remove the tmux fallback branch. Replace:

```typescript
if (!scanned && job.tmux) {
    scanText(
        job,
        args.pattern,
        readLogTail(job, OUTPUT_PREVIEW_CHARS),
        groups,
        { maxHitsPerJob: args.maxHitsPerJob, maxLineChars }
    );
}
```

With:

```typescript
if (!scanned) {
    scanText(
        job,
        args.pattern,
        readLogTail(job, OUTPUT_PREVIEW_CHARS),
        groups,
        { maxHitsPerJob: args.maxHitsPerJob, maxLineChars }
    );
}
```

Remove the `import { readLogTail }` if it came from registry — it should now come from output.ts indirectly via registry.

- [ ] **Step 6: Simplify `src/monitoring.ts` — update imports only**

`monitoring.ts` doesn't reference tmux directly. Just verify the `watchProgress` and `watchStalls` functions still compile after the types.ts changes (the `TmuxContext` removal shouldn't affect them since they only use `logPath` and `jobId`).

- [ ] **Step 7: Run all tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/output.test.ts' 'src/__tests__/format.test.ts' 'src/__tests__/registry.test.ts'`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/output.ts src/registry.ts src/log-search.ts src/monitoring.ts src/__tests__/output.test.ts
git commit -m "feat: file-tail output polling, remove tmux fallbacks"
```

---

### Task 4: Rewrite Bash Tool — Single Backend with `run_in_background`

**Files:**
- Create: `src/tools/bash-params.ts`
- Rewrite: `src/tools/bash.ts`
- Modify: `src/lifecycle.ts`
- Test: `src/__tests__/lifecycle.test.ts` (update existing)

**Interfaces:**
- Consumes: `spawnWithFileOutput` from Task 2, `pollFileTail`/`readBoundedTail` from Task 3
- Produces: Registered `bash` tool with `run_in_background` parameter, `promoteToBackground()` helper

- [ ] **Step 1: Create shared parameter schema `src/tools/bash-params.ts`**

```typescript
// src/tools/bash-params.ts
import { Type } from "@earendil-works/pi-ai";

export const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 120)" })
    ),
    run_in_background: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately. " +
                "Output is saved to /tmp/pi-bg-<jobId>.log.",
        })
    ),
    description: Type.Optional(
        Type.String({ description: "Short description of what this command does" })
    ),
});
```

- [ ] **Step 2: Rewrite `src/lifecycle.ts` — remove tmux, use AbortController per job**

Key changes to make in lifecycle.ts:
1. Remove all imports from proc.ts that reference tmux (`killTmuxWindow`, `readExitSentinel`, etc.)
2. Import from `spawn.ts` instead: `killProcessTree`, `processExists`
3. Remove the `reviveAndValidate` tmux branch (sentinel file check)
4. Replace `registerJobCleanup`/`runJobCleanup` with AbortController pattern (`createJobAbort`/`abortJob`)
5. Remove `cleanupStaleRuntimeArtifacts` `/tmp` full scan — replace with targeted cleanup (pi-bg- prefix only)
6. Remove the re-export line `export { watchProgress, watchStalls } from "./monitoring.ts"` — callers (bash.ts, bash-bg.ts, agent-bg.ts) now import from `./lifecycle.ts` for `watchStalls` or from `./output.ts` for `pollFileTail`. The `watchStalls` function stays in monitoring.ts and is imported directly by lifecycle.ts consumers.
7. Keep `isAutoBackgroundAllowed`, `detectBlockedSleep`, `isBlankCommand`, `requireExistingCwd`

Replace `registerJobCleanup` and `runJobCleanup`:

```typescript
/** Create an AbortController for a job. Aborting it cancels all monitors. */
export function createJobAbort(reg: BackgroundRegistry, jobId: string): AbortController {
    const existing = reg.jobAborts.get(jobId);
    if (existing) return existing;
    const ac = new AbortController();
    reg.jobAborts.set(jobId, ac);
    return ac;
}

/** Abort all monitors for a job and remove the controller. */
export function abortJob(reg: BackgroundRegistry, jobId: string): void {
    const ac = reg.jobAborts.get(jobId);
    if (ac) {
        ac.abort();
        reg.jobAborts.delete(jobId);
    }
}
```

Update `completeJob` to use `abortJob` instead of `runJobCleanup`:

```typescript
export function completeJob(args: {
    job: Job;
    code: number | null | undefined;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    const finished = findJob(args.reg, args.job.id) ?? args.job;
    abortJob(args.reg, finished.id);
    markTerminal(finished, statusFromExit(args.code), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
    }
    forget(args.reg, finished);
    renderSidebar(args.reg, args.ctx);
}
```

Update `terminateJobSilently`:

```typescript
export function terminateJobSilently(reg: BackgroundRegistry, job: Job): void {
    terminateJob(job);
    markKilledSilently(job);
    abortJob(reg, job.id);
    if (reg.pendingDecisionJobId === job.id) {
        reg.pendingDecisionJobId = undefined;
    }
}
```

Simplify `terminateJob` (no tmux):

```typescript
export function terminateJob(job: Job): void {
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}
```

Simplify `reviveAndValidate` (no tmux sentinel):

```typescript
export function reviveAndValidate(_reg: BackgroundRegistry, job: Job): "alive" | "completed" {
    if (job.status !== "running") return "completed";
    if (!processExists(job.pid)) {
        markTerminal(job, "failed");
        return "completed";
    }
    return "alive";
}
```

Replace `cleanupStaleRuntimeArtifacts`:

```typescript
export function cleanupStaleRuntimeArtifacts(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let entries;
    try {
        entries = readdirSync("/tmp", { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("pi-bg-")) continue;
        const fullPath = pathJoin("/tmp", entry.name);
        try {
            const { mtimeMs } = fsStatSync(fullPath);
            if (now - mtimeMs > MAX_AGE_MS) fsUnlink(fullPath);
        } catch { /* already gone */ }
    }
}
```

- [ ] **Step 3: Rewrite `src/tools/bash.ts` — single file-fd backend**

The core structure:

```typescript
// src/tools/bash.ts
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "../state.ts";
import {
    DEFAULT_TIMEOUT_MS, MAX_CONCURRENT_JOBS,
    OUTPUT_PREVIEW_CHARS, QUICK_COMPLETION_MS,
    type ForegroundSlot, type Job, type UiContext,
} from "../types.ts";
import { spawnWithFileOutput, killProcessTree } from "../spawn.ts";
import { pollFileTail, readBoundedTail } from "../output.ts";
import { add, nextJobId, logPathFor, readLogTail, renderSidebar } from "../registry.ts";
import {
    completeJob, ensureCompletionPromise, createJobAbort,
    detectBlockedSleep, isAutoBackgroundAllowed, isBlankCommand,
    isSignalExit, requestJobDecision, requireExistingCwd,
    terminateJobSilently, watchStalls,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";
import { bashParamSchema } from "./bash-params.ts";

type BashCtx = UiContext & { cwd: string };

export function registerBashTool(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    originalBash: ReturnType<typeof createBashTool>
): void {
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description:
            "Run a bash command. Long-running commands auto-background after timeout. " +
            "Set run_in_background=true to start in background immediately. " +
            "Use /bg to manually background a running command.",
        promptSnippet: "Run shell commands; long-running commands auto-background or use run_in_background=true",
        promptGuidelines: [
            "Use bash with run_in_background=true when a command is expected to run for a long time.",
            "Check background job status with jobs action='list'.",
            "Read background output with jobs action='output'.",
        ],
        parameters: bashParamSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const p = params as {
                command: string;
                timeout?: number;
                run_in_background?: boolean;
                description?: string;
            };
            const bashCtx = ctx as BashCtx;

            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);

            const sleepMatch = detectBlockedSleep(p.command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash with run_in_background=true for long waits.`
                );
            }

            // Enforce job limit.
            const running = Array.from(reg.jobs.values()).filter((j) => j.status === "running");
            if (running.length >= MAX_CONCURRENT_JOBS) {
                throw new Error(
                    `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                    `Kill or wait for existing jobs before starting new ones.`
                );
            }

            // Explicit background mode — spawn and return immediately.
            if (p.run_in_background) {
                return spawnBackground({
                    toolCallId, command: p.command, name: p.description,
                    cwd: bashCtx.cwd, reg, pi, ctx: bashCtx,
                });
            }

            // Foreground mode — race between completion and backgrounding.
            return runForeground({
                toolCallId, command: p.command,
                timeoutMs: p.timeout ? p.timeout * 1000 : DEFAULT_TIMEOUT_MS,
                signal, onUpdate, ctx: bashCtx, reg, pi,
            });
        },
    });
}

async function runForeground(args: {
    toolCallId: string;
    command: string;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<unknown> | undefined;
    ctx: BashCtx;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
}): Promise<AgentToolResult<unknown>> {
    const { toolCallId, command, timeoutMs, signal, onUpdate, ctx, reg, pi } = args;
    const id = nextJobId(reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command, cwd: ctx.cwd, logPath, signal,
    });

    // Register foreground slot for Ctrl+Shift+B.
    let pauseResolve: ((reason: "manual" | "timeout") => void) | null = null;
    const pausePromise = new Promise<"manual" | "timeout">((r) => { pauseResolve = r; });
    const requestPause = (reason: "manual" | "timeout") => pauseResolve?.(reason);

    const slot: ForegroundSlot = {
        toolCallId, command, logPath, pid: spawned.pid, requestPause,
    };
    reg.foreground.set(toolCallId, slot);
    reg.activeToolCallId = toolCallId;

    const job: Job = {
        id, command, pid: spawned.pid, startTime: Date.now(),
        status: "running", logPath, toolCallId, isBackgrounded: false,
    };
    add(reg, job);

    // Timeout timer.
    const timeoutTimer = setTimeout(() => {
        if (reg.nonInteractive) return;
        if (!reg.foreground.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killProcessTree(spawned.pid, "SIGTERM");
            return;
        }
        requestPause("timeout");
    }, timeoutMs);
    (timeoutTimer as NodeJS.Timeout).unref();

    let progressPoller: { stop: () => void } | undefined;

    const cleanup = () => {
        progressPoller?.stop();
        clearTimeout(timeoutTimer);
    };

    try {
        // Quick completion window (2s).
        const quickResult = await Promise.race<{ code: number | null } | null>([
            spawned.exit.then((c) => ({ code: c })),
            new Promise<null>((r) => {
                const t = setTimeout(r, QUICK_COMPLETION_MS);
                (t as NodeJS.Timeout).unref();
            }),
        ]);

        if (quickResult !== null) {
            cleanup();
            reg.foreground.delete(toolCallId);
            if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
            reg.jobs.delete(id);
            const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
            if (quickResult.code !== 0 && quickResult.code !== null && !isSignalExit(quickResult.code)) {
                throw new Error(output || `Command exited with code ${quickResult.code}`);
            }
            return { content: [textBlock(output || "(no output)")], details: undefined };
        }

        // Still running — start progress polling.
        progressPoller = pollFileTail(logPath, (text) => {
            onUpdate?.({ content: [{ type: "text", text }], details: undefined });
        });

        // Race: completion vs backgrounding.
        const race = await Promise.race<
            | { kind: "completed"; code: number | null }
            | { kind: "backgrounded"; reason: "manual" | "timeout" }
        >([
            spawned.exit.then((c) => ({ kind: "completed" as const, code: c })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);

        if (race.kind === "backgrounded") {
            cleanup();
            reg.foreground.delete(toolCallId);
            reg.activeToolCallId = null;
            job.isBackgrounded = true;
            ensureCompletionPromise(job);

            const jobAc = createJobAbort(reg, id);
            const cancelStall = watchStalls({
                jobId: id, command, logPath, pi,
                onOversize: () => terminateJobSilently(reg, job),
            });
            jobAc.signal.addEventListener("abort", cancelStall, { once: true });

            spawned.exit.then((code) => {
                completeJob({ job, code, reg, pi, ctx });
            });

            renderSidebar(reg, ctx);
            if (race.reason === "timeout") {
                requestJobDecision({
                    reg, pi, job, timeoutMs,
                    location: { kind: "pid", pid: spawned.pid },
                });
            }

            return {
                content: [textBlock(
                    `Process backgrounded as ${id}\nCommand: ${command}\nPID: ${spawned.pid}\nOutput: ${logPath}`
                )],
                details: undefined,
            };
        }

        // Normal completion.
        cleanup();
        reg.foreground.delete(toolCallId);
        if (reg.activeToolCallId === toolCallId) reg.activeToolCallId = null;
        reg.jobs.delete(id);
        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        if (race.code !== 0 && race.code !== null && !isSignalExit(race.code)) {
            throw new Error(output || `Command exited with code ${race.code}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        cleanup();
    }
}

function spawnBackground(args: {
    toolCallId: string;
    command: string;
    name?: string;
    cwd: string;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): AgentToolResult<unknown> {
    const id = nextJobId(args.reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command: args.command, cwd: args.cwd, logPath,
    });

    const job: Job = {
        id, name: args.name, command: args.command, pid: spawned.pid,
        startTime: Date.now(), status: "running", logPath,
        toolCallId: args.toolCallId, isBackgrounded: true,
    };
    ensureCompletionPromise(job);
    add(args.reg, job);

    const jobAc = createJobAbort(args.reg, id);
    const cancelStall = watchStalls({
        jobId: id, command: args.command, logPath, pi: args.pi,
        onOversize: () => terminateJobSilently(args.reg, job),
    });
    jobAc.signal.addEventListener("abort", cancelStall, { once: true });

    spawned.exit.then((code) => {
        completeJob({ job, code, reg: args.reg, pi: args.pi, ctx: args.ctx });
    });

    renderSidebar(args.reg, args.ctx);
    return {
        content: [textBlock(
            `Command running in background with ID: ${id}.${args.name ? ` Name: ${args.name}.` : ""} Output is being written to: ${logPath}`
        )],
        details: undefined,
    };
}
```

- [ ] **Step 4: Update lifecycle tests for new API**

Update `src/__tests__/lifecycle.test.ts` to replace `registerJobCleanup`/`runJobCleanup` references with `createJobAbort`/`abortJob`, and remove any tmux-related test cases.

- [ ] **Step 5: Run all tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/bash.ts src/tools/bash-params.ts src/lifecycle.ts src/__tests__/lifecycle.test.ts
git commit -m "feat: rewrite bash tool — single file-fd backend, run_in_background param"
```

---

### Task 5: Rewrite bash_bg Tool (Thin Wrapper)

**Files:**
- Rewrite: `src/tools/bash-bg.ts`

**Interfaces:**
- Consumes: `spawnWithFileOutput` from Task 2, `createJobAbort`/`watchStalls` from Task 4
- Produces: Registered `bash_bg` tool

- [ ] **Step 1: Rewrite `src/tools/bash-bg.ts`**

The bash_bg tool becomes a thin wrapper — it's essentially the `spawnBackground` path from the bash tool, with the `name`, `timeout`, and `notify` parameters:

```typescript
// src/tools/bash-bg.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { MAX_CONCURRENT_JOBS, type Job, type UiContext } from "../types.ts";
import { spawnWithFileOutput } from "../spawn.ts";
import { add, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import {
    completeJob, createJobAbort, ensureCompletionPromise,
    isAutoBackgroundAllowed, isBlankCommand, requestJobDecision,
    requireExistingCwd, terminateJobSilently, watchStalls,
} from "../lifecycle.ts";
import { textBlock } from "../format.ts";

type BashBgCtx = UiContext & { cwd: string };

export function registerBashBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Start a bash command in the background immediately. " +
            "Output is saved to /tmp/pi-bg-<jobId>.log.",
        promptSnippet: "Start long-running commands directly in the background",
        promptGuidelines: [
            "Use bash_bg when a command should definitely start in the background.",
            "Give the job a name when it will be easier to track in jobs list.",
        ],
        parameters: Type.Object({
            command: Type.String({ description: "Command to run" }),
            name: Type.Optional(Type.String({ description: "Label shown in jobs list" })),
            timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
            notify: Type.Optional(Type.Boolean({ description: "Notify on completion (default: true)" })),
        }),

        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as { command: string; name?: string; timeout?: number; notify?: boolean };
            const ctx2 = ctx as BashBgCtx;
            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(ctx2.cwd);

            const running = Array.from(reg.jobs.values()).filter((j) => j.status === "running");
            if (running.length >= MAX_CONCURRENT_JOBS) {
                throw new Error(`Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached.`);
            }

            const shouldNotify = p.notify !== false;
            const id = nextJobId(reg);
            const logPath = logPathFor(id);

            const spawned = spawnWithFileOutput({
                command: p.command, cwd: ctx2.cwd, logPath,
            });

            const job: Job = {
                id, name: p.name, command: p.command, pid: spawned.pid,
                startTime: Date.now(), status: "running", logPath,
                toolCallId, isBackgrounded: true,
            };
            ensureCompletionPromise(job);
            add(reg, job);

            const jobAc = createJobAbort(reg, id);
            const cancelStall = watchStalls({
                jobId: id, command: p.command, logPath, pi,
                onOversize: () => terminateJobSilently(reg, job),
            });
            jobAc.signal.addEventListener("abort", cancelStall, { once: true });

            // Optional timeout.
            if (p.timeout) {
                const timer = setTimeout(() => {
                    if (job.status !== "running" || reg.nonInteractive) return;
                    if (!isAutoBackgroundAllowed(p.command)) {
                        terminateJobSilently(reg, job);
                        renderSidebar(reg, ctx2);
                        return;
                    }
                    requestJobDecision({
                        reg, pi, job, timeoutMs: p.timeout! * 1000,
                        location: { kind: "pid", pid: spawned.pid },
                    });
                }, p.timeout * 1000);
                (timer as NodeJS.Timeout).unref();
                jobAc.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
            }

            spawned.exit.then((code) => {
                completeJob({ job, code, reg, pi, ctx: ctx2, shouldNotify });
            });

            renderSidebar(reg, ctx2);
            return {
                content: [textBlock(
                    `Command running in background with ID: ${id}.` +
                    `${p.name ? ` Name: ${p.name}.` : ""} Output is being written to: ${logPath}`
                )],
                details: undefined,
            };
        },
    });
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/bash-bg.ts
git commit -m "refactor: rewrite bash_bg — drop tmux, use file-fd spawn"
```

---

### Task 6: Rewrite agent_bg — Progress Streaming + Binary Resolution

**Files:**
- Rewrite: `src/tools/agent-bg.ts`

**Interfaces:**
- Consumes: `spawnWithFileOutput` from Task 2, `pollFileTail` from Task 3, `createJobAbort` from Task 4
- Produces: Registered `agent_bg` tool with progress streaming

- [ ] **Step 1: Rewrite `src/tools/agent-bg.ts`**

Key changes: resolve pi binary path, add progress streaming, use file-fd spawn:

```typescript
// src/tools/agent-bg.ts
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { BackgroundRegistry } from "../state.ts";
import { MAX_CONCURRENT_JOBS, type Job } from "../types.ts";
import { isBlankCommand, requireExistingCwd as requireCwd } from "../lifecycle.ts";
import { add, nextJobId, logPathFor, renderSidebar } from "../registry.ts";
import { completeJob, createJobAbort, terminateJobSilently, watchStalls } from "../lifecycle.ts";
import { pollFileTail } from "../output.ts";
import { textBlock } from "../format.ts";

/** Resolve the full path to the pi binary. */
function resolvePiBinary(): string {
    try {
        return execSync("which pi", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        return "pi";
    }
}

interface ContentMessage {
    role: string;
    content: string | { type: string; text?: string }[];
}

function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { message: ContentMessage } {
    return entry.type === "message" && "message" in entry;
}

function extractText(content: string | { type: string; text?: string }[]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b): b is { type: string; text: string } =>
            typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n");
}

function lastAssistantText(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (isMessageEntry(e) && e.message.role === "assistant") {
            return extractText(e.message.content).slice(-2_000);
        }
    }
    return "";
}

function firstUserPrompt(entries: SessionEntry[]): string {
    for (const e of entries) {
        if (isMessageEntry(e) && e.message.role === "user") {
            return extractText(e.message.content).slice(0, 2_000);
        }
    }
    return "";
}

export function registerAgentBgTool(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description: "Run a separate pi -p process in the background with continuity context.",
        promptSnippet: "Delegate work to a background pi -p process",
        promptGuidelines: [
            "Use agent_bg for work that can run independently from the current session.",
            "Completion is reported with a background-job notification.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "Task to send to the background agent" }),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
        }),

        async execute(toolCallId, params, _signal, onUpdate, ctx) {
            const p = params as { prompt: string; cwd?: string };
            if (isBlankCommand(p.prompt)) throw new Error("Prompt is empty.");
            const cwd = p.cwd ?? ctx.cwd;
            requireCwd(cwd);

            const running = Array.from(reg.jobs.values()).filter((j) => j.status === "running");
            if (running.length >= MAX_CONCURRENT_JOBS) {
                throw new Error(`Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached.`);
            }

            const id = nextJobId(reg);
            const logPath = logPathFor(id);
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            // Build continuity prompt.
            const entries = ctx.sessionManager.getEntries();
            const summary = lastAssistantText(entries);
            const originalPrompt = firstUserPrompt(entries);
            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "", "## Original task", p.prompt,
                ...(originalPrompt ? ["", "## Previous user context", originalPrompt] : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "", "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${id}.md`;
            writeFileSync(promptFile, promptContent);

            const model = ctx.model;
            const modelArg = model ? `${model.provider}/${model.id}` : undefined;
            const piBin = resolvePiBinary();
            const spawnArgs = [
                "-p", "--mode", "text",
                ...(modelArg ? ["--model", modelArg] : []),
                `@${promptFile}`,
            ];

            let proc;
            try {
                proc = spawn(piBin, spawnArgs, {
                    cwd, detached: true,
                    stdio: ["pipe", "pipe", "pipe"],
                });
            } catch (err) {
                try { unlinkSync(promptFile); } catch {}
                throw err;
            }

            if (!proc.pid) {
                try { unlinkSync(promptFile); } catch {}
                throw new Error("Failed to spawn background agent process");
            }

            const logStream = createWriteStream(logPath, { flags: "w" });
            proc.stdout?.pipe(logStream, { end: false });
            proc.stderr?.pipe(logStream, { end: false });

            const job: Job = {
                id, command: `pi -p (background agent)`, pid: proc.pid,
                startTime: Date.now(), status: "running", logPath,
                proc, toolCallId, isBackgrounded: true,
            };
            add(reg, job);

            const jobAc = createJobAbort(reg, id);

            // Progress streaming — surface agent output via onUpdate.
            const progressPoller = pollFileTail(logPath, (text) => {
                onUpdate?.({ content: [{ type: "text", text }], details: undefined });
            });
            jobAc.signal.addEventListener("abort", () => progressPoller.stop(), { once: true });

            const cancelStall = watchStalls({
                jobId: id, command: job.command, logPath, pi,
                onOversize: () => terminateJobSilently(reg, job),
            });
            jobAc.signal.addEventListener("abort", cancelStall, { once: true });

            const finalize = (code: number | null) => {
                logStream.end();
                completeJob({ job, code, reg, pi, ctx });
                try { unlinkSync(promptFile); } catch {}
            };
            proc.on("close", finalize);
            proc.on("error", () => finalize(1));

            renderSidebar(reg, ctx);
            return {
                content: [textBlock(
                    `Agent running in background with ID: ${id}. Output is being written to: ${logPath}\n` +
                    `Prompt: ${p.prompt.slice(0, 100)}${p.prompt.length > 100 ? "…" : ""}`
                )],
                details: undefined,
            };
        },
    });
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/agent-bg.ts
git commit -m "feat: agent_bg with progress streaming and pi binary resolution"
```

---

### Task 7: Fix Cooperative Steering — Use `sendUserMessage(deliverAs: "followUp")`

**Files:**
- Rewrite: `src/input.ts`
- Modify: `src/__tests__/input.test.ts`

**Interfaces:**
- Consumes: `backgroundActiveForeground` from lifecycle.ts
- Produces: `registerInputHandlers(pi, reg)` using documented Pi API

**Design note:** `waitForIdle()` is only available on `ExtensionCommandContext` (commands), NOT on the `ExtensionContext` passed to `input` event handlers. Instead we use `sendUserMessage(text, { deliverAs: "followUp" })` which natively queues the message until the agent is idle. This matches Claude Code's approach where user input during bash execution is queued (not dropped).

- [ ] **Step 1: Rewrite `src/input.ts`**

```typescript
// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Only intercept when we have an active foreground command.
        if (!reg.activeToolCallId) return { action: "continue" };
        if (!reg.foreground.has(reg.activeToolCallId)) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, pi, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // Abort the current turn so the bash tool returns the "backgrounded" result.
        ctx.abort?.();

        // Resubmit the user's message as a follow-up — Pi delivers it
        // after the current turn settles. No polling needed.
        try {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
        } catch {
            // Session ended between abort and resubmit — nothing to deliver to.
        }

        return { action: "handled" };
    });
}
```

- [ ] **Step 2: Update `src/__tests__/input.test.ts`**

Update the test to verify the new API:
- Mock `ctx.waitForIdle()` instead of checking sleep loops
- Verify `ctx.abort()` is called
- Verify the user message is resubmitted after idle

- [ ] **Step 3: Run tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/input.test.ts'`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/input.ts src/__tests__/input.test.ts
git commit -m "fix: cooperative steering uses waitForIdle instead of polling"
```

---

### Task 8: Rewrite Extension Entry Point — Session Lifecycle

**Files:**
- Rewrite: `src/index.ts`

**Interfaces:**
- Consumes: All tool registration functions from Tasks 4-7
- Produces: Extension entry point with proper session_start/session_shutdown

- [ ] **Step 1: Rewrite `src/index.ts`**

```typescript
// src/index.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import {
    cleanupStaleRuntimeArtifacts, detectNonInteractive, reviveAndValidate,
} from "./lifecycle.ts";
import { forget as forgetJob } from "./registry.ts";
import { EVENT, PERSISTED_STATE_SCHEMA_VERSION, type Job } from "./types.ts";
import { registerBashTool } from "./tools/bash.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerJobDecideTool } from "./tools/job-decide.ts";
import { registerAgentBgTool } from "./tools/agent-bg.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";
import { registerInputHandlers } from "./input.ts";

interface PersistedState {
    schemaVersion?: number;
    jobs?: Array<[string, Omit<Job, "proc" | "donePromise" | "resolveDone">]>;
    jobCounter?: number;
}

export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();

    const originalBash = createBashTool(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerJobDecideTool(pi, reg);
    registerAgentBgTool(pi, reg);

    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);

    pi.on("session_start", async (event, ctx) => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Restore serialized job state.
        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === EVENT.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        for (const entry of stateEntries) {
            const data = entry.data as PersistedState;
            if (data.schemaVersion !== PERSISTED_STATE_SCHEMA_VERSION) continue;
            if (data.jobs) {
                for (const [id, job] of data.jobs) {
                    reviveAndValidate(reg, job);
                    if (job.status !== "running") {
                        forgetJob(reg, job);
                    } else {
                        reg.jobs.set(id, job);
                    }
                }
            }
            if (typeof data.jobCounter === "number") {
                reg.counter = Math.max(reg.counter, data.jobCounter);
            }
        }

        cleanupStaleRuntimeArtifacts();
    });

    pi.on("session_shutdown", async (event, _ctx) => {
        // On quit, kill all running background jobs to avoid orphans.
        if (event.reason === "quit") {
            for (const job of reg.jobs.values()) {
                if (job.status === "running") {
                    terminateJobSilently(reg, job);
                }
            }
        }

        pi.appendEntry(EVENT.state, {
            schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
            jobs: Array.from(reg.jobs.entries()).map(([id, job]) => [
                id,
                { ...job, proc: undefined, donePromise: undefined, resolveDone: undefined },
            ]),
            jobCounter: reg.counter,
        });
    });
}
```

Add `terminateJobSilently` to the imports from lifecycle.ts:

```typescript
import {
    cleanupStaleRuntimeArtifacts, detectNonInteractive, reviveAndValidate,
    terminateJobSilently,
} from "./lifecycle.ts";
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "refactor: clean extension entry — no tmux, schema version bump"
```

---

### Task 9: Rich TUI Task Manager with `ctx.ui.custom()`

**Files:**
- Rewrite: `src/ui.ts`

**Interfaces:**
- Consumes: `BackgroundRegistry`, `Job`, formatting helpers
- Produces: `openBgListPanel(reg, ctx)` using Pi's TUI overlay system

- [ ] **Step 1: Rewrite `src/ui.ts` with `ctx.ui.custom()` overlay**

This task upgrades from the select()-loop to a proper TUI overlay. Since the Pi TUI API provides `ctx.ui.custom(factory, { overlay: true })` where the factory receives `(tui, theme, keybindings, done)` and returns a `Component`, we build a `SelectList`-based panel.

However, `ctx.ui.custom()` is only available on `ExtensionCommandContext` (commands), not on generic `ExtensionContext` (shortcuts). For shortcuts, we fall back to the existing select() approach. For commands, we use the richer overlay.

```typescript
// src/ui.ts
import type { Job, UiContext } from "./types.ts";
import { OUTPUT_PREVIEW_CHARS, PREVIEW_CHARS } from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import { formatDuration } from "./format.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { forget, readLogTail, renderSidebar } from "./registry.ts";

export async function openBgListPanel(
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<void> {
    // Use select()-based panel (works in both command and shortcut contexts).
    while (true) {
        const jobs = getJobList(reg);
        if (jobs.length === 0) {
            ctx.ui.notify("No background tasks", "info");
            return;
        }

        const items = jobs.map((job) => {
            const icon = statusIcon(job);
            const dur = formatDuration(Date.now() - job.startTime);
            const label = job.name ? `${job.name} (${job.id})` : job.id;
            const statusStr = job.status === "running" ? `running (${dur})` : job.status;
            const cmd = job.command.slice(0, PREVIEW_CHARS.taskList);
            return `${icon} ${label}: ${cmd} · ${statusStr}`;
        });

        const choice = await ctx.ui.select("Background Tasks", items);
        if (choice === undefined) return;

        const idx = items.indexOf(choice);
        const job = jobs[idx];
        if (!job) return;

        const continued = await showJobActions(job, reg, ctx);
        if (!continued) return;
    }
}

async function showJobActions(
    job: Job,
    reg: BackgroundRegistry,
    ctx: UiContext
): Promise<boolean> {
    const name = job.name ?? job.id;

    if (job.status === "running") {
        const options = ["Show Output", "Kill", "← Back"];
        const action = await ctx.ui.select(
            `▶ ${name} · ${job.command.slice(0, PREVIEW_CHARS.detail)}`,
            options
        );
        if (action === undefined) return false;
        if (action === "Show Output") { await showOutput(job, ctx); return true; }
        if (action === "Kill") {
            terminateJobSilently(reg, job);
            renderSidebar(reg, ctx);
            ctx.ui.notify(`Killed ${name}`, "info");
            return true;
        }
        return true;
    }

    const options = ["Show Output", "Remove", "← Back"];
    const action = await ctx.ui.select(`${statusIcon(job)} ${name} · ${job.status}`, options);
    if (action === undefined) return false;
    if (action === "Show Output") { await showOutput(job, ctx); return true; }
    if (action === "Remove") {
        forget(reg, job);
        renderSidebar(reg, ctx);
        ctx.ui.notify(`Removed ${name}`, "info");
        return true;
    }
    return true;
}

async function showOutput(job: Job, ctx: UiContext): Promise<void> {
    const out = readLogTail(job, OUTPUT_PREVIEW_CHARS);
    const dur = formatDuration(Date.now() - job.startTime);
    const exitLine = job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";
    await ctx.ui.editor(
        `${statusIcon(job)} ${job.name ?? job.id}`,
        `Command: ${job.command}\n` +
        `PID: ${job.pid} · Started: ${new Date(job.startTime).toLocaleString()}\n` +
        `Duration: ${dur} · Status: ${job.status}${exitLine}\n` +
        `Log: ${job.logPath}\n\n--- OUTPUT ---\n${out}`
    );
}

function getJobList(reg: BackgroundRegistry): Job[] {
    const all = Array.from(reg.jobs.values());
    const running = all.filter((j) => j.status === "running").sort((a, b) => b.startTime - a.startTime);
    const terminal = all.filter((j) => j.status !== "running").sort((a, b) => b.startTime - a.startTime);
    return [...running, ...terminal];
}

function statusIcon(job: Job): string {
    switch (job.status) {
        case "running": return "▶";
        case "completed": return "✓";
        case "failed": return "✗";
        case "killed": return "✗";
    }
}
```

- [ ] **Step 2: Run all tests**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ui.ts
git commit -m "refactor: simplify TUI task manager, English-only labels"
```

---

### Task 10: Update README + Version Bump

**Files:**
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `README.zh.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Updated docs reflecting v1.0 changes

- [ ] **Step 1: Update `package.json` version to 1.0.0**

Change `"version": "0.3.1"` to `"version": "1.0.0"` and update the description:

```json
"description": "Background tasks extension for pi. Claude Code parity — auto-background after 120s, run_in_background flag, Ctrl+Shift+B manual background, file-fd output capture, cooperative steering, agent_bg with progress streaming.",
```

- [ ] **Step 2: Update README.md**

Key changes:
- Remove "tmux is optional but recommended" — no tmux needed
- Add `run_in_background` parameter documentation to bash tool table
- Change default timeout from 15s to 120s in docs
- Update "How It Works" diagram to remove tmux branch
- Add "v1.0 Breaking Changes" section noting tmux removal and timeout change

- [ ] **Step 3: Update README.ko.md and README.zh.md to match**

- [ ] **Step 4: Run final full test suite**

Run: `cd /Users/patrickrho/projects/pi-patty-bg-tasks && node --experimental-strip-types --test --test-force-exit 'src/__tests__/*.test.ts'`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add package.json README.md README.ko.md README.zh.md
git commit -m "docs: v1.0.0 — Claude Code parity, no tmux dependency"
```

---

## Self-Review Checklist

| Spec Requirement | Task |
|-----------------|------|
| Drop tmux dependency | Task 1 (types), Task 2 (spawn), Task 3 (output), Task 4-6 (tools) |
| File-fd I/O (Claude Code pattern) | Task 2 (spawnWithFileOutput) |
| `run_in_background` parameter | Task 4 (bash tool) |
| Fix cooperative steering (sendUserMessage followUp) | Task 7 |
| Fix AbortSignal cleanup | Task 2 (spawn.ts — finally block) |
| Fix ForegroundSlot type hack | Task 1 (pid field instead of proc) |
| Max concurrent jobs limit | Task 1 (constant), Task 4-6 (enforcement) |
| agent_bg progress streaming | Task 6 |
| agent_bg binary resolution | Task 6 (resolvePiBinary) |
| Fix dead statusLabel branches | Task 1 |
| Fix /tmp scan scope | Task 4 (lifecycle.ts cleanup) |
| Session state schema version bump | Task 8 |
| Kill running jobs on session quit | Task 8 (session_shutdown with event.reason) |
| Simplified TUI task manager (English-only) | Task 9 |
| jobs/job_decide compile after lifecycle changes | Task 4 (lifecycle.ts changes), verified in Task 5/8 test runs |
| monitoring.ts / lifecycle.ts re-export cleanup | Task 4 (lifecycle.ts rewrite removes stale re-exports) |
| README/version update | Task 10 |
| Placeholder scan | No TBD/TODO found |
| Type consistency | `Job` (no tmux), `ForegroundSlot` (pid), `BackgroundRegistry` (jobAborts) consistent across all tasks |
