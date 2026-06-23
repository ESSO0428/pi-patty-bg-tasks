/**
 * Background-tasks tool registration — the public entry point for the
 * background-tasks feature. Registers four tools on the ExtensionAPI:
 *
 *   - `bash` (override of the built-in bash with backgrounding semantics)
 *   - `bash_bg` (start a command in background from the get-go)
 *   - `jobs` (list / output / kill / attach to background jobs)
 *   - `job_decide` (keep / kill / check on a timed-out background job)
 *
 * Foreground execution paths and lifecycle helpers live in sibling modules:
 *   - `./foreground.ts` — executeDirectForeground, executeTmuxForeground
 *   - `./lifecycle.ts`  — killJob, notifyJobCompletion, stall watchdog,
 *                         widget, lookup, timeout, progress poller
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolDetails } from "@earendil-works/pi-coding-agent";
import {
    createBashTool,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import type { TauState } from "../../state.ts";
import { CUSTOM_TYPE } from "../../types.ts";
import {
    assertCwdExists,
    createJobDonePromise,
    detectBlockedSleep,
    exitCodeToStatus,
    formatJobLine,
    generateJobId,
    isEmptyCommand,
    isProcessAlive,
    killProcessGroup,
    logPathForJob,
    markJobTerminal,
    MAX_OUTPUT_PREVIEW_CHARS,
    readOutputTail,
} from "../../utils.ts";
import { readTmuxOutput, spawnBackgroundTmux } from "../bash-tmux.ts";
import {
    clearPendingDecision,
    killJob,
    lookupJob,
    notifyCompletion,
    silenceJobAfterKill,
    startStallWatchdog,
    textBlock,
    updateWidget,
} from "./lifecycle.ts";
import { executeDirectForeground, executeTmuxForeground } from "./foreground.ts";

// Re-export the lifecycle helpers so callers can import everything from
// `./background` (the public surface) without reaching into `./lifecycle`.
export {
    bgTimeoutMessage,
    clearPendingDecision,
    killJob,
    lookupJob,
    markJobTerminal,
    notifyCompletion,
    notifyJobCompletion,
    registerBackgroundJob,
    silenceJobAfterKill,
    startProgressPoller,
    startStallWatchdog,
    startTimeoutTimer,
    textBlock,
    updateWidget,
} from "./lifecycle.ts";

export function registerBackgroundJobs(
    pi: ExtensionAPI,
    state: TauState
): void {
    const originalBashTool = createBashTool(process.cwd());

    pi.registerTool({
        ...originalBashTool,
        name: "bash",
        description:
            "Execute bash commands with streaming output. Commands that run longer than 2 minutes " +
            "are automatically backgrounded and the agent is asked whether to kill or let them continue. " +
            "Use Ctrl+Shift+B to manually background a running process. " +
            "Background job output is written to per-session log files.",
        promptSnippet:
            "Execute shell commands (backgroundable with Ctrl+Shift+B)",
        promptGuidelines: [
            "Use bash_bg when you know a command should run in background from the start.",
            "Use the jobs tool with action 'list' to check background job status.",
            "Use the jobs tool with action 'output' to read a background job's output file.",
        ],

        async execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx
        ): Promise<AgentToolResult<BashToolDetails | undefined>> {
            const { command } = params;

            if (isEmptyCommand(command)) {
                throw new Error("Command is empty.");
            }
            assertCwdExists(ctx.cwd);

            const sleepMatch = detectBlockedSleep(command);
            if (sleepMatch) {
                throw new Error(
                    `Blocked: ${sleepMatch}. Use bash_bg for long waits. ` +
                        "For pacing < 2s, sleep is fine."
                );
            }

            if (state.tmuxAvailable) {
                try {
                    return await executeTmuxForeground(
                        toolCallId,
                        command,
                        params,
                        signal,
                        onUpdate,
                        ctx,
                        state,
                        pi
                    );
                } catch {
                    // tmux spawn failed (no git repo, server error, etc.) —
                    // fall through to direct-spawn path.
                }
            }

            return await executeDirectForeground(
                toolCallId,
                command,
                params,
                signal,
                onUpdate,
                ctx,
                state,
                pi
            );
        },
    });

    // ── bash_bg tool ────────────────────────────────────────────────────

    pi.registerTool({
        name: "bash_bg",
        label: "Background Bash",
        description:
            "Run a bash command in background immediately. Output is written to a per-session log file. " +
            "Use the jobs tool to check status and read output.",
        promptSnippet:
            "Run bash command in background without blocking conversation",
        promptGuidelines: [
            "Use bash_bg when you want to start a long-running command in background immediately.",
            "This is different from regular bash + Ctrl+Shift+B — bash_bg backgrounds from the start.",
        ],
        parameters: Type.Object({
            command: Type.String({
                description: "Command to run in background",
            }),
            notify: Type.Optional(
                Type.Boolean({
                    description: "Notify when complete (default: true)",
                })
            ),
        }),

        async execute(
            toolCallId,
            params,
            _signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<undefined>> {
            if (isEmptyCommand(params.command)) {
                throw new Error("Command is empty.");
            }
            assertCwdExists(ctx.cwd);
            const shouldNotify = params.notify !== false;

            if (state.tmuxAvailable) {
                const job = spawnBackgroundTmux(
                    params.command,
                    ctx.cwd,
                    toolCallId,
                    state,
                    (jobId, command, logPath) =>
                        startStallWatchdog(jobId, command, logPath, pi, () => {
                            const live = state.backgroundJobs.get(jobId);
                            if (live) killJob(live);
                        }),
                    (completedJob) => {
                        clearPendingDecision(state, completedJob);
                        if (shouldNotify) notifyCompletion(completedJob, state, pi, ctx);
                        updateWidget(state, ctx);
                    }
                );

                updateWidget(state, ctx);
                return {
                    content: [
                        textBlock(
                            `Started background job ${job.id}\nCommand: ${params.command}\nOutput: ${job.logPath}`
                        ),
                    ],
                    details: undefined,
                };
            }

            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);

            const logFd = openSync(logPath, "w");
            const proc = spawn("bash", ["-c", params.command], {
                stdio: ["pipe", logFd, logFd],
                cwd: ctx.cwd,
                detached: true,
                env: { ...process.env },
            });
            closeSync(logFd);

            if (!proc.pid) {
                throw new Error("Failed to spawn background process");
            }

            const job: import("../../types.ts").BackgroundJob = {
                id: jobId,
                command: params.command,
                pid: proc.pid,
                startTime: Date.now(),
                status: "running",
                logPath,
                proc,
                toolCallId,
                isBackgrounded: true,
            };
            createJobDonePromise(job);
            state.backgroundJobs.set(jobId, job);

            const cancelStall = startStallWatchdog(
                jobId,
                params.command,
                logPath,
                pi,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job);
                }
            );

            const onTerminal = (code: number | null) => {
                cancelStall();
                if (job.status !== "running") return; // close + error race
                markJobTerminal(job, exitCodeToStatus(code), code ?? 0);
                clearPendingDecision(state, job);
                if (shouldNotify) notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
            };

            proc.on("close", onTerminal);
            proc.on("error", () => onTerminal(1));

            updateWidget(state, ctx);
            return {
                content: [
                    textBlock(
                        `Started background job ${jobId}\nCommand: ${params.command}\nPID: ${proc.pid}\nOutput: ${logPath}`
                    ),
                ],
                details: undefined,
            };
        },
    });

    // ── jobs tool ───────────────────────────────────────────────────────

    pi.registerTool({
        name: "jobs",
        label: "Background Jobs",
        description:
            "List, inspect, kill, or attach to background jobs. Output is read from disk files.",
        promptSnippet: "Manage background jobs (list/output/kill/attach)",
        promptGuidelines: [
            "Use jobs with action 'list' to see all background jobs.",
            "Use jobs with action 'output' to read a job's output from its log file.",
            "Use jobs with action 'kill' to terminate a running background job.",
            "Use jobs with action 'attach' to wait for a running job and get its final output.",
        ],
        parameters: Type.Object({
            action: StringEnum(["list", "output", "kill", "attach"] as const, {
                description: "Action to perform",
            }),
            jobId: Type.Optional(
                Type.String({
                    description: "Job ID for output/kill/attach",
                })
            ),
            wait: Type.Optional(
                Type.Boolean({
                    description:
                        "For attach: wait for completion (default true)",
                })
            ),
        }),

        async execute(
            _toolCallId,
            params,
            signal,
            onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            switch (params.action) {
                case "list": {
                    const running = Array.from(state.backgroundJobs.values());
                    const recent = state.recentTerminalJobs.slice(-5).reverse();
                    const lines = [
                        ...running.map((j) => formatJobLine(j)),
                        ...recent.map((j) => formatJobLine(j)),
                    ];
                    return {
                        content: [
                            textBlock(
                                lines.length > 0
                                    ? `Background Jobs:\n${lines.join("\n")}`
                                    : "No background jobs"
                            ),
                        ],
                        details: undefined,
                    };
                }

                case "output": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=output");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);
                    const output = job.tmux
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    return {
                        content: [
                            textBlock(
                                `Output for ${job.id} (${job.status})\nLog: ${job.logPath}\n\n${output}`
                            ),
                        ],
                        details: undefined,
                    };
                }

                case "kill": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=kill");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);
                    if (job.status !== "running") {
                        throw new Error(`Job is not running: ${job.id}`);
                    }
                    killJob(job);
                    silenceJobAfterKill(job);
                    clearPendingDecision(state, job);
                    return {
                        content: [
                            textBlock(
                                job.tmux
                                    ? `Killed tmux window ${job.tmux.windowId} for ${job.id}`
                                    : `Sent SIGTERM to ${job.id} (process group)`
                            ),
                        ],
                        details: undefined,
                    };
                }

                case "attach": {
                    if (!params.jobId)
                        throw new Error("jobId is required for action=attach");
                    const job = lookupJob(state, params.jobId);
                    if (!job) throw new Error(`Job not found: ${params.jobId}`);

                    const waitForCompletion = params.wait ?? true;
                    const skipWait =
                        state.pendingDecisionJobId === job.id &&
                        job.status === "running";

                    if (
                        job.status === "running" &&
                        waitForCompletion &&
                        !skipWait
                    ) {
                        if (!job.donePromise) createJobDonePromise(job);

                        if (!job.tmux && job.pid > 0 && !isProcessAlive(job.pid)) {
                            markJobTerminal(job, "failed");
                        }

                        onUpdate?.({
                            content: [
                                textBlock(
                                    `Attaching to ${job.id} (${job.status})...`
                                ),
                            ],
                            details: undefined,
                        });

                        if (signal && !signal.aborted) {
                            const abortPromise = new Promise<void>(
                                (resolve) => {
                                    signal.addEventListener(
                                        "abort",
                                        () => resolve(),
                                        { once: true }
                                    );
                                }
                            );
                            await Promise.race([job.donePromise, abortPromise]);
                        } else {
                            await job.donePromise;
                        }
                    }

                    const output = job.tmux
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    job.outputConsumed = true;
                    return {
                        content: [
                            textBlock(
                                `Attach finished for ${job.id}. Status: ${job.status}\nLog: ${job.logPath}\n\n${output}`
                            ),
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });

    // ── job_decide tool ─────────────────────────────────────────────────

    pi.registerTool({
        name: "job_decide",
        label: "Job Decision",
        description:
            "Decide what to do with a background job that timed out. Use this when prompted after a command is backgrounded.",
        promptSnippet: "Decide on a timed-out background job",
        promptGuidelines: [
            "Use job_decide with decision 'keep' to let the job continue running in the background.",
            "Use job_decide with decision 'kill' to terminate the job.",
            "Use job_decide with decision 'check' to see the job's current output before deciding.",
        ],
        parameters: Type.Object({
            jobId: Type.String({
                description: "The job ID to decide on",
            }),
            decision: StringEnum(["keep", "kill", "check"] as const, {
                description:
                    "keep = let it run, kill = terminate it, check = inspect output first",
            }),
        }),

        async execute(
            _toolCallId,
            params,
            _signal,
            _onUpdate,
            _ctx
        ): Promise<AgentToolResult<undefined>> {
            const job = lookupJob(state, params.jobId);
            if (!job) {
                state.pendingDecisionJobId = undefined;
                return {
                    content: [
                        { type: "text", text: `Job ${params.jobId} not found.` },
                    ],
                    details: undefined,
                };
            }

            switch (params.decision) {
                case "kill": {
                    if (job.status === "running") killJob(job);
                    silenceJobAfterKill(job);
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [
                            { type: "text", text: `Killed ${job.id}.` },
                        ],
                        details: undefined,
                    };
                }
                case "keep": {
                    state.pendingDecisionJobId = undefined;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Keeping ${job.id} running in the background. Use the jobs tool to check on it later.`,
                            },
                        ],
                        details: undefined,
                    };
                }
                case "check": {
                    const output = job.tmux
                        ? await readTmuxOutput(job, MAX_OUTPUT_PREVIEW_CHARS)
                        : await readOutputTail(
                              job.logPath,
                              MAX_OUTPUT_PREVIEW_CHARS
                          );
                    return {
                        content: [
                            { type: "text", text: `Output of ${job.id}:\n${output}` },
                        ],
                        details: undefined,
                    };
                }
            }
        },
    });
}
