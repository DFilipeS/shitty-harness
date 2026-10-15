import type { AssistantMessage, ImageContent, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, ModelInfo } from "@harness/protocol";

/** A content block of the assistant message currently being streamed. */
export type LiveBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; argumentsText: string };

/** The in-flight assistant message, built from `message_start`/`message_update` events. */
export type LiveMessage = {
	blocks: LiveBlock[];
	usage?: Usage;
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
			return { type: "toolCall", id: block.id, name: block.name, argumentsText: JSON.stringify(block.arguments) };
	}
}

export function fromAssistantMessage(message: AssistantMessage): LiveMessage {
	return { blocks: message.content.map(toLiveBlock), usage: message.usage };
}

function setBlock(blocks: LiveBlock[], index: number, block: LiveBlock): LiveBlock[] {
	const next = [...blocks];
	while (next.length < index) next.push({ type: "text", text: "" });
	next[index] = block;
	return next;
}

function updateBlock(blocks: LiveBlock[], index: number, change: (block: LiveBlock) => LiveBlock): LiveBlock[] {
	const existing = blocks[index];
	if (existing === undefined) return blocks;
	const next = [...blocks];
	next[index] = change(existing);
	return next;
}

/** Apply one `message_update` batch to the live message. */
export function applyMessageChanges(live: LiveMessage, usage: Usage, changes: MessageChanges): LiveMessage {
	let blocks = live.blocks;
	for (const change of changes) {
		switch (change.type) {
			case "message":
				blocks = change.message.content.map(toLiveBlock);
				break;
			case "text_start": {
				const block = change.block;
				if (block.type === "text") blocks = setBlock(blocks, change.contentIndex, { type: "text", text: block.text });
				break;
			}
			case "thinking_start": {
				const block = change.block;
				if (block.type === "thinking") blocks = setBlock(blocks, change.contentIndex, { type: "thinking", thinking: block.thinking });
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
					block.type === "toolCall" ? { ...block, argumentsText: block.argumentsText + change.delta } : block,
				);
				break;
			case "block":
				blocks = setBlock(blocks, change.contentIndex, toLiveBlock(change.block));
				break;
		}
	}
	return { blocks, usage };
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

/** One display part of a user message: text, an attached image, or an attached text file. */
export type UserPart =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "file"; name: string; mimeType: string; text: string };

/** The `<attached-file>` block the harness writes around an attached text file. */
const ATTACHED_FILE_PATTERN = /^<attached-file name="([^"]*)" mime="([^"]*)">\n([\s\S]*)\n<\/attached-file>$/;

/** The user message as display parts: plain text, images, and attached text files. */
export function userParts(message: UserMessage): UserPart[] {
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return message.content.map((part): UserPart => {
		if (part.type === "image") return { type: "image", data: part.data, mimeType: part.mimeType };
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
	if (message.content.some((block) => block.type === "text" || block.type === "toolCall")) return false;
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
};

/** Parses a tool call's arguments; undefined while they stream in or when they are not an object. */
export function parseToolArguments(text: string): Record<string, unknown> | undefined {
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
	const first = Object.values(args).find((value) => typeof value === "string");
	return typeof first === "string" ? first : "";
}


