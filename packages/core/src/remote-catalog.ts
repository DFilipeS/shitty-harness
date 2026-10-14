import {
	getModelType,
	isModelType,
	type AnyModel,
	type Model,
	type ModelsStoreEntry,
	type Provider,
	type RefreshModelsContext,
	type Api,
} from "@earendil-works/pi-ai";
import type { ProviderRefreshOutcome } from "@harness/protocol";

/**
 * pi's public model catalog. The pi CLI refreshes from the same service, so the harness picks up
 * new models as soon as the catalog is updated upstream, without waiting for a pi-ai release.
 */
export const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";

const CATALOG_MODEL_TYPES = ["chat", "image", "classifier"];
/** A catalog this fresh is trusted without a request, matching the pi CLI's throttle. */
const CATALOG_THROTTLE_MS = 4 * 60 * 60 * 1000;
const CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
const CATALOG_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const CATALOG_USER_AGENT = "shitty-harness/0.1.0";

/** What one provider's catalog refresh did, as reported back to the client. */
export type CatalogRefreshStatus = {
	providerId: string;
	outcome: ProviderRefreshOutcome;
	/** Remote models applied after the refresh; zero when none passed the freshness gate. */
	overlay: number;
	error?: string;
};

export type RemoteCatalogOptions = {
	/** Fetch implementation; tests inject a fake and mirrors can point at another catalog. */
	fetch?: typeof fetch;
	baseUrl?: string;
	/** Generation timestamp of the bundled catalog; older remote catalogs are ignored. */
	localGeneratedAt?: number;
	throttleMs?: number;
	userAgent?: string;
	now?: () => number;
	onStatus?: (status: CatalogRefreshStatus) => void;
	/**
	 * Rewrites the whole catalog for the account, e.g. OpenRouter's `/models/user`. When set, the
	 * stored or fetched catalog replaces the baseline, so models the account cannot use disappear.
	 */
	personalize?: (catalog: readonly AnyModel[], context: RefreshModelsContext) => Promise<readonly AnyModel[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Catalogs arrive as a list, `{ models }`, or an object keyed by model id. */
function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	const entries = Array.isArray(value)
		? value
		: isRecord(value) && Array.isArray(value.models)
			? value.models
			: isRecord(value)
				? Object.values(value)
				: undefined;
	if (entries === undefined) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	const models: AnyModel[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const type = entry.type ?? "chat";
		if (type !== "chat" && type !== "image" && type !== "classifier") continue;
		models.push({ ...entry, provider: providerId } as unknown as AnyModel);
	}
	return models;
}

async function readCatalog(providerId: string, response: Response): Promise<Omit<ModelsStoreEntry, "checkedAt">> {
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		models: parseCatalog(providerId, await response.json()),
		lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
		etag: response.headers.get("etag") ?? undefined,
	};
}

/** A remote catalog only applies when it changed after the bundled data was generated. */
function isNewer(lastModified: number | undefined, localGeneratedAt: number | undefined): boolean {
	return localGeneratedAt === undefined || (lastModified !== undefined && lastModified > localGeneratedAt);
}

function freshModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): AnyModel[] {
	if (entry === undefined || !isNewer(entry.lastModified, localGeneratedAt)) return [];
	return [...entry.models];
}

function catalogKey(model: AnyModel): string {
	return `${getModelType(model)}\u0000${model.id}`;
}

/** Remote entries replace bundled ones with the same id and type, and add the rest. */
function mergeCatalog(baseline: readonly AnyModel[], overlay: readonly AnyModel[]): AnyModel[] {
	const merged = new Map<string, AnyModel>();
	for (const model of baseline) merged.set(catalogKey(model), model);
	for (const model of overlay) merged.set(catalogKey(model), model);
	return [...merged.values()];
}

async function requestCatalog(
	providerId: string,
	options: { baseUrl: string; userAgent: string; fetch: typeof fetch; signal: AbortSignal; validator?: string },
): Promise<Response> {
	const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, options.baseUrl);
	url.searchParams.set("types", CATALOG_MODEL_TYPES.join(","));
	const headers: Record<string, string> = { accept: "application/json", "user-agent": options.userAgent };
	if (options.validator !== undefined) headers["if-none-match"] = options.validator;
	return fetchWithRetry(options.fetch, url, { headers, signal: options.signal });
}

/** Retry transient catalog failures; each attempt gets its own short timeout. */
async function fetchWithRetry(request: typeof fetch, url: URL, init: RequestInit): Promise<Response> {
	const parent = init.signal;
	for (let attempt = 1; ; attempt += 1) {
		const timeout = AbortSignal.timeout(CATALOG_ATTEMPT_TIMEOUT_MS);
		const signal = parent === undefined || parent === null ? timeout : AbortSignal.any([parent, timeout]);
		try {
			const response = await request(url, { ...init, signal });
			if (!RETRYABLE_STATUS.has(response.status) || attempt >= CATALOG_MAX_ATTEMPTS) return response;
			await response.body?.cancel().catch(() => undefined);
		} catch (error) {
			if (attempt >= CATALOG_MAX_ATTEMPTS || parent?.aborted === true) throw error;
		}
	}
}

/**
 * Wrap a provider with the pi.dev remote catalog. The bundled catalog stays the baseline; the
 * remote one is persisted in the models store (ETag and Last-Modified included) and overlaid on
 * top, so a refresh picks up new models without a package update.
 *
 * With `personalize` the catalog is first merged with the baseline and then rewritten for the
 * account, and the result replaces the baseline: a model the account cannot use disappears
 * instead of falling back to its bundled entry.
 */
export function withRemoteCatalog(provider: Provider, options: RemoteCatalogOptions = {}): Provider {
	const request = options.fetch ?? fetch;
	const baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL;
	const throttleMs = options.throttleMs ?? CATALOG_THROTTLE_MS;
	const userAgent = options.userAgent ?? CATALOG_USER_AGENT;
	const now = options.now ?? Date.now;
	let overlay: AnyModel[] = [];
	/** True when `overlay` is a whole catalog (personalized) rather than an overlay over the baseline. */
	let complete = false;

	const catalogFor = (baseline: readonly AnyModel[]): AnyModel[] =>
		complete && overlay.length > 0 ? [...overlay] : mergeCatalog(baseline, overlay);

	const report = (outcome: ProviderRefreshOutcome, overlayCount: number, error?: string): void => {
		options.onStatus?.({
			providerId: provider.id,
			outcome,
			overlay: overlayCount,
			...(error === undefined ? {} : { error }),
		});
	};

	return {
		...provider,
		getModels: () =>
			catalogFor(provider.getModels()).filter((model): model is Model<Api> => isModelType(model, "chat")),
		getAllModels: () => catalogFor(provider.getAllModels?.() ?? provider.getModels()),
		refreshModels: async (context: RefreshModelsContext) => {
			const stored = context.stored;
			const restored = freshModels(stored, options.localGeneratedAt).filter(
				(model) => model.provider === provider.id,
			);
			// A stored personalized catalog is the whole list, not an overlay over the bundled one.
			complete = options.personalize !== undefined && restored.length > 0;
			if (
				!(await context.publish({
					update: () => {
						overlay = restored;
					},
				}))
			) {
				return;
			}

			// pi-ai calls every provider once with `allowNetwork: false` to restore caches before it
			// resolves credentials. Only the network phase is a refresh worth reporting.
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				now() - stored.checkedAt < throttleMs
			) {
				report("throttled", restored.length);
				return;
			}

			const validator = stored !== undefined && stored.models.length > 0 ? stored.etag : undefined;
			let response: Response;
			try {
				response = await requestCatalog(provider.id, {
					baseUrl,
					userAgent,
					fetch: request,
					signal: context.signal,
					...(validator === undefined ? {} : { validator }),
				});
			} catch (error) {
				report("failed", restored.length, describeError(error));
				throw error;
			}
			if (context.signal.aborted) return;
			const checkedAt = now();

			if (response.status === 304 && stored !== undefined) {
				await context.publish({ persist: { ...stored, checkedAt } });
				report("not-modified", restored.length);
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: { models: stored?.models ?? [], checkedAt, lastModified: 0, etag: undefined },
				});
				report("unavailable", restored.length);
				return;
			}
			if (!response.ok) {
				await context.publish({ persist: { models: stored?.models ?? [], checkedAt } });
				report("failed", restored.length, `HTTP ${response.status}`);
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}

			let catalog: Omit<ModelsStoreEntry, "checkedAt">;
			try {
				catalog = await readCatalog(provider.id, response);
			} catch (error) {
				report("failed", restored.length, describeError(error));
				throw error;
			}
			if (context.signal.aborted) return;

			if (options.personalize !== undefined) {
				try {
					const baseline = provider.getAllModels?.() ?? provider.getModels();
					catalog = {
						...catalog,
						models: await options.personalize(mergeCatalog(baseline, catalog.models), context),
					};
					complete = true;
				} catch (error) {
					report("failed", restored.length, describeError(error));
					throw error;
				}
			}

			const entry: ModelsStoreEntry = { ...catalog, checkedAt };
			const fresh = freshModels(entry, options.localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					overlay = fresh;
				},
			});
			report("fetched", fresh.length);
		},
	};
}
