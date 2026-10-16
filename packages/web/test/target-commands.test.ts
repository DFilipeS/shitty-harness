import { describe, expect, it } from "vitest";
import type { CommandContext, CommandPage } from "../src/lib/commands.tsx";
import {
	buildFolderPage,
	buildNewSandboxPage,
	targetLabel,
	type NewSandboxChoice,
} from "../src/lib/target-commands.tsx";

const emptyPage = (): CommandPage => ({ kind: "commands", title: "Empty", commands: [] });

const context = (overrides: Partial<CommandContext> = {}): CommandContext => ({
	pushPage: () => {},
	replacePage: () => {},
	prompt: () => {},
	close: () => {},
	...overrides,
});

function commands(page: CommandPage | undefined) {
	if (page?.kind !== "commands") throw new Error("expected a command page");
	return page.commands;
}

function command(page: CommandPage | undefined, id: string) {
	return commands(page).find((candidate) => candidate.id === id);
}

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

describe("buildNewSandboxPage", () => {
	const build = (overrides: Partial<Parameters<typeof buildNewSandboxPage>[0]> = {}) =>
		buildNewSandboxPage({
			forwardAgent: true,
			templates: [
				{
					name: "harness-base",
					source: { kind: "default" },
					run: [],
					state: "ready",
				},
			],
			other: [],
			chooseTemplate: () => {},
			toggleForwardAgent: () => {},
			create: () => {},
			...overrides,
		});

	it("shows the chosen template, or the provider default when none is chosen", () => {
		const named = build({ template: "harness-base" });
		expect(command(named, "sandbox.new.template")?.detail).toBe("harness-base");
		const providerDefault = build();
		expect(command(providerDefault, "sandbox.new.template")?.detail).toBe("provider default");
	});

	it("opens the template picker and reports the choice", () => {
		const chosen: (string | null)[] = [];
		let pushed: CommandPage | undefined;
		command(build({ chooseTemplate: (value) => chosen.push(value) }), "sandbox.new.template")?.run(
			context({ pushPage: (page) => (pushed = page) }),
		);
		if (pushed?.kind !== "commands") throw new Error("expected the picker page");
		command(pushed, "sandbox.new.template.template.harness-base")?.run(context());
		command(pushed, "sandbox.new.template.default")?.run(context());
		expect(chosen).toEqual(["harness-base", null]);
	});

	it("creates an empty workspace with the chosen template and forwarding", () => {
		const created: NewSandboxChoice[] = [];
		command(build({ template: "harness-base", create: (choice) => created.push(choice) }), "sandbox.new.empty")?.run(
			context(),
		);
		expect(created).toEqual([
			{ source: { kind: "empty" }, forwardAgent: true, template: "harness-base" },
		]);
	});

	it("creates a git sandbox with the provider default when no template is chosen", async () => {
		const created: NewSandboxChoice[] = [];
		let submitted: ((value: string) => boolean | void | Promise<boolean | void>) | undefined;
		command(build({ create: (choice) => created.push(choice) }), "sandbox.new.git")?.run(
			context({ prompt: (options) => (submitted = options.onSubmit) }),
		);
		expect(await submitted?.("")).toBe(false);
		await submitted?.("https://github.com/owner/repo.git");
		expect(created).toEqual([
			{
				source: { kind: "git", url: "https://github.com/owner/repo.git" },
				forwardAgent: true,
				template: null,
			},
		]);
	});

	it("flips the forwarding row in place", () => {
		let toggled = 0;
		let replaced: CommandPage | undefined;
		const forward = command(build({ toggleForwardAgent: () => (toggled += 1) }), "sandbox.new.forward");
		expect(forward?.title).toBe("Forward SSH agent: on");
		forward?.run(context({ replacePage: (page) => (replaced = page) }));
		expect(toggled).toBe(1);
		expect(command(replaced, "sandbox.new.forward")?.title).toBe("Forward SSH agent: off");
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
		page.commands[0]?.run(context());
		expect(chosen).toBe("/Users/me");
	});

	it("walks into a child directory", () => {
		let pushed: CommandPage | undefined;
		const page = buildFolderPage(listing, (path) => ({ kind: "loading", title: path, load: async () => emptyPage() }), () => {}, async () => undefined);
		if (page.kind !== "commands") throw new Error("expected a command page");
		page.commands[2]?.run(context({ pushPage: (next) => (pushed = next) }));
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
		newFolder?.run(context({ prompt: (options) => (submitted = options.onSubmit) }));
		await submitted?.("project");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(requested).toEqual({ parent: "/Users/me", name: "project" });
		expect(chosen).toBe("/Users/me/project");
	});
});
