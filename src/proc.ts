// src/proc.ts — minimal shell helpers (tmux removed)
export { spawnWithFileOutput, killProcessTree, processExists } from "./spawn.ts";

/** Idempotent clearTimeout that accepts null/undefined. */
export function clearTimer(timer: NodeJS.Timeout | null | undefined): void {
    if (timer) clearTimeout(timer);
}
