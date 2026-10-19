import type { InboxItem } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { queuedMessageInfo } from "../src/queue.ts";

/** An input inbox item with the given content; queued writes are built inline where tested. */
function input(content: unknown, mode: "steer" | "followUp" = "followUp") {
	return queuedMessageInfo({ id: 7, mode, content } as unknown as InboxItem);
}

describe("queuedMessageInfo", () => {
	it("passes a plain string message through", () => {
		expect(input("Hello there")).toEqual({
			id: "7",
			mode: "followUp",
			text: "Hello there",
			attachments: [],
			images: 0,
		});
	});

	it("keeps the queue mode", () => {
		expect(input("Hello", "steer")?.mode).toBe("steer");
	});

	it("leaves queued writes out", () => {
		const write = queuedMessageInfo({ id: 8, mode: "write", entry: { kind: "pi.compaction" } } as unknown as InboxItem);
		expect(write).toBeUndefined();
	});

	it("joins the message's own text parts", () => {
		const content = [
			{ type: "text", text: "One thing," },
			{ type: "text", text: "then another." },
		];
		expect(input(content)?.text).toBe("One thing,\nthen another.");
	});

	it("reports the skill a message activates, without its instructions", () => {
		const content = [
			{ type: "text", text: '<skill name="deploy&amp;run" scope="project">\nBe kind.\nSkill directory: /skills/deploy\n</skill>' },
			{ type: "text", text: "Please deploy." },
		];
		expect(input(content)).toMatchObject({ skill: "deploy&run", text: "Please deploy." });
	});

	it("names attachments from the saved-files note, images apart", () => {
		const content = [
			{ type: "text", text: "Look at this" },
			{
				type: "text",
				text: "Attached files saved in the working directory:\n- notes.md (text/markdown): `.harness/attachments/1/1-notes.md`\n- shot.png (image/png): `.harness/attachments/1/2-shot.png`",
			},
			{ type: "text", text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>' },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		];
		expect(input(content)).toMatchObject({ text: "Look at this", attachments: ["notes.md"], images: 1 });
	});

	it("falls back to the attached-file wrappers when nothing was saved", () => {
		const content = [
			{ type: "text", text: "Look at this" },
			{ type: "text", text: '<attached-file name="notes.md" mime="text/markdown">\n# Notes\n</attached-file>' },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		];
		expect(input(content)).toMatchObject({ text: "Look at this", attachments: ["notes.md"], images: 1 });
	});

	it("ignores content it does not recognize", () => {
		expect(input(null)).toEqual({ id: "7", mode: "followUp", text: "", attachments: [], images: 0 });
	});
});
