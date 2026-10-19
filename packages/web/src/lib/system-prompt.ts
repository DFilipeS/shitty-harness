import type { PromptSectionInfo } from "@harness/protocol";

/**
 * Display helpers for the session panel. The data is verbatim — each section's stored text
 * includes its `<key>` wrapper — so the panel stays the truth of what the model last saw.
 */

/** A section's text without its `<key>` wrapper lines; verbatim when the wrapper is absent. */
export function sectionBody(section: PromptSectionInfo): string {
	const pattern = new RegExp(`^<${section.key}>\\n([\\s\\S]*)\\n</${section.key}>$`);
	const body = pattern.exec(section.text)?.[1];
	return body ?? section.text;
}

/** One preview line for a collapsed card. */
export function sectionPreview(section: PromptSectionInfo): string {
	return sectionBody(section)
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "") ?? "";
}

/** The full system prompt as one text: the sections in order, joined the way pi-ai joins them. */
export function fullPromptText(sections: readonly PromptSectionInfo[]): string {
	return sections.map((section) => section.text).join("\n\n");
}
