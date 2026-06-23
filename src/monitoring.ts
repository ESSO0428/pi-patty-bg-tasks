/**
 * 진행률 폴링 + 정체(stall) 감시.
 *
 * lifecycle.ts에서 분리 — 모니터링 전략(진행률 추적, 프롬프트 감지,
 * 과대 출력 차단)을 독립 모듈로 집중시켜 locality를 높인다.
 */

import { openSync, readSync, closeSync, statSync as fsStatSync } from "node:fs";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    EVENT,
    FOREGROUND_TAIL_BYTES,
    MAX_LOG_BYTES,
    STALL_CHECK_INTERVAL_MS,
    STALL_TAIL_BYTES,
    STALL_THRESHOLD_MS,
} from "./types.ts";
import { truncateTail } from "./format.ts";

// ─── 진행률 폴링 ─────────────────────────────────────────────────────

/**
 * 로그 파일을 1Hz로 폴링해 변경이 있을 때만 onUpdate를 호출한다. 동일
 * 내용 반복 전송을 막아 다운스트림 UI의 알림 스팸을 차단한다.
 */
export function watchProgress(
    logPath: string,
    onUpdate: ((text: string) => void) | undefined
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    const timer = nodeSetTimeout(function tick() {
        try {
            const { size } = fsStatSync(logPath);
            if (size === lastSize) {
                timer.refresh();
                return;
            }
            lastSize = size;
            // 마지막 N바이트만 동기적으로 읽는다.
            const fd = openSync(logPath, "r");
            try {
                const readStart = Math.max(0, size - FOREGROUND_TAIL_BYTES);
                const toRead = Math.min(size, FOREGROUND_TAIL_BYTES);
                const buf = Buffer.alloc(toRead);
                readSync(fd, buf, 0, toRead, readStart);
                const content = buf.toString("utf-8", 0, toRead);
                if (content && content !== lastContent) {
                    lastContent = content;
                    onUpdate?.(truncateTail(content, FOREGROUND_TAIL_BYTES));
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            // 파일이 아직 없거나 잠겨 있음 — 다음 틱에 재시도.
        }
        timer.refresh();
    }, 1_000);
    timer.unref();
    return { stop: () => clearTimeout(timer) };
}

// ─── 정체 감시 ───────────────────────────────────────────────────────

/**
 * 비활성(stalled) 상태를 감지한다. 출력 파일이:
 *   1. MAX_LOG_BYTES를 초과하면 onOversize를 호출하고 작업을 종료한다.
 *   2. STALL_THRESHOLD_MS 동안 크기가 그대로이고 꼬리가 인터랙티브
 *      프롬프트 패턴과 매치되면 bg-stall 경고 메시지를 보낸다.
 *
 * 호출자는 종결 시점에 cancel을 반드시 호출해 interval을 해제해야 한다
 * — 그렇지 않으면 정적 출력에 대해 가짜 정체 경고가 발생할 수 있다.
 */
export function watchStalls(args: {
    jobId: string;
    command: string;
    logPath: string;
    pi: ExtensionAPI;
    onOversize?: () => void;
}): () => void {
    let lastSize = 0;
    let lastGrowth = Date.now();
    let cancelled = false;

    const timer = nodeSetTimeout(function tick() {
        if (cancelled) return;
        try {
            const { size } = fsStatSync(args.logPath);

            if (size > MAX_LOG_BYTES) {
                cancelled = true;
                if (args.onOversize) args.onOversize();
                args.pi.sendMessage(
                    {
                        customType: EVENT.stall,
                        content: `⚠️ Background job ${args.jobId} exceeded ${MAX_LOG_BYTES / (1024 * 1024)} MiB output. Terminated.`,
                        display: true,
                        details: { jobId: args.jobId, logPath: args.logPath, command: args.command },
                    },
                    { deliverAs: "followUp", triggerTurn: true }
                );
                return;
            }

            if (size > lastSize) {
                lastSize = size;
                lastGrowth = Date.now();
            } else if (Date.now() - lastGrowth >= STALL_THRESHOLD_MS) {
                // 꼬리를 읽어 프롬프트 패턴을 검사한다.
                const fd = openSync(args.logPath, "r");
                try {
                    const readStart = Math.max(0, size - STALL_TAIL_BYTES);
                    const toRead = Math.min(size, STALL_TAIL_BYTES);
                    const buf = Buffer.alloc(toRead);
                    readSync(fd, buf, 0, toRead, readStart);
                    const tail = buf.toString("utf-8", 0, toRead);
                    if (looksLikePrompt(tail)) {
                        cancelled = true;
                        sendStallPrompt(args.pi, args.jobId, args.command, args.logPath, tail);
                        return;
                    }
                } finally {
                    closeSync(fd);
                }
            }
        } catch {
            /* 파일이 아직 없을 수 있음 — 다음 틱에 재시도. */
        }
        timer.refresh();
    }, STALL_CHECK_INTERVAL_MS);
    timer.unref();

    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
}

// ─── 프롬프트 패턴 매칭 ────────────────────────────────────────────────

/** 인터랙티브 프롬프트로 판별되는 패턴들. */
export const PROMPT_PATTERNS = [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\(yes\/no\)/i,
    /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
    /Press (any key|Enter)/i,
    /Continue\?/i,
    /Overwrite\?/i,
];

/** 꼬리 텍스트의 마지막 줄이 프롬프트 패턴과 매치되는지 검사. */
export function looksLikePrompt(tail: string): boolean {
    const lastLine = tail.trimEnd().split("\n").pop() ?? "";
    return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

function sendStallPrompt(
    pi: ExtensionAPI,
    jobId: string,
    command: string,
    logPath: string,
    tail: string
): void {
    const summary =
        `Background job ${jobId} appears to be waiting for interactive input.\n` +
        `Command: ${command}\n\n` +
        `Last output:\n${tail.trimEnd()}\n\n` +
        `The command is likely blocked on an interactive prompt. Kill this job and re-run ` +
        `with piped input (e.g., \`echo y | command\`) or a non-interactive flag.`;

    pi.sendMessage(
        {
            customType: EVENT.stall,
            content: `⚠️ ${summary}`,
            display: true,
            details: { jobId, logPath, command },
        },
        { deliverAs: "followUp", triggerTurn: true }
    );
}
