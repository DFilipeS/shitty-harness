import { describe, expect, it } from "vitest";
import {
	AttachmentError,
	attachmentAccept,
	isImageAttachment,
	readAttachment,
	toBase64,
} from "../src/lib/attachments.ts";

function file(name: string, type: string, content: BlobPart): File {
	return new File([content], name, { type });
}

describe("readAttachment", () => {
	it("reads an image as base64", async () => {
		const pending = await readAttachment(file("shot.png", "image/png", new Uint8Array([1, 2, 3])));
		expect(pending.attachment).toEqual({ name: "shot.png", mimeType: "image/png", data: "AQID" });
		expect(pending.size).toBe(3);
	});

	it("normalizes image/jpg to image/jpeg", async () => {
		const pending = await readAttachment(file("shot.jpg", "image/jpg", new Uint8Array([1])));
		expect(pending.attachment.mimeType).toBe("image/jpeg");
	});

	it("reads a text file", async () => {
		const pending = await readAttachment(file("notes.md", "text/markdown", "# Notes"));
		expect(pending.attachment).toEqual({ name: "notes.md", mimeType: "text/markdown", data: "# Notes" });
		expect(pending.size).toBe(7);
	});

	it("uses text/plain when the browser has no type for a text file", async () => {
		const pending = await readAttachment(file("notes.md", "", "# Notes"));
		expect(pending.attachment.mimeType).toBe("text/plain");
	});

	it("keeps the extension's classification over a generic type", async () => {
		const pending = await readAttachment(file("notes.md", "application/octet-stream", "# Notes"));
		expect(pending.attachment.mimeType).toBe("text/plain");
	});

	it("rejects unsupported files", async () => {
		await expect(readAttachment(file("archive.zip", "application/zip", "zip"))).rejects.toBeInstanceOf(
			AttachmentError,
		);
	});

	it("rejects an image over the size cap", async () => {
		const big = file("big.png", "image/png", new Uint8Array(5 * 1024 * 1024 + 1));
		await expect(readAttachment(big)).rejects.toBeInstanceOf(AttachmentError);
	});

	it("rejects a text file over the size cap", async () => {
		const big = file("big.txt", "text/plain", "a".repeat(512 * 1024 + 1));
		await expect(readAttachment(big)).rejects.toBeInstanceOf(AttachmentError);
	});
});

describe("isImageAttachment", () => {
	it("tells images from text files", () => {
		expect(isImageAttachment({ name: "a.png", mimeType: "image/png", data: "" })).toBe(true);
		expect(isImageAttachment({ name: "a.md", mimeType: "text/markdown", data: "" })).toBe(false);
	});
});

describe("attachmentAccept", () => {
	it("lists image types and text extensions", () => {
		const accept = attachmentAccept();
		expect(accept).toContain("image/png");
		expect(accept).toContain(".md");
	});
});

describe("toBase64", () => {
	it("encodes across chunk boundaries", () => {
		const bytes = new Uint8Array(0x8000 * 2 + 1);
		expect(toBase64(bytes)).toBe(btoa("\0".repeat(0x8000 * 2 + 1)));
	});
});
