import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { emptyConfig, type AppConfig } from "../src/config.ts";
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
		const config: AppConfig = { ...emptyConfig(), providers: { openrouter: { apiKey: "test-key" } } };
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
			expect(secondReports.find((report) => report.providerId === "openrouter")?.outcome).toBe("throttled");
			expect(offlineCalls.filter((url) => url.includes("openrouter"))).toHaveLength(0);
			expect((await second.listModels()).some((model) => model.id === ARGON_ID)).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("skips providers without credentials", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-models-"));
		try {
			const calls: string[] = [];
			const manager = new ProviderManager(join(dir, "config.json"), join(dir, "models.json"), emptyConfig(), {
				fetch: async (input) => {
					calls.push(String(input));
					return catalogResponse([]);
				},
				localGeneratedAt: 0,
			});
			expect(await manager.refresh({ force: true })).toEqual([]);
			expect(calls).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
