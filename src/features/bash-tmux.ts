/**
 * Tmux-backed bash execution backend.
 *
 * Spawns commands inside tmux windows instead of direct child processes.
 * This eliminates the foreground→background output race window (tmux owns
 * the process lifecycle) and lets users attach to running commands with
 * `tmux attach`.
 *
 * Used by background.ts when tmux is available. Falls back to direct
 * child-process spawning when tmux is absent.
 *
 * Requires a git repository (uses git-root-derived session name).
 */

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { TauState } from "../state.ts";
import type { BackgroundJob, TmuxJobContext } from "../types.ts";
import {
    createJobDonePromise,
    exitCodeToStatus,
    markJobTerminal,
} from "../utils.ts";
import {
    captureOutput,
    checkExitCode,
    getGitRoot,
    killWindow,
    sessionNameForGitRoot,
    spawnInTmux,
} from "../tmux.ts";

const COMPLETION_POLL_MS = 500;

/** Per-process run directory, memoised so the mkdirSync runs once. */
let cachedRunDir: string | undefined;
function runDirPath(): string {
    if (cachedRunDir) return cachedRunDir;
    const dir = `/tmp/pi-tmux-${process.pid}`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cachedRunDir = dir;
    return dir;
}

/** Clean up the script subdir on shutdown (sentinel files stay for running jobs). */
export function cleanupTmuxRunDir(): void {
    const dir = runDirPath();
    const scriptDir = join(dir, "s");
    try {
        rmSync(scriptDir, { recursive: true, force: true });
    } catch {
        /* already gone */
    }
}

/** Clean up run directories from dead pi processes. Called on session startup. */
export function cleanupStaleTmuxRunDirs(): void {
    const entries = readdirSync("/tmp").filter((e) => e.startsWith("pi-tmux-"));
    for (const entry of entries) {
        const pid = parseInt(entry.replace("pi-tmux-", ""), 10);
        if (pid === process.pid) continue;
        try {
            process.kill(pid, 0);
            continue;
        } catch {
            // dead — clean up
        }
        const dir = join("/tmp", entry);
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* permission error or concurrent cleanup */
        }
    }

    // Kill orphaned pi-bg sessions (all panes dead).
    try {
        const sessions = execSync(
            "tmux list-sessions -F '#{session_name}'",
            {
                encoding: "utf-8",
                timeout: 3000,
                stdio: ["ignore", "pipe", "pipe"],
            }
        )
            .trim()
            .split("\n")
            .filter((s) => s.startsWith("pi-bg-"));
        for (const session of sessions) {
            const panePids = execSync(
                `tmux list-panes -t ${session} -F '#{pane_pid}'`,
                {
                    encoding: "utf-8",
                    timeout: 3000,
                    stdio: ["ignore", "pipe", "pipe"],
                }
            )
                .trim()
                .split("\n")
                .map((p) => parseInt(p, 10));
            const allDead = panePids.every((pid) => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            });
            if (allDead) {
                execSync(`tmux kill-session -t ${session}`, {
                    timeout: 3000,
                    stdio: "ignore",
                });
            }
        }
    } catch {
        /* tmux not available or no sessions */
    }
}

/** Poll for exit-code completion of a tmux-backed job via the sentinel file. */
export function pollTmuxCompletion(job: BackgroundJob): {
    completed: boolean;
    exitCode?: number;
} {
    if (!job.tmux) return { completed: false };
    const code = checkExitCode(job.tmux.exitCodeFile);
    if (code === undefined) return { completed: false };
    return { completed: true, exitCode: code };
}

/** Kill a tmux-backed job by killing its tmux window. */
export function killTmuxJob(job: BackgroundJob): void {
    if (job.tmux) killWindow(job.tmux.windowId);
}

/**
 * Spawn a bash command in a tmux window (foreground mode).
 * Returns immediately with the tmux context; caller waits for completion
 * via the exit-code sentinel file.
 */
export function spawnForegroundTmux(
    command: string,
    cwd: string
): {
    tmuxCtx: TmuxJobContext;
    logPath: string;
} {
    const gitRoot = getGitRoot(cwd);
    if (!gitRoot) {
        throw new Error(
            "Not in a git repository — tmux backend requires a git root for session naming."
        );
    }

    const session = sessionNameForGitRoot(gitRoot);
    const result = spawnInTmux(command, cwd, runDirPath(), session);

    return {
        tmuxCtx: {
            session,
            windowId: result.windowId,
            exitCodeFile: result.exitCodeFile,
            outputFile: result.outputFile,
            gitRoot,
        },
        logPath: result.outputFile,
    };
}

/**
 * Spawn a bash command in a tmux window (background mode).
 *
 * Polls the exit-code sentinel every 500 ms; when the command completes,
 * the supplied `onComplete` callback fires (typically to send a
 * `job-completion` follow-up to the agent). The tmux window is killed
 * before the callback returns.
 */
export function spawnBackgroundTmux(
    command: string,
    cwd: string,
    toolCallId: string,
    state: TauState,
    onStartStallWatchdog: (
        jobId: string,
        command: string,
        logPath: string
    ) => () => void,
    onComplete: (job: BackgroundJob) => void
): BackgroundJob {
    const { tmuxCtx, logPath } = spawnForegroundTmux(command, cwd);

    const jobId = `tmux-${process.pid}-${++state.jobCounter}`;
    const job: BackgroundJob = {
        id: jobId,
        command,
        pid: -1,
        startTime: Date.now(),
        status: "running",
        logPath,
        toolCallId,
        isBackgrounded: true,
        tmux: tmuxCtx,
    };
    createJobDonePromise(job);
    state.backgroundJobs.set(jobId, job);

    const cancelStall = onStartStallWatchdog(jobId, command, logPath);

    const completionPoll = setInterval(() => {
        const result = pollTmuxCompletion(job);
        if (!result.completed) return;
        clearInterval(completionPoll);
        cancelStall();
        markJobTerminal(
            job,
            exitCodeToStatus(result.exitCode),
            result.exitCode ?? 0
        );
        if (job.tmux) killWindow(job.tmux.windowId);
        onComplete(job);
    }, COMPLETION_POLL_MS);
    completionPoll.unref();

    return job;
}

/** Read output from a tmux pane, truncating to maxChars. */
export function readTmuxOutput(
    job: BackgroundJob,
    maxChars: number
): Promise<string> {
    if (!job.tmux) return Promise.resolve("(no output)");
    const output = captureOutput(
        job.tmux.windowId,
        2_000,
        job.tmux.outputFile
    );
    if (output.length <= maxChars) return Promise.resolve(output);
    return Promise.resolve(
        `...[truncated, showing last ${maxChars} chars]\n${output.slice(-maxChars)}`
    );
}
