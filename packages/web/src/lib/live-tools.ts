import type { SnapshotEvent } from "@harness/protocol";

/** One tool call's live state while it runs. */
export type LiveTool = {
	name: string;
	/** The output pi-durable still retains for the call; earlier output may have been dropped. */
	output: string;
	running: boolean;
};

/**
 * The output change of one `tool_execution_update`: either a replacement, or a front trim followed by
 * an append to the retained window.
 */
export type ToolOutputWindow = { trimStart?: number; append?: string } | { set: string };

/** Apply one output window to a tool's retained output. */
export function applyToolOutput(current: string, window: ToolOutputWindow): string {
	if ("set" in window) return window.set;
	const trim = window.trimStart ?? 0;
	return (trim > 0 ? current.slice(trim) : current) + (window.append ?? "");
}

/**
 * Whether a tool call's block is open. A running call opens so its output is visible while it
 * streams, and collapses once its result is committed; a reader's own choice wins over both.
 */
export function toolBlockOpen(choice: boolean | undefined, running: boolean): boolean {
	return choice ?? running;
}

/**
 * The reader's choice to remember after they toggle a block to `open`: `undefined` when the toggle
 * only restates what the call's own state shows, so the block still collapses when the call
 * finishes. Callers drop the stored choice when this returns `undefined`.
 */
export function toolChoiceAfterToggle(open: boolean, running: boolean): boolean | undefined {
	return open === running ? undefined : open;
}

/** The live tool calls a snapshot carries, keyed by tool call id. */
export function liveToolsFromSnapshot(tools: SnapshotEvent["tools"]): Record<string, LiveTool> {
	const liveTools: Record<string, LiveTool> = {};
	for (const tool of tools) {
		if (tool.status === "done" && tool.output === undefined) continue;
		liveTools[tool.callId] = {
			name: tool.name,
			output: tool.output ?? "",
			running: tool.status !== "done",
		};
	}
	return liveTools;
}
