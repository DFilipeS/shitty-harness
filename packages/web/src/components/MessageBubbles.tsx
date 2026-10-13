import { useState } from "react";
import { formatTokens, type LiveBlock, type LiveMessage } from "../lib/messages.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * Open state of thinking blocks, keyed by `<assistant message timestamp>:<block index>`. The key is
 * stable across the live partial and the committed entry (both carry the request timestamp), so a
 * block expanded while the answer streamed stays open when the live bubble is replaced.
 */
const thinkingOpenState = new Map<string, boolean>();

export function UserBubble({ text }: { text: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-zinc-100 px-3.5 py-2 text-sm text-zinc-900">
				{text}
			</div>
		</div>
	);
}

export function AssistantBubble({
	messageKey,
	blocks,
	usage,
	streaming = false,
}: {
	messageKey: string;
	blocks: LiveBlock[];
	usage?: LiveMessage["usage"];
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
				return <BlockView key={index} block={block} stateKey={`${messageKey}:${index}`} />;
			})}
			{streaming && <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-zinc-500" />}
			{usage !== undefined && usage.input + usage.output > 0 && (
				<div className="text-[11px] text-zinc-600">
					{formatTokens(usage.input)} in · {formatTokens(usage.output)} out
				</div>
			)}
		</div>
	);
}

function BlockView({ block, stateKey }: { block: LiveBlock; stateKey: string }) {
	if (block.type === "thinking") {
		return <ThinkingBlock stateKey={stateKey} thinking={block.thinking} />;
	}
	if (block.type === "toolCall") {
		return (
			<div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 font-mono text-xs text-zinc-400">
				{block.name}({block.argumentsText})
			</div>
		);
	}
	return <Markdown text={block.text} />;
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
			className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-400"
		>
			<summary className="cursor-pointer select-none">Thinking</summary>
			<div className="mt-1.5 whitespace-pre-wrap italic">{thinking}</div>
		</details>
	);
}

export function ToolResultBubble({ text, isError }: { text: string; isError: boolean }) {
	return (
		<details
			className={`rounded-md border px-3 py-2 text-xs ${
				isError ? "border-red-500/30 bg-red-950/20 text-red-300" : "border-zinc-800 bg-zinc-900/40 text-zinc-400"
			}`}
		>
			<summary className="cursor-pointer select-none">{isError ? "Tool error" : "Tool result"}</summary>
			<pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap font-mono">{text}</pre>
		</details>
	);
}

export function Divider({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-3 py-1 text-[11px] tracking-wide text-zinc-600 uppercase">
			<div className="h-px flex-1 bg-zinc-800" />
			{label}
			<div className="h-px flex-1 bg-zinc-800" />
		</div>
	);
}
