/**
 * 슬래시 커맨드 등록.
 *
 *   - /bg: Ctrl+Shift+B와 동일 — 포그라운드 프로세스를 백그라운드로
 *   - /bg-list: 인터랙티브 백그라운드 작업 매니저 열기
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { EVENT } from "./types.ts";
import { renderSidebar } from "./registry.ts";
import { openBgListPanel } from "./ui.ts";

/** 모든 슬래시 커맨드를 등록한다. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry
): void {
    pi.registerCommand("bg", {
        description: "Background the current foreground process",
        handler: async (_args, ctx) => {
            if (reg.activeToolCallId) {
                const slot = reg.foreground.get(reg.activeToolCallId);
                if (slot) {
                    slot.requestPause();
                    renderSidebar(reg, ctx);
                    ctx.ui.notify("▶ Backgrounded — continuing.", "info");
                    pi.sendMessage(
                        {
                            customType: EVENT.background,
                            content:
                                `Command was manually backgrounded by user. ` +
                                `Output is being captured. ` +
                                `You can continue working — use the jobs tool to check on it later.`,
                            display: true,
                        },
                        { deliverAs: "followUp", triggerTurn: true }
                    );
                    return;
                }
            }
            ctx.ui.notify("No running process to background.", "warning");
        },
    });

    pi.registerCommand("bg-list", {
        description: "Open the interactive background task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });
}
