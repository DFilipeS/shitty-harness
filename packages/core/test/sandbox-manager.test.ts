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
				{ kind: "sandbox", provider: "fake", workspaceDir: root },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(env.cwd).toBe(root);
			expect(statuses.map((status) => status.phase)).toEqual(["starting", "ready"]);
			expect(remembered).toEqual([env.sandboxId]);

			// A second use returns the same environment without a new sandbox.
			const again = await manager.environment(
				{ kind: "sandbox", provider: "fake", workspaceDir: root },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(again).toBe(env);
			expect(await manager.list()).toHaveLength(1);

			// After forget, the target connects to the sandbox that already exists.
			manager.forget("7");
			const connected = await manager.environment(
				{ kind: "sandbox", provider: "fake", sandboxId: env.sandboxId, workspaceDir: root },
				"7",
				BACKGROUND_CONTEXT,
			);
			expect(connected.sandboxId).toBe(env.sandboxId);
			expect(await manager.list()).toHaveLength(1);
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
					{ kind: "sandbox", provider: "fake", sandboxId: "missing", workspaceDir: root },
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
});
