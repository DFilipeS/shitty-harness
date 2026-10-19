import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
	createEnvConformance,
	type EnvConformanceAssertions,
} from "@earendil-works/pi-durable/testing";
import { describe, expect, it, vi } from "vitest";
import { SandboxExecutionEnv } from "../src/sandboxes/env.ts";
import { FakeSandboxProvider } from "./helpers/fake-sandbox.ts";

const assertions: EnvConformanceAssertions = {
	ok: (value, message) => expect(value, message).toBeTruthy(),
	strictEqual: (actual, expected) => expect(actual).toBe(expected),
	deepEqual: (actual, expected) => expect(actual).toEqual(expected),
	partialDeepEqual: (actual, expected) => expect(actual).toMatchObject(expected as object),
	greaterThan: (actual, expected) => expect(actual).toBeGreaterThan(expected),
	rejects: async (operation, messageIncludes) => {
		await expect(operation).rejects.toThrow(messageIncludes);
	},
};

describe("SandboxExecutionEnv", () => {
	const cases = createEnvConformance({
		assertions,
		withEnv: async (use) => {
			const root = await mkdtemp(join(tmpdir(), "harness-sandbox-env-"));
			const provider = new FakeSandboxProvider();
			const handle = await provider.create({ workspaceDir: root });
			try {
				await use(new SandboxExecutionEnv(handle));
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	});

	for (const testCase of cases) {
		it(
			testCase.name,
			async () => {
				await testCase.run();
			},
			testCase.timeoutMs,
		);
	}

	it("passes the forwarded agent socket to commands", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-agent-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root });
		try {
			const env = new SandboxExecutionEnv(handle, { agentSocket: "/tmp/agent.sock" });
			getOrThrow(await env.exec("true", undefined, BACKGROUND_CONTEXT));
			expect(handle.lastExecEnv).toEqual({ SSH_AUTH_SOCK: "/tmp/agent.sock" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("renews the sandbox lifetime while a command runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-lifetime-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root, idleTimeoutMs: 40 });
		try {
			const env = new SandboxExecutionEnv(handle);
			const result = getOrThrow(await env.exec("sleep 0.15", undefined, BACKGROUND_CONTEXT));
			expect(result.exitCode).toBe(0);
			// One renewal before the command, then at least one during it.
			expect(handle.keepAliveCalls).toBeGreaterThanOrEqual(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("renews nothing when the sandbox has no idle timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-lifetime-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root });
		try {
			const env = new SandboxExecutionEnv(handle);
			getOrThrow(await env.exec("true", undefined, BACKGROUND_CONTEXT));
			expect(handle.keepAliveCalls).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs the command even when a renewal fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-lifetime-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root, idleTimeoutMs: 40 });
		handle.keepAliveFails = true;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const env = new SandboxExecutionEnv(handle);
			const result = getOrThrow(await env.exec("true", undefined, BACKGROUND_CONTEXT));
			expect(result.exitCode).toBe(0);
			expect(handle.keepAliveCalls).toBeGreaterThanOrEqual(1);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("runs commands in the workspace by default", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-cwd-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root });
		try {
			const env = new SandboxExecutionEnv(handle);
			getOrThrow(await env.writeFile("here.txt", "x", BACKGROUND_CONTEXT));
			let stdout = "";
			const result = getOrThrow(
				await env.exec(
					"cat here.txt",
					{
						onOutput: (text, _context, info) => {
							if (info.stream === "stdout") stdout += text;
						},
					},
					BACKGROUND_CONTEXT,
				),
			);
			expect(result.exitCode).toBe(0);
			expect(stdout).toBe("x");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
