/**
 * pi-patty-bg-tasks — Background Tasks Extension for pi
 *
 * Extracted from the pi-tau (τ) extension. Provides:
 *   - Backgrounded bash commands (bash_bg, Ctrl+B, 15s auto-background)
 *   - Backgrounded agent loop (Ctrl+B during processing)
 *   - Background agent (agent_bg — spawns a separate pi -p process)
 *   - Disk-based job output to /tmp/pi-bg-<jobId>.log
 *   - Process-group kill, stall detection, size watchdog
 *   - /bg, /fg, /jobs commands; Ctrl+B/X/J shortcuts
 *
 * Tools: bash (overridden), bash_bg, jobs, job_decide, agent_bg
 * Commands: /bg, /fg, /jobs
 * Shortcuts: Ctrl+B, Ctrl+J / Shift+Down, Ctrl+X
 */

import type {
    ExtensionAPI,
    ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { TauState } from "./state.ts";
import { cleanupStaleLogs, detectNonInteractive } from "./utils.ts";
import { isTmuxAvailable, checkExitCode } from "./tmux.ts";
import {
    registerBackgroundJobs,
} from "./features/background.ts";
import { registerBackgroundCommands } from "./features/background-commands.ts";
import { registerAgentBackground } from "./features/agent-background.ts";
import {
    cleanupTmuxRunDir,
    cleanupStaleTmuxRunDirs,
    attachTmuxContext,
} from "./features/bash-tmux.ts";
import type { BackgroundJob } from "./types.ts";

export default function (pi: ExtensionAPI) {
    const state = new TauState();

    // ── Register features ────────────────────────────────────────────

    registerBackgroundJobs(pi, state);
    registerBackgroundCommands(pi, state);
    registerAgentBackground(pi, state);

    // ── Cross-cutting tool_call handler ─────────────────────────────

    pi.on("tool_call", async (event): Promise<ToolCallEventResult> => {
        // Agent backgrounding: when the user has pressed Ctrl+B during agent
        // processing, refuse to run any further tool calls. The empty reason
        // tells the agent to stop cleanly without retrying.
        if (state.agentBackgrounded) {
            return { block: true, reason: "" };
        }

        // Pending job decision: when a bash command was auto-backgrounded by
        // the 15s timeout, the agent must call job_decide or jobs before any
        // other tool will run. This keeps the agent focused on the decision.
        if (
            state.pendingDecisionJobId !== undefined &&
            event.toolName !== "job_decide" &&
            event.toolName !== "jobs" &&
            event.toolName !== "bash"
        ) {
            const job = state.backgroundJobs.get(state.pendingDecisionJobId);
            const status =
                job?.status === "running"
                    ? "still running"
                    : (job?.status ?? "unknown");
            return {
                block: true,
                reason: `A background job (${state.pendingDecisionJobId}) is awaiting your decision (${status}). Use job_decide or jobs first.`,
            };
        }

        return {};
    });

    // ── Session lifecycle ───────────────────────────────────────────

    pi.on("session_start", async (_event, ctx) => {
        // ── Tmux detection ────────────────────────────────────────
        state.tmuxAvailable = isTmuxAvailable();
        if (!state.tmuxAvailable && !state.tmuxWarningShown) {
            state.tmuxWarningShown = true;
            ctx.ui.notify(
                "⚠️ tmux not found — using direct process management",
                "warning"
            );
        }

        // ── Print/non-interactive detection ──────────────────────
        // Mirror pi's own mode decision (print || !stdin.isTTY). When
        // non-interactive there is no agent loop to answer the bash tool's
        // auto-background job_decide prompt, so the tool must run commands to
        // completion instead of backgrounding on timeout.
        state.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        // Clean up run directories and tmux sessions from dead pi processes
        if (state.tmuxAvailable) {
            cleanupStaleTmuxRunDirs();
        }

        // Restore background-tasks state
        const entries = ctx.sessionManager.getEntries();
        for (const entry of entries) {
            if (
                entry.type === "custom" &&
                entry.customType === "background-tasks-state"
            ) {
                const data = entry.data as {
                    jobs?: [
                        string,
                        Omit<
                            BackgroundJob,
                            "proc" | "donePromise" | "resolveDone"
                        >,
                    ][];
                    jobCounter?: number;
                };
                if (data.jobs) {
                    for (const [id, jobData] of data.jobs) {
                        if (jobData.status === "running") {
                            // Tmux jobs store context in an ad-hoc `tmux` property
                            // that survives serialisation.
                            const tmux: unknown = (
                                jobData as unknown as Record<string, unknown>
                            ).tmux;
                            if (
                                typeof tmux === "object" &&
                                tmux !== null &&
                                "exitCodeFile" in tmux
                            ) {
                                // Tmux job — check sentinel file instead of pid
                                const exitCodeFile = (
                                    tmux as { exitCodeFile: string }
                                ).exitCodeFile;
                                const code = checkExitCode(exitCodeFile);
                                if (code !== undefined) {
                                    jobData.status = "completed";
                                    jobData.exitCode = code;
                                }
                                // else: still running — reattach the context
                                attachTmuxContext(
                                    jobData,
                                    tmux as import("./features/bash-tmux.ts").TmuxJobContext
                                );
                            } else {
                                // Direct-spawn job — check if pid is alive
                                try {
                                    process.kill(jobData.pid, 0);
                                } catch {
                                    jobData.status = "completed";
                                }
                            }
                        }
                        state.backgroundJobs.set(id, jobData);
                    }
                }
                if (typeof data.jobCounter === "number") {
                    state.jobCounter = Math.max(
                        state.jobCounter,
                        data.jobCounter
                    );
                }
                break;
            }
        }

        cleanupStaleLogs();
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
        cleanupTmuxRunDir();

        pi.appendEntry("background-tasks-state", {
            jobs: Array.from(state.backgroundJobs.entries()).map(
                ([id, job]) => [
                    id,
                    {
                        ...job,
                        proc: undefined,
                        donePromise: undefined,
                        resolveDone: undefined,
                    },
                ]
            ),
            jobCounter: state.jobCounter,
        });
    });
}
