import {
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	getSupportedThinkingLevels,
	type FauxProviderHandle,
	type ImageModel,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import type {
	DefaultsState,
	ImageModelInfo,
	ModelInfo,
	ProviderInfo,
	ProviderRefreshReport,
} from "@harness/protocol";
import type { Providers } from "../../src/providers.ts";

export const FAKE_PROVIDER_ID = "fake";
export const FAKE_MODEL_ID = "fake-model";
export const FAKE_REASONING_MODEL_ID = "fake-reasoning-model";

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

/** A second model that reasons, so tests can tell the default model and thinking level apart. */
export const FAKE_REASONING_MODEL = {
	...FAKE_MODEL,
	id: FAKE_REASONING_MODEL_ID,
	name: "Fake Reasoning Model",
	reasoning: true,
} satisfies Model<string>;

type Models = ReturnType<typeof createModels>;

export type FakeProvidersOptions = {
	apiKey?: string;
	/** Extra models beyond the default one; the first model is what the harness falls back to. */
	models?: readonly Model<string>[];
};

/** Catalog reads shared by the in-memory adapters below. */
function providersFor(models: Models, setApiKey: Providers["setApiKey"]): Providers {
	let defaults: DefaultsState = {};
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
		async listImageModels(): Promise<ImageModelInfo[]> {
			const available = await models.getAvailableOfType("image");
			return available
				.filter((model) => model.output.includes("text"))
				.map((model) => ({
					provider: model.provider,
					providerName: models.getProvider(model.provider)?.name ?? model.provider,
					id: model.id,
					name: model.name,
				}));
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
				imageGeneration: models.getModelOfType("image", model.provider, model.id) !== undefined,
			}));
		},
		setApiKey,
		getDefaults: () => ({ ...defaults }),
		async setDefaults(change): Promise<DefaultsState> {
			const next: DefaultsState = { ...defaults };
			if (change.model !== undefined) {
				if (change.model === null) delete next.model;
				else next.model = { ...change.model };
			}
			if (change.thinkingLevel !== undefined) {
				if (change.thinkingLevel === null) delete next.thinkingLevel;
				else next.thinkingLevel = change.thinkingLevel;
			}
			if (change.imageModel !== undefined) {
				if (change.imageModel === null) delete next.imageModel;
				else next.imageModel = { ...change.imageModel };
			}
			defaults = next;
			return { ...defaults };
		},
		async refresh(): Promise<ProviderRefreshReport[]> {
			return [];
		},
	};
}

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
			models: [FAKE_MODEL, ...(options.models ?? [])],
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

	return providersFor(models, async (providerId, key) => {
		if (providerId !== FAKE_PROVIDER_ID) return;
		apiKey = key ?? undefined;
	});
}

export const FAKE_IMAGE_PROVIDER_ID = "fake-images";
export const FAKE_IMAGE_MODEL_ID = "fake-image-model";
const FAKE_IMAGE_API = "openrouter-images";

/** An image model whose generation returns the given image without any network access. */
function createFakeImageProvider(image: { data: string; mimeType: string; usage?: Usage }) {
	const model: ImageModel<typeof FAKE_IMAGE_API> = {
		type: "image",
		id: FAKE_IMAGE_MODEL_ID,
		name: "Fake Image Model",
		api: FAKE_IMAGE_API,
		provider: FAKE_IMAGE_PROVIDER_ID,
		baseUrl: "http://localhost",
		input: ["text", "image"],
		output: ["image", "text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return createProvider({
		id: FAKE_IMAGE_PROVIDER_ID,
		name: "Fake Images",
		auth: { apiKey: { name: "Fake image key", resolve: async () => ({ auth: {} }) } },
		models: [model],
		images: {
			[FAKE_IMAGE_API]: {
				generateImages: async () => ({
					api: FAKE_IMAGE_API,
					provider: FAKE_IMAGE_PROVIDER_ID,
					model: FAKE_IMAGE_MODEL_ID,
					output: [{ type: "image", data: image.data, mimeType: image.mimeType }],
					...(image.usage === undefined ? {} : { usage: image.usage }),
					stopReason: "stop",
					timestamp: Date.now(),
				}),
			},
		},
	});
}

/**
 * Streaming `Providers` adapter built on pi-ai's faux provider. The scripted answer streams at
 * `tokensPerSecond`, so tests can observe a run while it is in flight. With `image`, a fake image
 * provider is registered too, so the `generate_image` tool has something to call.
 */
export function createFauxProviders(options: {
	text?: string;
	tokensPerSecond?: number;
	image?: { data: string; mimeType: string; usage?: Usage };
} = {}): {
	providers: Providers;
	faux: FauxProviderHandle;
} {
	const models = createModels();
	const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 20 });
	models.setProvider(faux.provider);
	if (options.image !== undefined) models.setProvider(createFakeImageProvider(options.image));
	faux.setResponses([fauxAssistantMessage(options.text ?? "The faux model is answering this prompt.")]);
	return { providers: providersFor(models, async () => {}), faux };
}
