import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	ATTACHMENT_LIMITS,
	classifyAttachmentFile,
	isImageMimeType,
	type PromptAttachment,
} from "@harness/protocol";
import { decodeBase64 } from "./base64.ts";
import { ServiceError } from "./errors.ts";

const textEncoder = new TextEncoder();

/** Where an attachment was saved: a workspace path, or undefined when it could not be written. */
export type SaveAttachment = (attachment: PromptAttachment, index: number) => Promise<string | undefined>;

/**
 * The model-facing content for a prompt: the message text, then the saved paths, then each text file
 * wrapped in an `<attached-file>` block, then the images.
 *
 * Validation rejects anything a provider cannot take: unsupported file types, files over their size
 * cap, and images when the model has no image input. Each attachment goes through `save` so the
 * model gets a workspace path it can pass to tools such as `generate_image` or `read`.
 */
export async function buildPromptContent(
	text: string,
	attachments: readonly PromptAttachment[],
	modelInput: readonly string[] | undefined,
	save: SaveAttachment,
): Promise<UserMessage["content"]> {
	validateAttachments(attachments, modelInput);
	if (attachments.length === 0) return text;

	const paths = await Promise.all(attachments.map((attachment, index) => save(attachment, index)));
	const parts: (TextContent | ImageContent)[] = [];
	if (text !== "") parts.push({ type: "text", text });
	const saved = savedFilesNote(attachments, paths);
	if (saved !== undefined) parts.push({ type: "text", text: saved });
	for (const attachment of attachments) {
		if (isImageMimeType(attachment.mimeType)) continue;
		parts.push({ type: "text", text: wrapTextFile(attachment) });
	}
	for (const attachment of attachments) {
		if (!isImageMimeType(attachment.mimeType)) continue;
		parts.push({ type: "image", data: attachment.data, mimeType: imageMimeType(attachment.mimeType) });
	}
	return parts;
}

/**
 * Write one attachment into the environment and return its path, or undefined when the write fails.
 * Images are decoded from base64; text files are written as UTF-8. The name is reduced to a safe
 * file name and prefixed with a timestamp and index, so repeated names never collide.
 */
export async function saveAttachment(
	env: Pick<ExecutionEnv, "writeFile">,
	conversationId: string,
	attachment: PromptAttachment,
	index: number,
	context: Context,
	now = Date.now(),
): Promise<string | undefined> {
	const path = `.harness/attachments/${conversationId}/${now}-${index + 1}-${safeFileName(attachment.name)}`;
	try {
		const data = isImageMimeType(attachment.mimeType) ? decodeBase64(attachment.data) : attachment.data;
		const result = await env.writeFile(path, data, context);
		if (result.ok) return path;
		console.warn(`[core] saving attachment ${attachment.name} to ${path} failed: ${result.error.message}`);
	} catch (error) {
		console.warn(`[core] saving attachment ${attachment.name} to ${path} failed:`, error);
	}
	return undefined;
}

/** The path list the model reads to reach the files later; omitted when nothing was saved. */
function savedFilesNote(
	attachments: readonly PromptAttachment[],
	paths: readonly (string | undefined)[],
): string | undefined {
	const lines: string[] = [];
	for (const [index, attachment] of attachments.entries()) {
		const path = paths[index];
		if (path === undefined) continue;
		lines.push(`- ${attachment.name} (${attachment.mimeType}): \`${path}\``);
	}
	if (lines.length === 0) return undefined;
	return `Attached files saved in the working directory:\n${lines.join("\n")}`;
}

/** Rejects attachments the model or the providers cannot take. */
function validateAttachments(attachments: readonly PromptAttachment[], modelInput: readonly string[] | undefined): void {
	if (attachments.length > ATTACHMENT_LIMITS.maxPerMessage) {
		throw new ServiceError(
			"invalid",
			`A message can carry at most ${ATTACHMENT_LIMITS.maxPerMessage} attachments`,
		);
	}

	let totalBytes = 0;
	let hasImage = false;
	for (const attachment of attachments) {
		const kind = classifyAttachmentFile(attachment.name, attachment.mimeType);
		if (kind === "unsupported") {
			throw new ServiceError(
				"unsupported_attachment",
				`Cannot attach ${attachment.name}: only images (PNG, JPEG, WebP, GIF) and text files are supported.`,
			);
		}
		const bytes =
			kind === "image" ? base64Bytes(attachment.data) : textEncoder.encode(attachment.data).byteLength;
		const limit = kind === "image" ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxTextBytes;
		if (bytes > limit) {
			throw new ServiceError("attachment_too_large", `${attachment.name} is larger than ${formatBytes(limit)}.`);
		}
		totalBytes += bytes;
		if (kind === "image") hasImage = true;
	}

	if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
		throw new ServiceError(
			"attachment_too_large",
			`The attachments are larger than ${formatBytes(ATTACHMENT_LIMITS.maxTotalBytes)} together.`,
		);
	}
	if (hasImage && !(modelInput ?? []).includes("image")) {
		throw new ServiceError(
			"unsupported_model",
			"This model cannot read images. Choose a vision model or remove the images.",
		);
	}
}

/** Keep the base name; drop path separators and anything the filesystem should not see. */
export function safeFileName(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? "";
	const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
	return cleaned;
}

/** Decoded byte length of base64 data, without decoding it. */
function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.floor((data.length * 3) / 4) - padding;
}

function imageMimeType(mimeType: string): string {
	return mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : mimeType;
}

/** The wrapper the model and the transcript both read; the web client renders it as a file card. */
function wrapTextFile(attachment: PromptAttachment): string {
	return `<attached-file name="${escapeAttribute(attachment.name)}" mime="${escapeAttribute(attachment.mimeType)}">\n${attachment.data}\n</attached-file>`;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Compact byte sizes: `512 B`, `4.2 KB`, `1.5 MB`. */
function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
