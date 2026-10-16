import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { SandboxManager, type SandboxStatus } from "../src/sandboxes/manager.ts";
import {
	FakeSandboxProvider,
	FakeSandboxSettingsStore,
	registerFakeSandboxProvider,
	type FakeSandboxHandle,
} from "./helpers/fake-sandbox.ts";

describe("SandboxManager", () => {
	it("creates a sandbox on first use, caches it, and remembers the id", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const statuses: SandboxStatus[] = [];
		const remembered: string[] = [];
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		manager.onStatus = (status) => statuses.push(status);
		manager.rememberSandboxId = async (_conversationId, sandboxId) => {
			remembered.push(sandboxId);
		};
		try {
			const env = await manager.environment(
				{ kind: "sandbox", provider: "fake", workspaceDir: root, forwardAgent: false },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(env.cwd).toBe(root);
			expect(statuses.map((status) => status.phase)).toEqual(["starting", "ready"]);
			expect(remembered).toEqual([env.sandboxId]);

			// A second use returns the same environment without a new sandbox.
			const again = await manager.environment(
				{ kind: "sandbox", provider: "fake", workspaceDir: root, forwardAgent: false },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(again).toBe(env);
			expect(await manager.list()).toHaveLength(1);

			// After forget, the target connects to the sandbox that already exists.
			manager.forget("7");
			const connected = await manager.environment(
				{ kind: "sandbox", provider: "fake", sandboxId: env.sandboxId, workspaceDir: root, forwardAgent: false },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(connected.sandboxId).toBe(env.sandboxId);
			expect(await manager.list()).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("connects a session's sandbox with the configured idle timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore({ idleTimeoutMs: 30_000 }) });
		try {
			const created = await manager.create({ workspaceDir: root });
			await manager.setSettings({ idleTimeoutMs: 60_000 });
			manager.forget("1");
			const env = await manager.environment(
				{ kind: "sandbox", provider: "fake", sandboxId: created.id, workspaceDir: root, forwardAgent: false },
				"1",
				BACKGROUND_CONTEXT,
			);
			expect((env.handle as FakeSandboxHandle).lifetimeMs).toBe(60_000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("pauses, resumes, kills, and reports metrics", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		try {
			const created = await manager.create({ workspaceDir: root, name: "project" });
			expect(created.name).toBe("project");
			await manager.pause("fake", created.id);
			expect((await manager.list())[0]?.state).toBe("paused");
			await manager.resume("fake", created.id);
			expect((await manager.list())[0]?.state).toBe("running");
			const metrics = await manager.metrics("fake", created.id);
			expect(metrics?.cpuCount).toBe(2);
			await manager.kill("fake", created.id);
			expect((await manager.list())[0]?.state).toBe("stopped");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reports a gone sandbox and refuses to open it", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const statuses: SandboxStatus[] = [];
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		manager.onStatus = (status) => statuses.push(status);
		try {
			await expect(
				manager.environment(
					{ kind: "sandbox", provider: "fake", sandboxId: "missing", workspaceDir: root, forwardAgent: false },
					"9",
					BACKGROUND_CONTEXT,
				),
			).rejects.toMatchObject({ code: "not_found" });
			expect(statuses.map((status) => status.phase)).toEqual(["gone"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("knows whether the provider is configured", () => {
		const manager = new SandboxManager({ store: new FakeSandboxSettingsStore() });
		expect(manager.configured()).toBe(true);
		const bare = new SandboxManager({
			store: new FakeSandboxSettingsStore({ providers: {} }),
		});
		expect(bare.configured()).toBe(false);
	});

	it("forwards the SSH agent and stops it on pause and kill", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const manager = new SandboxManager({
			store: new FakeSandboxSettingsStore(),
			resolveHostAgentSocket: async () => "/tmp/host-agent.sock",
		});
		try {
			const env = await manager.environment(
				{ kind: "sandbox", provider: "fake", workspaceDir: root, forwardAgent: true },
				"11",
				BACKGROUND_CONTEXT,
			);
			const handle = env.handle as FakeSandboxHandle;
			expect(env.agentSocket).toBe("/tmp/fake-agent.sock");
			expect(handle.forwarding).toEqual({ hostSocket: "/tmp/host-agent.sock", closed: false });
			expect((await manager.list())[0]?.forwarding).toBe(true);

			await manager.pause("fake", env.sandboxId);
			expect(handle.forwarding?.closed).toBe(true);
			expect((await manager.list())[0]?.forwarding).toBe(false);

			await manager.resume("fake", env.sandboxId);
			expect(handle.forwarding).toEqual({ hostSocket: "/tmp/host-agent.sock", closed: false });

			await manager.kill("fake", env.sandboxId);
			expect(handle.forwarding?.closed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps sandboxes and forwards on a settings change, and drops them on a credential change", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-manager-"));
		const provider = new FakeSandboxProvider();
		registerFakeSandboxProvider(provider);
		const store = new FakeSandboxSettingsStore();
		const manager = new SandboxManager({
			store,
			resolveHostAgentSocket: async () => "/tmp/host-agent.sock",
		});
		try {
			const env = await manager.environment(
				{ kind: "sandbox", provider: "fake", workspaceDir: root, forwardAgent: true },
				"13",
				BACKGROUND_CONTEXT,
			);
			const handle = env.handle as FakeSandboxHandle;

			// A toggle only affects sandboxes created later: the live one keeps its forward and cache.
			await manager.setSettings({ autoPause: false });
			expect(store.getSandboxSettings().autoPause).toBe(false);
			expect(handle.forwarding?.closed).toBe(false);
			const again = await manager.environment(
				{ kind: "sandbox", provider: "fake", sandboxId: env.sandboxId, workspaceDir: root, forwardAgent: true },
				"13",
				BACKGROUND_CONTEXT,
			);
			expect(again).toBe(env);

			// A new key invalidates: the sandbox must be used through a fresh provider and forward.
			await manager.setSettings({ apiKey: { provider: "fake", key: "another-key" } });
			expect(handle.forwarding?.closed).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
