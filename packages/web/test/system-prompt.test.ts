import { describe, expect, it } from "vitest";
import type { PromptSectionInfo } from "@harness/protocol";
import { fullPromptText, sectionBody, sectionPreview } from "../src/lib/system-prompt.ts";

const section = (key: string, text: string): PromptSectionInfo => ({ key, text });

describe("system prompt display", () => {
	it("strips a section's wrapper for the card body", () => {
		const wrapped = section("execution-target", "<execution-target>\nYou run locally.\n</execution-target>");
		expect(sectionBody(wrapped)).toBe("You run locally.");
	});

	it("keeps the text verbatim when the wrapper is absent", () => {
		expect(sectionBody(section("odd", "No wrapper here."))).toBe("No wrapper here.");
	});

	it("does not strip a wrapper that does not match the key", () => {
		expect(sectionBody(section("a", "<b>\nnot you\n</b>"))).toBe("<b>\nnot you\n</b>");
	});

	it("previews with the first non-empty line", () => {
		const wrapped = section("skills", "<skills>\n\n\nThe skills below…\nMore.\n</skills>");
		expect(sectionPreview(wrapped)).toBe("The skills below…");
	});

	it("joins the sections the way the model receives them", () => {
		const sections = [section("a", "<a>\nOne\n</a>"), section("b", "<b>\nTwo\n</b>")];
		expect(fullPromptText(sections)).toBe("<a>\nOne\n</a>\n\n<b>\nTwo\n</b>");
	});
});
