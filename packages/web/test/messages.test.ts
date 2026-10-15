import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ModelInfo } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { hasHiddenOutput, toolResultImages, toolResultText } from "../src/lib/messages.ts";

function result(content: ToolResultMessage["content"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content,
		isError: false,
		timestamp: 1,
	};
}

function imageModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		provider: "openrouter",
		providerName: "OpenRouter",
		id: "google/gemini-3-pro-image",
		name: "Google: Nano Banana Pro (Gemini 3 Pro Image)",
		reasoning: true,
		contextWindow: 65_536,
		maxTokens: 32_768,
		input: ["text", "image"],
		thinkingLevels: ["off", "low"],
		imageGeneration: true,
		...overrides,
	};
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "thinking about the picture" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "google/gemini-3-pro-image",
		usage: {
			input: 100,
			output: 1322,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 144,
			totalTokens: 1422,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("hasHiddenOutput", () => {
	it("spots an image model that billed image tokens but shows only thinking", () => {
		expect(hasHiddenOutput(assistant(), [imageModel()])).toBe(true);
	});

	it("ignores replies with text or a tool call", () => {
		const text = assistant({ content: [{ type: "text", text: "Here you go." }] });
		expect(hasHiddenOutput(text, [imageModel()])).toBe(false);
		const call = assistant({ content: [{ type: "toolCall", id: "call-1", name: "generate_image", arguments: {} }] });
		expect(hasHiddenOutput(call, [imageModel()])).toBe(false);
	});

	it("ignores models that cannot answer with an image", () => {
		expect(hasHiddenOutput(assistant(), [imageModel({ imageGeneration: false })])).toBe(false);
		expect(hasHiddenOutput(assistant(), [])).toBe(false);
	});

	it("ignores output the reasoning count accounts for", () => {
		const thinking = assistant({
			usage: {
				input: 100,
				output: 400,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 350,
				totalTokens: 500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(hasHiddenOutput(thinking, [imageModel()])).toBe(false);
	});
});

describe("tool result content", () => {
	it("joins the text parts", () => {
		const message = result([
			{ type: "text", text: "line one" },
			{ type: "text", text: "line two" },
		]);
		expect(toolResultText(message)).toBe("line one\nline two");
		expect(toolResultImages(message)).toEqual([]);
	});

	it("reads an image part", () => {
		const message = result([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		expect(toolResultText(message)).toBe("");
		expect(toolResultImages(message)).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
	});

	it("keeps both when a result mixes them", () => {
		const message = result([
			{ type: "text", text: "here it is" },
			{ type: "image", data: "aGk=", mimeType: "image/jpeg" },
		]);
		expect(toolResultText(message)).toBe("here it is");
		expect(toolResultImages(message)).toHaveLength(1);
	});
});
