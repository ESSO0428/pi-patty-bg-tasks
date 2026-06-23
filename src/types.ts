/**
 * Shared type definitions for the pi-patty-bg-tasks extension.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

// ─── Persisted-state schema ──────────────────────────────────────────

/** Bump when BackgroundJob shape changes incompatibly with old session blobs. */
export const PERSISTED_STATE_SCHEMA_VERSION = 1;

// ─── Background jobs ────────────────────────────────────────────────

export type JobStatus = "running" | "completed" | "failed" | "killed";

export interface TmuxJobContext {
    session: string;
    windowId: string;
    exitCodeFile: string;
    outputFile: string;
    gitRoot: string;
}

export interface BackgroundJob {
    id: string;
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
    /** True once the agent has consumed output via attach — suppresses completion notification. */
    outputConsumed?: boolean;
    /** True if running in background; false if foreground (not yet backgrounded). */
    isBackgrounded: boolean;
    /** Tmux-backed jobs attach their window context here. Plain object — survives serialisation. */
    tmux?: TmuxJobContext;
}

export interface RunningProcess {
    toolCallId: string;
    proc: ChildProcess;
    command: string;
    logPath: string;
    /** Resolves when the process should be backgrounded. Set by timeout or Ctrl+B. */
    triggerBackground: () => void;
    /** Resolves the execute() promise with the given result. */
    resolve?: (result: AgentToolResult<unknown>) => void;
    reject?: (error: Error) => void;
}

// ─── Custom message types ───────────────────────────────────────────

/** customType values used in pi.sendMessage and session-entry payloads. */
export const CUSTOM_TYPE = {
    state: "background-tasks-state",
    stall: "bg-stall",
    timeout: "bg-timeout",
    attach: "bg-attach",
    agentResume: "agent-resume",
    jobCompletion: "job-completion",
} as const;
export type CustomType = (typeof CUSTOM_TYPE)[keyof typeof CUSTOM_TYPE];

// ─── Minimal context interfaces ─────────────────────────────────────

export interface UiContext {
    ui: {
        notify(
            message: string,
            level?: "info" | "success" | "warning" | "error"
        ): void;
        setWidget(name: string, content: string[] | undefined): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
        select(title: string, options: string[]): Promise<string | undefined>;
        editor(title: string, content: string): Promise<string | undefined>;
    };
}
