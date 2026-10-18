import { describe, expect, it } from "vitest";
import {
	applyToolOutput,
	liveToolsFromSnapshot,
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
		expect(applyToolOutput("line 1\nline 2\n", { trimStart: 7, append: "line 3\n" })).toBe("line 2\nline 3\n");
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
		expect(
			liveToolsFromSnapshot([{ callId: "call-1", name: "bash", status: "done" }]),
		).toEqual({});
	});

	it("keeps a finished tool that still has output to read", () => {
		expect(
			liveToolsFromSnapshot([{ callId: "call-1", name: "bash", status: "done", output: "tail" }]),
		).toEqual({ "call-1": { name: "bash", output: "tail", running: false } });
	});
});
