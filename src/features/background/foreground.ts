/**
 * Foreground/background execution paths for the bash tool.
 *
 * The bash tool has two spawn backends:
 *   - direct child process (default)
 *   - tmux window (when tmux is available and we're in a git repo)
 *
 * Both paths share the same race semantics (2-second quick-completion
 * window, 15-second default timeout, Ctrl+B backgrounding, progress
 * polling). They differ only in how the child is spawned and how
 * completion is detected. Each path is a private function called from
 * the bash tool's `execute()` in `index.ts`.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolDetails } from "@earendil-works/pi-coding-agent";
import type { TauState } from "../../state.ts";
import type { BackgroundJob, RunningProcess, TmuxJobContext, UiContext } from "../../types.ts";
import {
    assertCwdExists,
    clearTimeoutSafe,
    createJobDonePromise,
    DEFAULT_TIMEOUT_MS,
    exitCodeToStatus,
    generateJobId,
    isAutoBackgroundAllowed,
    killProcessGroup,
    logPathForJob,
    MAX_OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    readOutputTail,
} from "../../utils.ts";
import { captureOutput, checkExitCode, killWindow } from "../../tmux.ts";
import {
    pollTmuxCompletion,
    spawnForegroundTmux,
} from "../bash-tmux.ts";
import {
    bgTimeoutMessage,
    killJob,
    markJobTerminal,
    notifyJobCompletion,
    registerBackgroundJob,
    startProgressPoller,
    startStallWatchdog,
    startTimeoutTimer,
    textBlock,
    updateWidget,
} from "./lifecycle.ts";
import { CUSTOM_TYPE } from "../../types.ts";

/**
 * Bash tool foreground path (no tmux). Race between proc-completion and
 * background-signal; quick-completion window skips the race entirely.
 */
export async function executeDirectForeground(
    toolCallId: string,
    command: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: UiContext & { cwd: string },
    state: TauState,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    assertCwdExists(ctx.cwd);

    const jobId = generateJobId(++state.jobCounter);
    const logPath = logPathForJob(jobId);
    mkdirSync(dirname(logPath), { recursive: true });

    const logFd = openSync(logPath, "w");
    const proc = spawn("bash", ["-c", command], {
        stdio: ["pipe", logFd, logFd],
        cwd: ctx.cwd,
        detached: true,
        env: { ...process.env },
    });
    closeSync(logFd);

    if (!proc.pid) throw new Error("Failed to spawn process");

    let backgroundResolve: (() => void) | null = null;
    const backgroundSignal = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
    });
    const triggerBackground = () => backgroundResolve?.();

    const rp: RunningProcess = {
        toolCallId,
        proc,
        command,
        logPath,
        triggerBackground,
    };
    state.runningProcesses.set(toolCallId, rp);
    state.currentlyRunningToolCallId = toolCallId;

    state.backgroundJobs.set(jobId, {
        id: jobId,
        command,
        pid: proc.pid,
        startTime: Date.now(),
        status: "running",
        logPath,
        proc,
        toolCallId,
        isBackgrounded: false,
    });

    const procResult = new Promise<{
        code: number | null;
        interrupted: boolean;
    }>((resolve) => {
        proc.on("close", (code) => {
            resolve({ code, interrupted: code === 137 || code === 143 });
        });
        proc.on("error", () => resolve({ code: 1, interrupted: false }));
    });

    if (signal) {
        signal.addEventListener("abort", () => {
            killProcessGroup(proc.pid!, "SIGTERM");
        });
    }

    const timeoutMs =
        typeof params.timeout === "number" ? params.timeout * 1_000 : undefined;
    const timer = startTimeoutTimer(
        triggerBackground,
        command,
        state,
        toolCallId,
        timeoutMs
    );

    const hintTimer = setTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+B to background", "info");
    }, QUICK_COMPLETION_MS);
    hintTimer.unref();

    let progress: { stop: () => void } | undefined;
    const cleanupTimers = () => {
        progress?.stop();
        clearTimeoutSafe(timer);
        clearTimeoutSafe(hintTimer);
    };

    try {
        const initialResult = await Promise.race<{
            code: number | null;
            interrupted: boolean;
        } | null>([
            procResult,
            new Promise<null>((resolve) => {
                const t = setTimeout(resolve, QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (initialResult !== null) {
            state.backgroundJobs.delete(jobId);
            const output = await readOutputTail(logPath, MAX_OUTPUT_PREVIEW_CHARS);
            if (
                initialResult.code !== 0 &&
                initialResult.code !== null &&
                !initialResult.interrupted
            ) {
                throw new Error(
                    output || `Command exited with code ${initialResult.code}`
                );
            }
            return { content: [textBlock(output || "(no output)")], details: undefined };
        }

        progress = startProgressPoller(logPath, onUpdate);

        const raceResult = await Promise.race<
            | { type: "completed"; code: number | null; interrupted: boolean }
            | { type: "backgrounded" }
        >([
            procResult.then((r) => ({ type: "completed" as const, ...r })),
            backgroundSignal.then(() => ({ type: "backgrounded" as const })),
        ]);

        if (raceResult.type === "backgrounded") {
            cleanupTimers();
            state.runningProcesses.delete(toolCallId);

            const job = registerBackgroundJob(
                proc,
                logPath,
                command,
                toolCallId,
                state,
                pi,
                ctx
            );
            state.pendingDecisionJobId = job.id;

            pi.sendMessage(
                {
                    customType: CUSTOM_TYPE.timeout,
                    content: bgTimeoutMessage({
                        jobId: job.id,
                        command,
                        logPath: job.logPath,
                        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
                        location: { kind: "pid", pid: job.pid },
                    }),
                    display: true,
                    details: {
                        jobId: job.id,
                        logPath: job.logPath,
                        command,
                    },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );

            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${job.id}\nCommand: ${command}\nPID: ${job.pid}\nOutput: ${job.logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        cleanupTimers();
        state.runningProcesses.delete(toolCallId);
        if (state.currentlyRunningToolCallId === toolCallId) {
            state.currentlyRunningToolCallId = null;
        }
        state.backgroundJobs.delete(jobId);

        const output = await readOutputTail(logPath, MAX_OUTPUT_PREVIEW_CHARS);
        if (
            raceResult.code !== 0 &&
            raceResult.code !== null &&
            !raceResult.interrupted
        ) {
            throw new Error(
                output || `Command exited with code ${raceResult.code}`
            );
        }

        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        cleanupTimers();
    }
}

/**
 * Bash tool foreground path on the tmux backend. Completion is detected
 * by polling the exit-code sentinel file written by the wrapper script.
 */
export async function executeTmuxForeground(
    toolCallId: string,
    command: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: UiContext & { cwd: string },
    state: TauState,
    pi: ExtensionAPI
): Promise<AgentToolResult<BashToolDetails | undefined>> {
    let jobId: string;
    let logPath: string;
    let tmuxCtx: TmuxJobContext;

    try {
        const result = spawnForegroundTmux(command, ctx.cwd);
        jobId = `tmux-${process.pid}-${++state.jobCounter}`;
        logPath = result.logPath;
        tmuxCtx = result.tmuxCtx;
    } catch {
        throw new Error(
            "tmux backend requires a git repository. " +
                "Falling back to direct process management."
        );
    }

    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1, // tmux owns the process lifecycle
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: false,
        tmux: tmuxCtx,
    };
    createJobDonePromise(job);
    state.backgroundJobs.set(jobId, job);

    let backgroundResolve: (() => void) | null = null;
    const backgroundSignal = new Promise<void>((resolve) => {
        backgroundResolve = resolve;
    });
    const triggerBackground = () => backgroundResolve?.();

    state.runningProcesses.set(toolCallId, {
        toolCallId,
        proc: { pid: -1 } as never,
        command,
        logPath,
        triggerBackground,
    });
    state.currentlyRunningToolCallId = toolCallId;

    if (signal) {
        signal.addEventListener("abort", () => killWindow(tmuxCtx.windowId));
    }

    const timeoutMs =
        typeof params.timeout === "number"
            ? params.timeout * 1_000
            : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
        if (state.nonInteractive) return;
        if (!state.runningProcesses.has(toolCallId)) return;
        if (!isAutoBackgroundAllowed(command)) {
            killWindow(tmuxCtx.windowId);
            return;
        }
        triggerBackground();
    }, timeoutMs);
    timer.unref();

    const hintTimer = setTimeout(() => {
        ctx.ui.notify("⏱ Ctrl+B to background", "info");
    }, QUICK_COMPLETION_MS);
    hintTimer.unref();

    let progress: { stop: () => void } | undefined;
    const cleanupTimers = () => {
        progress?.stop();
        clearTimeoutSafe(timer);
        clearTimeoutSafe(hintTimer);
    };

    const completionPromise = new Promise<number | null>((resolve) => {
        const check = setInterval(() => {
            const code = checkExitCode(tmuxCtx.exitCodeFile);
            if (code !== undefined) {
                clearInterval(check);
                resolve(code);
            }
        }, 200);
        check.unref();
    });

    try {
        const initialResult = await Promise.race<number | null>([
            completionPromise,
            new Promise<null>((resolve) => {
                const t = setTimeout(resolve, QUICK_COMPLETION_MS) as unknown as NodeJS.Timeout;
                t.unref();
            }),
        ]);

        if (initialResult !== null) {
            state.backgroundJobs.delete(jobId);
            const output = captureOutput(tmuxCtx.windowId, 2_000, tmuxCtx.outputFile);
            // Keep the tmux session alive across windows to avoid
            // fork+waitpid deadlocks that arise from session churn.
            killWindow(tmuxCtx.windowId);
            if (initialResult !== 0) {
                throw new Error(
                    output || `Command exited with code ${initialResult}`
                );
            }
            return { content: [textBlock(output || "(no output)")], details: undefined };
        }

        progress = startProgressPoller(logPath, onUpdate);

        const raceResult = await Promise.race<
            { type: "completed"; code: number | null } | { type: "backgrounded" }
        >([
            completionPromise.then((code) => ({
                type: "completed" as const,
                code,
            })),
            backgroundSignal.then(() => ({ type: "backgrounded" as const })),
        ]);

        if (raceResult.type === "backgrounded") {
            cleanupTimers();
            state.runningProcesses.delete(toolCallId);

            job.isBackgrounded = true;
            state.currentlyRunningToolCallId = null;

            // CRITICAL: capture the cancelStall return — the previous code
            // discarded it, leaking the 5 s interval forever after completion
            // and risking a spurious "stall" notification on terminal output.
            const cancelStall = startStallWatchdog(
                jobId,
                command,
                logPath,
                pi,
                () => killWindow(tmuxCtx.windowId)
            );

            const bgPoller = setInterval(() => {
                const result = pollTmuxCompletion(job);
                if (!result.completed) return;
                clearInterval(bgPoller);
                cancelStall();
                if (job.status !== "running") return;
                markJobTerminal(
                    job,
                    exitCodeToStatus(result.exitCode),
                    result.exitCode ?? 0
                );
                notifyJobCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            }, 500);
            bgPoller.unref();

            state.pendingDecisionJobId = jobId;

            pi.sendMessage(
                {
                    customType: CUSTOM_TYPE.timeout,
                    content: bgTimeoutMessage({
                        jobId,
                        command,
                        logPath,
                        timeoutMs,
                        location: { kind: "tmux", windowId: tmuxCtx.windowId },
                    }),
                    display: true,
                    details: { jobId, logPath, command },
                },
                { deliverAs: "followUp", triggerTurn: true }
            );

            updateWidget(state, ctx);
            return {
                content: [
                    textBlock(
                        `Process backgrounded as ${jobId}\nCommand: ${command}\nTmux window: ${tmuxCtx.windowId}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        }

        cleanupTimers();
        state.runningProcesses.delete(toolCallId);
        if (state.currentlyRunningToolCallId === toolCallId) {
            state.currentlyRunningToolCallId = null;
        }
        state.backgroundJobs.delete(jobId);

        const output = captureOutput(tmuxCtx.windowId, 2_000, tmuxCtx.outputFile);
        killWindow(tmuxCtx.windowId);

        if (raceResult.code !== 0 && raceResult.code !== null) {
            throw new Error(
                output || `Command exited with code ${raceResult.code}`
            );
        }

        return { content: [textBlock(output || "(no output)")], details: undefined };
    } finally {
        cleanupTimers();
    }
}
