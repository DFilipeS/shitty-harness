import { useEffect, useRef, useState } from "react";
import { formatTokens } from "../lib/format.ts";
import {
	toolBlockOpen,
	toolChoiceAfterToggle,
	type LiveTool,
	type NestedToolView,
} from "../lib/live-tools.ts";
import { answerText, ASK_USER_TOOL, parseQuestions } from "../lib/questions.ts";
import {
	parseSkillBlock,
	parseToolArguments,
	toolCallSummary,
	type LiveBlock,
	type NestedCallView,
	type SkillBlock,
	type LiveMessage,
	type ToolResultImage,
	type ToolResultView,
	type UserPart,
} from "../lib/messages.ts";
import type { Question, QueuedMessageInfo } from "@harness/protocol";
import {
	BookIcon,
	BrainIcon,
	CheckIcon,
	ChevronDownIcon,
	ClockIcon,
	FileIcon,
	FilePlusIcon,
	ImageIcon,
	PencilIcon,
	QuestionIcon,
	SpinnerIcon,
	TerminalIcon,
	WrenchIcon,
	XIcon,
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

/**
 * A message waiting in the queue, drawn where it will land once the run places it: the user's own
 * text and attachments behind a queued badge, with a way to take it back out.
 */
export function QueuedMessage({
	message,
	onRemove,
}: {
	message: QueuedMessageInfo;
	onRemove: () => void;
}) {
	return (
		<div className="flex justify-end" data-queued-message={message.id}>
			<div className="flex min-w-0 max-w-[85%] flex-col gap-1.5 rounded-2xl rounded-br-sm border border-dashed border-line-strong bg-user-bubble/60 px-3.5 py-2">
				<div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
					<ClockIcon className="h-3.5 w-3.5 shrink-0" />
					<span>
						{message.mode === "steer" ? "Queued · joins at the next step" : "Queued · runs next"}
					</span>
				</div>
				{message.skill !== undefined && (
					<div className="flex items-center gap-1.5 rounded-md border border-line bg-panel/50 px-2 py-1 text-xs">
						<BookIcon className="h-3.5 w-3.5 shrink-0 text-link" />
						<span className="shrink-0 text-fg-subtle">skill</span>
						<span className="min-w-0 truncate font-mono text-fg">{message.skill}</span>
					</div>
				)}
				{message.text !== "" && (
					<p className="text-sm whitespace-pre-wrap text-fg-muted">{message.text}</p>
				)}
				{(message.attachments.length > 0 || message.images > 0) && (
					<div className="flex flex-wrap gap-1.5">
						{message.attachments.map((name) => (
							<span
								key={name}
								className="flex items-center gap-1 rounded-md border border-line bg-panel/50 px-1.5 py-0.5 text-[11px] text-fg-muted"
							>
								<FileIcon className="h-3 w-3 shrink-0" />
								<span className="max-w-40 truncate">{name}</span>
							</span>
						))}
						{message.images > 0 && (
							<span className="flex items-center gap-1 rounded-md border border-line bg-panel/50 px-1.5 py-0.5 text-[11px] text-fg-muted">
								<ImageIcon className="h-3 w-3 shrink-0" />
								{message.images === 1 ? "1 image" : `${message.images} images`}
							</span>
						)}
					</div>
				)}
				<button
					type="button"
					onClick={onRemove}
					className="flex items-center gap-1 self-start rounded-md px-1 text-[11px] text-fg-faint hover:bg-raised hover:text-fg"
				>
					<XIcon className="h-3 w-3" />
					Remove
				</button>
			</div>
		</div>
	);
}

/** A text file sent with a message, collapsed until opened. */
function AttachedFileCard({ file }: { file: Extract<UserPart, { type: "file" }> }) {
	const [open, setOpen] = useState(false);
	return (
		<details
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			className="group rounded-md border border-line bg-panel/50 px-3 py-2 text-xs"
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<FileIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
				<span className="min-w-0 truncate font-mono text-fg">{file.name}</span>
				<span className="shrink-0 text-fg-faint">{file.mimeType}</span>
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
			</summary>
			{open && (
				<pre className="mt-1.5 max-h-80 overflow-auto border-t border-line pt-1.5 whitespace-pre-wrap font-mono text-fg-muted">
					{file.text}
				</pre>
			)}
		</details>
	);
}

/**
 * A skill's instructions, collapsed until opened: the same card whether the user invoked the skill
 * or the model activated it with the `skill` tool.
 */
function SkillCard({ skill }: { skill: SkillBlock }) {
	const [open, setOpen] = useState(false);
	return (
		<details
			data-skill-card={skill.name}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			className="group rounded-md border border-line bg-panel/50 px-3 py-2 text-xs"
		>
			<summary className="flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
				<BookIcon className="h-3.5 w-3.5 shrink-0 text-link" />
				<span className="shrink-0 text-fg-subtle">skill</span>
				<span className="min-w-0 truncate font-mono text-fg">{skill.name}</span>
				<span className="shrink-0 text-fg-faint">{skill.scope}</span>
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
			</summary>
			{open && (
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
			)}
		</details>
	);
}

export function AssistantBubble({
	messageKey,
	blocks,
	usage,
	toolResults,
	liveTools,
	nestedTools,
	activeIndex,
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
	/** Nested calls of this message's tool calls, keyed by parent tool call id. */
	nestedTools?: Readonly<Record<string, readonly NestedToolView[]>>;
	/** Index of the block a live message is still writing, so it can show as busy. */
	activeIndex?: number;
	streaming?: boolean;
	/** What the model request failed with, when it did. */
	error?: string;
}) {
	const hasVisible = blocks.some((block, index) => blockIsVisible(block, index === activeIndex));
	if (!hasVisible && !streaming && error === undefined) return null;
	return (
		<div className="flex flex-col gap-2">
			{blocks.map((block, index) => {
				const active = index === activeIndex;
				if (!blockIsVisible(block, active)) return null;
				return (
					<BlockView
						key={index}
						block={block}
						active={active}
						stateKey={`${messageKey}:${index}`}
						toolResults={toolResults}
						{...(liveTools === undefined ? {} : { liveTools })}
						{...(nestedTools === undefined ? {} : { nestedTools })}
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

/**
 * Whether a block has anything to show. Text and thinking appear once they have content, except for
 * the block still being written: a thinking block shows as soon as it starts, even before its first
 * characters are revealed.
 */
function blockIsVisible(block: LiveBlock, active: boolean): boolean {
	if (block.type === "text") return block.text !== "";
	if (block.type === "thinking") return block.thinking !== "" || active;
	return true;
}

function BlockView({
	block,
	active,
	stateKey,
	toolResults,
	liveTools,
	nestedTools,
}: {
	block: LiveBlock;
	active: boolean;
	stateKey: string;
	toolResults?: ReadonlyMap<string, ToolResultView>;
	liveTools?: Readonly<Record<string, LiveTool>>;
	nestedTools?: Readonly<Record<string, readonly NestedToolView[]>>;
}) {
	if (block.type === "thinking") {
		return <ThinkingBlock stateKey={stateKey} thinking={block.thinking} active={active} />;
	}
	if (block.type === "toolCall") {
		const result = toolResults?.get(block.id);
		// A loaded skill reads as the skill itself; running, failed, and "already active" calls stay tool rows.
		const skill =
			block.name === "skill" && result?.isError === false
				? parseSkillBlock(result.text)
				: undefined;
		if (skill !== undefined) return <SkillCard skill={skill} />;
		if (block.name === ASK_USER_TOOL) {
			const questions = parseQuestions(parseToolArguments(block.argumentsText));
			if (questions !== undefined)
				return <QuestionBlock call={block} questions={questions} result={result} />;
		}
		return (
			<ToolCallBlock
				call={block}
				result={result}
				live={liveTools?.[block.id]}
				nested={nestedTools?.[block.id]}
			/>
		);
	}
	return <Markdown text={block.text} />;
}

type ToolCall = Extract<LiveBlock, { type: "toolCall" }>;

/** A nested call a script made, as the settled result lists it or the live view carries it. */
type NestedCallLine = {
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	error?: string;
};

/** The tool calls a code mode script made: one plain line each, with its status. */
function NestedCallLines({ calls }: { calls: readonly NestedCallLine[] }) {
	if (calls.length === 0) return null;
	return (
		<ul className="flex flex-col gap-1 border-t border-line pt-1.5">
			{calls.map((call) => (
				<li
					key={`${call.name}:${call.args}`}
					data-nested-call={call.status}
					className="flex gap-1.5"
				>
					<span className="mt-px w-3.5 shrink-0">
						{call.status === "running" ? (
							<SpinnerIcon className="h-3.5 w-3.5 text-fg-subtle" />
						) : call.status === "ok" ? (
							<CheckIcon className="h-3.5 w-3.5 text-ok" />
						) : (
							<XIcon
								className={`h-3.5 w-3.5 ${call.status === "error" ? "text-red-500" : "text-fg-faint"}`}
							/>
						)}
					</span>
					<span className="shrink-0 font-mono text-fg-subtle">{call.name}</span>
					<span className="min-w-0 truncate font-mono text-fg-faint" title={call.args}>
						{call.args}
					</span>
					{call.error !== undefined && (
						<span className="min-w-0 truncate font-mono text-red-500" title={call.error}>
							{call.error}
						</span>
					)}
				</li>
			))}
		</ul>
	);
}

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

/** One collapsible row per tool call. The icon slot shows a spinner while the call executes. */
function ToolCallBlock({
	call,
	result,
	live,
	nested,
}: {
	call: ToolCall;
	result?: ToolResultView;
	live?: LiveTool;
	nested?: readonly NestedToolView[];
}) {
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
					{/* The icon slot carries the state: a spinner replaces the tool's icon while it executes, so
					    every tool reads the same way at a glance. */}
					{running ? (
						<SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
					) : (
						<ToolIcon
							name={call.name}
							className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-red-500" : "text-fg-subtle"}`}
						/>
					)}
					<span className="shrink-0 font-mono text-fg">{call.name}</span>
					{preview !== "" && (
						<span className="min-w-0 truncate font-mono text-fg-subtle">{preview}</span>
					)}
					{running && <span className="shrink-0 text-fg-faint">running…</span>}
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
				{/* The body mounts only while open: a long transcript keeps hundreds of collapsed rows,
				    and their outputs need no DOM until someone reads them. */}
				{open && (
					<div
						ref={contentRef}
						onScroll={(event) => {
							const element = event.currentTarget;
							stickToBottom.current =
								element.scrollHeight - element.scrollTop - element.clientHeight < 24;
						}}
						className="mt-1.5 flex max-h-80 flex-col gap-1.5 overflow-y-auto"
					>
						<ToolArguments name={call.name} text={call.argumentsText} args={args} />
						{/* A code mode script's calls read as plain lines: live while the script runs, then from
					    the committed result, so they stay attached to the block that made them. */}
						{result !== undefined && result.nestedCalls !== undefined && (
							<NestedCallLines calls={result.nestedCalls} />
						)}
						{running && nested !== undefined && nested.length > 0 && (
							<NestedCallLines calls={nested} />
						)}
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
				)}
			</details>
			{/* Images are the point of the call, so they stay visible below the collapsed row. */}
			{result !== undefined && <ToolResultImages images={result.images} />}
		</>
	);
}

/**
 * An `ask_user` call. While it waits, the row points at the form docked below; once answered it reads
 * as one line per question, and opens to show every option with the chosen ones checked.
 */
function QuestionBlock({
	call,
	questions,
	result,
}: {
	call: ToolCall;
	questions: Question[];
	result?: ToolResultView;
}) {
	const [open, setOpen] = useState(() => toolOpenChoices.get(call.id) ?? false);
	const reply = result?.questionReply;
	const waiting = result === undefined;
	const cancelled = result?.isError === true && result.text.includes("was aborted");
	const failed = result?.isError === true && !cancelled;
	const state = waiting
		? "waiting"
		: cancelled
			? "cancelled"
			: failed
				? "failed"
				: reply?.kind === "skipped"
					? "skipped"
					: "answered";
	const status =
		state === "waiting" ? "waiting for your answer…" : state === "answered" ? undefined : state;
	const headers = questions.map((question, index) => question.header || `Question ${index + 1}`);

	return (
		<details
			data-tool-call={call.name}
			data-tool-state={state}
			open={open}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				setOpen(next);
				if (next) toolOpenChoices.set(call.id, true);
				else toolOpenChoices.delete(call.id);
			}}
			className={`group rounded-md border bg-panel/50 px-3 py-2 text-xs ${failed ? "border-red-500/30" : "border-line"}`}
		>
			<summary className="flex cursor-pointer list-none flex-col gap-1 select-none [&::-webkit-details-marker]:hidden">
				<span className="flex items-center gap-1.5">
					<QuestionIcon
						className={`h-3.5 w-3.5 shrink-0 ${failed ? "text-red-500" : waiting ? "text-link" : "text-fg-subtle"}`}
					/>
					<span className="shrink-0 font-mono text-fg">{call.name}</span>
					<span className="min-w-0 truncate text-fg-subtle">{headers.join(" · ")}</span>
					{status !== undefined && (
						<span
							className={`shrink-0 ${failed ? "text-red-500" : waiting ? "text-link" : "text-fg-faint"}`}
						>
							{status}
						</span>
					)}
					<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
				</span>
				{reply?.kind === "answered" && (
					<span className="flex flex-col gap-0.5 pl-5 group-open:hidden">
						{questions.map((_, index) => (
							<span key={index} className="flex min-w-0 gap-1.5">
								<span className="shrink-0 text-fg-faint">{headers[index]}</span>
								<span className="shrink-0 text-fg-faint">→</span>
								<span
									className={`min-w-0 truncate ${reply.answers[index]?.skipped === true ? "text-fg-faint" : "text-fg"}`}
								>
									{answerText(reply.answers[index])}
								</span>
							</span>
						))}
					</span>
				)}
			</summary>
			{open && (
				<div className="mt-1.5 flex max-h-80 flex-col gap-3 overflow-y-auto border-t border-line pt-1.5">
					{questions.map((question, index) => {
						const answer = reply?.kind === "answered" ? reply.answers[index] : undefined;
						return (
							<div key={index} className="flex flex-col gap-1">
								<div className="text-fg">
									<span className="text-fg-faint">{headers[index]}</span> {question.question}
									{question.multiSelect === true && (
										<span className="text-fg-faint"> (pick any)</span>
									)}
								</div>
								<ul className="flex flex-col gap-0.5">
									{question.options.map((option) => {
										const chosen = answer?.selected.includes(option.label) === true;
										return (
											<li
												key={option.label}
												className={`flex gap-1.5 ${chosen ? "text-fg" : "text-fg-subtle"}`}
											>
												<span className="mt-px w-3.5 shrink-0">
													{chosen && <CheckIcon className="h-3.5 w-3.5 text-ok" />}
												</span>
												<span>
													<span className={chosen ? "font-medium" : ""}>{option.label}</span>
													{option.description !== "" && (
														<span className="text-fg-faint"> — {option.description}</span>
													)}
												</span>
											</li>
										);
									})}
									{answer?.skipped === true && <li className="pl-5 text-fg-faint">Skipped</li>}
									{answer?.other !== undefined && (
										<li className="flex gap-1.5 text-fg">
											<span className="mt-px w-3.5 shrink-0">
												<CheckIcon className="h-3.5 w-3.5 text-ok" />
											</span>
											<span className="font-medium">“{answer.other}”</span>
										</li>
									)}
								</ul>
							</div>
						);
					})}
					{failed && result !== undefined && result.text !== "" && (
						<pre className="border-t border-line pt-1.5 whitespace-pre-wrap font-mono text-red-700 dark:text-red-300">
							{result.text}
						</pre>
					)}
				</div>
			)}
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
		return <pre className="whitespace-pre-wrap font-mono text-fg-muted">{text}</pre>;
	}
	const code = typeof args.code === "string" ? args.code : undefined;
	if (name === "codemode" && code !== undefined) {
		// The script is the point, so it reads as code, not as one escaped JSON string. The fence is
		// longer than any backtick run inside the script, so the code cannot close it early.
		const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
		const fence = "`".repeat(longest + 1);
		return <Markdown text={`${fence}javascript\n${code}\n${fence}`} size="xs" />;
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
			<pre className="whitespace-pre-wrap font-mono text-fg-muted">
				{JSON.stringify(args, null, 2)}
			</pre>
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

function ThinkingBlock({
	stateKey,
	thinking,
	active,
}: {
	stateKey: string;
	thinking: string;
	active: boolean;
}) {
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
				{/* The spinner replaces the brain while the model is still thinking. */}
				{active ? (
					<SpinnerIcon className="h-3.5 w-3.5 shrink-0" />
				) : (
					<BrainIcon className="h-3.5 w-3.5 shrink-0" />
				)}
				{active ? "Thinking…" : "Thinking"}
				<ChevronDownIcon className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
			</summary>
			{open && (
				<div className="mt-1.5">
					<Markdown text={thinking} variant="thinking" size="xs" />
				</div>
			)}
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
		<div
			data-hidden-output
			className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
		>
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
	const [open, setOpen] = useState(false);
	return (
		<>
			<details
				open={open}
				onToggle={(event) => setOpen(event.currentTarget.open)}
				className={`rounded-md border px-3 py-2 text-xs ${
					isError
						? "border-red-500/30 bg-red-500/10 text-red-700 dark:bg-red-950/20 dark:text-red-300"
						: "border-line bg-panel/50 text-fg-muted"
				}`}
			>
				<summary className="cursor-pointer select-none">
					{isError ? "Tool error" : "Tool result"}
				</summary>
				{open && text !== "" && (
					<pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap font-mono">{text}</pre>
				)}
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
