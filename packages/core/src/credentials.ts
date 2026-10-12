import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { AppConfig, ProviderConfig } from "./config.ts";

function credentialFromProvider(provider: ProviderConfig | undefined): Credential | undefined {
	if (provider?.apiKey === undefined || provider.apiKey === "") return undefined;
	return { type: "api_key", key: provider.apiKey };
}

/**
 * Credential storage on top of `data/config.json`, so pi-ai resolves auth from the same place the
 * settings UI writes to. `modify` is the serialized write path pi-ai expects for token refresh.
 */
export class ConfigCredentialStore implements CredentialStore {
	readonly #readConfig: () => AppConfig;
	readonly #mutateConfig: (change: (config: AppConfig) => void | Promise<void>) => Promise<void>;

	constructor(
		readConfig: () => AppConfig,
		mutateConfig: (change: (config: AppConfig) => void | Promise<void>) => Promise<void>,
	) {
		this.#readConfig = readConfig;
		this.#mutateConfig = mutateConfig;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return credentialFromProvider(this.#readConfig().providers[providerId]);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(this.#readConfig().providers)
			.filter(([, provider]) => provider.apiKey !== undefined && provider.apiKey !== "")
			.map(([providerId]) => ({ providerId, type: "api_key" as const }));
	}

	async modify(
		providerId: string,
		change: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		let result: Credential | undefined;
		await this.#mutateConfig(async (config) => {
			const next = await change(credentialFromProvider(config.providers[providerId]));
			result = next;
			if (next === undefined) return;
			if (next.type !== "api_key") throw new Error("Only API key credentials are supported");
			if (next.key === undefined || next.key === "") delete config.providers[providerId];
			else config.providers[providerId] = { apiKey: next.key };
		});
		return result;
	}

	async delete(providerId: string): Promise<void> {
		await this.#mutateConfig((config) => {
			delete config.providers[providerId];
		});
	}
}
