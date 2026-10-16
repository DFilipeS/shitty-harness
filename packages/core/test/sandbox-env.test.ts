import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance, type EnvConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
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

	it("runs commands in the workspace by default", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-sandbox-cwd-"));
		const provider = new FakeSandboxProvider();
		const handle = await provider.create({ workspaceDir: root });
		try {
			const env = new SandboxExecutionEnv(handle);
			getOrThrow(await env.writeFile("here.txt", "x", BACKGROUND_CONTEXT));
			let stdout = "";
			const result = getOrThrow(
				await env.exec("cat here.txt", { onOutput: (text, _context, info) => { if (info.stream === "stdout") stdout += text; } }, BACKGROUND_CONTEXT),
			);
			expect(result.exitCode).toBe(0);
			expect(stdout).toBe("x");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
