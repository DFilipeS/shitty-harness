import type { ModelInfo } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { buildModelPage } from "../src/lib/session-commands.tsx";

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

describe("buildModelPage", () => {
	it("offers chat models but not image-generation models", () => {
		const page = buildModelPage(
			[
				model({ id: "chat-model", name: "Chat Model" }),
				model({ id: "image-model", name: "Image Model", imageGeneration: true }),
			],
			undefined,
			async () => {},
		);
		expect(page.commands.map((command) => command.id)).toEqual(["model.openrouter.chat-model"]);
	});

	it("marks the current model", () => {
		const page = buildModelPage(
			[model({ id: "chat-model" })],
			{ provider: "openrouter", modelId: "chat-model" },
			async () => {},
		);
		expect(page.commands[0]?.current).toBe(true);
	});
});
