import { describe, expect, it } from "vitest";
import type { ProviderTemplateInfo, TemplateInfo } from "@harness/protocol";
import type { CommandContext, CommandPage } from "../src/lib/commands.tsx";
import { buildTemplatePickerPage, templateShortName } from "../src/lib/template-commands.tsx";

const template = (name: string, state: TemplateInfo["state"]): TemplateInfo => ({
	name,
	source: { kind: "default" },
	run: [],
	state,
});

const other = (names: string[], templateId: string): ProviderTemplateInfo => ({
	names,
	templateId,
	buildStatus: "ready",
});

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

describe("templateShortName", () => {
	it("takes the last path segment without its tag", () => {
		expect(templateShortName("project/harness-base:default")).toBe("harness-base");
		expect(templateShortName("harness-base")).toBe("harness-base");
		expect(templateShortName("project/a/b:v2")).toBe("b");
	});
});

describe("buildTemplatePickerPage", () => {
	const page = () =>
		buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [
				template("ready-one", "ready"),
				template("stale-one", "stale"),
				template("draft-one", "draft"),
				template("broken-one", "failed"),
				template("gone-one", "missing"),
			],
			other: [other(["project/elsewhere:default"], "tpl-elsewhere")],
			select: () => {},
		});

	it("offers the provider default, ready and stale templates, other templates, and a name", () => {
		const ids = commands(page()).map((command) => command.id);
		expect(ids).toEqual([
			"pick.default",
			"pick.template.ready-one",
			"pick.template.stale-one",
			"pick.other.tpl-elsewhere",
			"pick.name",
		]);
	});

	it("marks a stale template in its detail", () => {
		const stale = commands(page()).find((command) => command.id === "pick.template.stale-one");
		expect(stale?.detail).toContain("recipe changed");
	});

	it("marks the provider default and a named template as current", () => {
		const providerDefault = buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [template("ready-one", "ready")],
			other: [],
			select: () => {},
		});
		expect(
			commands(providerDefault).find((command) => command.id === "pick.default")?.current,
		).toBe(true);
		expect(
			commands(providerDefault).find((command) => command.id === "pick.template.ready-one")
				?.current,
		).toBe(false);

		const named = buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [template("ready-one", "ready")],
			other: [],
			current: "ready-one",
			select: () => {},
		});
		expect(commands(named).find((command) => command.id === "pick.default")?.current).toBe(false);
		expect(
			commands(named).find((command) => command.id === "pick.template.ready-one")?.current,
		).toBe(true);
	});

	it("selects the provider default with null and a template by name", () => {
		const selected: (string | null)[] = [];
		const picker = buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [template("ready-one", "ready")],
			other: [other(["project/elsewhere:default"], "tpl-elsewhere")],
			select: (value) => selected.push(value),
		});
		commands(picker)
			.find((command) => command.id === "pick.default")
			?.run(context());
		commands(picker)
			.find((command) => command.id === "pick.template.ready-one")
			?.run(context());
		commands(picker)
			.find((command) => command.id === "pick.other.tpl-elsewhere")
			?.run(context());
		expect(selected).toEqual([null, "ready-one", "elsewhere"]);
	});

	it("selects a typed name and keeps the palette open for an empty one", async () => {
		const selected: (string | null)[] = [];
		let submitted: ((value: string) => boolean | void | Promise<boolean | void>) | undefined;
		const picker = buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [],
			other: [],
			select: (value) => selected.push(value),
		});
		commands(picker)
			.find((command) => command.id === "pick.name")
			?.run(context({ prompt: (options) => (submitted = options.onSubmit) }));
		expect(await submitted?.("  ")).toBe(false);
		expect(selected).toEqual([]);
		await submitted?.(" custom ");
		expect(selected).toEqual(["custom"]);
	});

	it("hides other templates that carry a harness template's name", () => {
		const picker = buildTemplatePickerPage({
			idPrefix: "pick",
			templates: [template("harness-base", "ready")],
			other: [other(["project/harness-base:default"], "tpl-1")],
			select: () => {},
		});
		expect(commands(picker).map((command) => command.id)).not.toContain("pick.other.tpl-1");
	});
});
