import { describe, expect, it } from "vitest";
import {
	clampHead,
	initialHead,
	MAX_RENDERED,
	prependHead,
	trimHeadAtBottom,
} from "../src/lib/windowing.ts";

describe("initialHead", () => {
	it("starts at the tail of a long session", () => {
		expect(initialHead(510)).toBe(470);
	});

	it("starts at zero for a session that fits one page", () => {
		expect(initialHead(40)).toBe(0);
		expect(initialHead(3)).toBe(0);
		expect(initialHead(0)).toBe(0);
	});
});

describe("prependHead", () => {
	it("moves up by one page", () => {
		expect(prependHead(100)).toBe(70);
	});

	it("stops at the first entry", () => {
		expect(prependHead(10)).toBe(0);
		expect(prependHead(0)).toBe(0);
	});
});

describe("clampHead", () => {
	it("keeps a valid head untouched", () => {
		expect(clampHead(5, 100)).toBe(5);
	});

	it("pulls the head back when the list shrank", () => {
		expect(clampHead(50, 10)).toBe(9);
		expect(clampHead(3, 0)).toBe(0);
	});
});

describe("trimHeadAtBottom", () => {
	it("keeps the window while it is within bounds", () => {
		expect(trimHeadAtBottom(0, MAX_RENDERED)).toBe(0);
		expect(trimHeadAtBottom(10, MAX_RENDERED + 10)).toBe(10);
	});

	it("returns to the tail window once the window grew too long", () => {
		expect(trimHeadAtBottom(0, MAX_RENDERED + 1)).toBe(MAX_RENDERED + 1 - 40);
	});
});
