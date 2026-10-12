import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { HarnessService, type HarnessServiceDependencies } from "../src/index.ts";
import { createFakeProviders, FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./helpers/fake-providers.ts";

type OpenOptions = {
	apiKey?: string;
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
});
