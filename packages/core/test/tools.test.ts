import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import type { EnvironmentFactory } from "../src/environment.ts";
import { HarnessService } from "../src/index.ts";
import { localEnvironment } from "../src/node.ts";
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("coding tools", () => {
	it("offers the bundled tools and runs them in the local environment", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-tools-"));
		const { providers, faux } = createFauxProviders();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi from the tool\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("bash", { command: "cat hello.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
		});
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Write hello.txt and read it back", "request-tools");
			const started = await waitFor(async () => (await service.listSessions())[0]?.working === true);
			const finished = await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect({ started, finished }).toEqual({ started: true, finished: true });

			expect(await readFile(join(workspace, "hello.txt"), "utf8")).toBe("hi from the tool\n");

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const toolResults = snapshot.entries.filter((entry) => entry.kind === "pi.tool-result");
			expect(toolResults).toHaveLength(2);
			expect(JSON.stringify(toolResults[0]?.model)).toContain("hello.txt");
			expect(JSON.stringify(toolResults[1]?.model)).toContain("hi from the tool");
		} finally {
			await service.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("roots the local environment at the workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-env-"));
		try {
			const environment = localEnvironment(workspace);
			const target = { conversationId: 1, read: {} } as unknown as Parameters<EnvironmentFactory>[0];
			const env = await environment(target, BACKGROUND_CONTEXT);
			expect(env?.cwd).toBe(workspace);
			const written = await env?.writeFile("note.txt", "hi", BACKGROUND_CONTEXT);
			expect(written?.ok).toBe(true);
			expect(await readFile(join(workspace, "note.txt"), "utf8")).toBe("hi");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("puts the image instruction in the prompt", async () => {
		const { providers, faux } = createFauxProviders({ image: { data: PNG, mimeType: "image/png" } });
		let prompt = "";
		faux.setResponses([
			(context) => {
				// Sections ride on the system message, not in its content.
				prompt = context.messages
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify(message))
					.join("\n");
				return fauxAssistantMessage("ok");
			},
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "hello", "request-prompt");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(prompt).toContain("generate_image tool");
		} finally {
			await service.close();
		}
	});

	it("generates an image through the harness and keeps it in the transcript", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-tools-image-"));
		const { providers, faux } = createFauxProviders({ image: { data: PNG, mimeType: "image/png" } });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "a red apple" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Here is your image."),
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
		});
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Generate a red apple", "request-image");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const toolResults = snapshot.entries.filter((entry) => entry.kind === "pi.tool-result");
			expect(toolResults).toHaveLength(1);
			const message = toolResults[0]?.model?.[0];
			const content = message?.role === "toolResult" ? message.content : [];
			expect(content.some((part) => part.type === "image" && part.data === PNG)).toBe(true);
			expect(JSON.stringify(content)).toContain("Saved `image-");
			const files = await readdir(workspace);
			expect(files.some((name) => /^image-\d+\.png$/.test(name))).toBe(true);
		} finally {
			await service.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("fails tool calls when no environment is configured", async () => {
		const { providers, faux } = createFauxProviders();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Run a command", "request-no-env");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const toolResults = snapshot.entries.filter((entry) => entry.kind === "pi.tool-result");
			expect(toolResults).toHaveLength(1);
			expect(JSON.stringify(toolResults[0]?.model)).toContain("No execution environment");
		} finally {
			await service.close();
		}
	});
});
