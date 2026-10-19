import { afterEach, describe, expect, it, vi } from "vitest";
import { recentFolders, rememberFolder } from "../src/lib/recent-folders.ts";
import { fakeStorage } from "./fake-storage.ts";

const KEY = "harness-recent-folders";

/** Points the module's `localStorage` at a stand-in holding `stored` under the recents key. */
function withStorage(stored?: string): void {
	vi.stubGlobal("localStorage", fakeStorage(stored === undefined ? {} : { [KEY]: stored }));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("recentFolders", () => {
	it("returns nothing when nothing is stored", () => {
		withStorage();
		expect(recentFolders()).toEqual([]);
	});

	it("reads the stored folders, most recent first", () => {
		withStorage(JSON.stringify(["/Users/me/project", "/Users/me/other"]));
		expect(recentFolders()).toEqual(["/Users/me/project", "/Users/me/other"]);
	});

	it("drops junk entries and keeps at most five", () => {
		withStorage(JSON.stringify(["/a", 13, null, "", "/a", "/b", "/c", "/d", "/e", "/f"]));
		expect(recentFolders()).toEqual(["/a", "/b", "/c", "/d", "/e"]);
	});

	it("survives storage that throws or holds invalid JSON", () => {
		withStorage("{not json");
		expect(recentFolders()).toEqual([]);
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("unavailable");
			},
			setItem: () => {
				throw new Error("unavailable");
			},
		});
		expect(recentFolders()).toEqual([]);
		expect(() => rememberFolder("/a")).not.toThrow();
	});
});

describe("rememberFolder", () => {
	it("puts the folder at the front, dropping the duplicate and the oldest beyond five", () => {
		withStorage(JSON.stringify(["/b", "/c", "/d", "/e", "/f"]));
		rememberFolder("/c");
		expect(recentFolders()).toEqual(["/c", "/b", "/d", "/e", "/f"]);
		rememberFolder("/a");
		expect(recentFolders()).toEqual(["/a", "/c", "/b", "/d", "/e"]);
	});

	it("ignores blank paths", () => {
		withStorage(JSON.stringify(["/b"]));
		rememberFolder("   ");
		expect(recentFolders()).toEqual(["/b"]);
	});
});
