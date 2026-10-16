import { describe, expect, it } from "vitest";
import type { SandboxesState, SandboxSettingsInfo } from "@harness/protocol";
import type { CommandContext, CommandPage, PromptOptions } from "../src/lib/commands.tsx";
import { buildSandboxSettingsPage } from "../src/lib/sandbox-commands.tsx";

const settings = (change: Partial<SandboxSettingsInfo> = {}): SandboxSettingsInfo => ({
	provider: "e2b",
	providerName: "E2B",
	idleTimeoutMs: 5 * 60_000,
	autoPause: true,
	forwardAgent: true,
	configured: true,
	...change,
});

const state = (next: SandboxSettingsInfo): SandboxesState => ({
	provider: next.provider,
	settings: next,
	sandboxes: [],
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

function command(page: CommandPage | undefined, id: string) {
	return commands(page).find((candidate) => candidate.id === id);
}

describe("buildSandboxSettingsPage", () => {
	it("flips the auto-pause row before the server answers", async () => {
		let answer: (state: SandboxesState | undefined) => void = () => {};
		const replaced: CommandPage[] = [];
		let requested: unknown;
		const page = buildSandboxSettingsPage(settings({ autoPause: false }), (change) => {
			requested = change;
			return new Promise((resolve) => (answer = resolve));
		});

		const running = command(page, "sandbox.settings.autopause")?.run(
			context({ replacePage: (next) => replaced.push(next) }),
		);
		expect(requested).toEqual({ autoPause: true });
		expect(replaced).toHaveLength(1);
		expect(command(replaced[0], "sandbox.settings.autopause")?.title).toBe("Auto-pause: on");

		// The server's answer replaces the guess; here it agrees with it.
		answer(state(settings({ autoPause: true })));
		await running;
		expect(replaced).toHaveLength(2);
		expect(command(replaced[1], "sandbox.settings.autopause")?.title).toBe("Auto-pause: on");
	});

	it("keeps the palette open and flips the auto-pause row", async () => {
		const changes: unknown[] = [];
		let replaced: CommandPage | undefined;
		const page = buildSandboxSettingsPage(settings({ autoPause: false }), async (change) => {
			changes.push(change);
			return state(settings({ autoPause: change.autoPause === true }));
		});

		const autoPause = command(page, "sandbox.settings.autopause");
		expect(autoPause?.title).toBe("Auto-pause: off");
		expect(autoPause?.keepOpen).toBe(true);

		await autoPause?.run(context({ replacePage: (next) => (replaced = next) }));
		expect(changes).toEqual([{ autoPause: true }]);
		expect(command(replaced, "sandbox.settings.autopause")?.title).toBe("Auto-pause: on");
	});

	it("keeps the palette open and flips the forward-agent row", async () => {
		const changes: unknown[] = [];
		let replaced: CommandPage | undefined;
		const page = buildSandboxSettingsPage(settings({ forwardAgent: false }), async (change) => {
			changes.push(change);
			return state(settings({ forwardAgent: change.forwardAgent === true }));
		});

		const forward = command(page, "sandbox.settings.forward");
		expect(forward?.title).toBe("Forward SSH agent: off");
		expect(forward?.keepOpen).toBe(true);

		await forward?.run(context({ replacePage: (next) => (replaced = next) }));
		expect(changes).toEqual([{ forwardAgent: true }]);
		expect(command(replaced, "sandbox.settings.forward")?.title).toBe("Forward SSH agent: on");
	});

	it("returns to the page after setting the idle timeout", async () => {
		let submitted: PromptOptions | undefined;
		let replaced: CommandPage | undefined;
		const page = buildSandboxSettingsPage(settings(), async (change) =>
			state(settings({ idleTimeoutMs: change.idleTimeoutMs ?? 0 })),
		);

		command(page, "sandbox.settings.idle")?.run(
			context({ prompt: (options) => (submitted = options), replacePage: (next) => (replaced = next) }),
		);
		expect(submitted?.returnToPage).toBe(true);

		await submitted?.onSubmit("15");
		expect(command(replaced, "sandbox.settings.idle")?.detail).toBe("15 min");
	});

	it("shows the new idle timeout before the server answers", async () => {
		let submitted: PromptOptions | undefined;
		const replaced: CommandPage[] = [];
		const pending = new Promise<undefined>(() => {});
		const page = buildSandboxSettingsPage(settings(), () => pending);

		command(page, "sandbox.settings.idle")?.run(
			context({ prompt: (options) => (submitted = options), replacePage: (next) => replaced.push(next) }),
		);
		void submitted?.onSubmit("15");
		expect(command(replaced[0], "sandbox.settings.idle")?.detail).toBe("15 min");
	});

	it("shows a cleared template before the server answers", async () => {
		let submitted: PromptOptions | undefined;
		const replaced: CommandPage[] = [];
		const pending = new Promise<undefined>(() => {});
		const page = buildSandboxSettingsPage(settings({ template: "harness-base" }), () => pending);

		command(page, "sandbox.settings.template")?.run(
			context({ prompt: (options) => (submitted = options), replacePage: (next) => replaced.push(next) }),
		);
		void submitted?.onSubmit("");
		expect(command(replaced[0], "sandbox.settings.template")?.detail).toBe("provider default");
	});

	it("keeps the idle prompt open when the value is not a number", async () => {
		let submitted: PromptOptions | undefined;
		let calls = 0;
		const page = buildSandboxSettingsPage(settings(), async () => {
			calls += 1;
			return state(settings());
		});

		command(page, "sandbox.settings.idle")?.run(context({ prompt: (options) => (submitted = options) }));
		expect(await submitted?.onSubmit("soon")).toBe(false);
		expect(calls).toBe(0);
	});
});
