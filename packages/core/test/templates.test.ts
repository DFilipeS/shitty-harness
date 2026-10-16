import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { HarnessService } from "../src/index.ts";
import { localEnvironment } from "../src/node.ts";
import { SandboxError } from "../src/sandboxes/provider.ts";
import { parseRecipe, serializeRecipe, STARTER_RECIPE, templateName } from "../src/sandboxes/recipe.ts";
import { SandboxManager } from "../src/sandboxes/manager.ts";
import { TemplateManager, TemplateStore } from "../src/sandboxes/templates.ts";
import { createFauxProviders } from "./helpers/fake-providers.ts";
import {
	FakeSandboxProvider,
	FakeSandboxSettingsStore,
	registerFakeSandboxProvider,
} from "./helpers/fake-sandbox.ts";

/** Wait until `predicate` holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function templateManager(
	dir: string,
	provider: FakeSandboxProvider,
	options: { defaultTemplate?: () => string | undefined } = {},
): TemplateManager {
	return new TemplateManager({
		store: new TemplateStore(dir),
		provider: () => provider,
		configured: () => true,
		identity: () => ({ id: "fake", displayName: "Fake" }),
		...(options.defaultTemplate === undefined ? {} : { defaultTemplate: options.defaultTemplate }),
	});
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "harness-templates-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("template recipes", () => {
	it("parses the fields a recipe may carry", () => {
		const recipe = parseRecipe(
			[
				"description: Node 22 with pnpm",
				"from:",
				"  image: node:22",
				"run:",
				"  - corepack enable",
				"  - apt-get update && apt-get install -y git",
			].join("\n"),
		);
		expect(recipe).toEqual({
			description: "Node 22 with pnpm",
			source: { kind: "image", image: "node:22" },
			run: ["corepack enable", "apt-get update && apt-get install -y git"],
		});
	});

	it("defaults the source to the provider base image", () => {
		expect(parseRecipe("run:\n  - true\n").source).toEqual({ kind: "default" });
		expect(parseRecipe("").source).toEqual({ kind: "default" });
	});

	it("rejects unknown fields, both sources, and empty commands", () => {
		expect(() => parseRecipe("apt: [git]\n")).toThrow(/Unknown recipe field/);
		expect(() => parseRecipe("from:\n  template: a\n  image: b\n")).toThrow(/not both/);
		expect(() => parseRecipe("run:\n  - ''\n")).toThrow(/non-empty/);
		expect(() => parseRecipe("run: not-a-list\n")).toThrow(/list of commands/);
	});

	it("round-trips through the stored YAML", () => {
		const recipe = {
			description: "Base tools",
			source: { kind: "template" as const, name: "harness-base" },
			run: ["apt-get update", "apt-get install -y jq"],
		};
		expect(parseRecipe(serializeRecipe(recipe))).toEqual(recipe);
	});

	it("gives the starter recipe the common tools and Docker", () => {
		const commands = STARTER_RECIPE.run.join("\n");
		expect(commands).toContain("websocat");
		expect(commands).toContain("get.docker.com");
		expect(commands).toContain("usermod -aG docker user");
	});

	it("normalizes names and rejects the rest", () => {
		expect(templateName("  Node-22  ")).toBe("node-22");
		expect(templateName("node 22")).toBeUndefined();
		expect(templateName("a/b")).toBeUndefined();
		expect(templateName("")).toBeUndefined();
	});
});

describe("template manager", () => {
	it("creates, builds, and reports a ready template with its log", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			const manager = templateManager(dir, provider);
			await manager.create("node-22", { source: { kind: "image", image: "node:22" }, run: ["corepack enable"] });
			expect((await manager.list()).templates).toMatchObject([{ name: "node-22", state: "draft" }]);

			await manager.startBuild("node-22");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "ready");
			expect(provider.buildStarts).toEqual(["node-22"]);
			expect(provider.templateBuilds[0]?.spec).toEqual({
				name: "node-22",
				source: { kind: "image", image: "node:22" },
				run: ["corepack enable"],
			});
			expect((await manager.logs("node-22")).lines).toEqual(["step one", "step two"]);
		});
	});

	it("marks a template stale when its recipe changes after a build", async () => {
		await withDir(async (dir) => {
			const manager = templateManager(dir, new FakeSandboxProvider());
			await manager.create("tools", { source: { kind: "default" }, run: ["true"] });
			await manager.startBuild("tools");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "ready");

			await manager.update("tools", { source: { kind: "default" }, run: ["false"] });
			expect((await manager.list()).templates[0]?.state).toBe("stale");
		});
	});

	it("records a failed build and its error", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			provider.buildError = "apt-get exited 100";
			const manager = templateManager(dir, provider);
			await manager.create("broken", { source: { kind: "default" }, run: ["false"] });
			await manager.startBuild("broken");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "failed");
			const [template] = (await manager.list()).templates;
			expect(template?.lastBuild?.error).toContain("apt-get exited 100");
			expect((await manager.logs("broken")).done).toBe(true);
		});
	});

	it("runs builds one at a time, in the order they were queued", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			let release: () => void = () => {};
			provider.buildGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const manager = templateManager(dir, provider);
			await manager.create("first", { source: { kind: "default" }, run: [] });
			await manager.create("second", { source: { kind: "default" }, run: [] });

			await manager.startBuild("first");
			await manager.startBuild("second");
			await waitFor(async () => provider.buildStarts.length === 1);
			expect(provider.buildStarts).toEqual(["first"]);
			// The second build waits while the first is gated, and the list shows it queued.
			expect((await manager.list()).templates.find((template) => template.name === "second")?.state).toBe("building");

			release();
			await waitFor(async () => provider.buildStarts.length === 2);
			expect(provider.buildStarts).toEqual(["first", "second"]);
			await waitFor(async () => (await manager.list()).templates.every((template) => template.state === "ready"));
		});
	});

	it("refuses a duplicate name, creates the starter once, and removes a template", async () => {
		await withDir(async (dir) => {
			const manager = templateManager(dir, new FakeSandboxProvider());
			await manager.createStarter();
			await expect(manager.createStarter()).rejects.toBeInstanceOf(SandboxError);
			expect((await manager.list()).templates.map((template) => template.name)).toEqual(["harness-base"]);
			await manager.remove("harness-base");
			expect((await manager.list()).templates).toHaveLength(0);
		});
	});

	it("lists provider templates the harness does not manage as other", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			provider.templates.set("tpl-elsewhere", {
				names: ["elsewhere"],
				templateId: "tpl-elsewhere",
				buildId: "build-elsewhere",
			});
			const manager = templateManager(dir, provider);
			await manager.create("mine", { source: { kind: "default" }, run: [] });
			await manager.startBuild("mine");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "ready");

			const state = await manager.list();
			expect(state.other.map((template) => template.names)).toEqual([["elsewhere"]]);
		});
	});

	it("marks a managed template missing when the provider no longer has it", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			const manager = templateManager(dir, provider);
			await manager.create("gone", { source: { kind: "default" }, run: [] });
			await manager.startBuild("gone");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "ready");

			provider.templates.clear();
			expect((await manager.list()).templates[0]?.state).toBe("missing");
		});
	});

	it("deletes a managed template in the provider too", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			const manager = templateManager(dir, provider);
			await manager.create("doomed", { source: { kind: "default" }, run: [] });
			await manager.startBuild("doomed");
			await waitFor(async () => (await manager.list()).templates[0]?.state === "ready");

			await manager.deleteTemplate("doomed");
			expect(provider.templates.size).toBe(0);
			expect((await manager.list()).templates).toHaveLength(0);
		});
	});

	it("exposes the stored sandbox default in the list", async () => {
		await withDir(async (dir) => {
			const manager = templateManager(dir, new FakeSandboxProvider(), {
				defaultTemplate: () => "harness-base",
			});
			expect((await manager.list()).default).toBe("harness-base");

			const without = templateManager(dir, new FakeSandboxProvider());
			expect((await without.list()).default).toBeUndefined();
		});
	});

	it("emits a changed event as a build moves through its states", async () => {
		await withDir(async (dir) => {
			const provider = new FakeSandboxProvider();
			let release: () => void = () => {};
			provider.buildGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const manager = templateManager(dir, provider);
			const states: string[] = [];
			manager.onChanged = () => {
				void manager.list().then((state) => {
					const template = state.templates[0];
					if (template !== undefined) states.push(template.state);
				});
			};
			await manager.create("watched", { source: { kind: "default" }, run: [] });
			await manager.startBuild("watched");
			await waitFor(async () => states.includes("building"));
			release();
			await waitFor(async () => states.includes("ready"));
			expect(states).toContain("building");
			expect(states.at(-1)).toBe("ready");
		});
	});
});

describe("template service commands", () => {
	it("creates and builds a template through the service and announces it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-templates-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const templates = templateManager(dir, provider);
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
			templates,
		});
		const events: string[] = [];
		service.on((event) => {
			if (event.type === "templates") {
				events.push(...event.templates.map((template) => `${template.name}:${template.state}`));
			}
		});
		try {
			const created = await service.createTemplate("service-base", {
				description: "For the service test",
				source: { kind: "default" },
				run: ["true"],
			});
			expect(created.templates).toMatchObject([{ name: "service-base", state: "draft" }]);

			await service.buildTemplate("service-base");
			await waitFor(async () => (await service.listTemplates()).templates[0]?.state === "ready");
			expect(events).toContain("service-base:draft");
			expect(events).toContain("service-base:ready");
			expect((await service.templateLogs("service-base")).lines).toEqual(["step one", "step two"]);
		} finally {
			await service.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses a bad template name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-templates-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
			templates: templateManager(dir, provider),
		});
		try {
			await expect(service.createTemplate("Bad Name", {})).rejects.toMatchObject({ code: "invalid" });
		} finally {
			await service.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads a stored template that equals the provider default as no choice", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-templates-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const store = new FakeSandboxSettingsStore({ template: "base" });
		const manager = new SandboxManager({ store });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
			templates: templateManager(dir, provider, {
				defaultTemplate: () => store.getSandboxSettings().template,
			}),
		});
		try {
			expect((await service.listSandboxes()).settings.template).toBeUndefined();
			await service.createStarterTemplate();
			expect((await service.listTemplates()).default).toBeUndefined();

			await service.setSandboxSettings({ template: "harness-base" });
			expect((await service.listTemplates()).default).toBe("harness-base");
		} finally {
			await service.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("resets the sandbox default when its template is removed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-templates-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const store = new FakeSandboxSettingsStore({ template: "harness-base" });
		const manager = new SandboxManager({ store });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
			templates: templateManager(dir, provider, { defaultTemplate: () => store.getSandboxSettings().template }),
		});
		const defaults: (string | undefined)[] = [];
		service.on((event) => {
			if (event.type === "sandboxes") defaults.push(event.settings.template);
		});
		try {
			await service.createStarterTemplate();
			expect((await service.listTemplates()).default).toBe("harness-base");

			const after = await service.removeTemplate("harness-base");
			expect(after.default).toBeUndefined();
			expect(manager.settings.template).toBeUndefined();
			expect(manager.defaultTemplate()).toBe("base");
			expect(defaults.at(-1)).toBeUndefined();
		} finally {
			await service.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("resets the sandbox default when its template is deleted in E2B", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-templates-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({
			store: new FakeSandboxSettingsStore({ template: "harness-base" }),
		});
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
			templates: templateManager(dir, provider),
		});
		try {
			await service.createStarterTemplate();
			await service.buildTemplate("harness-base");
			await waitFor(async () => (await service.listTemplates()).templates[0]?.state === "ready");

			const after = await service.deleteTemplate("harness-base");
			expect(after.templates).toHaveLength(0);
			expect(provider.templates.size).toBe(0);
			expect(manager.settings.template).toBeUndefined();
		} finally {
			await service.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
