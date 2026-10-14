import { getSupportedThinkingLevels, type Models, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfo, ProviderInfo, ProviderRefreshReport } from "@harness/protocol";
import { saveConfig, type AppConfig } from "./config.ts";
import { ConfigCredentialStore } from "./credentials.ts";
import { FileModelsStore } from "./models-store.ts";
import { withRemoteCatalog, type CatalogRefreshStatus } from "./remote-catalog.ts";

/**
 * The providers module the harness depends on: the pi-ai model catalog plus the provider
 * settings the settings UI reads and writes. `ProviderManager` is the production adapter.
 */
export interface Providers {
	readonly models: Models;
	listProviders(): Promise<ProviderInfo[]>;
	listModels(): Promise<ModelInfo[]>;
	setApiKey(providerId: string, apiKey: string | null): Promise<void>;
	/** Refresh remote model catalogs; `force` bypasses the freshness throttle. */
	refresh(options?: { providerId?: string; force?: boolean }): Promise<ProviderRefreshReport[]>;
}

/** Overrides for tests and catalog mirrors; production uses the pi.dev defaults. */
export type ProviderManagerOptions = {
	fetch?: typeof fetch;
	catalogBaseUrl?: string;
	localGeneratedAt?: number;
	throttleMs?: number;
	userAgent?: string;
	now?: () => number;
};

/**
 * Owns the pi-ai model catalog and the provider credentials in `config.json`. All writes are
 * serialized and persisted before they resolve, so the settings UI always sees what is on disk.
 */
export class ProviderManager implements Providers {
	readonly models: MutableModels;
	readonly #configPath: string;
	#config: AppConfig;
	#queue: Promise<void> = Promise.resolve();
	readonly #statuses = new Map<string, CatalogRefreshStatus>();

	constructor(configPath: string, modelsPath: string, config: AppConfig, options: ProviderManagerOptions = {}) {
		this.#configPath = configPath;
		this.#config = config;
		this.models = builtinModels({
			credentials: new ConfigCredentialStore(
				() => this.#config,
				(change) => this.#mutate(change),
			),
			modelsStore: new FileModelsStore(modelsPath),
		});
		// Give every provider a remote catalog overlay, so refreshing can pick up models that the
		// bundled pi-ai catalog predates.
		const localGeneratedAt = options.localGeneratedAt ?? getBuiltinModelDataGeneratedAt();
		for (const provider of [...this.models.getProviders()]) {
			this.models.setProvider(
				withRemoteCatalog(provider, {
					...(options.fetch === undefined ? {} : { fetch: options.fetch }),
					...(options.catalogBaseUrl === undefined ? {} : { baseUrl: options.catalogBaseUrl }),
					...(localGeneratedAt === undefined ? {} : { localGeneratedAt }),
					...(options.throttleMs === undefined ? {} : { throttleMs: options.throttleMs }),
					...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
					...(options.now === undefined ? {} : { now: options.now }),
					onStatus: (status) => this.#statuses.set(status.providerId, status),
				}),
			);
		}
	}

	#mutate(change: (config: AppConfig) => void | Promise<void>): Promise<void> {
		const run = this.#queue.then(async () => {
			await change(this.#config);
			await saveConfig(this.#configPath, this.#config);
		});
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async setApiKey(providerId: string, apiKey: string | null): Promise<void> {
		await this.#mutate((config) => {
			if (apiKey === null || apiKey.trim() === "") {
				delete config.providers[providerId];
				return;
			}
			config.providers[providerId] = { apiKey: apiKey.trim() };
		});
	}

	async listProviders(): Promise<ProviderInfo[]> {
		const providers: ProviderInfo[] = [];
		for (const provider of this.models.getProviders()) {
			const auth = await this.models.checkAuth(provider.id);
			providers.push({
				id: provider.id,
				name: provider.name,
				configured: auth !== undefined,
				...(auth?.source === undefined ? {} : { authSource: auth.source }),
				modelCount: this.models.getModels(provider.id).length,
			});
		}
		return providers;
	}

	async listModels(): Promise<ModelInfo[]> {
		const available = await this.models.getAvailable();
		return available.map((model) => ({
			provider: model.provider,
			providerName: this.models.getProvider(model.provider)?.name ?? model.provider,
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			input: model.input,
			thinkingLevels: getSupportedThinkingLevels(model),
		}));
	}

	/** Refresh remote catalogs (all configured providers when `providerId` is omitted). */
	async refresh(options: { providerId?: string; force?: boolean } = {}): Promise<ProviderRefreshReport[]> {
		const providerIds =
			options.providerId === undefined
				? this.models.getProviders().map((provider) => provider.id)
				: [options.providerId];
		const before = new Map(providerIds.map((id) => [id, this.models.getModels(id).length]));
		this.#statuses.clear();
		const result = await this.models.refresh({
			force: options.force ?? true,
			...(options.providerId === undefined ? {} : { providers: [options.providerId] }),
		});

		const reports: ProviderRefreshReport[] = [];
		for (const providerId of providerIds) {
			const status = this.#statuses.get(providerId);
			const error = result.errors.get(providerId);
			// No status and no error means the provider was skipped (unknown or unconfigured).
			if (status === undefined && error === undefined) continue;
			const models = this.models.getModels(providerId).length;
			const added = models - (before.get(providerId) ?? 0);
			const outcome = status?.outcome ?? "failed";
			const message = status?.error ?? error?.message;
			reports.push({
				providerId,
				name: this.models.getProvider(providerId)?.name ?? providerId,
				outcome,
				models,
				added,
				...(message === undefined ? {} : { error: message }),
			});
			const detail = `outcome=${outcome} models=${models} added=${added}${message === undefined ? "" : ` error=${message}`}`;
			if (outcome === "failed") console.warn(`[core] model catalog ${providerId}: ${detail}`);
			else console.log(`[core] model catalog ${providerId}: ${detail}`);
		}
		return reports;
	}
}
