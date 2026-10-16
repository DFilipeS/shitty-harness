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
