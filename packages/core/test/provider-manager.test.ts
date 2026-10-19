import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { emptyConfig, loadConfig, type AppConfig } from "../src/config.ts";
import { ProviderManager } from "../src/providers.ts";

const LAST_MODIFIED = "Wed, 14 Oct 2026 09:03:09 GMT";
const ARGON_ID = "google/gemini-4-argon";

const ARGON = {
	type: "chat",
	id: ARGON_ID,
	name: "Google: Gemini 4 Argon",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0.1875 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
} as AnyModel;

function catalogResponse(models: readonly AnyModel[]): Response {
	return new Response(JSON.stringify(models), {
		status: 200,
		headers: { "content-type": "application/json", "last-modified": LAST_MODIFIED, etag: '"v1"' },
	});
}

describe("ProviderManager", () => {
	it("refreshes the remote catalog, caches it, and restores it without the network", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		const configPath = join(dir, "config.json");
		const modelsPath = join(dir, "models.json");
		const config: AppConfig = {
			...emptyConfig(),
			providers: { openrouter: { apiKey: "test-key" } },
		};
		// pi-ai's OpenRouter personalizer uses the global fetch, not the injected one, so keep it off
		// the network; a 401 leaves the catalog unpersonalized, as an unknown key should.
		vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
		try {
			const calls: string[] = [];
			const manager = new ProviderManager(configPath, modelsPath, config, {
				fetch: async (input) => {
					calls.push(String(input));
					return catalogResponse([ARGON]);
				},
				catalogBaseUrl: "https://pi.dev",
				localGeneratedAt: 0,
			});

			const reports = await manager.refresh({ force: true });
			const openrouter = reports.find((report) => report.providerId === "openrouter");
			expect(openrouter).toMatchObject({ name: "OpenRouter", outcome: "fetched", added: 1 });
			expect((await manager.listModels()).some((model) => model.id === ARGON_ID)).toBe(true);
			expect(calls.some((url) => url.includes("/api/models/providers/openrouter"))).toBe(true);

			const persisted = JSON.parse(await readFile(modelsPath, "utf8"));
			expect(persisted.openrouter.etag).toBe('"v1"');
			expect(persisted.openrouter.lastModified).toBe(Date.parse(LAST_MODIFIED));
			expect(persisted.openrouter.models.map((model: AnyModel) => model.id)).toContain(ARGON_ID);
			// The model cache must never carry credentials.
			expect(JSON.stringify(persisted)).not.toContain("test-key");

			// A second manager restores the cache and skips the network while it is fresh.
			const offlineCalls: string[] = [];
			const second = new ProviderManager(configPath, modelsPath, config, {
				fetch: async (input) => {
					offlineCalls.push(String(input));
					throw new Error("offline");
				},
				catalogBaseUrl: "https://pi.dev",
				localGeneratedAt: 0,
			});
			const secondReports = await second.refresh({ force: false });
			expect(secondReports.find((report) => report.providerId === "openrouter")?.outcome).toBe(
				"throttled",
			);
			expect(offlineCalls.filter((url) => url.includes("openrouter"))).toHaveLength(0);
			expect((await second.listModels()).some((model) => model.id === ARGON_ID)).toBe(true);
		} finally {
			vi.unstubAllGlobals();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("persists model defaults in config.json and clears them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-defaults-"));
		const configPath = join(dir, "config.json");
		const modelsPath = join(dir, "models.json");
		const expected = {
			model: { provider: "openrouter", modelId: ARGON_ID },
			thinkingLevel: "high",
			imageModel: { provider: "openrouter", modelId: "google/gemini-3-pro-image" },
		} as const;
		try {
			const manager = new ProviderManager(configPath, modelsPath, emptyConfig(), {
				localGeneratedAt: 0,
			});
			await manager.setDefaults(expected);
			expect(manager.getDefaults()).toEqual(expected);
			expect(JSON.parse(await readFile(configPath, "utf8")).defaults).toEqual(expected);

			// A new manager reads them back from disk.
			const second = new ProviderManager(configPath, modelsPath, await loadConfig(configPath), {
				localGeneratedAt: 0,
			});
			expect(second.getDefaults()).toEqual(expected);

			await second.setDefaults({ model: null, thinkingLevel: null, imageModel: null });
			expect(second.getDefaults()).toEqual({});
			expect(JSON.parse(await readFile(configPath, "utf8")).defaults).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores invalid defaults when loading config.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-defaults-"));
		const configPath = join(dir, "config.json");
		try {
			await writeFile(
				configPath,
				JSON.stringify({
					providers: {},
					defaults: { model: { provider: 7 }, thinkingLevel: "turbo" },
				}),
			);
			expect((await loadConfig(configPath)).defaults).toBeUndefined();

			await writeFile(
				configPath,
				JSON.stringify({
					providers: {},
					defaults: {
						model: { provider: "openrouter", modelId: "google/gemini-4-argon" },
						thinkingLevel: "turbo",
					},
				}),
			);
			expect((await loadConfig(configPath)).defaults).toEqual({
				model: { provider: "openrouter", modelId: "google/gemini-4-argon" },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("lists only image models the tool can drive", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		const configPath = join(dir, "config.json");
		const modelsPath = join(dir, "models.json");
		const config: AppConfig = {
			...emptyConfig(),
			providers: { fireworks: { apiKey: "test-key" } },
		};
		const usable = {
			...ARGON,
			type: "image",
			id: "fake/image-usable",
			provider: "fireworks",
			output: ["image", "text"],
		} as unknown as AnyModel;
		const unusable = {
			...ARGON,
			type: "image",
			id: "fake/image-only",
			provider: "fireworks",
			output: ["image"],
		} as unknown as AnyModel;
		try {
			const manager = new ProviderManager(configPath, modelsPath, config, {
				fetch: async () => catalogResponse([usable, unusable]),
				localGeneratedAt: 0,
			});
			await manager.refresh({ force: true });
			const ids = (await manager.listImageModels()).map((model) => model.id);
			expect(ids).toContain("fake/image-usable");
			expect(ids).not.toContain("fake/image-only");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("marks chat models that have an image sibling", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		const configPath = join(dir, "config.json");
		const modelsPath = join(dir, "models.json");
		const config: AppConfig = {
			...emptyConfig(),
			providers: { fireworks: { apiKey: "test-key" } },
		};
		const siblingId = "fake/image-model";
		const chat = { ...ARGON, id: siblingId, provider: "fireworks" } as AnyModel;
		const image = {
			...ARGON,
			type: "image",
			id: siblingId,
			provider: "fireworks",
			input: ["text"],
			output: ["image"],
		} as unknown as AnyModel;
		try {
			const manager = new ProviderManager(configPath, modelsPath, config, {
				fetch: async () => catalogResponse([chat, image]),
				localGeneratedAt: 0,
			});
			await manager.refresh({ force: true });
			const models = (await manager.listModels()).filter(
				(model) => model.provider === "fireworks" && model.id === siblingId,
			);
			expect(models).toHaveLength(1);
			expect(models[0]?.imageGeneration).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("personalizes the OpenRouter catalog with the account's models", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		const configPath = join(dir, "config.json");
		const modelsPath = join(dir, "models.json");
		const config: AppConfig = {
			...emptyConfig(),
			providers: { openrouter: { apiKey: "test-key" } },
		};
		const catalogFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("/api/models/providers/openrouter")) return catalogResponse([ARGON]);
			throw new Error(`unexpected catalog fetch: ${url}`);
		};
		// `personalizeOpenRouterCatalog` uses the global fetch for `/models/user`.
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			if (!url.includes("/models/user")) throw new Error(`unexpected fetch: ${url}`);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: ARGON_ID,
							context_length: 4096,
							top_provider: { max_completion_tokens: 512 },
							pricing: {
								prompt: "0.000001",
								completion: "0.000002",
								input_cache_read: "0.0000001",
								input_cache_write: "0.0000002",
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		try {
			const manager = new ProviderManager(configPath, modelsPath, config, {
				fetch: catalogFetch,
				localGeneratedAt: 0,
			});
			await manager.refresh({ force: true });

			// Only the account's model survives, at the account's limits and prices.
			const models = (await manager.listModels()).filter(
				(model) => model.provider === "openrouter",
			);
			expect(models.map((model) => model.id)).toEqual([ARGON_ID]);
			expect(models[0]?.contextWindow).toBe(4096);
			expect(models[0]?.maxTokens).toBe(512);
			const argon = manager.models.getModel("openrouter", ARGON_ID);
			expect(argon?.cost.input).toBeCloseTo(1);
			expect(argon?.cost.output).toBeCloseTo(2);
			expect(argon?.cost.cacheRead).toBeCloseTo(0.1);

			// A fresh manager restores the personalized list, not the bundled one.
			const second = new ProviderManager(configPath, modelsPath, config, {
				fetch: async () => {
					throw new Error("offline");
				},
				localGeneratedAt: 0,
			});
			await second.refresh({ force: false });
			expect(
				(await second.listModels())
					.filter((model) => model.provider === "openrouter")
					.map((model) => model.id),
			).toEqual([ARGON_ID]);
		} finally {
			vi.unstubAllGlobals();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips providers without credentials", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		try {
			const calls: string[] = [];
			const manager = new ProviderManager(
				join(dir, "config.json"),
				join(dir, "models.json"),
				emptyConfig(),
				{
					fetch: async (input) => {
						calls.push(String(input));
						return catalogResponse([]);
					},
					localGeneratedAt: 0,
				},
			);
			expect(await manager.refresh({ force: true })).toEqual([]);
			expect(calls).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
