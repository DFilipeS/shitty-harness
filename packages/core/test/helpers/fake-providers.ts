import { createModels, createProvider, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelInfo, ProviderInfo } from "@harness/protocol";
import type { Providers } from "../../src/providers.ts";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_MODEL_ID = "fake-model";

const FAKE_MODEL = {
	id: FAKE_MODEL_ID,
	name: "Fake Model",
	api: "fake-api",
	provider: FAKE_PROVIDER_ID,
	baseUrl: "http://localhost",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 8_000,
	maxTokens: 1_000,
} satisfies Model<string>;

export type FakeProvidersOptions = {
	apiKey?: string;
};

/**
 * In-memory `Providers` adapter for tests: a real pi-ai catalog with one static model whose API-key
 * auth is a closure variable. Streaming is not implemented, so prompt tests configure no model.
 */
export function createFakeProviders(options: FakeProvidersOptions = {}): Providers {
	let apiKey = options.apiKey;
	const models = createModels();
	models.setProvider(
		createProvider({
			id: FAKE_PROVIDER_ID,
			name: "Fake Provider",
			auth: {
				apiKey: {
					name: "Fake API key",
					resolve: async () => (apiKey === undefined ? undefined : { auth: { apiKey } }),
				},
			},
			models: [FAKE_MODEL],
			api: {
				stream: () => {
					throw new Error("Fake provider streaming is not implemented");
				},
				streamSimple: () => {
					throw new Error("Fake provider streaming is not implemented");
				},
			},
		}),
	);

	return {
		models,
		async listProviders(): Promise<ProviderInfo[]> {
			const providers: ProviderInfo[] = [];
			for (const provider of models.getProviders()) {
				const auth = await models.checkAuth(provider.id);
				providers.push({
					id: provider.id,
					name: provider.name,
					configured: auth !== undefined,
					...(auth?.source === undefined ? {} : { authSource: auth.source }),
					modelCount: models.getModels(provider.id).length,
				});
			}
			return providers;
		},
		async listModels(): Promise<ModelInfo[]> {
			const available = await models.getAvailable();
			return available.map((model) => ({
				provider: model.provider,
				providerName: models.getProvider(model.provider)?.name ?? model.provider,
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: model.input,
				thinkingLevels: getSupportedThinkingLevels(model),
			}));
		},
		async setApiKey(providerId: string, key: string | null): Promise<void> {
			if (providerId !== FAKE_PROVIDER_ID) return;
			apiKey = key ?? undefined;
		},
		async refresh(): Promise<void> {},
	};
}
