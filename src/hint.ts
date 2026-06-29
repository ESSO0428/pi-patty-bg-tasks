/**
 * Live "(ctrl+b to run in background)" hint shown below the editor while a
 * foreground bash command is running — mirrors Claude Code's BackgroundHint,
 * which appears once a command has run past the quick-completion window.
 */

import type { UiContext } from "./types.ts";

const HINT_KEY = "bg-hint";

/**
 * The key to press to background, as shown in the hint. Inside a tmux session
 * `ctrl+b` is tmux's prefix key, so it must be pressed twice — Claude Code
 * shows the same "(twice)" note.
 */
function backgroundHintLabel(): string {
    return process.env.TMUX
        ? "ctrl+b ctrl+b (twice) to run in background"
        : "ctrl+b to run in background";
}

/** Show the background hint below the editor. */
export function showBackgroundHint(ctx: UiContext): void {
    ctx.ui.setWidget(HINT_KEY, [`(${backgroundHintLabel()})`], {
        placement: "belowEditor",
    });
}

/** Clear the background hint. Safe to call when no hint is shown. */
export function clearBackgroundHint(ctx: UiContext): void {
    ctx.ui.setWidget(HINT_KEY, undefined);
}
