import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { showBackgroundHint, clearBackgroundHint } from "../hint.ts";
import type { UiContext } from "../types.ts";

interface WidgetCall {
    name: string;
    content: string[] | undefined;
    options?: { placement?: string };
}

function makeCtx(): { calls: WidgetCall[]; ctx: UiContext } {
    const calls: WidgetCall[] = [];
    const ctx = {
        ui: {
            notify: () => {},
            setWidget: (name: string, content: string[] | undefined, options?: { placement?: string }) =>
                calls.push({ name, content, options }),
            setStatus: () => {},
            theme: { fg: (_c: string, t: string) => t },
            select: async () => undefined,
            editor: async () => undefined,
        },
    } as unknown as UiContext;
    return { calls, ctx };
}

function withTmux(value: string | undefined, fn: () => void): void {
    const prev = process.env.TMUX;
    if (value === undefined) delete process.env.TMUX;
    else process.env.TMUX = value;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.TMUX;
        else process.env.TMUX = prev;
    }
}

void describe("background hint", () => {
    void it("shows a ctrl+b hint below the editor when not in tmux", () => {
        withTmux(undefined, () => {
            const { calls, ctx } = makeCtx();
            showBackgroundHint(ctx);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].options?.placement, "belowEditor");
            const line = calls[0].content?.[0] ?? "";
            assert.match(line, /ctrl\+b to run in background/);
            assert.ok(!/twice/.test(line));
        });
    });

    void it("shows the double-press note inside tmux", () => {
        withTmux("/tmp/tmux-1/default,123,0", () => {
            const { calls, ctx } = makeCtx();
            showBackgroundHint(ctx);
            assert.match(calls[0].content?.[0] ?? "", /twice/);
        });
    });

    void it("clears the hint by setting undefined content", () => {
        const { calls, ctx } = makeCtx();
        clearBackgroundHint(ctx);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].content, undefined);
    });
});
