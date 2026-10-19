import type { AgentEvent, EntryRecord, SnapshotEvent, UsageState } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reducer, type State } from "../src/lib/session-state.ts";

/** A minimal snapshot: what every test needs and nothing more. */
function snapshot(overrides: Partial<SnapshotEvent> = {}): SnapshotEvent {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		nestedTools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: {} as UsageState,
		...overrides,
	};
}

/** The state after attaching to a session, the usual starting point. */
function attachedSession(id: string, overrides: Partial<SnapshotEvent> = {}): State {
	return reducer(reducer(initialState, { type: "session/activate", id }), {
		type: "session/attached",
		id,
		snapshot: snapshot(overrides),
	});
}

/** A committed tool result entry, as `message_end` and `entry_appended` carry it. */
function toolResultEntry(toolCallId: string, toolName = "codemode"): EntryRecord {
	return {
		id: `entry-${toolCallId}`,
		kind: "pi.tool-result",
		model: [
			{ role: "toolResult", toolCallId, toolName, content: [], isError: false, timestamp: 1 },
		],
	} as unknown as EntryRecord;
}

describe("session state reducer", () => {
	it("activates a session and attaches to its snapshot", () => {
		const state = attachedSession("7", {
			run: { inputs: [12] },
			inbox: [{ id: 12, mode: "followUp" }],
		});
		expect(state.activeSessionId).toBe("7");
		expect(state.sessionsById["7"]).toMatchObject({
			attached: true,
			runActive: true,
			inbox: [{ id: "12", mode: "followUp" }],
			queue: [],
		});
	});

	it("keeps the queue when a snapshot event replaces the view", () => {
		let state = attachedSession("7");
		state = reducer(state, {
			type: "session/queue",
			id: "7",
			ids: "",
			items: [{ id: "12", mode: "followUp", text: "Hello", attachments: [], images: 0 }],
		});
		state = reducer(state, { type: "session/event", id: "7", event: snapshot() });
		expect(state.sessionsById["7"]?.queue).toHaveLength(1);
	});

	it("applies fetched queue items only while the queued ids still match", () => {
		let state = attachedSession("7", { inbox: [{ id: 12, mode: "followUp" }] });
		// The inbox moves on before the fetch lands: the stale response is dropped.
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: { type: "inbox_update", items: [{ id: 13, mode: "followUp" }] },
		});
		state = reducer(state, {
			type: "session/queue",
			id: "7",
			ids: "12",
			items: [{ id: "12", mode: "followUp", text: "stale", attachments: [], images: 0 }],
		});
		expect(state.sessionsById["7"]?.queue).toEqual([]);
		// A fetch for the current ids lands.
		state = reducer(state, {
			type: "session/queue",
			id: "7",
			ids: "13",
			items: [{ id: "13", mode: "followUp", text: "fresh", attachments: [], images: 0 }],
		});
		expect(state.sessionsById["7"]?.queue).toMatchObject([{ id: "13", text: "fresh" }]);
	});

	it("applies events to a session that has no state yet", () => {
		const state = reducer(initialState, {
			type: "session/event",
			id: "9",
			event: { type: "run_start", inputs: [] },
		});
		expect(state.sessionsById["9"]).toMatchObject({ id: "9", runActive: true });
	});

	it("ends a run and clears its live tools", () => {
		let state = attachedSession("7");
		const event: AgentEvent = {
			type: "tool_execution_start",
			args: {},
			toolCallId: "call-1",
			toolName: "bash",
		};
		state = reducer(state, { type: "session/event", id: "7", event });
		expect(state.sessionsById["7"]?.liveTools["call-1"]).toMatchObject({ running: true });
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: { type: "run_end", inputs: [] },
		});
		expect(state.sessionsById["7"]).toMatchObject({
			runActive: false,
			liveTools: {},
			nestedTools: [],
		});
	});

	it("routes a script's nested calls to its parent, not the running tools", () => {
		let state = attachedSession("7");
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_start",
				args: {},
				toolCallId: "call-1",
				toolName: "codemode",
			},
		});
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_start",
				args: { command: "echo one" },
				toolCallId: "call-1/c1",
				toolName: "bash",
				parentToolCallId: "call-1",
			},
		});
		expect(Object.keys(state.sessionsById["7"]?.liveTools ?? {})).toEqual(["call-1"]);
		expect(state.sessionsById["7"]?.nestedTools).toEqual([
			{
				callId: "call-1/c1",
				parentCallId: "call-1",
				name: "bash",
				args: '{"command":"echo one"}',
				status: "running",
			},
		]);

		// A nested call's streaming output stays out; only its end changes its line.
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_update",
				toolCallId: "call-1/c1",
				toolName: "bash",
				parentToolCallId: "call-1",
				output: { set: "one\n" },
			},
		});
		expect(state.sessionsById["7"]?.nestedTools[0]).toMatchObject({ status: "running" });

		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_end",
				toolCallId: "call-1/c1",
				toolName: "bash",
				parentToolCallId: "call-1",
				result: { taskId: 5, isError: true, diagnostics: [] },
			} as AgentEvent,
		});
		expect(state.sessionsById["7"]?.nestedTools[0]).toMatchObject({ status: "error" });
	});

	it("drops a script's nested calls when its result commits", () => {
		let state = attachedSession("7");
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_start",
				args: {},
				toolCallId: "call-1",
				toolName: "codemode",
			},
		});
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_start",
				args: {},
				toolCallId: "call-1/c1",
				toolName: "bash",
				parentToolCallId: "call-1",
			},
		});
		state = reducer(state, {
			type: "session/event",
			id: "7",
			event: {
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "codemode",
				entry: toolResultEntry("call-1"),
			} as AgentEvent,
		});
		expect(state.sessionsById["7"]?.liveTools).toEqual({});
		expect(state.sessionsById["7"]?.nestedTools).toEqual([]);
	});

	it("carries a script's nested calls from a snapshot", () => {
		const state = attachedSession("7", {
			nestedTools: [
				{
					callId: "call-1/c1",
					parentCallId: "call-1",
					parentTaskId: 9,
					taskId: 10,
					name: "bash",
					status: "running",
					arguments: { command: "echo one" },
				},
			],
		});
		expect(state.sessionsById["7"]?.nestedTools).toEqual([
			{
				callId: "call-1/c1",
				parentCallId: "call-1",
				name: "bash",
				args: '{"command":"echo one"}',
				status: "running",
			},
		]);
	});

	it("drops the active session when it disappears from the list", () => {
		let state = attachedSession("7");
		state = reducer(state, { type: "sessions/set", sessions: [] });
		expect(state.activeSessionId).toBeUndefined();
		expect(state.sessionsById["7"]).toBeUndefined();
	});
});
