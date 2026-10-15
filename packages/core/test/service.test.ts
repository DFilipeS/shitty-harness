import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { HarnessService, type HarnessServiceDependencies } from "../src/index.ts";
import {
	createFakeProviders,
	createFauxProviders,
	FAKE_IMAGE_MODEL_ID,
	FAKE_IMAGE_PROVIDER_ID,
	FAKE_MODEL_ID,
	FAKE_PROVIDER_ID,
	FAKE_REASONING_MODEL,
	FAKE_REASONING_MODEL_ID,
	type FakeProvidersOptions,
} from "./helpers/fake-providers.ts";

type OpenOptions = {
	apiKey?: string;
	models?: FakeProvidersOptions["models"];
};

async function openService(options: OpenOptions = {}): Promise<HarnessService> {
	const dependencies: HarnessServiceDependencies = {
		storage: new MemoryStorage(),
		providers: createFakeProviders(options),
	};
	return HarnessService.create(dependencies);
}

async function withService(run: (service: HarnessService) => Promise<void>, options: OpenOptions = {}): Promise<void> {
	const service = await openService(options);
	try {
		await run(service);
	} finally {
		await service.close();
	}
}

const FAKE_IMAGE_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

/** Poll a predicate until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("HarnessService", () => {
	it("opens with no sessions", async () => {
		await withService(async (service) => {
			expect(await service.listSessions()).toEqual([]);
		});
	});

	it("creates a session with an initial model and lists it", async () => {
		await withService(
			async (service) => {
				const session = await service.createSession();
				expect(session.title).toBe("New session");
				expect((await service.listSessions()).map((candidate) => candidate.id)).toContain(session.id);

				const agent = await service.configureSession(session.id, {});
				expect(agent.model).toEqual({ provider: FAKE_PROVIDER_ID, modelId: FAKE_MODEL_ID });
			},
			{ apiKey: "test-key" },
		);
	});

	it("uses the default model and thinking level for new sessions", async () => {
		await withService(
			async (service) => {
				const defaults = await service.setDefaults({
					model: { provider: FAKE_PROVIDER_ID, modelId: FAKE_REASONING_MODEL_ID },
					thinkingLevel: "high",
				});
				expect(defaults).toEqual({
					model: { provider: FAKE_PROVIDER_ID, modelId: FAKE_REASONING_MODEL_ID },
					thinkingLevel: "high",
				});

				const session = await service.createSession();
				const agent = await service.configureSession(session.id, {});
				expect(agent.model).toEqual({ provider: FAKE_PROVIDER_ID, modelId: FAKE_REASONING_MODEL_ID });
				expect(agent.thinkingLevel).toBe("high");
			},
			{ apiKey: "test-key", models: [FAKE_REASONING_MODEL] },
		);
	});

	it("clamps the default thinking level to the model that gets it", async () => {
		await withService(
			async (service) => {
				await service.setDefaults({ thinkingLevel: "high" });
				const session = await service.createSession();
				const agent = await service.configureSession(session.id, {});
				expect(agent.model).toEqual({ provider: FAKE_PROVIDER_ID, modelId: FAKE_MODEL_ID });
				expect(agent.thinkingLevel).toBe("off");
			},
			{ apiKey: "test-key" },
		);
	});

	it("falls back to the first model when the default is cleared", async () => {
		await withService(
			async (service) => {
				await service.setDefaults({ model: { provider: FAKE_PROVIDER_ID, modelId: FAKE_REASONING_MODEL_ID } });
				await service.setDefaults({ model: null });
				const session = await service.createSession();
				const agent = await service.configureSession(session.id, {});
				expect(agent.model).toEqual({ provider: FAKE_PROVIDER_ID, modelId: FAKE_MODEL_ID });
			},
			{ apiKey: "test-key", models: [FAKE_REASONING_MODEL] },
		);
	});

	it("lists models alphabetically inside each provider", async () => {
		const alpha = { ...FAKE_REASONING_MODEL, id: "alpha-model", name: "Alpha Model" };
		await withService(
			async (service) => {
				const { models } = await service.listProviders();
				expect(models.map((model) => model.name)).toEqual([
					"Alpha Model",
					"Fake Model",
					"Fake Reasoning Model",
				]);
			},
			{ apiKey: "test-key", models: [FAKE_REASONING_MODEL, alpha] },
		);
	});

	it("stores a default image model", async () => {
		const { providers } = createFauxProviders({ image: { data: "aGk=", mimeType: "image/png" } });
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const defaults = await service.setDefaults({
				imageModel: { provider: FAKE_IMAGE_PROVIDER_ID, modelId: FAKE_IMAGE_MODEL_ID },
			});
			expect(defaults.imageModel).toEqual({ provider: FAKE_IMAGE_PROVIDER_ID, modelId: FAKE_IMAGE_MODEL_ID });
			const { imageModels } = await service.listProviders();
			expect(imageModels.map((model) => model.id)).toContain(FAKE_IMAGE_MODEL_ID);
		} finally {
			await service.close();
		}
	});

	it("rejects a default image model that does not exist", async () => {
		await withService(async (service) => {
			await expect(
				service.setDefaults({ imageModel: { provider: "nope", modelId: "nope" } }),
			).rejects.toMatchObject({ code: "unknown_model" });
		});
	});

	it("rejects a default model that does not exist", async () => {
		await withService(async (service) => {
			await expect(
				service.setDefaults({ model: { provider: "nope", modelId: "nope" } }),
			).rejects.toMatchObject({ code: "unknown_model" });
		});
	});

	it("renames a session and rejects an empty title", async () => {
		await withService(async (service) => {
			const session = await service.createSession();
			const renamed = await service.renameSession(session.id, "  Renamed  ");
			expect(renamed.title).toBe("Renamed");
			expect((await service.listSessions())[0]?.title).toBe("Renamed");

			await expect(service.renameSession(session.id, "   ")).rejects.toMatchObject({ code: "invalid" });
		});
	});

	it("deletes a session and rejects later access", async () => {
		await withService(async (service) => {
			const session = await service.createSession();
			await service.deleteSession(session.id);
			expect(await service.listSessions()).toEqual([]);

			await expect(service.renameSession(session.id, "Again")).rejects.toMatchObject({ code: "not_found" });
			await expect(service.subscribeSession(session.id, () => {})).rejects.toMatchObject({ code: "not_found" });
		});
	});

	it("configures and clears a provider API key", async () => {
		await withService(async (service) => {
			const before = await service.listProviders();
			expect(before.providers.find((provider) => provider.id === FAKE_PROVIDER_ID)?.configured).toBe(false);

			await service.configureProvider(FAKE_PROVIDER_ID, "test-key");
			const configured = await service.listProviders();
			expect(configured.providers.find((provider) => provider.id === FAKE_PROVIDER_ID)?.configured).toBe(true);
			expect(configured.models.map((model) => model.id)).toContain(FAKE_MODEL_ID);

			await service.configureProvider(FAKE_PROVIDER_ID, null);
			const cleared = await service.listProviders();
			expect(cleared.providers.find((provider) => provider.id === FAKE_PROVIDER_ID)?.configured).toBe(false);
		});
	});

	it("rejects prompts with an empty message", async () => {
		await withService(async (service) => {
			const session = await service.createSession();
			await expect(service.prompt(session.id, "   ", "request-1")).rejects.toMatchObject({ code: "invalid" });
		});
	});

	it("rejects prompts without a model", async () => {
		await withService(
			async (service) => {
				const session = await service.createSession();
				await service.configureSession(session.id, { model: null });
				await expect(service.prompt(session.id, "Hello", "request-2")).rejects.toMatchObject({ code: "no_model" });
			},
			{ apiKey: "test-key" },
		);
	});

	it("places attachments in the user message", async () => {
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Look at this", "request-attachments", [
				{ name: "shot.png", mimeType: "image/png", data: "aGk=" },
				{ name: "notes.md", mimeType: "text/markdown", data: "# Notes" },
			]);
			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			const user = snapshot.entries.find((entry) => entry.kind === "pi.user");
			expect(user?.model?.[0]).toMatchObject({
				role: "user",
				content: [
					{ type: "text", text: "Look at this" },
					{
						type: "text",
						text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>',
					},
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
			});
			unsubscribe();
		} finally {
			await service.close();
		}
	});

	it("saves attachments in the workspace and tells the model the path", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-attachments-"));
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
		});
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Look at this", "request-save", [
				{ name: "shot.png", mimeType: "image/png", data: "aGk=" },
			]);

			const directory = join(workspace, ".harness", "attachments", session.id);
			const files = await readdir(directory);
			expect(files).toHaveLength(1);
			const file = files[0] ?? "";
			expect(await readFile(join(directory, file))).toEqual(Buffer.from("aGk=", "base64"));

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			const user = snapshot.entries.find((entry) => entry.kind === "pi.user");
			expect(JSON.stringify(user?.model?.[0]?.content)).toContain(`.harness/attachments/${session.id}/${file}`);
			unsubscribe();
		} finally {
			await service.close();
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("titles a session from its attachments when there is no text", async () => {
		const { providers } = createFauxProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "  ", "request-title", [
				{ name: "notes.md", mimeType: "text/markdown", data: "hi" },
			]);
			const listed = (await service.listSessions()).find((candidate) => candidate.id === session.id);
			expect(listed?.title).toBe("notes.md");
		} finally {
			await service.close();
		}
	});

	it("rejects image attachments for a text-only model", async () => {
		await withService(
			async (service) => {
				const session = await service.createSession();
				await expect(
					service.prompt(session.id, "Look", "request-image", [
						{ name: "shot.png", mimeType: "image/png", data: "aGk=" },
					]),
				).rejects.toMatchObject({ code: "unsupported_model" });
			},
			{ apiKey: "test-key" },
		);
	});

	it("gives a client that attaches later the current snapshot and usage", async () => {
		const { providers, faux } = createFauxProviders({
			image: { data: "aGk=", mimeType: "image/png", usage: FAKE_IMAGE_USAGE },
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("generate_image", { prompt: "a cat" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			// Hold one stream open while the run finishes, like a browser that stays attached.
			const first = await service.subscribeSession(session.id, () => {});
			await service.prompt(session.id, "Draw a cat", "request-late-attach");
			const idle = await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(idle).toBe(true);

			const second = await service.subscribeSession(session.id, () => {});
			expect(second.snapshot.entries.length).toBeGreaterThan(0);
			expect(second.snapshot.usage.tools?.generate_image?.cost.total).toBeCloseTo(0.5);
			first.unsubscribe();
			second.unsubscribe();
		} finally {
			await service.close();
		}
	});

	it("marks a session as working while a run is active", async () => {
		const { providers } = createFauxProviders({ tokensPerSecond: 10 });
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const session = await service.createSession();
			expect(session.working).toBe(false);

			const observed: boolean[] = [];
			service.on((event) => {
				if (event.type === "sessions") observed.push(...event.sessions.map((candidate) => candidate.working));
			});

			await service.prompt(session.id, "Are you working?", "request-working");
			const started = await waitFor(async () => (await service.listSessions())[0]?.working === true);
			const finished = await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect({ started, finished }).toEqual({ started: true, finished: true });
			expect(observed).toContain(true);
		} finally {
			await service.close();
		}
	});
});
