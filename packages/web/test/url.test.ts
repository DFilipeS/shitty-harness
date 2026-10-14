import { describe, expect, it } from "vitest";
import { sessionIdFromPath, sessionPath } from "../src/lib/url.ts";

describe("sessionIdFromPath", () => {
	it("reads the id from a session path", () => {
		expect(sessionIdFromPath("/sessions/42")).toBe("42");
		expect(sessionIdFromPath("/sessions/42/")).toBe("42");
		expect(sessionIdFromPath("/sessions/abc-123")).toBe("abc-123");
	});

	it("decodes the id", () => {
		expect(sessionIdFromPath("/sessions/a%20b")).toBe("a b");
	});

	it("has no id for other paths", () => {
		expect(sessionIdFromPath("/")).toBeUndefined();
		expect(sessionIdFromPath("/sessions")).toBeUndefined();
		expect(sessionIdFromPath("/sessions/42/messages")).toBeUndefined();
		expect(sessionIdFromPath("/other/42")).toBeUndefined();
	});

	it("ignores a broken escape", () => {
		expect(sessionIdFromPath("/sessions/%")).toBeUndefined();
	});
});

describe("sessionPath", () => {
	it("builds a session path", () => {
		expect(sessionPath("42")).toBe("/sessions/42");
	});

	it("escapes the id", () => {
		expect(sessionPath("a b")).toBe("/sessions/a%20b");
	});

	it("round-trips", () => {
		expect(sessionIdFromPath(sessionPath("42"))).toBe("42");
		expect(sessionIdFromPath(sessionPath("a/b c"))).toBe("a/b c");
	});
});
