import type {
	AssistantMessage,
	ImageContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, ModelInfo, QuestionReply } from "@harness/protocol";

/** A content block of the assistant message currently being streamed. */
export type LiveBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; argumentsText: string };

/** The in-flight assistant message, built from `message_start`/`message_update` events. */
export type LiveMessage = {
	blocks: LiveBlock[];
	usage?: Usage;
	/** Set when the model request failed; such a message carries no useful content. */
	error?: string;
};

type MessageChanges = Extract<AgentEvent, { type: "message_update" }>["changes"];
type AssistantBlock = AssistantMessage["content"][number];

export function toLiveBlock(block: AssistantBlock): LiveBlock {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return { type: "thinking", thinking: block.thinking };
		case "toolCall":
			return {
				type: "toolCall",
				id: block.id,
				name: block.name,
				argumentsText: JSON.stringify(block.arguments),
			};
	}
}

export function fromAssistantMessage(message: AssistantMessage): LiveMessage {
	const error = assistantError(message);
	return {
		blocks: message.content.map(toLiveBlock),
		usage: message.usage,
		...(error === undefined ? {} : { error }),
	};
}

/** The failure a committed assistant message carries, when the model request failed. */
export function assistantError(message: AssistantMessage): string | undefined {
	if (message.stopReason !== "error") return undefined;
	return message.errorMessage ?? "The model request failed.";
}

function setBlock(blocks: LiveBlock[], index: number, block: LiveBlock): LiveBlock[] {
	const next = [...blocks];
	while (next.length < index) next.push({ type: "text", text: "" });
	next[index] = block;
	return next;
}

function updateBlock(
	blocks: LiveBlock[],
	index: number,
	change: (block: LiveBlock) => LiveBlock,
): LiveBlock[] {
	const existing = blocks[index];
	if (existing === undefined) return blocks;
	const next = [...blocks];
	next[index] = change(existing);
	return next;
}

/** Apply one `message_update` batch to the live message. */
export function applyMessageChanges(
	live: LiveMessage,
	usage: Usage,
	changes: MessageChanges,
): LiveMessage {
	let blocks = live.blocks;
	let error = live.error;
	for (const change of changes) {
		switch (change.type) {
			case "message":
				blocks = change.message.content.map(toLiveBlock);
				error = assistantError(change.message);
				break;
			case "text_start": {
				const block = change.block;
				if (block.type === "text")
					blocks = setBlock(blocks, change.contentIndex, { type: "text", text: block.text });
				break;
			}
			case "thinking_start": {
				const block = change.block;
				if (block.type === "thinking")
					blocks = setBlock(blocks, change.contentIndex, {
						type: "thinking",
						thinking: block.thinking,
					});
				break;
			}
			case "toolcall_start": {
				const block = change.block;
				if (block.type === "toolCall") {
					blocks = setBlock(blocks, change.contentIndex, {
						type: "toolCall",
						id: block.id,
						name: block.name,
						argumentsText: JSON.stringify(block.arguments),
					});
				}
				break;
			}
			case "text_delta":
				blocks = updateBlock(blocks, change.contentIndex, (block) =>
					block.type === "text" ? { ...block, text: block.text + change.delta } : block,
				);
				break;
			case "thinking_delta":
				blocks = updateBlock(blocks, change.contentIndex, (block) =>
					block.type === "thinking" ? { ...block, thinking: block.thinking + change.delta } : block,
				);
				break;
			case "toolcall_delta":
				blocks = updateBlock(blocks, change.contentIndex, (block) =>
					block.type === "toolCall"
						? { ...block, argumentsText: block.argumentsText + change.delta }
						: block,
				);
				break;
			case "block":
				blocks = setBlock(blocks, change.contentIndex, toLiveBlock(change.block));
				break;
		}
	}
	return { blocks, usage, ...(error === undefined ? {} : { error }) };
}

/**
 * The content block a live message is still writing, or `undefined` once the message is complete.
 * Blocks arrive in order, so the last one is the block in flight; the client marks it busy.
 */
export function activeBlockIndex(
	blocks: readonly LiveBlock[],
	finished: boolean | undefined,
): number | undefined {
	return finished === true || blocks.length === 0 ? undefined : blocks.length - 1;
}

export function userMessageOf(entry: EntryRecord): UserMessage | undefined {
	if (entry.kind !== "pi.user") return undefined;
	const message = entry.model?.[0];
	return message?.role === "user" ? message : undefined;
}

export function assistantMessageOf(entry: EntryRecord): AssistantMessage | undefined {
	if (entry.kind !== "pi.assistant") return undefined;
	const message = entry.model?.[0];
	return message?.role === "assistant" ? message : undefined;
}

export function toolResultOf(entry: EntryRecord): ToolResultMessage | undefined {
	if (entry.kind !== "pi.tool-result") return undefined;
	const message = entry.model?.[0];
	return message?.role === "toolResult" ? message : undefined;
}

/** One display part of a user message: text, an attached image, an attached text file, or a skill. */
export type UserPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "file"; name: string; mimeType: string; text: string }
	| { type: "skill"; skill: SkillBlock };

/** A skill's content as the harness hands it to the model, by invocation or by the `skill` tool. */
export type SkillBlock = {
	name: string;
	scope: string;
	instructions: string;
	directory?: string;
	files: string[];
};

/** The `<skill>` block the harness writes around an activated skill. */
const SKILL_BLOCK_PATTERN = /^<skill name="([^"]*)" scope="([^"]*)">\n([\s\S]*)\n<\/skill>$/;
const SKILL_DIRECTORY_MARKER = "\n\nSkill directory: ";

/** Parses a skill block; undefined for any other text. */
export function parseSkillBlock(text: string): SkillBlock | undefined {
	const match = SKILL_BLOCK_PATTERN.exec(text);
	if (match === null) return undefined;
	const [, name, scope, content] = match;
	if (name === undefined || scope === undefined || content === undefined) return undefined;
	const split = content.lastIndexOf(SKILL_DIRECTORY_MARKER);
	const instructions = split === -1 ? content : content.slice(0, split);
	const footer = split === -1 ? "" : content.slice(split + SKILL_DIRECTORY_MARKER.length);
	const directory = footer.split("\n", 1)[0];
	const files = [...footer.matchAll(/^<file>(.*)<\/file>$/gm)].map((file) =>
		unescapeText(file[1] ?? ""),
	);
	return {
		name: unescapeAttribute(name),
		scope,
		instructions: instructions.trim(),
		...(directory === undefined || directory === "" ? {} : { directory }),
		files,
	};
}

function unescapeText(value: string): string {
	return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The `<attached-file>` block the harness writes around an attached text file. */
const ATTACHED_FILE_PATTERN =
	/^<attached-file name="([^"]*)" mime="([^"]*)">\n([\s\S]*)\n<\/attached-file>$/;

/** The user message as display parts: plain text, images, and attached text files. */
export function userParts(message: UserMessage): UserPart[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part): UserPart => {
		if (part.type === "image") return { type: "image", data: part.data, mimeType: part.mimeType };
		const skill = parseSkillBlock(part.text);
		if (skill !== undefined) return { type: "skill", skill };
		return parseAttachedFile(part.text) ?? { type: "text", text: part.text };
	});
}

function parseAttachedFile(text: string): UserPart | undefined {
	const match = ATTACHED_FILE_PATTERN.exec(text);
	if (match === null) return undefined;
	const [, name, mimeType, content] = match;
	if (name === undefined || mimeType === undefined || content === undefined) return undefined;
	return {
		type: "file",
		name: unescapeAttribute(name),
		mimeType: unescapeAttribute(mimeType),
		text: content,
	};
}

/** Reverse of the escaping `buildPromptContent` applies to file names and MIME types. */
function unescapeAttribute(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&amp;", "&");
}

export function toolResultText(message: ToolResultMessage): string {
	return message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter((text) => text !== "")
		.join("\n");
}

/**
 * True when a reply looks like it produced something the transcript cannot hold: a chat model that
 * generates images inline leaves only thinking behind, because an assistant message has no image
 * content. Only models with an image sibling can answer that way, and the billed output tokens that
 * no reasoning or text accounts for are the tell.
 */
export function hasHiddenOutput(message: AssistantMessage, models: readonly ModelInfo[]): boolean {
	if (message.content.some((block) => block.type === "text" || block.type === "toolCall"))
		return false;
	const model = models.find(
		(candidate) => candidate.provider === message.provider && candidate.id === message.model,
	);
	if (model?.imageGeneration !== true) return false;
	return message.usage.output - (message.usage.reasoning ?? 0) > 200;
}

/** Images the tool returned, in order. */
export function toolResultImages(message: ToolResultMessage): ToolResultImage[] {
	return message.content
		.filter((part): part is ImageContent => part.type === "image")
		.map((part) => ({ data: part.data, mimeType: part.mimeType }));
}

/** An image a tool returned: base64 data and its MIME type. */
export type ToolResultImage = {
	data: string;
	mimeType: string;
};

/** A tool result paired with the call it belongs to. */
export type ToolResultView = {
	text: string;
	images: readonly ToolResultImage[];
	isError: boolean;
	/** For `generate_image`: the provider and model that produced the image. */
	imageModel?: GeneratedImageInfo;
	/** For `ask_user`: how the user replied. */
	questionReply?: QuestionReply;
	/** For `codemode`: the tool calls the script made, from the result's details. */
	nestedCalls?: readonly NestedCallView[];
};

/** One call inside a settled codemode result, as its details list it. */
export type NestedCallView = {
	name: string;
	/** Compact JSON of the arguments, already cut for display. */
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	/** Error text, cut for display; set when the call failed. */
	error?: string;
};

/** The provider and model a generated image came from. */
export type GeneratedImageInfo = {
	provider: string;
	providerName: string;
	modelId: string;
	modelName: string;
};

/** Reads the model reference a `generate_image` result carries; undefined for other tools. */
export function generatedImageInfo(message: ToolResultMessage): GeneratedImageInfo | undefined {
	if (message.toolName !== "generate_image") return undefined;
	const details = message.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const record = details as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.modelId !== "string") return undefined;
	return {
		provider: record.provider,
		providerName: typeof record.providerName === "string" ? record.providerName : record.provider,
		modelId: record.modelId,
		modelName: typeof record.modelName === "string" ? record.modelName : record.modelId,
	};
}

/** Reads the tool calls a `codemode` result's details list; undefined for other results. */
export function codemodeCalls(message: ToolResultMessage): NestedCallView[] | undefined {
	if (message.toolName !== "codemode") return undefined;
	const details = message.details;
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
	const calls = (details as Record<string, unknown>).calls;
	if (!Array.isArray(calls)) return undefined;
	const views: NestedCallView[] = [];
	for (const call of calls) {
		const entry =
			typeof call === "object" && call !== null && !Array.isArray(call)
				? (call as Record<string, unknown>)
				: undefined;
		if (typeof entry?.name !== "string" || typeof entry.args !== "string") continue;
		if (
			entry.status !== "running" &&
			entry.status !== "ok" &&
			entry.status !== "error" &&
			entry.status !== "cancelled"
		)
			continue;
		views.push({
			name: entry.name,
			args: entry.args,
			status: entry.status,
			...(typeof entry.error === "string" ? { error: entry.error } : {}),
		});
	}
	return views;
}

/**
 * Parse results keyed by the raw arguments text. Every render of every tool block parses anew
 * without this, and a session re-attach re-renders them all: the cache makes the repeat free.
 */
const parsedArguments = new Map<string, Record<string, unknown> | undefined>();
const PARSED_ARGUMENTS_LIMIT = 500;

/** Parses a tool call's arguments; undefined while they stream in or when they are not an object. */
export function parseToolArguments(text: string): Record<string, unknown> | undefined {
	if (parsedArguments.has(text)) {
		const hit = parsedArguments.get(text);
		parsedArguments.delete(text);
		parsedArguments.set(text, hit); // Refresh LRU recency.
		return hit;
	}
	const parsed = parseArguments(text);
	parsedArguments.set(text, parsed);
	if (parsedArguments.size > PARSED_ARGUMENTS_LIMIT) {
		const oldest = parsedArguments.keys().next().value;
		if (oldest !== undefined) parsedArguments.delete(oldest);
	}
	return parsed;
}

function parseArguments(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** A short one-liner for a collapsed tool call: its command, or the file it touches. */
export function toolCallSummary(args: Record<string, unknown> | undefined): string {
	if (args === undefined) return "";
	if (typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	if (typeof args.code === "string") return codeSummary(args.code);
	const first = Object.values(args).find((value) => typeof value === "string");
	return typeof first === "string" ? first : "";
}

/** The first line of a script worth reading as its summary, cut for the collapsed row. */
function codeSummary(code: string): string {
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("// @options:")) continue;
		return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
	}
	return "";
}
