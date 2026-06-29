// src/spawn.ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<number | null>;
}

/**
 * Spawn `bash -c <command>` with stdout+stderr written directly to a file
 * descriptor. The child is detached so we can SIGTERM the whole process group.
 *
 * This is the Claude Code pattern: the kernel writes output to disk with zero
 * JS involvement. Progress is extracted by polling the file tail separately.
 */
export function spawnWithFileOutput(args: {
    command: string;
    cwd: string;
    logPath: string;
    signal?: AbortSignal;
}): SpawnResult {
    mkdirSync(dirname(args.logPath), { recursive: true });
    const logFd = openSync(args.logPath, "w");

    const proc = spawn("bash", ["-c", args.command], {
        stdio: ["ignore", logFd, logFd],
        cwd: args.cwd,
        detached: true,
        env: { ...process.env },
    });
    closeSync(logFd);

    if (!proc.pid) throw new Error("Failed to spawn process");
    const pid = proc.pid;

    // AbortSignal handling — kill process tree on abort.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) {
            onAbort();
        } else {
            args.signal.addEventListener("abort", onAbort, { once: true });
        }
    }

    const exit = new Promise<number | null>((resolve) => {
        proc.on("close", (code) => resolve(code));
        proc.on("error", () => resolve(1));
    }).finally(() => {
        args.signal?.removeEventListener("abort", onAbort);
    });

    proc.unref();

    return { pid, logPath: args.logPath, exit };
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
