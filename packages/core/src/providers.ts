import { getSupportedThinkingLevels, type MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfo, ProviderInfo } from "@harness/protocol";
import { saveConfig, type AppConfig } from "./config.ts";
import { ConfigCredentialStore } from "./credentials.ts";
import { FileModelsStore } from "./models-store.ts";

/**
 * Owns the pi-ai model catalog and the provider credentials in `config.json`. All writes are
 * serialized and persisted before they resolve, so the settings UI always sees what is on disk.
 */
export class ProviderManager {
	readonly models: MutableModels;
	readonly #configPath: string;
	#config: AppConfig;
	#queue: Promise<void> = Promise.resolve();

	constructor(configPath: string, modelsPath: string, config: AppConfig) {
		this.#configPath = configPath;
		this.#config = config;
		this.models = builtinModels({
			credentials: new ConfigCredentialStore(
				() => this.#config,
				(change) => this.#mutate(change),
			),
			modelsStore: new FileModelsStore(modelsPath),
		});
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

	/** Refresh dynamic provider catalogs (all configured ones when `providerId` is omitted). */
	async refresh(providerId?: string): Promise<void> {
		await this.models.refresh({
			force: true,
			...(providerId === undefined ? {} : { providers: [providerId] }),
		});
	}
}
