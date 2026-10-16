import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { HarnessService, SandboxError, type ServiceEvent } from "../src/index.ts";
import { localEnvironment } from "../src/node.ts";
import { SandboxManager } from "../src/sandboxes/manager.ts";
import { createFauxProviders } from "./helpers/fake-providers.ts";
import {
	FakeSandboxProvider,
	FakeSandboxSettingsStore,
	registerFakeSandboxProvider,
} from "./helpers/fake-sandbox.ts";

/** Poll a predicate until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function toolCallingService(tool: string, args: JsonObject) {
	const { providers, faux } = createFauxProviders();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	return providers;
}

describe("sandbox targets", () => {
	it("runs tools in a lazily created sandbox and remembers its id", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers: toolCallingService("write", { path: "hello.txt", content: "hi from the sandbox\n" }),
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		try {
			const session = await service.createSession();
			const updated = await service.setTarget(session.id, {
				kind: "sandbox",
				source: { kind: "empty" },
				workspaceDir: sandboxRoot,
			});
			expect(updated.target).toMatchObject({ kind: "sandbox", provider: "fake" });
			// Nothing is created until the environment is needed.
			expect(await manager.list()).toHaveLength(0);

			await service.prompt(session.id, "Write hello.txt", "request-sandbox");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			expect(await readFile(join(sandboxRoot, "hello.txt"), "utf8")).toBe("hi from the sandbox\n");
			const listed = (await service.listSessions()).find((candidate) => candidate.id === session.id);
			expect(listed?.target.kind).toBe("sandbox");
			const sandboxId = listed?.target.kind === "sandbox" ? listed.target.sandboxId : undefined;
			expect(sandboxId).toBeDefined();

			const state = await service.listSandboxes();
			expect(state.settings.configured).toBe(true);
			expect(state.sandboxes.map((sandbox) => sandbox.id)).toEqual([sandboxId]);
			expect(state.sandboxes[0]?.sessions).toContain(session.id);

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const change = snapshot.entries.find((entry) => entry.kind === "app.target");
			expect(change?.data).toMatchObject({ kind: "sandbox", provider: "fake" });
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("connects a session to an existing sandbox without creating another", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers: toolCallingService("write", { path: "existing.txt", content: "hi\n" }),
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		try {
			const created = await manager.create({ workspaceDir: sandboxRoot, name: "shared" });
			const session = await service.createSession();
			await service.setTarget(session.id, {
				kind: "sandbox",
				sandboxId: created.id,
				workspaceDir: sandboxRoot,
			});
			await service.prompt(session.id, "Write existing.txt", "request-existing");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			expect(await readFile(join(sandboxRoot, "existing.txt"), "utf8")).toBe("hi\n");
			expect(await manager.list()).toHaveLength(1);
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("reports a gone sandbox and fails the tool without falling back", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers: toolCallingService("write", { path: "fallback.txt", content: "must not run\n" }),
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		const statuses: ServiceEvent[] = [];
		service.on((event) => statuses.push(event));
		try {
			const created = await manager.create({ workspaceDir: sandboxRoot });
			const session = await service.createSession();
			await service.setTarget(session.id, {
				kind: "sandbox",
				sandboxId: created.id,
				workspaceDir: sandboxRoot,
			});
			await manager.kill("fake", created.id);

			await service.prompt(session.id, "Write fallback.txt", "request-gone");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			// The tool failed and nothing ran in the local scratch directory.
			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const toolResults = snapshot.entries.filter((entry) => entry.kind === "pi.tool-result");
			expect(toolResults).toHaveLength(1);
			expect(JSON.stringify(toolResults[0]?.model)).toContain("gone");
			await expect(readFile(join(workspacesDir, session.id, "fallback.txt"), "utf8")).rejects.toThrow();
			const gone = statuses.some(
				(event) => event.type === "target" && event.status.phase === "gone",
			);
			expect(gone).toBe(true);
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("forwards the host SSH agent into a sandbox session", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({
			store: new FakeSandboxSettingsStore(),
			resolveHostAgentSocket: async () => "/tmp/host-agent.sock",
		});
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers: toolCallingService("bash", { command: "true" }),
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		try {
			const session = await service.createSession();
			await service.setTarget(session.id, {
				kind: "sandbox",
				source: { kind: "empty" },
				workspaceDir: sandboxRoot,
				forwardAgent: true,
			});
			await service.prompt(session.id, "Run true", "request-agent");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			expect(provider.handles[0]?.lastExecEnv).toEqual({ SSH_AUTH_SOCK: "/tmp/fake-agent.sock" });
			const state = await service.listSandboxes();
			expect(state.sandboxes[0]?.forwarding).toBe(true);
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("lists the provider once per sandbox command", async () => {
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
		});
		try {
			const before = provider.listCount;
			await service.setSandboxSettings({ autoPause: false });
			expect(provider.listCount - before).toBe(1);
			const another = provider.listCount;
			await service.listSandboxes();
			expect(provider.listCount - another).toBe(1);
		} finally {
			await service.close();
		}
	});

	it("rejects a sandbox key the provider refuses", async () => {
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider, async () => {
			throw new SandboxError("auth", "bad key");
		});
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore({ providers: {} }) });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
		});
		try {
			await expect(service.configureSandboxProvider("fake", "bad")).rejects.toMatchObject({ code: "auth" });
			expect(manager.settings.providers.fake).toBeUndefined();
		} finally {
			await service.close();
		}
	});

	it("refuses a sandbox target without a configured provider", async () => {
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore({ providers: {} }) });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			sandboxes: manager,
		});
		try {
			const session = await service.createSession();
			await expect(service.setTarget(session.id, { kind: "sandbox" })).rejects.toMatchObject({
				code: "sandbox_unavailable",
			});
		} finally {
			await service.close();
		}
	});

	it("stores a sandbox as the default target for new sessions", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		try {
			await service.setDefaults({ target: { kind: "sandbox" } });
			const session = await service.createSession();
			expect(session.target).toMatchObject({ kind: "sandbox", provider: "fake" });
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("uses the stored default template, or the provider's own for an explicit null", async () => {
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
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
		});
		try {
			expect(manager.defaultTemplate()).toBe("harness-base");
			await service.createSandbox({ workspaceDir: sandboxRoot, source: { kind: "empty" } });
			expect(provider.createSpecs[0]?.template).toBe("harness-base");

			await service.createSandbox({ workspaceDir: sandboxRoot, source: { kind: "empty" }, template: null });
			expect(provider.createSpecs[1]?.template).toBe("base");

			await service.createSandbox({ workspaceDir: sandboxRoot, source: { kind: "empty" }, template: "node-22" });
			expect(provider.createSpecs[2]?.template).toBe("node-22");
		} finally {
			await service.close();
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("pins the provider default when a sandbox target names no template", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-sandbox-service-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "harness-sandbox-root-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: localEnvironment(),
			workspacesDir,
			sandboxes: manager,
		});
		try {
			const session = await service.createSession();
			await service.setTarget(session.id, {
				kind: "sandbox",
				source: { kind: "empty" },
				workspaceDir: sandboxRoot,
			});
			await service.prompt(session.id, "Do nothing", "request-template");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(provider.createSpecs[0]?.template).toBe("base");
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});
});
