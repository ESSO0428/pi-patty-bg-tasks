/**
 * Background-jobs lifecycle — cross-cutting helpers for managing the
 * registry of background jobs: stall watchdog, status widget, job
 * lookup, kill, completion notification, timeout, progress polling.
 *
 * No tool registration lives here; that is in `index.ts`.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../../state.ts";
import { killWindow } from "../../tmux.ts";
import {
    CUSTOM_TYPE,
    type BackgroundJob,
    type UiContext,
} from "../../types.ts";
import {
    COMMAND_PREVIEW_CHARS,
    createJobDonePromise,
    DEFAULT_TIMEOUT_MS,
    exitCodeToStatus,
    formatDuration,
    FOREGROUND_TAIL_BYTES,
    generateJobId,
    isAutoBackgroundAllowed,
    isProcessAlive,
    killProcessGroup,
    MAX_LOG_BYTES,
    markJobTerminal,
    readOutputTailSync,
    removeJob,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    STALL_THRESHOLD_MS,
} from "../../utils.ts";

/** Build a `{type:"text"}` content block from a string. */
export function textBlock(s: string) {
    return { type: "text" as const, text: s };
}

/**
 * Mark a job as killed and suppress the completion notification.
 * Use in every kill path (tool, shortcut, watchdog) to prevent
 * proc.on("close") from sending a spurious job-completion message
 * that re-enters the agent loop.
 */
export function silenceJobAfterKill(job: BackgroundJob): void {
    markJobTerminal(job, "killed");
    job.outputConsumed = true;
}

// ─── Stall watchdog ─────────────────────────────────────────────────

/** Interactive-prompt regex table used by the stall watchdog. */
const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

function looksLikePromptSync(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

/**
 * Poll the job's log file every STALL_CHECK_INTERVAL_MS. Fires a
 * `bg-stall` follow-up message when:
 *   - the log file exceeds MAX_LOG_BYTES (oversize, after calling
 *     `onOversize` so the caller can SIGTERM the process group), OR
 *   - the file has not grown for STALL_THRESHOLD_MS AND its tail
 *     matches an interactive-prompt pattern.
 *
 * Returns a cancel function the caller MUST invoke on terminal state to
 * avoid a leaked interval (and a spurious stall notification that
 * fires against the now-static output of a finished job).
 */
export function startStallWatchdog(
    jobId: string,
    command: string,
    logPath: string,
    pi: ExtensionAPI,
    onOversize?: () => void
): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
    let cancelled = false;

    const timer = setInterval(() => {
        if (cancelled) return;
        try {
            const { size } = statSync(logPath);

            if (size > MAX_LOG_BYTES) {
                cancelled = true;
                clearInterval(timer);
                if (onOversize) onOversize();
                pi.sendMessage(
                    {
                        customType: CUSTOM_TYPE.stall,
                        content: `⚠️ Background job ${jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
                        display: true,
                        details: { jobId, logPath, command },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
                return;
            }

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
                return;
            }
            if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;

            const tail = readOutputTailSync(logPath, STALL_TAIL_BYTES);
            if (!looksLikePromptSync(tail)) {
                lastGrowth = Date.now();
                return;
            }

            cancelled = true;
            clearInterval(timer);

            const summary =
                `Background job ${jobId} appears to be waiting for interactive input.\n` +
                `Command: ${command}\n\n` +
                `Last output:\n${tail.trimEnd()}\n\n` +
                `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
                `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;

            pi.sendMessage(
                {
                    customType: CUSTOM_TYPE.stall,
                    content: `⚠️ ${summary}`,
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );
        } catch {
            // File may not exist yet — skip this tick
        }
    }, STALL_CHECK_INTERVAL_MS);

    timer.unref();
    return () => {
        cancelled = true;
        clearInterval(timer);
    };
}

// ─── Widget / status bar ────────────────────────────────────────────

export function updateWidget(state: TauState, ctx: UiContext): void {
    const pills: string[] = [];
    let runningCount = 0;

    if (state.agentBackgrounded) pills.push("◐ agent (backgrounded)");

    for (const job of state.backgroundJobs.values()) {
        if (job.status !== "running") continue;
        runningCount++;
        const duration = formatDuration(Date.now() - job.startTime);
        const icon = job.isBackgrounded ? "◐" : "▶";
        pills.push(
            `${icon} ${job.id}: ${job.command.slice(0, COMMAND_PREVIEW_CHARS.widget)} (${duration})`
        );
    }

    if (pills.length === 0) {
        ctx.ui.setWidget("background-jobs", undefined);
        ctx.ui.setStatus("background-jobs", undefined);
        return;
    }

    ctx.ui.setWidget("background-jobs", pills);

    const parts = [`${runningCount} running`];
    if (state.completedJobCount > 0) parts.push(`${state.completedJobCount} done`);
    if (state.failedJobCount > 0) parts.push(`${state.failedJobCount} failed`);
    ctx.ui.setStatus(
        "background-jobs",
        ctx.ui.theme.fg("accent", `◐ ${parts.join(", ")}`)
    );
}

/**
 * Look up a job by ID. Tries exact match first, then falls back to
 * prepending "job-" to handle LLMs that strip the prefix. Also checks
 * recent terminal jobs for completed/failed/killed lookups.
 */
export function lookupJob(
    state: TauState,
    jobId: string
): BackgroundJob | undefined {
    return (
        state.backgroundJobs.get(jobId) ??
        state.backgroundJobs.get(`job-${jobId}`) ??
        state.recentTerminalJobs.find(
            (j) => j.id === jobId || j.id === `job-${jobId}`
        )
    );
}

/** Clear pendingDecisionJobId if it matches the given job's id. */
export function clearPendingDecision(
    state: TauState,
    job: BackgroundJob
): void {
    if (state.pendingDecisionJobId === job.id)
        state.pendingDecisionJobId = undefined;
}

// ─── Shared kill + completion helpers ───────────────────────────────

/**
 * Kill a job — dispatches to tmux-window kill, process-group SIGTERM, or
 * direct PID kill for rehydrated jobs whose `proc` handle was stripped
 * on session serialise but whose OS PID is still alive.
 */
export function killJob(job: BackgroundJob): void {
    if (job.tmux) {
        killWindow(job.tmux.windowId);
        return;
    }
    if (job.proc && isProcessAlive(job.proc.pid)) {
        killProcessGroup(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && isProcessAlive(job.pid)) {
        killProcessGroup(job.pid, "SIGTERM");
    }
}

/**
 * Send a structured completion notification to the agent. Shared by the
 * direct-spawn and tmux-foreground paths so the user sees the same
 * `job-completion` message shape regardless of backend.
 */
export function notifyJobCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    if (job.outputConsumed) {
        removeJob(state, job);
        return;
    }
    const duration = formatDuration(Date.now() - job.startTime);
    const emoji = job.status === "completed" ? "✅" : "❌";
    const statusText = `Background ${job.id} ${job.status} (${duration})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(statusText, job.status === "completed" ? "success" : "error");

    pi.sendMessage(
        {
            customType: CUSTOM_TYPE.jobCompletion,
            content:
                `${emoji} ${statusText}\n` +
                `Command: ${job.command}\n` +
                `Output: ${job.logPath}${exitCodeText}`,
            display: true,
            details: {
                jobId: job.id,
                status: job.status,
                exitCode: job.exitCode,
                duration,
                command: job.command,
                logPath: job.logPath,
            },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );

    removeJob(state, job);
}

/** Public alias for direct-spawn callers (tool completion, watchdog). */
export function notifyCompletion(
    job: BackgroundJob,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): void {
    notifyJobCompletion(job, state, pi, ctx);
}

// ── Background a running foreground process (signal-based) ─────────

/**
 * Register a foreground process as a background job, start stall watchdog,
 * and set up completion handlers. Called when the background signal wins
 * the Promise.race (timeout or Ctrl+B).
 */
export function registerBackgroundJob(
    proc: import("node:child_process").ChildProcess,
    logPath: string,
    command: string,
    toolCallId: string,
    state: TauState,
    pi: ExtensionAPI,
    ctx: UiContext
): BackgroundJob {
    const jobId = generateJobId(++state.jobCounter);

    const fresh: BackgroundJob = {
        id: jobId,
        command,
        pid: proc.pid!,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc,
        toolCallId,
        isBackgrounded: true,
    };
    createJobDonePromise(fresh);

    // Reuse the existing foreground registration when present; only allocate
    // a new job object when there is none. Returning the live entry means
    // any downstream caller sees the same object held by state.backgroundJobs.
    const job: BackgroundJob = state.backgroundJobs.has(jobId)
        ? (state.backgroundJobs.get(jobId) as BackgroundJob)
        : (state.backgroundJobs.set(jobId, fresh), fresh);
    job.isBackgrounded = true;
    state.currentlyRunningToolCallId = null;

    const cancelStall = startStallWatchdog(jobId, command, logPath, pi, () => {
        if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
        silenceJobAfterKill(job);
    });

    proc.on("close", (code) => {
        cancelStall();
        if (job.status !== "running") return; // already silenced / kill raced
        markJobTerminal(job, exitCodeToStatus(code), code ?? 0);
        clearPendingDecision(state, job);
        notifyJobCompletion(job, state, pi, ctx);
        updateWidget(state, ctx);
    });

    ctx.ui.notify(`Process backgrounded as ${jobId}`, "info");
    updateWidget(state, ctx);

    return job;
}

// ── Default timeout timer (signal-based) ─────────────────────────────

/**
 * Start a timer that resolves the background signal after timeoutMs.
 * If the command is not auto-backgroundable, kills the process instead.
 * Returns the timer handle so it can be cleared on early completion.
 */
export function startTimeoutTimer(
    triggerBackground: () => void,
    command: string,
    state: TauState,
    toolCallId: string,
    explicitTimeoutMs?: number
): NodeJS.Timeout {
    const timeoutMs = explicitTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timer = setTimeout(() => {
        // Non-interactive: no agent loop to answer job_decide, so let the
        // command run to completion instead of backgrounding/killing it.
        if (state.nonInteractive) return;
        if (!state.runningProcesses.has(toolCallId)) return;

        if (!isAutoBackgroundAllowed(command)) {
            const rp = state.runningProcesses.get(toolCallId);
            if (rp?.proc.pid) killProcessGroup(rp.proc.pid, "SIGTERM");
            return;
        }

        triggerBackground();
    }, timeoutMs);
    timer.unref();
    return timer;
}

// ─── Timeout follow-up message ──────────────────────────────────────

/** Build the "your command timed out and was backgrounded" follow-up message. */
export function bgTimeoutMessage(args: {
    jobId: string;
    command: string;
    logPath: string;
    timeoutMs: number;
    location: { kind: "pid"; pid: number } | { kind: "tmux"; windowId: string };
}): string {
    const where =
        args.location.kind === "pid"
            ? `PID: ${args.location.pid}`
            : `Tmux window: ${args.location.windowId}`;
    const attachHint =
        args.location.kind === "tmux"
            ? `You can attach to the tmux window with: tmux attach -t ${args.location.windowId}`
            : `Do NOT use jobs action "attach" on this job — it will block indefinitely.`;
    return (
        `⏰ Command timed out after ${formatDuration(args.timeoutMs)} and has been backgrounded as ${args.jobId}.\n` +
        `Command: ${args.command}\n` +
        `${where}\n` +
        `Output so far: ${args.logPath}\n\n` +
        `Use the job_decide tool with jobId "${args.jobId}" to decide:\n` +
        `- decision "check": inspect the output first\n` +
        `- decision "keep": let it continue running\n` +
        `- decision "kill": terminate it\n\n` +
        attachHint
    );
}

// ─── Live progress polling (shared by both backends) ────────────────

/**
 * Build a 1 Hz poller that streams the last `FOREGROUND_TAIL_BYTES` of
 * `logPath` to `onUpdate`. Skips the update when the file is unchanged
 * since the previous tick (no-op suppression).
 */
export function startProgressPoller(
    logPath: string,
    onUpdate:
        | ((update: {
              content: Array<{ type: "text"; text: string }>;
              details: undefined;
          }) => void)
        | undefined
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    const timer = setInterval(() => {
        try {
            const { size } = statSync(logPath);
            if (size === lastSize) return;
            lastSize = size;
            const content = readOutputTailSync(logPath, FOREGROUND_TAIL_BYTES);
            if (!content || content === lastContent) return;
            lastContent = content;
            onUpdate?.({
                content: [{ type: "text", text: content }],
                details: undefined,
            });
        } catch {
            // File may not be readable yet
        }
    }, 1_000);
    timer.unref();
    return { stop: () => clearInterval(timer) };
}

// Re-exports so consumers of the lifecycle module don't need to reach
// into utils.ts for the same primitives this module uses internally.
export { markJobTerminal, removeJob };
