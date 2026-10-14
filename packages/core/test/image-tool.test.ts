import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantImages, ImageApi, ImageContent, ImageModel, Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolDiagnostic, ToolExecutionApi } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it, vi } from "vitest";
import { GenerateImageTool, openRouterGenerationCost } from "../src/image-tool.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const OTHER_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const IMAGE_MODEL: ImageModel<ImageApi> = {
	type: "image",
	id: "openrouter/google/gemini-3-pro-image",
	name: "Google: Nano Banana Pro (Gemini 3 Pro Image)",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	input: ["text", "image"],
	output: ["image", "text"],
	cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0.375 },
};

const OTHER_MODEL: ImageModel<ImageApi> = { ...IMAGE_MODEL, id: "openrouter/other-image", name: "Other Image" };
/** A dedicated image endpoint model: image output only, not reachable through chat completions. */
const IMAGE_ONLY_MODEL: ImageModel<ImageApi> = {
	...IMAGE_MODEL,
	id: "black-forest-labs/flux-3-image",
	name: "Black Forest Labs: FLUX.3 Image",
	output: ["image"],
};

function generated(overrides: Partial<AssistantImages> = {}): AssistantImages {
	return {
		api: "openrouter-images",
		provider: "openrouter",
		model: IMAGE_MODEL.id,
		output: [{ type: "image", data: PNG, mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

type ApiOptions = {
	available?: readonly ImageModel<ImageApi>[];
	generate?: (model: ImageModel<ImageApi>) => Promise<AssistantImages>;
	env?: NodeExecutionEnv;
	current?: { provider: string; modelId: string };
	diagnostics?: ToolDiagnostic[];
};

function fakeApi(options: ApiOptions = {}): ToolExecutionApi {
	return {
		models: {
			getAvailableOfType: async () => options.available ?? [IMAGE_MODEL],
			generateImages: async (model: ImageModel<ImageApi>) => (options.generate ?? (() => generated()))(model),
			getAuth: async () => ({ auth: { apiKey: "test-key" } }),
		},
		agent: async () => ({ model: options.current }),
		env: options.env,
		diagnostic: (diagnostic: ToolDiagnostic) => options.diagnostics?.push(diagnostic),
	} as unknown as ToolExecutionApi;
}

function imageParts(result: { output?: readonly { type: string }[] }): ImageContent[] {
	return (result.output ?? []).filter((part): part is ImageContent => part.type === "image");
}

const ESTIMATE: Usage = {
	input: 15,
	output: 1237,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1252,
	cost: { input: 0.00003, output: 0.014844, cacheRead: 0, cacheWrite: 0, total: 0.014874 },
};

function generationLookup(total: number): typeof fetch {
	return async () => new Response(JSON.stringify({ data: { total_cost: total } }), { status: 200 });
}

describe("openRouterGenerationCost", () => {
	it("reads total_cost from the generation endpoint", async () => {
		const urls: string[] = [];
		const cost = await openRouterGenerationCost("gen-1", "https://openrouter.ai/api/v1/", "key", {
			fetch: async (input) => {
				urls.push(String(input));
				return new Response(JSON.stringify({ data: { total_cost: 0.135834 } }), { status: 200 });
			},
		});
		expect(cost).toBeCloseTo(0.135834);
		expect(urls).toEqual(["https://openrouter.ai/api/v1/generation?id=gen-1"]);
	});

	it("returns undefined when the lookup fails", async () => {
		expect(
			await openRouterGenerationCost("gen-1", "https://openrouter.ai/api/v1", "key", {
				fetch: async () => new Response("nope", { status: 500 }),
			}),
		).toBeUndefined();
		expect(
			await openRouterGenerationCost("gen-1", "https://openrouter.ai/api/v1", "key", {
				fetch: async () => {
					throw new Error("offline");
				},
			}),
		).toBeUndefined();
		expect(
			await openRouterGenerationCost("gen-1", "https://openrouter.ai/api/v1", "key", {
				fetch: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
			}),
		).toBeUndefined();
	});
});

describe("generate_image", () => {
	it("generates an image, saves it, and returns it", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-image-"));
		try {
			const env = new NodeExecutionEnv({ cwd: workspace });
			const result = await GenerateImageTool.execute(
				{ prompt: "a red apple" },
				fakeApi({ env }),
				BACKGROUND_CONTEXT,
			);

			expect(result.isError).toBeUndefined();
			expect(imageParts(result)).toHaveLength(1);
			expect(imageParts(result)[0]?.data).toBe(PNG);
			const note = (result.output ?? []).find((part) => part.type === "text")?.text ?? "";
			const saved = /`(image-\d+\.png)`/.exec(note)?.[1];
			expect(saved).toBeDefined();
			expect((await readFile(join(workspace, saved ?? ""))).toString("base64")).toBe(PNG);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("uses what OpenRouter charged instead of pi-ai's estimate", async () => {
		vi.stubGlobal("fetch", generationLookup(0.135834));
		try {
			const result = await GenerateImageTool.execute(
				{ prompt: "a red apple" },
				fakeApi({ generate: async () => generated({ usage: ESTIMATE, responseId: "gen-1" }) }),
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBeUndefined();
			expect(result.usage?.cost.total).toBeCloseTo(0.135834);
			expect(result.usage?.cost.input).toBeCloseTo(0.00003);
			expect(result.usage?.cost.output).toBeCloseTo(0.135834 - 0.00003);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps pi-ai's estimate when the lookup fails", async () => {
		vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
		try {
			const result = await GenerateImageTool.execute(
				{ prompt: "a red apple" },
				fakeApi({ generate: async () => generated({ usage: ESTIMATE, responseId: "gen-1" }) }),
				BACKGROUND_CONTEXT,
			);
			expect(result.usage?.cost.total).toBeCloseTo(0.014874);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reports a provider failure", async () => {
		const result = await GenerateImageTool.execute(
			{ prompt: "a red apple" },
			fakeApi({
				generate: async () =>
					generated({
						stopReason: "error",
						errorMessage: "This request requires at least $1.00 in balance for image or video output",
						output: [],
					}),
			}),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("at least $1.00");
	});

	it("reports a missing image model", async () => {
		const result = await GenerateImageTool.execute({ prompt: "x" }, fakeApi({ available: [] }), BACKGROUND_CONTEXT);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("No image model is available");
	});

	it("reports an unknown requested model", async () => {
		const result = await GenerateImageTool.execute(
			{ prompt: "x", model: "nope" },
			fakeApi(),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("Unknown image model: nope");
	});

	it("prefers a chat-compatible model when there is no sibling", async () => {
		let used: ImageModel<ImageApi> | undefined;
		const result = await GenerateImageTool.execute(
			{ prompt: "x" },
			fakeApi({
				available: [IMAGE_ONLY_MODEL, IMAGE_MODEL],
				generate: async (model) => {
					used = model;
					return generated();
				},
			}),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(used?.id).toBe(IMAGE_MODEL.id);
	});

	it("uses a requested model even when it is image-only", async () => {
		let used: ImageModel<ImageApi> | undefined;
		const result = await GenerateImageTool.execute(
			{ prompt: "x", model: "black-forest-labs/flux-3-image" },
			fakeApi({
				available: [IMAGE_ONLY_MODEL, IMAGE_MODEL],
				generate: async (model) => {
					used = model;
					return generated();
				},
			}),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(used?.id).toBe(IMAGE_ONLY_MODEL.id);
	});

	it("prefers the conversation model's image sibling", async () => {
		let used: ImageModel<ImageApi> | undefined;
		const result = await GenerateImageTool.execute(
			{ prompt: "x" },
			fakeApi({
				available: [OTHER_MODEL, IMAGE_MODEL],
				current: { provider: "openrouter", modelId: IMAGE_MODEL.id },
				generate: async (model) => {
					used = model;
					return generated();
				},
			}),
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(used?.id).toBe(IMAGE_MODEL.id);
	});

	it("writes every image when the model returns more than one", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "harness-image-"));
		try {
			const env = new NodeExecutionEnv({ cwd: workspace });
			const result = await GenerateImageTool.execute(
				{ prompt: "two apples", path: "apples" },
				fakeApi({
					env,
					generate: async () =>
						generated({
							output: [
								{ type: "image", data: PNG, mimeType: "image/png" },
								{ type: "image", data: OTHER_PNG, mimeType: "image/jpeg" },
							],
						}),
				}),
				BACKGROUND_CONTEXT,
			);
			expect(imageParts(result)).toHaveLength(2);
			expect((await readFile(join(workspace, "apples-1.png"))).toString("base64")).toBe(PNG);
			expect((await readFile(join(workspace, "apples-2.jpg"))).toString("base64")).toBe(OTHER_PNG);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
