import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { HarnessService } from "../src/index.ts";
import { createFauxProviders } from "./helpers/fake-providers.ts";

/** Poll a predicate until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("codemode", () => {
	it("runs a script's nested tool calls and reports them in the result's details", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-codemode-"));
		const { providers, faux } = createFauxProviders();
		const script = `
			const first = await tools.bash({ command: "echo one" });
			const second = await tools.bash({ command: "echo two" });
			return [first.output.trim(), second.output.trim()].join(" + ");
		`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: script })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
		});
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Run two echoes in one script", "request-codemode");
			expect(await waitFor(async () => (await service.listSessions())[0]?.working === false)).toBe(
				true,
			);

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const result = snapshot.entries.find((entry) => entry.kind === "pi.tool-result");
			expect(result).toBeDefined();
			const message = result?.model?.[0] as
				{ content?: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
			const text = (message?.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			expect(text).toContain("one + two");
			const details = message?.details as
				{ calls?: Array<{ name: string; status: string }> } | undefined;
			expect(details?.calls).toHaveLength(2);
			expect(details?.calls?.map((call) => [call.name, call.status])).toEqual([
				["bash", "ok"],
				["bash", "ok"],
			]);
		} finally {
			await service.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
