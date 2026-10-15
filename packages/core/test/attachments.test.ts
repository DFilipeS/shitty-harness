import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, type PromptAttachment } from "@harness/protocol";
import { buildPromptContent, saveAttachment } from "../src/attachments.ts";
import { ServiceError } from "../src/errors.ts";

const VISION = ["text", "image"];
const TEXT_ONLY = ["text"];

function attachment(overrides: Partial<PromptAttachment> = {}): PromptAttachment {
	return { name: "notes.md", mimeType: "text/markdown", data: "# Notes", ...overrides };
}

const noSave = async (): Promise<string | undefined> => undefined;

async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
	try {
		await run();
	} catch (error) {
		return error instanceof ServiceError ? error.code : `not a ServiceError: ${String(error)}`;
	}
	return undefined;
}

describe("buildPromptContent", () => {
	it("returns plain text when there are no attachments", async () => {
		expect(await buildPromptContent("Hello", [], VISION, noSave)).toBe("Hello");
	});

	it("sends images as image content for vision models", async () => {
		const content = await buildPromptContent(
			"Look",
			[attachment({ name: "shot.png", mimeType: "image/png", data: "aGk=" })],
			VISION,
			noSave,
		);
		expect(content).toEqual([
			{ type: "text", text: "Look" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
	});

	it("normalizes image/jpg to image/jpeg", async () => {
		const content = await buildPromptContent(
			"",
			[attachment({ name: "shot.jpg", mimeType: "image/jpg", data: "aGk=" })],
			VISION,
			noSave,
		);
		expect(content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/jpeg" }]);
	});

	it("wraps text files in an attached-file block", async () => {
		const content = await buildPromptContent("See this", [attachment()], TEXT_ONLY, noSave);
		expect(content).toEqual([
			{ type: "text", text: "See this" },
			{
				type: "text",
				text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
		]);
	});

	it("escapes quotes and ampersands in file names", async () => {
		const content = await buildPromptContent("", [attachment({ name: 'a&"b.md' })], TEXT_ONLY, noSave);
		expect(content).toEqual([
			{
				type: "text",
				text: '<attached-file name="a&amp;&quot;b.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
		]);
	});

	it("keeps the text, paths, files, then images order", async () => {
		const content = await buildPromptContent(
			"Both",
			[attachment({ name: "shot.png", mimeType: "image/png", data: "aGk=" }), attachment()],
			VISION,
			async (file, index) => `saved/${index + 1}-${file.name}`,
		);
		expect(content).toEqual([
			{ type: "text", text: "Both" },
			{
				type: "text",
				text: "Attached files saved in the working directory:\n- shot.png (image/png): `saved/1-shot.png`\n- notes.md (text/markdown): `saved/2-notes.md`",
			},
			{
				type: "text",
				text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
	});

	it("omits the path list when nothing was saved", async () => {
		expect(await buildPromptContent("", [attachment()], TEXT_ONLY, noSave)).toEqual([
			{
				type: "text",
				text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
		]);
	});

	it("lists only the files that were saved", async () => {
		const content = await buildPromptContent(
			"",
			[attachment({ name: "a.md" }), attachment({ name: "b.md" })],
			TEXT_ONLY,
			async (_file, index) => (index === 0 ? "saved/a.md" : undefined),
		);
		expect(content).toEqual([
			{ type: "text", text: "Attached files saved in the working directory:\n- a.md (text/markdown): `saved/a.md`" },
			{
				type: "text",
				text: '<attached-file name="a.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
			{
				type: "text",
				text: '<attached-file name="b.md" mime="text/markdown">\n# Notes\n</attached-file>',
			},
		]);
	});

	it("rejects unsupported files before saving anything", async () => {
		let saves = 0;
		const code = await errorCode(() =>
			buildPromptContent(
				"",
				[attachment({ name: "archive.zip", mimeType: "application/zip" })],
				TEXT_ONLY,
				async () => {
					saves += 1;
					return undefined;
				},
			),
		);
		expect({ code, saves }).toEqual({ code: "unsupported_attachment", saves: 0 });
	});

	it("rejects images when the model has no image input", async () => {
		const code = await errorCode(() =>
			buildPromptContent(
				"",
				[attachment({ name: "shot.png", mimeType: "image/png", data: "aGk=" })],
				TEXT_ONLY,
				noSave,
			),
		);
		expect(code).toBe("unsupported_model");
	});

	it("rejects a text file over the size cap", async () => {
		const data = "a".repeat(ATTACHMENT_LIMITS.maxTextBytes + 1);
		expect(await errorCode(() => buildPromptContent("", [attachment({ data })], TEXT_ONLY, noSave))).toBe(
			"attachment_too_large",
		);
	});

	it("rejects an image over the size cap", async () => {
		const data = "A".repeat(Math.ceil((ATTACHMENT_LIMITS.maxImageBytes + 1) / 3) * 4);
		const code = await errorCode(() =>
			buildPromptContent("", [attachment({ name: "shot.png", mimeType: "image/png", data })], VISION, noSave),
		);
		expect(code).toBe("attachment_too_large");
	});

	it("rejects more attachments than a message allows", async () => {
		const attachments = Array.from({ length: ATTACHMENT_LIMITS.maxPerMessage + 1 }, (_, index) =>
			attachment({ name: `file-${index}.md`, data: "x" }),
		);
		expect(await errorCode(() => buildPromptContent("", attachments, TEXT_ONLY, noSave))).toBe("invalid");
	});

	it("rejects attachments that are too large together", async () => {
		const bytes = Math.floor(ATTACHMENT_LIMITS.maxImageBytes * 0.9);
		const data = "A".repeat(Math.ceil(bytes / 3) * 4);
		const attachments = Array.from({ length: 5 }, (_, index) =>
			attachment({ name: `shot-${index}.png`, mimeType: "image/png", data }),
		);
		expect(await errorCode(() => buildPromptContent("", attachments, VISION, noSave))).toBe("attachment_too_large");
	});
});

describe("saveAttachment", () => {
	function writer(): {
		writes: { path: string; content: string | Uint8Array }[];
		env: { writeFile(path: string, content: string | Uint8Array): Promise<{ ok: true; value: undefined }> };
	} {
		const writes: { path: string; content: string | Uint8Array }[] = [];
		return {
			writes,
			env: {
				async writeFile(path, content) {
					writes.push({ path, content });
					return { ok: true as const, value: undefined };
				},
			},
		};
	}

	it("writes images as decoded bytes under a stamped path", async () => {
		const { writes, env } = writer();
		const path = await saveAttachment(
			env,
			"42",
			attachment({ name: "shot.png", mimeType: "image/png", data: "AQID" }),
			0,
			BACKGROUND_CONTEXT,
			1_000,
		);
		expect(path).toBe(".harness/attachments/42/1000-1-shot.png");
		expect(writes).toEqual([{ path, content: new Uint8Array([1, 2, 3]) }]);
	});

	it("writes text files as text", async () => {
		const { writes, env } = writer();
		const path = await saveAttachment(env, "42", attachment(), 1, BACKGROUND_CONTEXT, 1_000);
		expect(path).toBe(".harness/attachments/42/1000-2-notes.md");
		expect(writes).toEqual([{ path, content: "# Notes" }]);
	});

	it("sanitizes path separators and unsafe characters", async () => {
		const { env } = writer();
		const path = await saveAttachment(
			env,
			"42",
			attachment({ name: "../../evil name!.md" }),
			0,
			BACKGROUND_CONTEXT,
			1_000,
		);
		expect(path).toBe(".harness/attachments/42/1000-1-evil_name_.md");
	});

	it("returns undefined when the write fails", async () => {
		const env = {
			async writeFile(): Promise<never> {
				throw new Error("disk full");
			},
		};
		expect(await saveAttachment(env, "42", attachment(), 0, BACKGROUND_CONTEXT, 1_000)).toBeUndefined();
	});
});
