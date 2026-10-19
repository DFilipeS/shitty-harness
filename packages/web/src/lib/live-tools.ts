import type { SnapshotEvent } from "@harness/protocol";

/** One tool call's live state while it runs. */
export type LiveTool = {
	name: string;
	/** The output pi-durable still retains for the call; earlier output may have been dropped. */
	output: string;
	running: boolean;
};

/**
 * One nested tool call: a call a running tool made through code mode, shown as a plain line in its
 * parent call's block. `args` is compact JSON, cut for display the way the result's details cut it.
 */
export type NestedToolView = {
	callId: string;
	parentCallId: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error";
};

/** Characters of a nested call's arguments shown, matching the codemode result's own cut. */
const NESTED_ARGS_CHARS = 200;

/** Compact JSON of a nested call's arguments, cut for display. */
export function nestedArgsOf(args: unknown): string {
	const text = (() => {
		try {
			return JSON.stringify(args) ?? "";
		} catch {
			return "";
		}
	})();
	return text.length > NESTED_ARGS_CHARS ? `${text.slice(0, NESTED_ARGS_CHARS - 3)}...` : text;
}

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

/**
 * The nested tool calls a snapshot carries, in creation order. A nested slot ends `done` with a
 * `summary` once the call settles; a call whose parent settled first is already gone from the list.
 */
export function nestedToolsFromSnapshot(
	nestedTools: SnapshotEvent["nestedTools"],
): NestedToolView[] {
	return nestedTools.map((tool) => ({
		callId: tool.callId,
		parentCallId: tool.parentCallId,
		name: tool.name,
		args: nestedArgsOf(tool.arguments),
		status: tool.status === "done" ? (tool.summary?.isError === true ? "error" : "ok") : "running",
	}));
}

/** Nested tool calls grouped by the parent call whose block shows them. */
export function nestedToolsByParent(
	nestedTools: readonly NestedToolView[],
): Record<string, NestedToolView[]> {
	const byParent: Record<string, NestedToolView[]> = {};
	for (const tool of nestedTools) {
		const group = byParent[tool.parentCallId] ?? [];
		group.push(tool);
		byParent[tool.parentCallId] = group;
	}
	return byParent;
}
