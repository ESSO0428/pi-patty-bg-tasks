// src/output.ts
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { FOREGROUND_TAIL_BYTES } from "./types.ts";

/**
 * Read the tail of a log file, bounded by maxChars.
 * For large files, only the last maxChars bytes are read (O(maxChars), not O(fileSize)).
 */
export function readBoundedTail(logPath: string, maxChars: number): string {
    try {
        const { size } = statSync(logPath);
        if (size === 0) return "(no output yet)";
        if (size <= maxChars) return readFileSync(logPath, "utf-8");
        const fd = openSync(logPath, "r");
        try {
            const buf = Buffer.alloc(maxChars);
            readSync(fd, buf, 0, maxChars, Math.max(0, size - maxChars));
            return `...[truncated, showing last ${maxChars} chars]\n${buf.toString("utf-8")}`;
        } finally {
            closeSync(fd);
        }
    } catch {
        return "(no output yet)";
    }
}

/**
 * Poll a log file tail at `intervalMs` (default 1000ms). Calls `onUpdate`
 * only when content changes. Returns a handle with `stop()`.
 *
 * This is the Claude Code pattern: the file is written to by the child
 * process via file descriptor. We poll the tail for progress display.
 */
export function pollFileTail(
    logPath: string,
    onUpdate: (text: string) => void,
    intervalMs = 1_000
): { stop: () => void } {
    let lastSize = 0;
    let lastContent = "";
    let stopped = false;

    const timer = setTimeout(function tick() {
        if (stopped) return;
        try {
            const { size } = statSync(logPath);
            if (size === lastSize) {
                timer.refresh();
                return;
            }
            lastSize = size;
            const fd = openSync(logPath, "r");
            try {
                const readStart = Math.max(0, size - FOREGROUND_TAIL_BYTES);
                const toRead = Math.min(size, FOREGROUND_TAIL_BYTES);
                const buf = Buffer.alloc(toRead);
                readSync(fd, buf, 0, toRead, readStart);
                const content = buf.toString("utf-8", 0, toRead);
                if (content && content !== lastContent) {
                    lastContent = content;
                    onUpdate(content);
                }
            } finally {
                closeSync(fd);
            }
        } catch {
            // File not yet created or locked — retry next tick.
        }
        if (!stopped) timer.refresh();
    }, intervalMs);
    (timer as NodeJS.Timeout).unref();

    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
        },
    };
}
