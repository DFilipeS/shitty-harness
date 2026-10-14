import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { toolResultImages, toolResultText } from "../src/lib/messages.ts";

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
