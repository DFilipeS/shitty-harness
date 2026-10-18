import { useEffect, useRef, useState } from "react";
import { formatTokens } from "../lib/format.ts";
import { toolBlockOpen, toolChoiceAfterToggle, type LiveTool } from "../lib/live-tools.ts";
import {
	parseSkillBlock,
	parseToolArguments,
	toolCallSummary,
	type LiveBlock,
	type SkillBlock,
	type LiveMessage,
	type ToolResultImage,
	type ToolResultView,
	type UserPart,
} from "../lib/messages.ts";
import {
	BookIcon,
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
 * A reader's own choice about a tool block, keyed by tool call id and kept only while it disagrees
 * with what the block shows on its own. The id is stable from the live partial to the committed
 * entry, so a choice made while the call ran survives the swap.
 */
const toolOpenChoices = new Map<string, boolean>();

export function UserBubble({ parts }: { parts: UserPart[] }) {
	return (
		<div className="flex justify-end">
			<div className="flex min-w-0 max-w-[85%] flex-col gap-2 rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-2">
				{parts.map((part, index) => {
					if (part.type === "image") {
						return (
							<PreviewableImage
								key={index}
								image={part}
								alt="Attached image"
								className="self-end"
							/>
						);
					}
					if (part.type === "file") return <AttachedFileCard key={index} file={part} />;
					if (part.type === "skill") return <SkillCard key={index} skill={part.skill} />;
					return <Markdown key={index} text={part.text} variant="user" />;
				})}
			</div>
		</div>
	);
}

/** A text file sent with a message, collapsed until opened. */
function AttachedFileCard({ file }: { file: Extract<UserPart, { type: "file" }> }) {
	return (
		<details className="group rounded-md border border-line bg-panel/50 px-3 py-2 text-xs">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<FileIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
				<span className="min-w-0 truncate font-mono text-fg">{file.name}</span>
				<span className="shrink-0 text-fg-faint">{file.mimeType}</span>
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
			</summary>
			<pre className="mt-1.5 max-h-80 overflow-auto border-t border-line pt-1.5 whitespace-pre-wrap font-mono text-fg-muted">
				{file.text}
			</pre>
		</details>
	);
}

/**
 * A skill's instructions, collapsed until opened: the same card whether the user invoked the skill
 * or the model activated it with the `skill` tool.
 */
function SkillCard({ skill }: { skill: SkillBlock }) {
	return (
		<details data-skill-card={skill.name} className="group rounded-md border border-line bg-panel/50 px-3 py-2 text-xs">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<BookIcon className="h-3.5 w-3.5 shrink-0 text-link" />
				<span className="shrink-0 text-fg-subtle">skill</span>
				<span className="min-w-0 truncate font-mono text-fg">{skill.name}</span>
				<span className="shrink-0 text-fg-faint">{skill.scope}</span>
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
			</summary>
			<div className="mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto border-t border-line pt-1.5">
				<Markdown text={skill.instructions} />
				{skill.directory !== undefined && (
					<div className="truncate font-mono text-[11px] text-fg-faint" title={skill.directory}>
						{skill.directory}
					</div>
				)}
				{skill.files.length > 0 && (
					<ul className="font-mono text-[11px] text-fg-subtle">
						{skill.files.map((file) => (
							<li key={file} className="truncate">
								{file}
							</li>
						))}
					</ul>
				)}
			</div>
		</details>
	);
}

export function AssistantBubble({
	messageKey,
	blocks,
	usage,
	toolResults,
	liveTools,
	streaming = false,
	error,
}: {
	messageKey: string;
	blocks: LiveBlock[];
	usage?: LiveMessage["usage"];
	/** Results of this message's tool calls, keyed by tool call id. */
	toolResults?: ReadonlyMap<string, ToolResultView>;
	/** Output of this message's running tool calls, keyed by tool call id. */
	liveTools?: Readonly<Record<string, LiveTool>>;
	streaming?: boolean;
	/** What the model request failed with, when it did. */
	error?: string;
}) {
	const hasVisible = blocks.some((block) => {
		if (block.type === "text") return block.text !== "";
		if (block.type === "thinking") return block.thinking !== "";
		return true;
	});
	if (!hasVisible && !streaming && error === undefined) return null;
	return (
		<div className="flex flex-col gap-2">
			{blocks.map((block, index) => {
				if (block.type === "text" && block.text === "") return null;
				if (block.type === "thinking" && block.thinking === "") return null;
				return (
					<BlockView
						key={index}
						block={block}
						stateKey={`${messageKey}:${index}`}
						toolResults={toolResults}
						{...(liveTools === undefined ? {} : { liveTools })}
					/>
				);
			})}
			{error !== undefined && (
				<div
					data-model-error
					className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300"
				>
					<div className="font-medium">The model request failed.</div>
					{error !== "" && (
						<pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono">{error}</pre>
					)}
				</div>
			)}
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
	liveTools,
}: {
	block: LiveBlock;
	stateKey: string;
	toolResults?: ReadonlyMap<string, ToolResultView>;
	liveTools?: Readonly<Record<string, LiveTool>>;
}) {
	if (block.type === "thinking") {
		return <ThinkingBlock stateKey={stateKey} thinking={block.thinking} />;
	}
	if (block.type === "toolCall") {
		const result = toolResults?.get(block.id);
		// A loaded skill reads as the skill itself; running, failed, and "already active" calls stay tool rows.
		const skill = block.name === "skill" && result?.isError === false ? parseSkillBlock(result.text) : undefined;
		if (skill !== undefined) return <SkillCard skill={skill} />;
		return <ToolCallBlock call={block} result={result} live={liveTools?.[block.id]} />;
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
		case "skill":
			return <BookIcon className={className} />;
		default:
			return <WrenchIcon className={className} />;
	}
}

/** One collapsible row per tool call, holding the arguments, live output, and the result. */
function ToolCallBlock({ call, result, live }: { call: ToolCall; result?: ToolResultView; live?: LiveTool }) {
	const [choice, setChoice] = useState<boolean | undefined>(() => toolOpenChoices.get(call.id));
	const running = result === undefined;
	// A running call opens so its output is readable as it streams, then collapses when the committed
	// result lands; a reader who toggled the block themselves keeps their choice.
	const open = toolBlockOpen(choice, running);
	const args = parseToolArguments(call.argumentsText);
	const preview = toolCallSummary(args);
	const failed = result?.isError === true;
	// The committed result is the tool's own text; while running, show the retained live window.
	const output = result?.text ?? live?.output ?? "";
	const contentRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	// Follow the newest output while it streams, unless the reader scrolled up.
	useEffect(() => {
		const element = contentRef.current;
		if (element === null || !running) return;
		if (stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, [output, running]);

	return (
		<>
			<details
				data-tool-call={call.name}
				data-tool-state={failed ? "failed" : running ? "running" : "done"}
				open={open}
				onToggle={(event) => {
					// A toggle that only restates the call's own state leaves no choice behind, so the block
					// still collapses when the call finishes.
					const next = toolChoiceAfterToggle(event.currentTarget.open, running);
					setChoice(next);
					if (next === undefined) toolOpenChoices.delete(call.id);
					else toolOpenChoices.set(call.id, next);
				}}
				className={`group rounded-md border bg-panel/50 px-3 py-2 text-xs ${failed ? "border-red-500/30" : "border-line"}`}
			>
				<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
					<ToolIcon name={call.name} className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-red-500" : "text-fg-subtle"}`} />
					<span className="shrink-0 font-mono text-fg">{call.name}</span>
					{preview !== "" && <span className="min-w-0 truncate font-mono text-fg-subtle">{preview}</span>}
					{running && (
						<span className="shrink-0 text-fg-faint motion-safe:animate-pulse">running…</span>
					)}
					{failed && <span className="shrink-0 text-red-500">failed</span>}
					<span className="ml-auto flex shrink-0 items-center gap-1.5">
						{result?.imageModel !== undefined && (
							<span
								className="hidden max-w-40 truncate text-fg-faint sm:inline-block"
								title={`${result.imageModel.providerName} · ${result.imageModel.modelName} (${result.imageModel.modelId})`}
							>
								{result.imageModel.modelName}
							</span>
						)}
						<ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
					</span>
				</summary>
				<div
					ref={contentRef}
					onScroll={(event) => {
						const element = event.currentTarget;
						stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
					}}
					className="mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto"
				>
					<ToolArguments name={call.name} text={call.argumentsText} args={args} />
					{result?.imageModel !== undefined && (
						<div className="text-fg-faint">
							Model: {result.imageModel.providerName} · {result.imageModel.modelName} (
							{result.imageModel.modelId})
						</div>
					)}
					{output !== "" && (
						<pre
							className={`border-t border-line pt-1.5 whitespace-pre-wrap font-mono ${
								failed ? "text-red-700 dark:text-red-300" : "text-fg-muted"
							}`}
						>
							{output}
						</pre>
					)}
				</div>
			</details>
			{/* Images are the point of the call, so they stay visible below the collapsed row. */}
			{result !== undefined && <ToolResultImages images={result.images} />}
		</>
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
		return <pre className="whitespace-pre-wrap font-mono text-fg-muted">{text}</pre>;
	}
	const command = typeof args.command === "string" ? args.command : undefined;
	if (name === "bash" && command !== undefined) {
		return (
			<pre className="whitespace-pre-wrap font-mono text-fg-muted">
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
			<pre className="whitespace-pre-wrap font-mono text-fg-muted">{JSON.stringify(args, null, 2)}</pre>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			{path !== undefined && <div className="truncate font-mono text-fg-subtle">{path}</div>}
			{content !== undefined && (
				<pre className="whitespace-pre-wrap font-mono text-fg-muted">{content}</pre>
			)}
			{edits?.map((edit, index) => {
				const entry = record(edit);
				const oldText = typeof entry?.oldText === "string" ? entry.oldText : undefined;
				const newText = typeof entry?.newText === "string" ? entry.newText : undefined;
				return (
					<div key={index} className="overflow-hidden rounded border border-line">
						{oldText !== undefined && (
							<pre className="whitespace-pre-wrap bg-red-500/10 px-2 py-1 font-mono text-red-700 dark:text-red-300">
								- {oldText}
							</pre>
						)}
						{newText !== undefined && (
							<pre className="whitespace-pre-wrap bg-green-500/10 px-2 py-1 font-mono text-green-700 dark:text-green-300">
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

function imageDataUrl(image: ToolResultImage): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * An image that opens full size when clicked. A data URL cannot be opened in a new tab (Chrome
 * blocks top-level navigation to `data:`), and an in-app preview keeps the image viewable on a
 * phone too.
 */
function PreviewableImage({
	image,
	alt,
	className,
}: {
	image: ToolResultImage;
	alt: string;
	className?: string;
}) {
	const [preview, setPreview] = useState(false);

	useEffect(() => {
		if (!preview) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPreview(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [preview]);

	return (
		<>
			<button
				type="button"
				onClick={() => setPreview(true)}
				aria-label="View image full size"
				className={`w-fit cursor-zoom-in ${className ?? ""}`}
			>
				<img
					src={imageDataUrl(image)}
					alt={alt}
					className="max-h-[28rem] max-w-full rounded-lg border border-line"
				/>
			</button>
			{preview && (
				<div
					data-image-preview
					role="dialog"
					aria-modal="true"
					aria-label="Image preview"
					onClick={() => setPreview(false)}
					className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-4"
				>
					<img
						src={imageDataUrl(image)}
						alt={alt}
						onClick={(event) => event.stopPropagation()}
						className="max-h-full max-w-full rounded-lg"
					/>
				</div>
			)}
		</>
	);
}

/** Images a tool returned, shown inline. */
function ToolResultImages({ images }: { images: readonly ToolResultImage[] }) {
	if (images.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-2">
			{images.map((image, index) => (
				<PreviewableImage key={index} image={image} alt="Tool result" />
			))}
		</div>
	);
}

/**
 * Explains a reply that billed output the transcript could not store: an image-generation model
 * answered with an image of its own, which a chat message cannot carry.
 */
export function HiddenOutputNotice() {
	return (
		<div data-hidden-output className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
			Nothing to show for this reply: the model produced an image of its own, which a chat message
			cannot store. Ask it to use the <span className="font-mono">generate_image</span> tool, or
			switch to a text model.
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
		<>
			<details
				className={`rounded-md border px-3 py-2 text-xs ${
					isError
						? "border-red-500/30 bg-red-500/10 text-red-700 dark:bg-red-950/20 dark:text-red-300"
						: "border-line bg-panel/50 text-fg-muted"
				}`}
			>
				<summary className="cursor-pointer select-none">{isError ? "Tool error" : "Tool result"}</summary>
				{text !== "" && <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap font-mono">{text}</pre>}
			</details>
			<ToolResultImages images={images} />
		</>
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
