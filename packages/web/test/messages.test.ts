import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ModelInfo } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import {
	activeBlockIndex,
	applyMessageChanges,
	assistantError,
	codemodeCalls,
	fromAssistantMessage,
	hasHiddenOutput,
	generatedImageInfo,
	toolResultImages,
	toolResultText,
	userParts,
} from "../src/lib/messages.ts";

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

describe("model errors", () => {
	it("reads the failure a committed assistant message carries", () => {
		expect(assistantError(assistant({ stopReason: "error", errorMessage: "412 suspended" }))).toBe(
			"412 suspended",
		);
		expect(assistantError(assistant({ stopReason: "error" }))).toBe("The model request failed.");
		expect(assistantError(assistant())).toBeUndefined();
		expect(assistantError(assistant({ stopReason: "aborted" }))).toBeUndefined();
	});

	it("keeps the failure on the live message as it streams", () => {
		const live = fromAssistantMessage(
			assistant({ content: [], stopReason: "error", errorMessage: "suspended" }),
		);
		expect(live.error).toBe("suspended");

		const updated = applyMessageChanges(live, live.usage ?? assistant().usage, [
			{
				type: "message",
				message: assistant({ content: [], stopReason: "error", errorMessage: "still suspended" }),
			},
		]);
		expect(updated.error).toBe("still suspended");
	});
});

describe("activeBlockIndex", () => {
	const thinking = { type: "thinking", thinking: "weighing it" } as const;
	const text = { type: "text", text: "here goes" } as const;

	it("is the last block while the message streams", () => {
		expect(activeBlockIndex([thinking, text], undefined)).toBe(1);
		expect(activeBlockIndex([thinking], undefined)).toBe(0);
	});

	it("is nothing once the message is finished", () => {
		expect(activeBlockIndex([thinking], true)).toBeUndefined();
	});

	it("is nothing while a message has no blocks yet", () => {
		expect(activeBlockIndex([], undefined)).toBeUndefined();
	});
});

describe("hasHiddenOutput", () => {
	it("spots an image model that billed image tokens but shows only thinking", () => {
		expect(hasHiddenOutput(assistant(), [imageModel()])).toBe(true);
	});

	it("ignores replies with text or a tool call", () => {
		const text = assistant({ content: [{ type: "text", text: "Here you go." }] });
		expect(hasHiddenOutput(text, [imageModel()])).toBe(false);
		const call = assistant({
			content: [{ type: "toolCall", id: "call-1", name: "generate_image", arguments: {} }],
		});
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

describe("codemodeCalls", () => {
	it("reads the script's calls from a codemode result's details", () => {
		const message: ToolResultMessage = {
			...result([]),
			toolName: "codemode",
			details: {
				calls: [
					{ id: 1, name: "bash", args: '{"command":"echo one"}', status: "ok" },
					{ id: 2, name: "bash", args: '{"command":"oops"}', status: "error", error: "boom" },
				],
			},
		};
		expect(codemodeCalls(message)).toEqual([
			{ name: "bash", args: '{"command":"echo one"}', status: "ok" },
			{ name: "bash", args: '{"command":"oops"}', status: "error", error: "boom" },
		]);
	});

	it("stays undefined for other tools and other shapes", () => {
		expect(codemodeCalls(result([]))).toBeUndefined();
		expect(
			codemodeCalls({ ...result([]), toolName: "codemode", details: { calls: "nope" } }),
		).toBeUndefined();
		expect(
			codemodeCalls({
				...result([]),
				toolName: "codemode",
				details: { calls: [{ name: "bash", args: "{}", status: "weird" }] },
			}),
		).toEqual([]);
	});
});

function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

describe("userParts", () => {
	it("keeps a plain string message as one text part", () => {
		expect(userParts(user("Hello"))).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("splits text and images", () => {
		expect(
			userParts(
				user([
					{ type: "text", text: "Look" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				]),
			),
		).toEqual([
			{ type: "text", text: "Look" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
	});

	it("parses an attached file block", () => {
		expect(
			userParts(
				user([
					{
						type: "text",
						text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>',
					},
				]),
			),
		).toEqual([{ type: "file", name: "notes.md", mimeType: "text/markdown", text: "# Notes" }]);
	});

	it("unescapes file names", () => {
		expect(
			userParts(
				user([
					{
						type: "text",
						text: '<attached-file name="a&amp;&quot;b.md" mime="text/plain">\nx\n</attached-file>',
					},
				]),
			),
		).toEqual([{ type: "file", name: 'a&"b.md', mimeType: "text/plain", text: "x" }]);
	});

	it("leaves text that only looks like a block alone", () => {
		const text = 'not <attached-file name="x" mime="text/plain">';
		expect(userParts(user([{ type: "text", text }]))).toEqual([{ type: "text", text }]);
	});
});

describe("generatedImageInfo", () => {
	const details = {
		provider: "openrouter",
		providerName: "OpenRouter",
		modelId: "google/gemini-3-pro-image",
		modelName: "Nano Banana Pro",
	};

	it("reads the provider and model from a generate_image result", () => {
		const message = { ...result([]), toolName: "generate_image", details };
		expect(generatedImageInfo(message)).toEqual(details);
	});

	it("ignores other tools", () => {
		expect(generatedImageInfo({ ...result([]), details })).toBeUndefined();
	});

	it("falls back to the ids when names are missing", () => {
		const message = {
			...result([]),
			toolName: "generate_image",
			details: { provider: "openrouter", modelId: "google/gemini-3-pro-image" },
		};
		expect(generatedImageInfo(message)).toEqual({
			provider: "openrouter",
			providerName: "openrouter",
			modelId: "google/gemini-3-pro-image",
			modelName: "google/gemini-3-pro-image",
		});
	});

	it("ignores malformed details", () => {
		expect(
			generatedImageInfo({ ...result([]), toolName: "generate_image", details: { provider: 1 } }),
		).toBeUndefined();
		expect(
			generatedImageInfo({ ...result([]), toolName: "generate_image", details: "nope" }),
		).toBeUndefined();
	});
});
