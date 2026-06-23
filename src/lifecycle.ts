/**
 * 백그라운드 잡의 수명 주기를 관리하는 라이프사이클 헬퍼들.
 *
 * 진행률 폴링, 정체 감시, 완료 통지, 타임아웃 스케줄링, 잡 종료 표시,
 * 정리(킬) 같은 횡단 관심사를 한곳에 모았다.
 */

import { readdirSync, statSync as fsStatSync, rmSync, unlinkSync as fsUnlink } from "node:fs";
import { join as pathJoin } from "node:path";
import { setTimeout as nodeSetTimeout } from "node:timers";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DEFAULT_TIMEOUT_MS,
    EVENT,
    QUICK_COMPLETION_MS,
    type Job,
    type JobStatus,
    type UiContext,
} from "./types.ts";
import type { BackgroundRegistry } from "./state.ts";
import {
    clearTimer,
    killProcessTree,
    killTmuxWindow,
    processExists,
    readExitSentinel,
} from "./proc.ts";
import { findJob, forget, renderSidebar } from "./registry.ts";
import { formatDuration } from "./format.ts";
export { watchProgress, watchStalls } from "./monitoring.ts";

// ─── 잡 종료 표시 ────────────────────────────────────────────────────

/**
 * 잡 종료 후 표준 완료 흐름 — markTerminal → notifyFinished → forget → renderSidebar.
 * 모든 툴(bash, bash_bg, agent_bg)의 proc.on("close") / sentinel 폴링 콜백에서
 * 공유하는 표준 종료 프로토콜.
 */
export function completeJob(args: {
    job: Job;
    code: number | null;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (args.job.status !== "running") return;
    markTerminal(args.job, statusFromExit(args.code), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        const finished = findJob(args.reg, args.job.id);
        if (finished) {
            notifyFinished({ job: finished, reg: args.reg, pi: args.pi, ctx: args.ctx });
            forget(args.reg, finished);
        }
    }
    renderSidebar(args.reg, args.ctx);
}

/**
 * 잡을 터미널 상태로 표시하고 donePromise를 해소한다. 멱등성 보장 —
 * 이미 터미널이면 무시한다. proc 참조는 GC를 위해 명시적으로 제거한다.
 */
export function markTerminal(
    job: Job,
    status: JobStatus,
    exitCode?: number
): void {
    if (
        job.status === "completed" ||
        job.status === "failed" ||
        job.status === "killed"
    ) {
        return;
    }
    job.status = status;
    job.exitCode = exitCode;
    delete job.proc;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** 종료 코드를 JobStatus로 매핑. null은 시그널 종료(취소)로 간주하여 completed. */
export function statusFromExit(code: number | null | undefined): JobStatus {
    return code === 0 || code === null ? "completed" : "failed";
}

/**
 * 잡 donePromise를 생성한다. attach/log-wait 흐름에서 결과를 기다리는
 * 진입점이 된다.
 */
/** 멱등성 보장 — 이미 donePromise가 있으면 재생성하지 않는다. */
export function createCompletionPromise(job: Job): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

/**
 * 잡을 "killed"로 표시하고 출력 소비 플래그를 켠다. 모든 종료 경로에서
 * proc.on("close")가 가짜 완료 통지를 보내는 것을 막기 위해 사용한다.
 */
export function markKilledSilently(job: Job): void {
    markTerminal(job, "killed");
    job.outputConsumed = true;
}

/** 종료 코드 패턴이 SIGKILL/SIGTERM인지 확인한다 — 정상 종료를 기대하는
 *  호출자가 의도된 취소로 취급할 수 있도록 한다. */
export function isSignalExit(code: number | null | undefined): boolean {
    return code === 137 || code === 143;
}

// ─── 잡 정리 ─────────────────────────────────────────────────────────

/**
 * 잡을 정리한다 — tmux 창이면 kill-window, 살아있는 프로세스 그룹이면
 * SIGTERM, 재수화(rehydrated) 잡의 경우 proc 핸들이 없어도 PID로 직접
 * 시그널을 보낸다.
 */
export function terminateJob(job: Job): void {
    if (job.tmux) {
        killTmuxWindow(job.tmux.windowId);
        return;
    }
    if (job.proc && processExists(job.proc.pid)) {
        killProcessTree(job.proc.pid, "SIGTERM");
        return;
    }
    if (job.pid > 0 && processExists(job.pid)) {
        killProcessTree(job.pid, "SIGTERM");
    }
}

// ─── 타임아웃 ────────────────────────────────────────────────────────

/**
 * `requestPause`를 트리거하는 타임아웃 타이머를 시작한다. 비-인터랙티브
 * 모드에서는 job_decide 응답자가 없으므로 백그라운딩하지 않는다.
 * 호출자가 조기 종료 시 반드시 clearTimer로 정리해야 한다.
 */
export function scheduleTimeout(args: {
    requestPause: () => void;
    command: string;
    reg: BackgroundRegistry;
    toolCallId: string;
    explicitMs?: number;
    isAutoBackgroundAllowed: (command: string) => boolean;
}): NodeJS.Timeout {
    const ms = args.explicitMs ?? DEFAULT_TIMEOUT_MS;
    const t = nodeSetTimeout(() => {
        if (args.reg.nonInteractive) return;
        if (!args.reg.foreground.has(args.toolCallId)) return;
        if (!args.isAutoBackgroundAllowed(args.command)) {
            const slot = args.reg.foreground.get(args.toolCallId);
            if (slot?.proc.pid) killProcessTree(slot.proc.pid, "SIGTERM");
            return;
        }
        args.requestPause();
    }, ms);
    t.unref();
    return t;
}

// ─── 완료 통지 ───────────────────────────────────────────────────────

/**
 * 잡이 완료되었음을 에이전트에게 통지한다. outputConsumed가 true면
 * (예: /jobs attach가 이미 출력 소비함) 통지를 보내지 않고 정리만 한다.
 * 통지 직후 registry에서 forget()하여 메모리에서 제거한다.
 */
export function notifyFinished(args: {
    job: Job;
    reg: BackgroundRegistry;
    pi: ExtensionAPI;
    ctx: UiContext;
}): void {
    const { job, reg, pi, ctx } = args;
    if (job.outputConsumed) {
        // 출력은 이미 소비됨 — 통지 없이 정리.
        // registry.forget은 호출 측에서 처리.
        return;
    }

    const duration = formatDuration(Date.now() - job.startTime);
    const emoji = job.status === "completed" ? "✅" : "❌";
    const statusText = `Background ${job.id} ${job.status} (${duration})`;
    const exitCodeText =
        job.exitCode !== undefined ? `\nExit code: ${job.exitCode}` : "";

    ctx.ui.notify(
        statusText,
        job.status === "completed" ? "info" : "error"
    );

    pi.sendMessage(
        {
            customType: EVENT.jobFinished,
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
}

/**
 * 타임아웃 후 백그라운딩되었음을 에이전트에게 알리는 follow-up 메시지를
 * 만든다. 직접 spawn / tmux 백엔드 양쪽에서 동일한 메시지 형태를 보장한다.
 */
export function buildTimeoutNotice(args: {
    jobId: string;
    command: string;
    logPath: string;
    timeoutMs: number;
    location: { kind: "pid"; pid: number } | { kind: "tmux"; windowId: string };
}): { content: string; details: Record<string, unknown> } {
    const where =
        args.location.kind === "pid"
            ? `PID: ${args.location.pid}`
            : `Tmux window: ${args.location.windowId}`;
    const attachHint =
        args.location.kind === "tmux"
            ? `You can attach to the tmux window with: tmux attach -t ${args.location.windowId}`
            : `Do NOT use jobs action "attach" on this job — it will block indefinitely.`;
    return {
        content:
            `⏰ Command timed out after ${formatDuration(args.timeoutMs)} and has been backgrounded as ${args.jobId}.\n` +
            `Command: ${args.command}\n` +
            `${where}\n` +
            `Output so far: ${args.logPath}\n\n` +
            `Use the job_decide tool with jobId "${args.jobId}" to decide:\n` +
            `- decision "check": inspect the output first\n` +
            `- decision "keep": let it continue running\n` +
            `- decision "kill": terminate it\n\n` +
            attachHint,
        details: {
            jobId: args.jobId,
            logPath: args.logPath,
            command: args.command,
        },
    };
}

// ─── 보조 ────────────────────────────────────────────────────────────

/** cwd가 실제로 존재하는지 확인. 존재하지 않으면 명확한 에러를 던진다. */
export function requireExistingCwd(cwd: string): void {
    try {
        fsStatSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** 공백뿐인 명령인지 확인한다. bash는 빈 명령을 에러 없이 통과시키므로 명시적으로 거부한다. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

/**
 * 자동 백그라운딩이 허용되는 명령인지 확인한다. sleep 같이 백그라운딩이
 * 무의미한 명령을 거부한다.
 */
const DISALLOWED_AUTO_BACKGROUND = new Set(["sleep"]);
export function isAutoBackgroundAllowed(command: string): boolean {
    const base = command.trim().split(/\s+/)[0] ?? "";
    return !DISALLOWED_AUTO_BACKGROUND.has(base);
}

/**
 * 2초 이상의 sleep을 거부한다. bash의 foreground sleep은 사용자 인터랙티브
 * 흐름을 차단하므로 long-running 작업은 bash_bg를 사용해야 한다.
 */
export function detectBlockedSleep(command: string): string | null {
    const first =
        command
            .trim()
            .split(/&&|;|\|/)[0]
            ?.trim() ?? "";
    const m = /^sleep\s+(\d+(?:\.\d+)?)\s*$/.exec(first);
    if (!m) return null;
    const secs = parseFloat(m[1]);
    if (secs < 2) return null;
    return first;
}

// ─── 재수화 (session restore) ────────────────────────────────────────

/**
 * 직렬화된 세션 항목에서 재수화된 잡의 상태를 검증한다. PID가 죽었거나
 * tmux 종료 코드가 기록되어 있으면 completed로 강제 전환한다.
 */
export function reviveAndValidate(
    reg: BackgroundRegistry,
    job: Job
): "alive" | "completed" {
    if (job.status !== "running") return "completed";

    if (job.tmux) {
        const sentinel = job.tmux.exitCodeFile;
        const code = readExitSentinel(sentinel);
        if (code !== undefined) {
            markTerminal(job, statusFromExit(code), code);
            return "completed";
        }
        return "alive";
    }
    if (!processExists(job.pid)) {
        markTerminal(job, "failed");
        return "completed";
    }
    return "alive";
}

// ─── 비-인터랙티브 모드 감지 ─────────────────────────────────────────

/** pi가 비-인터랙티브 모드로 실행 중인지 감지 (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}

// ─── 정리 (cleanup) ─────────────────────────────────────────────────

/** 24시간 이상된 /tmp/pi-bg-* 로그 파일을 삭제한다. */
export function cleanupStaleLogs(): void {
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    let entries;
    try {
        entries = readdirSync("/tmp", { withFileTypes: true });
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("pi-bg-")) continue;
        const path = `/tmp/${entry.name}`;
        try {
            const { mtimeMs } = fsStatSync(path);
            if (now - mtimeMs > MAX_AGE_MS) fsUnlink(path);
        } catch {
            /* 이미 사라진 파일 */
        }
    }
}

/** 죽은 pi 프로세스의 tmux 잔여물을 정리한다. */
export function cleanupStaleTmuxArtifacts(): void {
    const entries = readdirSync("/tmp").filter((e) => e.startsWith("pi-tmux-"));
    for (const entry of entries) {
        const pid = parseInt(entry.replace("pi-tmux-", ""), 10);
        if (pid === process.pid) continue;
        try {
            process.kill(pid, 0);
            continue;
        } catch {
            /* 죽은 PID */
        }
        const dir = pathJoin("/tmp", entry);
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* 권한 에러 또는 동시 정리 */
        }
    }
}

// 의도적으로 export된 헬퍼들 — 사용처에서 참조되므로 보존.
void findJob;
void renderSidebar;
void isSignalExit;
void clearTimer;
void QUICK_COMPLETION_MS;
