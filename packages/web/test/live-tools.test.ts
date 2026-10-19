import type { SnapshotEvent } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import {
	applyToolOutput,
	liveToolsFromSnapshot,
	nestedArgsOf,
	nestedToolsByParent,
	nestedToolsFromSnapshot,
	toolBlockOpen,
	toolChoiceAfterToggle,
} from "../src/lib/live-tools.ts";

describe("toolBlockOpen", () => {
	it("opens a running call", () => {
		expect(toolBlockOpen(undefined, true)).toBe(true);
	});

	it("collapses a call whose result is committed", () => {
		expect(toolBlockOpen(undefined, false)).toBe(false);
	});

	it("keeps a block the reader opened after the call finished", () => {
		expect(toolBlockOpen(true, false)).toBe(true);
	});

	it("keeps a block the reader collapsed while the call ran", () => {
		expect(toolBlockOpen(false, true)).toBe(false);
	});
});

describe("toolChoiceAfterToggle", () => {
	it("records collapsing a running block", () => {
		expect(toolChoiceAfterToggle(false, true)).toBe(false);
	});

	it("records opening a finished block", () => {
		expect(toolChoiceAfterToggle(true, false)).toBe(true);
	});

	it("records nothing when the reader opens a running block", () => {
		expect(toolChoiceAfterToggle(true, true)).toBeUndefined();
	});

	it("records nothing when the reader collapses a finished block", () => {
		expect(toolChoiceAfterToggle(false, false)).toBeUndefined();
	});
});

describe("applyToolOutput", () => {
	it("replaces the window when the update sets it", () => {
		expect(applyToolOutput("old output", { set: "new output" })).toBe("new output");
	});

	it("appends to the retained window", () => {
		expect(applyToolOutput("line 1\n", { append: "line 2\n" })).toBe("line 1\nline 2\n");
	});

	it("drops the front of the window before appending", () => {
		expect(applyToolOutput("line 1\nline 2\n", { trimStart: 7, append: "line 3\n" })).toBe(
			"line 2\nline 3\n",
		);
	});

	it("trims without appending", () => {
		expect(applyToolOutput("abcdef", { trimStart: 2 })).toBe("cdef");
	});

	it("leaves the window alone for an empty update", () => {
		expect(applyToolOutput("kept", {})).toBe("kept");
	});
});

describe("liveToolsFromSnapshot", () => {
	it("carries running tools with their retained output", () => {
		const tools = liveToolsFromSnapshot([
			{ callId: "call-1", name: "bash", status: "running", output: "working…" },
			{ callId: "call-2", name: "read", status: "pending" },
		]);
		expect(tools).toEqual({
			"call-1": { name: "bash", output: "working…", running: true },
			"call-2": { name: "read", output: "", running: true },
		});
	});

	it("skips a finished tool whose result is already committed", () => {
		expect(liveToolsFromSnapshot([{ callId: "call-1", name: "bash", status: "done" }])).toEqual({});
	});

	it("keeps a finished tool that still has output to read", () => {
		expect(
			liveToolsFromSnapshot([{ callId: "call-1", name: "bash", status: "done", output: "tail" }]),
		).toEqual({ "call-1": { name: "bash", output: "tail", running: false } });
	});
});

describe("nestedArgsOf", () => {
	it("compacts an object into JSON", () => {
		expect(nestedArgsOf({ command: "echo one" })).toBe('{"command":"echo one"}');
	});

	it("cuts long arguments for display", () => {
		const args = nestedArgsOf({ path: "x".repeat(300) });
		expect(args.length).toBe(200);
		expect(args.endsWith("...")).toBe(true);
	});
});

describe("nestedToolsFromSnapshot", () => {
	it("carries nested slots with their parent, in creation order", () => {
		const nestedTools = nestedToolsFromSnapshot([
			{
				callId: "call-1/c1",
				parentCallId: "call-1",
				name: "bash",
				status: "running",
				arguments: { command: "echo one" },
			},
			{
				callId: "call-1/c2",
				parentCallId: "call-1",
				name: "read",
				status: "pending",
				arguments: { path: "a.txt" },
			},
		] as SnapshotEvent["nestedTools"]);
		expect(nestedTools).toEqual([
			{
				callId: "call-1/c1",
				parentCallId: "call-1",
				name: "bash",
				args: '{"command":"echo one"}',
				status: "running",
			},
			{
				callId: "call-1/c2",
				parentCallId: "call-1",
				name: "read",
				args: '{"path":"a.txt"}',
				status: "running",
			},
		]);
	});

	it("marks a settled slot ok or error by its summary", () => {
		const nestedTools = nestedToolsFromSnapshot([
			{
				callId: "call-1/c1",
				parentCallId: "call-1",
				name: "bash",
				status: "done",
				arguments: {},
				summary: { isError: false },
			},
			{
				callId: "call-1/c2",
				parentCallId: "call-1",
				name: "bash",
				status: "done",
				arguments: {},
				summary: { isError: true, error: "boom" },
			},
		] as SnapshotEvent["nestedTools"]);
		expect(nestedTools.map((tool) => tool.status)).toEqual(["ok", "error"]);
	});
});

describe("nestedToolsByParent", () => {
	it("groups nested calls by the parent call whose block shows them", () => {
		const groups = nestedToolsByParent([
			{ callId: "call-1/c1", parentCallId: "call-1", name: "bash", args: "", status: "ok" },
			{ callId: "call-2/c1", parentCallId: "call-2", name: "read", args: "", status: "running" },
			{ callId: "call-2/c2", parentCallId: "call-2", name: "read", args: "", status: "error" },
		]);
		expect(Object.keys(groups)).toEqual(["call-1", "call-2"]);
		expect(groups["call-2"]).toHaveLength(2);
	});
});
