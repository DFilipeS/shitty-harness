import type { Context } from "@earendil-works/chord";
import {
	Type,
	type AssistantImages,
	type ImageApi,
	type ImageContent,
	type ImageModel,
	type ImagesInputContent,
	type Models,
	type Usage,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import type { ModelRef } from "@harness/protocol";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

const EXTENSION_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

const generateImageSchema = Type.Object({
	prompt: Type.String({ description: "What the image should show, or how to change the input image." }),
	image: Type.Optional(
		Type.String({
			description:
				"File in the working directory to edit or use as a reference, for example a path from an earlier `Saved ...` note or from the attached-files list.",
		}),
	),
	path: Type.Optional(
		Type.String({ description: "File to write the image to, relative to the working directory." }),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Image model id to use, from the list in your instructions. Default: the configured image model, the conversation model's image sibling, else the first available.",
		}),
	),
});

export type ImageToolsOptions = {
	/** The catalog, so the prompt section can list the image models the tool can drive. */
	models: Models;
	/** The configured default image model, when one is set. */
	defaultImageModel?: () => ModelRef | undefined;
};

function mimeTypeFor(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSION_MIME_TYPES[extension] ?? "image/png";
}

function withExtension(path: string, extension: string): string {
	return /\.[a-z0-9]+$/i.test(path) ? path : `${path}.${extension}`;
}

/**
 * Which image model to use: the requested one, the configured default, the image sibling of the
 * conversation's model (the same id listed as an image model), else a chat-compatible one.
 *
 * pi-ai's OpenRouter image API speaks chat completions, so only models that also return text work
 * through it; dedicated image endpoints (FLUX, Seedream, ...) answer on `/images` instead and are
 * left out of the list.
 */
function resolveImageModel(
	available: readonly ImageModel<ImageApi>[],
	requested: string | undefined,
	preferred: ModelRef | undefined,
	current: { provider: string; modelId: string } | undefined,
): ImageModel<ImageApi> | undefined {
	if (requested !== undefined) {
		return available.find(
			(model) => model.id === requested || model.id.endsWith(`/${requested}`) || model.name === requested,
		);
	}
	if (preferred !== undefined) {
		const match = available.find(
			(model) => model.provider === preferred.provider && model.id === preferred.modelId,
		);
		if (match !== undefined) return match;
	}
	if (current !== undefined) {
		const sibling = available.find(
			(model) => model.provider === current.provider && model.id === current.modelId,
		);
		if (sibling !== undefined) return sibling;
		const byId = available.find((model) => model.id === current.modelId);
		if (byId !== undefined) return byId;
	}
	return available.find((model) => model.output.includes("text")) ?? available[0];
}

/**
 * What OpenRouter actually charged for a generation.
 *
 * pi-ai prices image tokens at the model's text output rate, but OpenRouter bills them at the
 * model's `image_output` rate — 10x the text rate for Nano Banana Pro — so pi-ai's estimate can be
 * far too low. The generation endpoint has the real number; undefined when it cannot be read.
 */
export async function openRouterGenerationCost(
	responseId: string,
	baseUrl: string,
	apiKey: string,
	options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<number | undefined> {
	const request = options.fetch ?? fetch;
	try {
		const url = `${baseUrl.replace(/\/+$/, "")}/generation?id=${encodeURIComponent(responseId)}`;
		const response = await request(url, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) return undefined;
		const data = "data" in body ? (body as { data: unknown }).data : body;
		if (typeof data !== "object" || data === null) return undefined;
		const total = (data as { total_cost?: unknown }).total_cost;
		return typeof total === "number" && Number.isFinite(total) ? total : undefined;
	} catch {
		return undefined;
	}
}

/** pi-ai's usage with the cost OpenRouter reports, when it can be read. */
async function actualUsage(
	result: AssistantImages,
	model: ImageModel<ImageApi>,
	api: ToolExecutionApi,
	context: Context,
): Promise<Usage | undefined> {
	const usage = result.usage;
	if (usage === undefined || result.api !== "openrouter-images" || result.responseId === undefined) {
		return usage;
	}
	const auth = await api.models.getAuth(model.provider);
	const apiKey = auth?.auth.apiKey;
	if (apiKey === undefined) return usage;
	const total = await openRouterGenerationCost(result.responseId, model.baseUrl, apiKey, {
		...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
	});
	if (total === undefined) return usage;
	// The image charge is an output charge; keep the parts summing to the real total.
	const cost = { ...usage.cost };
	cost.output = Math.max(0, total - cost.input - cost.cacheRead - cost.cacheWrite);
	cost.total = total;
	return { ...usage, cost };
}

/** Writes the images into the environment; failures become diagnostics, not a failed call. */
async function saveImages(
	api: ToolExecutionApi,
	images: readonly ImageContent[],
	requestedPath: string | undefined,
	context: Context,
): Promise<string[]> {
	const env = api.env;
	if (env === undefined) return [];
	const saved: string[] = [];
	for (const [index, image] of images.entries()) {
		const extension = MIME_EXTENSIONS[image.mimeType] ?? "png";
		const base = requestedPath ?? `image-${Date.now()}`;
		const target = images.length === 1 ? withExtension(base, extension) : `${base}-${index + 1}.${extension}`;
		const result = await env.writeFile(target, decodeBase64(image.data), context);
		if (result.ok) saved.push(target);
		else {
			api.diagnostic({
				severity: "warn",
				code: "save_failed",
				message: `Could not save ${target}: ${result.error.message}`,
			});
		}
	}
	return saved;
}

/** Reads the optional input image into the generation request. */
async function inputImage(
	api: ToolExecutionApi,
	path: string,
	context: Context,
): Promise<{ input: ImagesInputContent } | { error: string }> {
	const env = api.env;
	if (env === undefined) return { error: "Cannot read an input image: no execution environment is configured." };
	const file = await env.readBinaryFile(path, context);
	if (!file.ok) return { error: `Could not read ${path}: ${file.error.message}` };
	return { input: { type: "image", data: encodeBase64(file.value), mimeType: mimeTypeFor(path) } };
}

/**
 * Generates an image through the provider's image API (`Models.generateImages`) rather than the
 * chat stream, which cannot carry images. The image is written into the working directory and
 * returned as a tool result, so it shows up in the conversation. With `image`, an existing file
 * goes in as input, which is how a picture gets edited.
 */
export function createGenerateImageTool(options: Pick<ImageToolsOptions, "defaultImageModel"> = {}) {
	return defineTool({
		name: "generate_image",
		description:
			"Generate or edit an image with the provider's image model. The image is saved in the working directory and shown in the conversation.",
		parameters: generateImageSchema,
		execute: async (args, api, context) => {
			const available = await api.models.getAvailableOfType("image");
			if (available.length === 0) {
				return {
					output: [
						{
							type: "text",
							text: "No image model is available. Configure a provider that can generate images.",
						},
					],
					isError: true,
				};
			}
			const agent = await api.agent(context);
			const model = resolveImageModel(
				available,
				args.model,
				options.defaultImageModel?.(),
				agent.model,
			);
			if (model === undefined) {
				return { output: [{ type: "text", text: `Unknown image model: ${args.model}` }], isError: true };
			}
			// For the transcript: which provider and model the picture came from.
			const details = {
				provider: model.provider,
				providerName: api.models.getProvider(model.provider)?.name ?? model.provider,
				modelId: model.id,
				modelName: model.name,
			};

			const input: ImagesInputContent[] = [];
			if (args.image !== undefined) {
				const read = await inputImage(api, args.image, context);
				if ("error" in read) {
					return { output: [{ type: "text", text: read.error }], isError: true, details };
				}
				input.push(read.input);
			}
			input.push({ type: "text", text: args.prompt });

			const result = await api.models.generateImages(
				model,
				{ input },
				context.abortSignal === undefined ? undefined : { signal: context.abortSignal },
			);
			const usage = await actualUsage(result, model, api, context);
			const usageField = usage === undefined ? {} : { usage };
			if (result.stopReason !== "stop") {
				return {
					output: [
						{ type: "text", text: result.errorMessage ?? `Image generation ${result.stopReason}.` },
					],
					isError: true,
					details,
					...usageField,
				};
			}
			const images = result.output.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) {
				return {
					output: [{ type: "text", text: "The model returned no image." }],
					isError: true,
					details,
					...usageField,
				};
			}

			const saved = await saveImages(api, images, args.path, context);
			const note =
				saved.length === 0
					? "The image was not saved: no execution environment is configured."
					: `Saved ${saved.map((path) => `\`${path}\``).join(", ")}.`;
			return { output: [...images, { type: "text", text: note }], details, ...usageField };
		},
	});
}

/** The tool with no configured default, for callers that do not manage settings. */
export const GenerateImageTool = createGenerateImageTool();

/**
 * Points image work at the tool and names the models it can drive, so "use the cheap one" works.
 * Without the section, an image-generation chat model sometimes answers with an image of its own,
 * which the chat stream cannot carry: pi-ai drops it and the turn shows only thinking. The section
 * renders only where the tool is offered and an image model exists.
 */
function imageSection(options: ImageToolsOptions, toolName: string) {
	return section(
		"image-generation",
		async (input) => {
			if (!input.agent.tools.some((tool) => tool.name === toolName)) return undefined;
			const available = await options.models.getAvailableOfType("image");
			const usable = available.filter((model) => model.output.includes("text"));
			if (usable.length === 0) return undefined;
			const preferred = options.defaultImageModel?.();
			const lines = [
				"For anything that creates or changes an image, call the generate_image tool and then reply in text. Never put an image in a reply: the chat stream cannot store one, so it would be lost.",
				"Pass `image` with a file path to edit or reference an existing image, such as one from an earlier `Saved ...` note or from the attached-files list.",
				`Image models: ${usable.map((model) => `${model.name} (${model.id})`).join(", ")}.`,
			];
			const defaultModel =
				preferred === undefined
					? undefined
					: usable.find((model) => model.provider === preferred.provider && model.id === preferred.modelId);
			if (defaultModel !== undefined) lines.push(`The configured default is ${defaultModel.name}.`);
			return lines.join(" ");
		},
		{ tag: false },
	);
}

/** The image tools, installed alongside the coding tools. */
export function createImageTools(options: ImageToolsOptions) {
	const tool = createGenerateImageTool(options);
	return defineExtension({
		name: "image-tools",
		tools: [tool],
		sections: [imageSection(options, tool.name)],
	});
}
