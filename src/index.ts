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
import {
    cleanupStaleLogs,
    detectNonInteractive,
    isProcessAlive,
} from "./utils.ts";
import { checkExitCode, isTmuxAvailable } from "./tmux.ts";
import {
    cleanupStaleTmuxRunDirs,
    cleanupTmuxRunDir,
} from "./features/bash-tmux.ts";
import { registerBackgroundJobs } from "./features/background/index.ts";
import { registerBackgroundCommands } from "./features/background-commands.ts";
import { registerAgentBackground } from "./features/agent-background.ts";
import {
    CUSTOM_TYPE,
    PERSISTED_STATE_SCHEMA_VERSION,
    type BackgroundJob,
} from "./types.ts";

interface PersistedState {
    schemaVersion?: number;
    jobs?: Array<
        [string, Omit<BackgroundJob, "proc" | "donePromise" | "resolveDone">]
    >;
    jobCounter?: number;
}

export default function (pi: ExtensionAPI) {
    const state = new TauState();

    registerBackgroundJobs(pi, state);
    registerBackgroundCommands(pi, state);
    registerAgentBackground(pi, state);

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

    pi.on("session_start", async (_event, ctx) => {
        state.tmuxAvailable = isTmuxAvailable();
        if (!state.tmuxAvailable && !state.tmuxWarningShown) {
            state.tmuxWarningShown = true;
            ctx.ui.notify(
                "⚠️ tmux not found — using direct process management",
                "warning"
            );
        }

        state.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );

        if (state.tmuxAvailable) {
            cleanupStaleTmuxRunDirs();
        }

        const entries = ctx.sessionManager.getEntries();
        const stateEntries = entries.filter(
            (e) =>
                e.type === "custom" &&
                (e as { customType?: string }).customType === CUSTOM_TYPE.state
        ) as Array<{ type: "custom"; customType: string; data: unknown }>;

        // Apply in order — last entry wins. Oldest entries first so newer
        // writes overwrite them.
        for (const entry of stateEntries) {
            const data = entry.data as PersistedState;
            if (data.jobs) {
                for (const [id, jobData] of data.jobs) {
                    if (jobData.status === "running") {
                        const tmux = jobData.tmux;
                        if (tmux && "exitCodeFile" in tmux) {
                            const code = checkExitCode(tmux.exitCodeFile);
                            if (code !== undefined) {
                                jobData.status = "completed";
                                jobData.exitCode = code;
                            }
                        } else if (!isProcessAlive(jobData.pid)) {
                            jobData.status = "completed";
                        }
                    }
                    state.backgroundJobs.set(id, jobData);
                }
            }
            if (typeof data.jobCounter === "number") {
                state.jobCounter = Math.max(state.jobCounter, data.jobCounter);
            }
        }

        cleanupStaleLogs();
    });

    pi.on("session_shutdown", async (_event, _ctx) => {
        cleanupTmuxRunDir();

        pi.appendEntry(CUSTOM_TYPE.state, {
            schemaVersion: PERSISTED_STATE_SCHEMA_VERSION,
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
