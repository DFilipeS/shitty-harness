/**
 * Rules shared by the client and the server for prompt attachments: which files may be attached,
 * how big they may be, and how they are classified.
 *
 * pi-ai's chat messages only carry text and images, so an attachment is either an image (sent as
 * image content to models that accept it) or a text file (inlined into the message text).
 */

/** One file attached to a prompt. `data` is base64 for images and UTF-8 text for other files. */
export type PromptAttachment = {
	name: string;
	mimeType: string;
	data: string;
};

/** What an attachment carries. */
export type AttachmentKind = "image" | "text" | "unsupported";

/** Caps on what one message may carry. */
export const ATTACHMENT_LIMITS = {
	/** Most attachments in one message. */
	maxPerMessage: 10,
	/** Most bytes an image may decode to. */
	maxImageBytes: 5 * 1024 * 1024,
	/** Most bytes a text file may be. */
	maxTextBytes: 512 * 1024,
	/** Most bytes all attachments in one message may decode to. */
	maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** Image types the providers accept. `image/jpg` is normalized to `image/jpeg` on the way in. */
export const ATTACHMENT_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/gif",
] as const;

/** File extensions read as text. The extension wins over a missing or generic browser MIME type. */
export const ATTACHMENT_TEXT_EXTENSIONS = [
	"md",
	"markdown",
	"mdx",
	"txt",
	"text",
	"log",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"ndjson",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"xml",
	"html",
	"htm",
	"css",
	"scss",
	"less",
	"svg",
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"mts",
	"cts",
	"tsx",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"kts",
	"scala",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"swift",
	"sh",
	"bash",
	"zsh",
	"fish",
	"ps1",
	"bat",
	"sql",
	"graphql",
	"gql",
	"proto",
	"diff",
	"patch",
	"tex",
	"rst",
	"org",
	"ics",
	"vcf",
	"srt",
	"vtt",
	"properties",
	"plist",
	"gitignore",
	"gitattributes",
	"editorconfig",
	"lock",
] as const;

/** Whole file names that are text even though they have no extension. */
export const ATTACHMENT_TEXT_FILE_NAMES = [
	"dockerfile",
	"makefile",
	"rakefile",
	"gemfile",
	"procfile",
	"readme",
	"license",
	"licence",
	"notice",
	"changelog",
	"authors",
	"copying",
] as const;

/** MIME types that are text even though they do not start with `text/`. */
export const ATTACHMENT_TEXT_MIME_TYPES = [
	"application/json",
	"application/ld+json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/typescript",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/sql",
	"application/graphql",
] as const;

/** True for the image types the providers accept. */
export function isImageMimeType(mimeType: string): boolean {
	return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/** True for MIME types that name text. */
export function isTextMimeType(mimeType: string): boolean {
	const mime = mimeType.toLowerCase();
	return mime.startsWith("text/") || (ATTACHMENT_TEXT_MIME_TYPES as readonly string[]).includes(mime);
}

/** What an attachment file carries: an image, text, or something the harness cannot send. */
export function classifyAttachmentFile(name: string, mimeType: string): AttachmentKind {
	if (isImageMimeType(mimeType)) return "image";
	if (isTextMimeType(mimeType)) return "text";
	const extension = name.split(".").pop()?.toLowerCase() ?? "";
	if ((ATTACHMENT_TEXT_EXTENSIONS as readonly string[]).includes(extension)) return "text";
	const lower = name.toLowerCase();
	const stem = lower.split(".")[0] ?? "";
	if ((ATTACHMENT_TEXT_FILE_NAMES as readonly string[]).includes(lower)) return "text";
	if ((ATTACHMENT_TEXT_FILE_NAMES as readonly string[]).includes(stem)) return "text";
	return "unsupported";
}
