import { useState } from "react";
import { formatTokens } from "../lib/format.ts";
import {
	parseToolArguments,
	toolCallSummary,
	type LiveBlock,
	type LiveMessage,
	type ToolResultImage,
	type ToolResultView,
} from "../lib/messages.ts";
import {
	BrainIcon,
	ChevronDownIcon,
	FileIcon,
	FilePlusIcon,
	PencilIcon,
	TerminalIcon,
	WrenchIcon,
} from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * Open state of thinking blocks, keyed by `<assistant message timestamp>:<block index>`. The key is
 * stable across the live partial and the committed entry (both carry the request timestamp), so a
 * block expanded while the answer streamed stays open when the live bubble is replaced.
 */
const thinkingOpenState = new Map<string, boolean>();

/**
 * Open state of tool blocks, keyed by tool call id. The id is stable from the live partial to the
 * committed entry, so a block expanded while the call ran stays open afterwards.
 */
const toolOpenState = new Map<string, boolean>();

export function UserBubble({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-2">
				<Markdown text={text} variant="user" />
			</div>
		</div>
	);
}

export function AssistantBubble({
	messageKey,
	blocks,
	usage,
	toolResults,
	streaming = false,
}: {
	messageKey: string;
	blocks: LiveBlock[];
	usage?: LiveMessage["usage"];
	/** Results of this message's tool calls, keyed by tool call id. */
	toolResults?: ReadonlyMap<string, ToolResultView>;
	streaming?: boolean;
}) {
	const hasVisible = blocks.some((block) => {
		if (block.type === "text") return block.text !== "";
		if (block.type === "thinking") return block.thinking !== "";
		return true;
	});
	if (!hasVisible && !streaming) return null;
	return (
		<div className="flex flex-col gap-2">
			{blocks.map((block, index) => {
				if (block.type === "text" && block.text === "") return null;
				if (block.type === "thinking" && block.thinking === "") return null;
				return <BlockView key={index} block={block} stateKey={`${messageKey}:${index}`} toolResults={toolResults} />;
			})}
			{usage !== undefined && usage.input + usage.output > 0 && (
				<div className="text-[11px] text-fg-faint">
					{formatTokens(usage.input)} in · {formatTokens(usage.output)} out
				</div>
			)}
		</div>
	);
}

function BlockView({
	block,
	stateKey,
	toolResults,
}: {
	block: LiveBlock;
	stateKey: string;
	toolResults?: ReadonlyMap<string, ToolResultView>;
}) {
	if (block.type === "thinking") {
		return <ThinkingBlock stateKey={stateKey} thinking={block.thinking} />;
	}
	if (block.type === "toolCall") {
		return <ToolCallBlock call={block} result={toolResults?.get(block.id)} />;
	}
	return <Markdown text={block.text} />;
}

type ToolCall = Extract<LiveBlock, { type: "toolCall" }>;

/** The tool's icon; unknown tools get a wrench. */
function ToolIcon({ name, className }: { name: string; className?: string }) {
	switch (name) {
		case "bash":
			return <TerminalIcon className={className} />;
		case "read":
			return <FileIcon className={className} />;
		case "write":
			return <FilePlusIcon className={className} />;
		case "edit":
			return <PencilIcon className={className} />;
		default:
			return <WrenchIcon className={className} />;
	}
}

/** One collapsible row per tool call, holding the arguments and the result, like a thinking block. */
function ToolCallBlock({ call, result }: { call: ToolCall; result?: ToolResultView }) {
	const [open, setOpen] = useState(() => toolOpenState.get(call.id) ?? false);
	const args = parseToolArguments(call.argumentsText);
	const preview = toolCallSummary(args);
	const failed = result?.isError === true;
	return (
		<details
			data-tool-call={call.name}
			data-tool-state={failed ? "failed" : result === undefined ? "running" : "done"}
			open={open}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				toolOpenState.set(call.id, next);
				setOpen(next);
			}}
			className={`group rounded-md border bg-panel/50 px-3 py-2 text-xs ${failed ? "border-red-500/30" : "border-line"}`}
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<ToolIcon name={call.name} className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-red-500" : "text-fg-subtle"}`} />
				<span className="shrink-0 font-mono text-fg">{call.name}</span>
				{preview !== "" && <span className="min-w-0 truncate font-mono text-fg-subtle">{preview}</span>}
				{result === undefined && (
					<span className="shrink-0 text-fg-faint motion-safe:animate-pulse">running…</span>
				)}
				{failed && <span className="shrink-0 text-red-500">failed</span>}
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
			</summary>
			<div className="mt-1.5 flex flex-col gap-1.5">
				<ToolArguments name={call.name} text={call.argumentsText} args={args} />
				{result !== undefined && (result.text !== "" || result.images.length > 0) && (
					<div className="flex flex-col gap-1.5 border-t border-line pt-1.5">
						<ToolResultImages images={result.images} />
						{result.text !== "" && (
							<pre
								className={`max-h-80 overflow-auto whitespace-pre-wrap font-mono ${
									failed ? "text-red-700 dark:text-red-300" : "text-fg-muted"
								}`}
							>
								{result.text}
							</pre>
						)}
					</div>
				)}
			</div>
		</details>
	);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Tool-aware rendering of the call arguments, with pretty JSON as the fallback. */
function ToolArguments({
	name,
	text,
	args,
}: {
	name: string;
	text: string;
	args: Record<string, unknown> | undefined;
}) {
	if (args === undefined) {
		// Still streaming, or not an object: show what arrived.
		return <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-fg-muted">{text}</pre>;
	}
	const command = typeof args.command === "string" ? args.command : undefined;
	if (name === "bash" && command !== undefined) {
		return (
			<pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-fg-muted">
				<span className="text-fg-faint">$ </span>
				{command}
			</pre>
		);
	}
	const path = typeof args.path === "string" ? args.path : undefined;
	const content = typeof args.content === "string" ? args.content : undefined;
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (path === undefined && content === undefined && edits === undefined) {
		return (
			<pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-fg-muted">
				{JSON.stringify(args, null, 2)}
			</pre>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{path !== undefined && <div className="truncate font-mono text-fg-subtle">{path}</div>}
			{content !== undefined && (
				<pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-fg-muted">{content}</pre>
			)}
			{edits?.map((edit, index) => {
				const entry = record(edit);
				const oldText = typeof entry?.oldText === "string" ? entry.oldText : undefined;
				const newText = typeof entry?.newText === "string" ? entry.newText : undefined;
				return (
					<div key={index} className="overflow-hidden rounded border border-line">
						{oldText !== undefined && (
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-red-500/10 px-2 py-1 font-mono text-red-700 dark:text-red-300">
								- {oldText}
							</pre>
						)}
						{newText !== undefined && (
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-green-500/10 px-2 py-1 font-mono text-green-700 dark:text-green-300">
								+ {newText}
							</pre>
						)}
					</div>
				);
			})}
		</div>
	);
}

function ThinkingBlock({ stateKey, thinking }: { stateKey: string; thinking: string }) {
	const [open, setOpen] = useState(() => thinkingOpenState.get(stateKey) ?? false);
	return (
		<details
			open={open}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				thinkingOpenState.set(stateKey, next);
				setOpen(next);
			}}
			className="group rounded-md border border-line bg-panel/50 px-3 py-2 text-xs text-fg-muted"
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<BrainIcon className="h-3.5 w-3.5 shrink-0" />
				Thinking
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
			</summary>
			<div className="mt-1.5">
				<Markdown text={thinking} variant="thinking" size="xs" />
			</div>
		</details>
	);
}

/** Images a tool returned, shown as thumbnails that open the full image in a new tab. */
function ToolResultImages({ images }: { images: readonly ToolResultImage[] }) {
	if (images.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1.5">
			{images.map((image, index) => {
				const src = `data:${image.mimeType};base64,${image.data}`;
				return (
					<a key={index} href={src} target="_blank" rel="noreferrer" className="w-fit">
						<img src={src} alt="Tool result" className="max-h-80 max-w-full rounded border border-line" />
					</a>
				);
			})}
		</div>
	);
}

export function ToolResultBubble({
	text,
	images,
	isError,
}: {
	text: string;
	images: readonly ToolResultImage[];
	isError: boolean;
}) {
	return (
		<details
			className={`rounded-md border px-3 py-2 text-xs ${
				isError
					? "border-red-500/30 bg-red-500/10 text-red-700 dark:bg-red-950/20 dark:text-red-300"
					: "border-line bg-panel/50 text-fg-muted"
			}`}
		>
			<summary className="cursor-pointer select-none">{isError ? "Tool error" : "Tool result"}</summary>
			<div className="mt-1.5 flex flex-col gap-1.5">
				<ToolResultImages images={images} />
				{text !== "" && <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono">{text}</pre>}
			</div>
		</details>
	);
}

export function Divider({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-3 py-1 text-[11px] tracking-wide text-fg-faint uppercase">
			<div className="h-px flex-1 bg-line" />
			{label}
			<div className="h-px flex-1 bg-line" />
		</div>
	);
}
