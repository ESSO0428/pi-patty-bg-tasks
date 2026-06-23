/**
 * Background agent (agent_bg) — spawn a detached `pi -p` process for
 * autonomous task execution.
 *
 * Extracts the original prompt and last assistant message from the session,
 * constructs a continuation prompt, and spawns `pi -p` in the background.
 * Output is written to /tmp/pi-bg-<jobId>.log; the agent is notified on
 * completion via a follow-up message.
 */

import { spawn } from "node:child_process";
import {
    createWriteStream,
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
    ExtensionAPI,
    SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { tmpdir } from "node:os";
import type { TauState } from "../state.ts";
import type { BackgroundJob } from "../types.ts";
import {
    assertCwdExists,
    createJobDonePromise,
    generateJobId,
    isEmptyCommand,
    killProcessGroup,
    logPathForJob,
    markJobTerminal,
    exitCodeToStatus,
} from "../utils.ts";
import {
    silenceJobAfterKill,
    startStallWatchdog,
    clearPendingDecision,
    notifyCompletion,
    updateWidget,
} from "./background/index.ts";

// ─── Context extraction ─────────────────────────────────────────────

/** Type guard: this session entry carries a `message` field with extractable
 *  text content. Mirrors the upstream `SessionMessageEntry` discriminated
 *  union but uses a local structural type for the fields we read. */
function isMessageEntry(
    entry: SessionEntry
): entry is SessionEntry & { message: { role: string; content: unknown } } {
    return entry.type === "message" && "message" in entry;
}

/** Extract plain text from a message content field (string or content blocks). */
export function extractTextFromContent(
    content: string | { type: string; text?: string }[]
): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter(
            (b): b is { type: string; text: string } =>
                typeof b === "object" &&
                b !== null &&
                b.type === "text" &&
                typeof b.text === "string"
        )
        .map((b) => b.text)
        .join("\n");
}

/** Last assistant message text from the session, or "" if none. */
export function extractLastAssistantSummary(entries: SessionEntry[]): string {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (isMessageEntry(entry) && entry.message.role === "assistant") {
            return extractTextFromContent(
                entry.message.content as Parameters<typeof extractTextFromContent>[0]
            ).slice(-2_000);
        }
    }
    return "";
}

/** First user prompt in the session, or "" if none. */
export function extractOriginalPrompt(entries: SessionEntry[]): string {
    for (const entry of entries) {
        if (isMessageEntry(entry) && entry.message.role === "user") {
            return extractTextFromContent(
                entry.message.content as Parameters<typeof extractTextFromContent>[0]
            ).slice(0, 2_000);
        }
    }
    return "";
}

/** Sum of all message text bytes in the session. */
export function estimateConversationBytes(entries: SessionEntry[]): number {
    let bytes = 0;
    for (const entry of entries) {
        if (isMessageEntry(entry)) {
            bytes += extractTextFromContent(
                entry.message.content as Parameters<typeof extractTextFromContent>[0]
            ).length;
        }
    }
    return bytes;
}

// ─── Feature registration ───────────────────────────────────────────

export function registerAgentBackground(
    pi: ExtensionAPI,
    state: TauState
): void {
    pi.registerTool({
        name: "agent_bg",
        label: "Background Agent",
        description:
            "Spawn a separate pi process to handle a task in the background. " +
            "Constructs a continuation prompt from the current conversation " +
            "context and the specified task. " +
            "Use the jobs tool to check status and read output.",
        promptSnippet:
            "Delegate a task to a background pi process with context continuity",
        promptGuidelines: [
            "Use agent_bg for tasks that can run independently without the current conversation.",
            "The background agent gets a summary of the original task and where you left off.",
            "Use the jobs tool to check on progress. You will be notified when it finishes.",
        ],
        parameters: Type.Object({
            prompt: Type.String({
                description: "Task for the background agent",
            }),
            cwd: Type.Optional(
                Type.String({
                    description:
                        "Working directory (defaults to current directory)",
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
            if (isEmptyCommand(params.prompt)) {
                throw new Error("Prompt is empty.");
            }
            const cwd = params.cwd ?? ctx.cwd;
            assertCwdExists(cwd);

            const jobId = generateJobId(++state.jobCounter);
            const logPath = logPathForJob(jobId);
            mkdirSync(logPath.replace(/\/[^/]+$/, ""), { recursive: true });

            const entries = ctx.sessionManager.getEntries();
            const summary = extractLastAssistantSummary(entries);
            const originalPrompt = extractOriginalPrompt(entries);

            const promptContent = [
                "You are continuing a task that was backgrounded.",
                "",
                "## Original task",
                params.prompt,
                ...(originalPrompt
                    ? ["", "## Previous user context", originalPrompt]
                    : []),
                ...(summary ? ["", "## Where you left off", summary] : []),
                "",
                "Continue from where you left off.",
            ].join("\n");

            const promptFile = `${tmpdir()}/pi-bg-prompt-${jobId}.md`;
            writeFileSync(promptFile, promptContent);

            // Resolve `provider/id` so the spawned pi uses the same model
            // instead of falling back to the default config.
            const model = ctx.model;
            const modelArg = model
                ? `${model.provider}/${model.id}`
                : undefined;
            const spawnArgs = [
                "-p",
                "--mode",
                "text",
                ...(modelArg ? ["--model", modelArg] : []),
                `@${promptFile}`,
            ];

            const proc = spawn("pi", spawnArgs, {
                cwd,
                detached: true,
                stdio: ["pipe", "pipe", "pipe"],
            });

            if (!proc.pid) {
                try {
                    unlinkSync(promptFile);
                } catch {
                    /* ignore */
                }
                throw new Error("Failed to spawn background agent process");
            }

            const logStream = createWriteStream(logPath, { flags: "w" });
            proc.stdout?.pipe(logStream, { end: false });
            proc.stderr?.pipe(logStream, { end: false });

            const job: BackgroundJob = {
                id: jobId,
                command: `pi -p (background agent)`,
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
                job.command,
                logPath,
                pi,
                () => {
                    if (proc.pid) killProcessGroup(proc.pid, "SIGTERM");
                    silenceJobAfterKill(job);
                }
            );

            const cleanupFiles = [promptFile];

            const onTerminal = (code: number | null) => {
                cancelStall();
                logStream.end();
                if (job.status !== "running") return; // close + error race
                markJobTerminal(job, exitCodeToStatus(code), code ?? 0);
                clearPendingDecision(state, job);
                notifyCompletion(job, state, pi, ctx);
                updateWidget(state, ctx);
                for (const f of cleanupFiles) {
                    try {
                        unlinkSync(f);
                    } catch {
                        /* already gone */
                    }
                }
            };

            proc.on("close", onTerminal);
            proc.on("error", () => onTerminal(1));

            updateWidget(state, ctx);

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Started background agent ${jobId}\n` +
                            `Prompt: ${params.prompt.slice(0, 100)}${params.prompt.length > 100 ? "…" : ""}\n` +
                            `PID: ${proc.pid}\n` +
                            `Output: ${logPath}\n` +
                            `Context: ${(estimateConversationBytes(entries) / 1024).toFixed(0)} KB`,
                    },
                ],
                details: undefined,
            };
        },
    });
}
