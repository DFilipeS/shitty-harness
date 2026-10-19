import { dirname } from "node:path/posix";
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, DocumentReader, PromptInput } from "@earendil-works/pi-durable";
import {
	CONTEXT_FILE_CANDIDATES,
	createProjectInstructionsSection,
	loadContextFiles,
	MAX_CONTEXT_FILE_BYTES,
	ProjectInstructionsLibrary,
} from "../src/project-instructions.ts";
import type { SkillFs } from "../src/skills/fs.ts";
import type { ResolvedTarget } from "../src/targets.ts";

/**
 * An in-memory filesystem over a mutable map: every key is a file's full path. The map can
 * change between calls, so caching tests can edit the files in place.
 */
function fakeFs(files: Record<string, string>): SkillFs {
	return {
		async list(dir) {
			const names = new Set<string>();
			for (const path of Object.keys(files)) {
				if (dirname(path) !== dir) continue;
				names.add(dir === "/" ? path.slice(1) : path.slice(dir.length + 1));
			}
			return [...names].map((name) => ({ name, kind: "file" as const, size: 0 }));
		},
		async readText(path) {
			return files[path];
		},
		async readBytes() {
			return undefined;
		},
		async realPath(path) {
			return path;
		},
		async isDirectory() {
			return true;
		},
	};
}

const local: ResolvedTarget = { kind: "local", path: "/home/dev/proj/app", scratch: false };

/** The SkillFs methods the loader never calls; inline fakes override `list` and `readText`. */
const noOpFs: SkillFs = {
	async list() {
		return [];
	},
	async readText() {
		return undefined;
	},
	async readBytes() {
		return undefined;
	},
	async realPath(path) {
		return path;
	},
	async isDirectory() {
		return true;
	},
};
const resolveLocal = async () => local;
const conversationId = "c1" as unknown as ConversationId;
/** The section only reads `read`, `conversationId`, and `env`; the rest is a cast stub. */
const input = (fs: SkillFs) =>
	({
		read: {} as DocumentReader,
		conversationId,
		agent: undefined,
		env: undefined,
		shown: {},
		fs,
	}) as unknown as PromptInput & { fs: SkillFs };

describe("project instructions", () => {
	it("takes one file per directory, first candidate wins", async () => {
		const files = await loadContextFiles(
			fakeFs({
				"/home/dev/proj/app/AGENTS.md": "app rules",
				"/home/dev/proj/app/CLAUDE.md": "shadowed",
				"/home/dev/proj/AGENTS.override.md": "parent override",
			}),
			"/home/dev/proj/app",
			undefined,
		);
		expect(files.map((file) => file.path)).toEqual([
			"/home/dev/proj/AGENTS.override.md",
			"/home/dev/proj/app/AGENTS.md",
		]);
	});

	it("accepts the uppercase and CLAUDE variants", async () => {
		const files = await loadContextFiles(
			fakeFs({
				"/work/AGENTS.MD": "upper",
				"/work/sub/CLAUDE.md": "claude",
			}),
			"/work/sub",
			undefined,
		);
		expect(files.map((file) => file.path)).toEqual(["/work/AGENTS.MD", "/work/sub/CLAUDE.md"]);
	});

	it("puts the global file first, then ancestors outermost-first", async () => {
		const files = await loadContextFiles(
			fakeFs({
				"/home/dev/.agents/AGENTS.md": "global",
				"/AGENTS.md": "root",
				"/home/AGENTS.md": "home",
				"/home/dev/proj/AGENTS.md": "proj",
			}),
			"/home/dev/proj/app",
			"/home/dev",
		);
		expect(files.map((file) => file.text)).toEqual(["global", "root", "home", "proj"]);
	});

	it("strips a BOM and truncates oversized files", async () => {
		const big = `\uFEFF${"x".repeat(MAX_CONTEXT_FILE_BYTES + 100)}`;
		const files = await loadContextFiles(fakeFs({ "/app/AGENTS.md": big }), "/app", undefined);
		expect(files).toHaveLength(1);
		expect(files[0]?.truncated).toBe(true);
		expect(files[0]?.text.length).toBeLessThanOrEqual(MAX_CONTEXT_FILE_BYTES);
	});

	it("renders each file framed by its path, with a truncation note when cut", async () => {
		const fs = fakeFs({
			"/home/dev/proj/app/AGENTS.md": "x".repeat(MAX_CONTEXT_FILE_BYTES + 100),
			"/AGENTS.md": "root rules",
		});
		const section = createProjectInstructionsSection(
			new ProjectInstructionsLibrary({ resolveTarget: resolveLocal, hostFs: fs }),
		);
		const text = await section.render(input(fs), {} as Context);
		expect(text).toContain(
			'<project_instructions path="/AGENTS.md">\nroot rules\n</project_instructions>',
		);
		expect(text).toContain('<project_instructions path="/home/dev/proj/app/AGENTS.md">');
		expect(text).toContain("[Truncated:");
	});

	it("renders undefined when the target carries no context files", async () => {
		const fs = fakeFs({});
		const section = createProjectInstructionsSection(
			new ProjectInstructionsLibrary({ resolveTarget: resolveLocal, hostFs: fs }),
		);
		expect(await section.render(input(fs), {} as Context)).toBeUndefined();
	});

	it("follows a symlinked context file", async () => {
		const files = await loadContextFiles(
			{
				...fakeFs({ "/home/dev/.agents/irrelevant": "no" }),
				async list(dir) {
					if (dir === "/home/dev/.agents") return [{ name: "AGENTS.md", kind: "symlink", size: 0 }];
					return [];
				},
				async readText(path) {
					return path === "/home/dev/.agents/AGENTS.md" ? "global via link" : undefined;
				},
			},
			"/home/dev/proj/app",
			"/home/dev",
		);
		expect(files.map((file) => file.text)).toEqual(["global via link"]);
	});

	it("falls through a broken symlink to the next candidate", async () => {
		const files = await loadContextFiles(
			{
				...noOpFs,
				async list(dir) {
					if (dir === "/work")
						return [
							{ name: "AGENTS.override.md", kind: "symlink", size: 0 },
							{ name: "AGENTS.md", kind: "file", size: 0 },
						];
					return [];
				},
				async readText(path) {
					return path === "/work/AGENTS.md" ? "the real one" : undefined;
				},
			},
			"/work",
			undefined,
		);
		expect(files.map((file) => file.path)).toEqual(["/work/AGENTS.md"]);
	});

	it("lists candidates in precedence order", () => {
		expect(CONTEXT_FILE_CANDIDATES.indexOf("AGENTS.override.md")).toBe(0);
		expect(CONTEXT_FILE_CANDIDATES.indexOf("CLAUDE.md")).toBeGreaterThan(
			CONTEXT_FILE_CANDIDATES.indexOf("AGENTS.md"),
		);
	});

	it("caches per conversation until invalidated", async () => {
		const files: Record<string, string> = { "/home/dev/proj/app/AGENTS.md": "one" };
		const fs = fakeFs(files);
		const library = new ProjectInstructionsLibrary({ resolveTarget: resolveLocal, hostFs: fs });
		const read = {} as DocumentReader;
		const context = {} as Context;

		const first = await library.files(read, conversationId, undefined, context);
		expect(first.map((file) => file.text)).toEqual(["one"]);

		files["/home/dev/proj/app/AGENTS.md"] = "two";
		const cached = await library.files(read, conversationId, undefined, context);
		expect(cached.map((file) => file.text)).toEqual(["one"]);

		library.invalidate(conversationId);
		const fresh = await library.files(read, conversationId, undefined, context);
		expect(fresh.map((file) => file.text)).toEqual(["two"]);
	});
});
