import { describe, expect, it } from "vitest";
import type { CommandPage } from "../src/lib/commands.tsx";
import { buildFolderPage, targetLabel } from "../src/lib/target-commands.tsx";

const emptyPage = (): CommandPage => ({ kind: "commands", title: "Empty", commands: [] });

describe("targetLabel", () => {
	it("names the scratch directory and shows folder paths", () => {
		expect(targetLabel(undefined)).toBe("Scratch");
		expect(targetLabel({ kind: "local", path: "/tmp/scratch", scratch: true })).toBe("Scratch");
		expect(targetLabel({ kind: "local", path: "/Users/me/project", scratch: false })).toBe("/Users/me/project");
	});

	it("shows the provider's display name for sandboxes", () => {
		expect(
			targetLabel({
				kind: "sandbox",
				provider: "e2b",
				providerName: "E2B",
				sandboxId: "abc12345def",
				workspaceDir: "/home/user/workspace",
			}),
		).toBe("E2B:abc12345");
		expect(
			targetLabel({ kind: "sandbox", provider: "e2b", providerName: "E2B", workspaceDir: "/home/user/workspace" }),
		).toBe("New sandbox");
	});
});

describe("buildFolderPage", () => {
	const listing = {
		path: "/Users/me",
		parent: "/Users",
		directories: [
			{ name: "project", path: "/Users/me/project" },
			{ name: "scratch", path: "/Users/me/scratch" },
		],
	};

	it("offers the current folder, its parent, its children, and a new folder", () => {
		const page = buildFolderPage(listing, emptyPage, () => {}, async () => undefined);
		expect(page.kind).toBe("commands");
		if (page.kind !== "commands") throw new Error("expected a command page");
		expect(page.commands.map((command) => command.id)).toEqual([
			"folder.choose",
			"folder.up",
			"folder./Users/me/project",
			"folder./Users/me/scratch",
			"folder.new",
		]);
	});

	it("uses the current folder when chosen", () => {
		let chosen: string | undefined;
		const page = buildFolderPage(listing, emptyPage, (path) => (chosen = path), async () => undefined);
		if (page.kind !== "commands") throw new Error("expected a command page");
		page.commands[0]?.run({ pushPage: () => {}, prompt: () => {}, close: () => {} });
		expect(chosen).toBe("/Users/me");
	});

	it("walks into a child directory", () => {
		let pushed: CommandPage | undefined;
		const page = buildFolderPage(listing, (path) => ({ kind: "loading", title: path, load: async () => emptyPage() }), () => {}, async () => undefined);
		if (page.kind !== "commands") throw new Error("expected a command page");
		page.commands[2]?.run({ pushPage: (next) => (pushed = next), prompt: () => {}, close: () => {} });
		expect(pushed?.kind).toBe("loading");
	});

	it("creates a new folder and chooses it", async () => {
		let requested: { parent: string; name: string } | undefined;
		let chosen: string | undefined;
		const page = buildFolderPage(
			listing,
			emptyPage,
			(path) => (chosen = path),
			async (parent, name) => {
				requested = { parent, name };
				return { path: `${parent}/${name}` };
			},
		);
		if (page.kind !== "commands") throw new Error("expected a command page");
		const newFolder = page.commands[page.commands.length - 1];
		let submitted: ((value: string) => boolean | void | Promise<boolean | void>) | undefined;
		newFolder?.run({
			pushPage: () => {},
			prompt: (options) => (submitted = options.onSubmit),
			close: () => {},
		});
		await submitted?.("project");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(requested).toEqual({ parent: "/Users/me", name: "project" });
		expect(chosen).toBe("/Users/me/project");
	});
});
