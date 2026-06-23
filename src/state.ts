/**
 * Shared mutable state for the pi-patty-bg-tasks extension.
 *
 * Single state instance shared across all feature modules.
 */

import type { BackgroundJob, RunningProcess } from "./types.ts";

export class TauState {
    // ── Background jobs ──────────────────────────────────────────────

    backgroundJobs = new Map<string, BackgroundJob>();
    runningProcesses = new Map<string, RunningProcess>();
    jobCounter = 0;
    currentlyRunningToolCallId: string | null = null;
    agentBackgrounded = false;
    pendingDecisionJobId: string | undefined;

    /** Whether tmux is available for the tmux-backed bash backend. */
    tmuxAvailable = false;
    /** Whether the tmux-unavailable warning has been shown this session. */
    tmuxWarningShown = false;

    /**
     * Whether pi is running non-interactively (print/`-p` mode, or stdin is not
     * a TTY). When true there is no interactive agent loop to answer the
     * auto-background `job_decide` prompt, so the bash tool must NOT
     * auto-background on timeout — it runs the command to completion instead.
     */
    nonInteractive = false;

    /** Lifetime counters for terminal jobs (for status bar summary). */
    completedJobCount = 0;
    failedJobCount = 0;

    /** Recent terminal jobs kept for `jobs output` lookups. */
    recentTerminalJobs: BackgroundJob[] = [];
}
