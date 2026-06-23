/**
 * Shared utility functions for the pi-patty-bg-tasks extension.
 *
 * Pure, dependency-free utilities. Anything that touches ExtensionAPI, the
 * tmux backend, or feature orchestration lives in the relevant feature
 * module instead.
 */

import {
    closeSync,
    openSync,
    readdirSync,
    readSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import type { BackgroundJob, JobStatus } from "./types.ts";

// ─── Configuration constants ────────────────────────────────────────

/** Default timeout for foreground bash commands (15s, matching Claude Code). */
export const DEFAULT_TIMEOUT_MS = 15_000;
export const STALL_CHECK_INTERVAL_MS = 5_000;
export const STALL_THRESHOLD_MS = 45_000;
export const STALL_TAIL_BYTES = 1024;
export const MAX_OUTPUT_PREVIEW_CHARS = 12_000;
/** Maximum log file size before the stall watchdog kills the job. */
export const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100 MiB

/** Quick-completion window — commands finishing within this skip the backgrounded path. */
export const QUICK_COMPLETION_MS = 2_000;
/** Tail-read size used by the 1-Hz progress poll to surface live output. */
export const FOREGROUND_TAIL_BYTES = 4_096;
/** Number of recent terminal jobs kept for `jobs output` lookups. */
export const MAX_RECENT_TERMINAL = 20;
/** Lines captured from a tmux pane when a quick-completion path needs the body. */
export const TMUX_CAPTURE_LINES = 2_000;
/** Tmux completion-poller cadence when the window is in the foreground. */
export const TMUX_FOREGROUND_POLL_MS = 200;
/** Tmux completion-poller cadence when the window is in the background. */
export const TMUX_BACKGROUND_POLL_MS = 500;

/** Display-string previews for jobs in the pill bar, job list, and detail view. */
export const COMMAND_PREVIEW_CHARS = {
    widget: 25,
    taskList: 40,
    detail: 50,
    line: 80,
} as const;

// ─── Process management ─────────────────────────────────────────────

/** Kill an entire process group. Requires the child to have been spawned
 *  with `detached: true` so it became a process group leader. */
export function killProcessGroup(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        // Process group kill failed — try just the parent.
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap "is the process alive?" probe via signal 0. Returns false on ESRCH (dead). */
export function isProcessAlive(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM means the process exists but we lack permission to signal it.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Idempotent clearTimeout that accepts null/undefined. */
export function clearTimeoutSafe(
    timer: NodeJS.Timeout | null | undefined
): void {
    if (timer) clearTimeout(timer);
}

// ─── Job helpers ────────────────────────────────────────────────────

export function generateJobId(
    counter: number,
    pid: number = process.pid
): string {
    return `job-${pid}-${counter}`;
}

export function logPathForJob(jobId: string): string {
    return `/tmp/pi-bg-${jobId}.log`;
}

export function createJobDonePromise(job: BackgroundJob): void {
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

export function markJobTerminal(
    job: BackgroundJob,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    // Drop the executor-closure reference so the job can be GC'd promptly.
    delete job.donePromise;
}

/** Map a child-process exit code to a JobStatus. null (killed) → "completed". */
export function exitCodeToStatus(
    code: number | null | undefined
): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

/** Minimal state shape consumed by removeJob — keeps utils stateless wrt state.ts. */
export interface JobState {
    backgroundJobs: Map<string, BackgroundJob>;
    recentTerminalJobs: BackgroundJob[];
    pendingDecisionJobId: string | undefined;
    completedJobCount: number;
    failedJobCount: number;
}

/** Remove a terminal job from the background jobs map and update counters. */
export function removeJob(state: JobState, job: BackgroundJob): void {
    if (!state.backgroundJobs.delete(job.id)) return;
    if (state.pendingDecisionJobId === job.id) {
        state.pendingDecisionJobId = undefined;
    }
    if (job.status === "completed") state.completedJobCount++;
    if (job.status === "failed") state.failedJobCount++;
    state.recentTerminalJobs.push(job);
    if (state.recentTerminalJobs.length > MAX_RECENT_TERMINAL) {
        state.recentTerminalJobs.shift();
    }
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

export function formatJobLine(job: BackgroundJob): string {
    const duration = formatDuration(Date.now() - job.startTime);
    return `${job.id}: ${job.command.slice(0, COMMAND_PREVIEW_CHARS.line)} - ${statusLabel(job, duration)}`;
}

/** Human-readable status string for a job, including its duration when running. */
export function statusLabel(job: BackgroundJob, duration?: string): string {
    switch (job.status) {
        case "running":
            return job.isBackgrounded
                ? `◐ running (${duration ?? formatDuration(Date.now() - job.startTime)})`
                : `▶ running (${duration ?? formatDuration(Date.now() - job.startTime)})`;
        case "completed":
            return "✅ completed";
        case "failed":
            return "❌ failed";
        case "killed":
            return "🛑 killed";
    }
}

/** Truncate a tail with a consistent "showing last N chars" marker. */
export function truncateTail(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return `...[truncated, showing last ${maxChars} chars]\n${content.slice(-maxChars)}`;
}

// ─── Output reading ─────────────────────────────────────────────────

export async function readOutputTail(
    path: string,
    maxChars: number
): Promise<string> {
    let content: string;
    try {
        content = await readFile(path, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return "(no output yet)";
        }
        throw err;
    }
    return truncateTail(content, maxChars);
}

export function readOutputTailSync(path: string, maxChars: number): string {
    try {
        const { size } = statSync(path);
        if (size === 0) return "(no output yet)";
        const fd = openSync(path, "r");
        try {
            const readStart = Math.max(0, size - maxChars);
            const toRead = Math.min(size, maxChars);
            const buf = Buffer.alloc(toRead);
            readSync(fd, buf, 0, toRead, readStart);
            return truncateTail(buf.toString("utf-8", 0, toRead), maxChars);
        } finally {
            closeSync(fd);
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return "(no output yet)";
        }
        throw err;
    }
}

// ─── Stall detection ────────────────────────────────────────────────

const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

/** Interactive-prompt patterns at the end of output that suggest a command is
 *  blocked waiting for keyboard input. */
export function looksLikePrompt(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

// ─── Log file cleanup ──────────────────────────────────────────────

/** Remove stale /tmp/pi-bg-* log files older than 24 hours. */
export function cleanupStaleLogs(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    let entries: import("node:fs").Dirent[];
    try {
        entries = readdirSync("/tmp", { withFileTypes: true });
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("pi-bg-")) continue;
        const filePath = `/tmp/${entry.name}`;
        try {
            const { mtimeMs } = statSync(filePath);
            if (now - mtimeMs > MAX_AGE_MS) unlinkSync(filePath);
        } catch {
            /* file already gone */
        }
    }
}

// ─── Command policies ────────────────────────────────────────────────

/** Commands that should not be automatically backgrounded on timeout. */
const DISALLOWED_AUTO_BACKGROUND_COMMANDS = ["sleep"];

/** Check whether a command is allowed to be auto-backgrounded. */
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND_COMMANDS.includes(base);
}

/**
 * Detect standalone or leading `sleep N` patterns that should run in
 * foreground or use bash_bg instead. Returns the matched command or null.
 * Blocks sleep >= 2 seconds; allows sub-2s pacing.
 */
export function detectBlockedSleep(command: string): string | null {
    const first =
        command
            .trim()
            .split(/&&|;|\|/)[0]
            ?.trim() ?? "";
    const m = /^sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(first);
    if (!m) return null;
    const secs = parseFloat(m[1]);
    if (secs < 2) return null;
    return first;
}

/** True for empty or whitespace-only commands. */
export function isEmptyCommand(command: string): boolean {
    return command.trim().length === 0;
}

/**
 * Whether pi is running non-interactively. Mirrors pi's own mode decision
 * (`parsed.print || !stdinIsTTY`): explicit `-p`/`--print`, or stdin not a TTY
 * (piped / spawned by another process).
 */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

/**
 * Throw if cwd does not exist. The bash and bash_bg tools pass cwd through
 * to spawn(); without this check an ENOENT surfaces as an opaque tool error.
 */
export function assertCwdExists(cwd: string): void {
    try {
        statSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}
