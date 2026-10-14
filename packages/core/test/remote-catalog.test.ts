import type { AnyModel, ModelsStoreEntry, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { withRemoteCatalog, type CatalogRefreshStatus } from "../src/remote-catalog.ts";

const PROVIDER_ID = "openrouter";
const LAST_MODIFIED = "Wed, 14 Oct 2026 09:03:09 GMT";

const FLASH: AnyModel = {
	type: "chat",
	id: "google/gemini-2.5-flash",
	name: "Google: Gemini 2.5 Flash",
	api: "openai-completions",
	provider: PROVIDER_ID,
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
	contextWindow: 1_048_576,
	maxTokens: 65_535,
} as AnyModel;

const ARGON: AnyModel = {
	...FLASH,
	id: "google/gemini-4-argon",
	name: "Google: Gemini 4 Argon",
} as AnyModel;

const IMAGE: AnyModel = {
	...FLASH,
	type: "image",
	id: "google/gemini-4-argon-image",
	output: ["image"],
} as unknown as AnyModel;

/** A provider with the parts `withRemoteCatalog` reads; streaming is never exercised here. */
function fakeProvider(models: readonly AnyModel[] = [FLASH]): Provider {
	return {
		id: PROVIDER_ID,
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api/v1",
		auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test" } }) } },
		getModels: () => models.filter((model) => model.type !== "image" && model.type !== "classifier"),
		getAllModels: () => models,
		stream: () => {
			throw new Error("not implemented");
		},
		streamSimple: () => {
			throw new Error("not implemented");
		},
	} as unknown as Provider;
}

function catalogResponse(models: readonly AnyModel[], headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(models), {
		status: 200,
		headers: { "content-type": "application/json", "last-modified": LAST_MODIFIED, etag: '"v1"', ...headers },
	});
}

type ContextOptions = {
	stored?: ModelsStoreEntry;
	allowNetwork?: boolean;
	force?: boolean;
};

function fakeContext(options: ContextOptions = {}): {
	context: RefreshModelsContext;
	publications: { persist?: ModelsStoreEntry | null; update?: () => void }[];
} {
	const publications: { persist?: ModelsStoreEntry | null; update?: () => void }[] = [];
	const context = {
		...(options.stored === undefined ? {} : { stored: options.stored }),
		publish: async (publication: { persist?: ModelsStoreEntry | null; update?: () => void }) => {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		allowNetwork: options.allowNetwork ?? true,
		force: options.force ?? true,
		signal: new AbortController().signal,
	} satisfies RefreshModelsContext;
	return { context, publications };
}

describe("withRemoteCatalog", () => {
	it("overlays new models and persists the catalog with its validator", async () => {
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => catalogResponse([FLASH, ARGON, IMAGE]),
			now: () => 1_000,
			onStatus: (status) => statuses.push(status),
		});
		const { context, publications } = fakeContext();
		await provider.refreshModels?.(context);

		expect(provider.getModels().map((model) => model.id)).toEqual(["google/gemini-2.5-flash", "google/gemini-4-argon"]);
		expect(provider.getAllModels?.().map((model) => model.id)).toContain("google/gemini-4-argon-image");
		const persisted = publications.find((publication) => publication.persist !== undefined)?.persist;
		expect(persisted?.etag).toBe('"v1"');
		expect(persisted?.lastModified).toBe(Date.parse(LAST_MODIFIED));
		expect(persisted?.checkedAt).toBe(1_000);
		expect(statuses).toEqual([{ providerId: PROVIDER_ID, outcome: "fetched", overlay: 3 }]);
	});

	it("accepts catalogs keyed by model id", async () => {
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => catalogResponse({ "chat:google/gemini-4-argon": ARGON } as unknown as AnyModel[]),
		});
		await provider.refreshModels?.(fakeContext().context);
		expect(provider.getModels().map((model) => model.id)).toContain("google/gemini-4-argon");
	});

	it("restores the stored catalog and revalidates it with If-None-Match", async () => {
		const stored: ModelsStoreEntry = { models: [FLASH, ARGON], lastModified: Date.parse(LAST_MODIFIED), etag: '"v1"', checkedAt: 100 };
		let validator: string | null = null;
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async (_url, init) => {
				validator = new Headers(init?.headers).get("if-none-match");
				return new Response(null, { status: 304 });
			},
			now: () => 2_000,
			onStatus: (status) => statuses.push(status),
		});
		const { context, publications } = fakeContext({ stored });
		await provider.refreshModels?.(context);

		expect(validator).toBe('"v1"');
		expect(provider.getModels().map((model) => model.id)).toContain("google/gemini-4-argon");
		expect(publications.at(-1)?.persist?.checkedAt).toBe(2_000);
		expect(publications.at(-1)?.persist?.etag).toBe('"v1"');
		expect(statuses).toEqual([{ providerId: PROVIDER_ID, outcome: "not-modified", overlay: 2 }]);
	});

	it("skips the request while the stored catalog is fresh, unless forced", async () => {
		const stored: ModelsStoreEntry = { models: [FLASH], lastModified: Date.parse(LAST_MODIFIED), checkedAt: 900, etag: '"v1"' };
		const statuses: CatalogRefreshStatus[] = [];
		let calls = 0;
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => {
				calls += 1;
				return catalogResponse([FLASH, ARGON]);
			},
			now: () => 1_000,
			throttleMs: 10_000,
			onStatus: (status) => statuses.push(status),
		});

		await provider.refreshModels?.(fakeContext({ stored, force: false }).context);
		expect(calls).toBe(0);
		expect(provider.getModels().map((model) => model.id)).not.toContain("google/gemini-4-argon");
		expect(statuses).toEqual([{ providerId: PROVIDER_ID, outcome: "throttled", overlay: 1 }]);

		await provider.refreshModels?.(fakeContext({ stored, force: true }).context);
		expect(calls).toBe(1);
		expect(provider.getModels().map((model) => model.id)).toContain("google/gemini-4-argon");
	});

	it("ignores catalogs older than the bundled model data", async () => {
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => catalogResponse([FLASH, ARGON], { "last-modified": "Tue, 13 Oct 2026 00:00:00 GMT" }),
			localGeneratedAt: Date.parse(LAST_MODIFIED),
			onStatus: (status) => statuses.push(status),
		});
		await provider.refreshModels?.(fakeContext().context);

		expect(provider.getModels().map((model) => model.id)).toEqual(["google/gemini-2.5-flash"]);
		expect(statuses).toEqual([{ providerId: PROVIDER_ID, outcome: "fetched", overlay: 0 }]);
	});

	it("marks providers without a remote catalog as unavailable", async () => {
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => new Response(null, { status: 404 }),
			onStatus: (status) => statuses.push(status),
		});
		const { context, publications } = fakeContext();
		await provider.refreshModels?.(context);

		expect(publications.at(-1)?.persist?.lastModified).toBe(0);
		expect(statuses).toEqual([{ providerId: PROVIDER_ID, outcome: "unavailable", overlay: 0 }]);
	});

	it("restores the cached catalog in the offline phase without reporting it", async () => {
		const stored: ModelsStoreEntry = { models: [FLASH], lastModified: Date.parse(LAST_MODIFIED) };
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => {
				throw new Error("network should not be used");
			},
			onStatus: (status) => statuses.push(status),
		});
		await provider.refreshModels?.(fakeContext({ stored, allowNetwork: false }).context);

		expect(statuses).toEqual([]);
		expect(provider.getModels().map((model) => model.id)).toEqual(["google/gemini-2.5-flash"]);
	});

	it("reports failures and keeps the stored catalog", async () => {
		const stored: ModelsStoreEntry = { models: [FLASH], lastModified: Date.parse(LAST_MODIFIED), etag: '"v1"' };
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => new Response("boom", { status: 500 }),
			onStatus: (status) => statuses.push(status),
		});
		await expect(provider.refreshModels?.(fakeContext({ stored }).context)).rejects.toThrow(/500/);

		expect(statuses.at(-1)).toEqual({ providerId: PROVIDER_ID, outcome: "failed", overlay: 1, error: "HTTP 500" });
		expect(provider.getModels().map((model) => model.id)).toEqual(["google/gemini-2.5-flash"]);
	});

	it("reports invalid catalogs as failures", async () => {
		const statuses: CatalogRefreshStatus[] = [];
		const provider = withRemoteCatalog(fakeProvider(), {
			fetch: async () => new Response(JSON.stringify(42), { status: 200, headers: { "content-type": "application/json" } }),
			onStatus: (status) => statuses.push(status),
		});
		await expect(provider.refreshModels?.(fakeContext().context)).rejects.toThrow(/Invalid model catalog/);
		expect(statuses.at(-1)?.outcome).toBe("failed");
	});
});
