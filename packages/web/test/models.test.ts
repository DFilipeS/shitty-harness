import type { ModelInfo } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { modelCapabilities } from "../src/lib/models.ts";

function model(overrides: Partial<ModelInfo>): ModelInfo {
	return {
		provider: "openrouter",
		providerName: "OpenRouter",
		id: "some/model",
		name: "Some Model",
		reasoning: false,
		contextWindow: 100_000,
		maxTokens: 1_000,
		input: ["text"],
		thinkingLevels: ["off"],
		imageGeneration: false,
		...overrides,
	};
}

describe("modelCapabilities", () => {
	it("has none for a plain text model", () => {
		expect(modelCapabilities(model({}))).toEqual([]);
	});

	it("reports reasoning", () => {
		expect(modelCapabilities(model({ reasoning: true }))).toEqual(["reasoning"]);
	});

	it("reports image input", () => {
		expect(modelCapabilities(model({ input: ["text", "image"] }))).toEqual(["image"]);
	});

	it("reports both in display order", () => {
		expect(modelCapabilities(model({ reasoning: true, input: ["text", "image"] }))).toEqual([
			"reasoning",
			"image",
		]);
	});

	it("reports image generation", () => {
		expect(modelCapabilities(model({ imageGeneration: true }))).toEqual(["imageGeneration"]);
	});

	it("reports all three in display order", () => {
		expect(
			modelCapabilities(
				model({ reasoning: true, input: ["text", "image"], imageGeneration: true }),
			),
		).toEqual(["reasoning", "image", "imageGeneration"]);
	});
});
