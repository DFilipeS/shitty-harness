import type { Context } from "@earendil-works/chord";
import { Type, type ImageApi, type ImageContent, type ImageModel } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

const generateImageSchema = Type.Object({
	prompt: Type.String({ description: "What the image should show." }),
	path: Type.Optional(
		Type.String({ description: "File to write the image to, relative to the working directory." }),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Image model id to use. Default: the conversation model's image sibling, else the first available.",
		}),
	),
});

function decodeBase64(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function withExtension(path: string, extension: string): string {
	return /\.[a-z0-9]+$/i.test(path) ? path : `${path}.${extension}`;
}

/**
 * Which image model to use: the requested one, the image sibling of the conversation's model (the
 * same id listed as an image model), else a chat-compatible one.
 *
 * pi-ai's OpenRouter image API speaks chat completions, so only models that also return text work
 * through it; dedicated image endpoints (FLUX, Seedream, ...) answer on `/images` instead and are
 * only used when asked for by name.
 */
function resolveImageModel(
	available: readonly ImageModel<ImageApi>[],
	requested: string | undefined,
	current: { provider: string; modelId: string } | undefined,
): ImageModel<ImageApi> | undefined {
	if (requested !== undefined) {
		return available.find(
			(model) => model.id === requested || model.id.endsWith(`/${requested}`) || model.name === requested,
		);
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

/**
 * Generates an image through the provider's image API (`Models.generateImages`) rather than the
 * chat stream, which cannot carry images. The image is written into the working directory and
 * returned as a tool result, so it shows up in the conversation.
 */
export const GenerateImageTool = defineTool({
	name: "generate_image",
	description:
		"Generate an image from a text prompt with the provider's image model. The image is saved in the working directory and shown in the conversation.",
	parameters: generateImageSchema,
	execute: async (args, api, context) => {
		const available = await api.models.getAvailableOfType("image");
		if (available.length === 0) {
			return {
				output: [
					{ type: "text", text: "No image model is available. Configure a provider that can generate images." },
				],
				isError: true,
			};
		}
		const agent = await api.agent(context);
		const model = resolveImageModel(available, args.model, agent.model);
		if (model === undefined) {
			return { output: [{ type: "text", text: `Unknown image model: ${args.model}` }], isError: true };
		}

		const result = await api.models.generateImages(
			model,
			{ input: [{ type: "text", text: args.prompt }] },
			context.abortSignal === undefined ? undefined : { signal: context.abortSignal },
		);
		const usage = result.usage === undefined ? {} : { usage: result.usage };
		if (result.stopReason !== "stop") {
			return {
				output: [
					{ type: "text", text: result.errorMessage ?? `Image generation ${result.stopReason}.` },
				],
				isError: true,
				...usage,
			};
		}
		const images = result.output.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) {
			return { output: [{ type: "text", text: "The model returned no image." }], isError: true, ...usage };
		}

		const saved = await saveImages(api, images, args.path, context);
		const note =
			saved.length === 0
				? "The image was not saved: no execution environment is configured."
				: `Saved ${saved.map((path) => `\`${path}\``).join(", ")}.`;
		return { output: [...images, { type: "text", text: note }], ...usage };
	},
});

/** The image tools, installed alongside the coding tools. */
export const ImageTools = defineExtension({ name: "image-tools", tools: [GenerateImageTool] });
