import {
	ATTACHMENT_IMAGE_MIME_TYPES,
	ATTACHMENT_LIMITS,
	ATTACHMENT_TEXT_EXTENSIONS,
	classifyAttachmentFile,
	isImageMimeType,
	isTextMimeType,
	type PromptAttachment,
} from "@harness/protocol";
import { formatBytes } from "./format.ts";

/** A file read and waiting to be sent with the next message. */
export type PendingAttachment = {
	key: string;
	attachment: PromptAttachment;
	/** Decoded size in bytes. */
	size: number;
};

/** A problem with a file the user picked; the message is safe to show. */
export class AttachmentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentError";
	}
}

const textEncoder = new TextEncoder();

/** The `accept` attribute for the file picker: supported image types and text extensions. */
export function attachmentAccept(): string {
	const types: string[] = [...ATTACHMENT_IMAGE_MIME_TYPES, "text/*"];
	const extensions = ATTACHMENT_TEXT_EXTENSIONS.map((extension) => `.${extension}`);
	return [...types, ...extensions].join(",");
}

/** True when the attachment goes to the model as an image. */
export function isImageAttachment(attachment: PromptAttachment): boolean {
	return isImageMimeType(attachment.mimeType);
}

/**
 * Read one picked file into an attachment. Images become base64; text files become UTF-8 text.
 * Anything else, or anything over its size cap, throws an `AttachmentError`.
 */
export async function readAttachment(file: File): Promise<PendingAttachment> {
	const kind = classifyAttachmentFile(file.name, file.type);
	if (kind === "unsupported") {
		throw new AttachmentError(
			`Cannot attach ${file.name}: only images (PNG, JPEG, WebP, GIF) and text files are supported.`,
		);
	}
	if (kind === "image") {
		if (file.size > ATTACHMENT_LIMITS.maxImageBytes) {
			throw new AttachmentError(
				`${file.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxImageBytes)}.`,
			);
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		return {
			key: crypto.randomUUID(),
			attachment: {
				name: file.name,
				mimeType: file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type,
				data: toBase64(bytes),
			},
			size: bytes.byteLength,
		};
	}
	if (file.size > ATTACHMENT_LIMITS.maxTextBytes) {
		throw new AttachmentError(
			`${file.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxTextBytes)}.`,
		);
	}
	const text = await file.text();
	return {
		key: crypto.randomUUID(),
		attachment: {
			name: file.name,
			mimeType: isTextMimeType(file.type) ? file.type : "text/plain",
			data: text,
		},
		size: textEncoder.encode(text).byteLength,
	};
}

/** Base64 without blowing the call stack on large files. */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}
