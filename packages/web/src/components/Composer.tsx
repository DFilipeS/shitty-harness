import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import { ATTACHMENT_LIMITS, type SkillInfo } from "@harness/protocol";
import {
	attachmentAccept,
	isImageAttachment,
	readAttachment,
	type PendingAttachment,
} from "../lib/attachments.ts";
import { formatBytes } from "../lib/format.ts";
import { useProviderPalette } from "../lib/provider-commands.tsx";
import { useModelPalette, useThinkingPalette } from "../lib/session-commands.tsx";
import { completeInvocation, invokedSkill, matchSkills, skillQuery } from "../lib/skills.ts";
import { useTargetPalette, targetLabel } from "../lib/target-commands.tsx";
import { useHarness } from "../lib/store.tsx";
import {
	BookIcon,
	BrainIcon,
	CpuIcon,
	FileIcon,
	FolderIcon,
	KeyIcon,
	LayersIcon,
	PaperclipIcon,
	SendIcon,
	StopIcon,
	TerminalIcon,
	XIcon,
} from "./icons.tsx";

/** The textarea grows with its content up to this height, then scrolls. Matches `max-h-40`. */
const MAX_TEXTAREA_HEIGHT = 160;

/** Floating message composer. ChatPanel positions it and reserves its height in the message list. */
export function Composer({ ref, hidden = false }: { ref?: Ref<HTMLDivElement>; hidden?: boolean }) {
	const { activeSession, activeSessionId, sendPrompt, abortSession, status, models } = useHarness();
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const [attachError, setAttachError] = useState<string | undefined>(undefined);
	const [dragging, setDragging] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const model = activeSession?.agent.model;
	const runActive = activeSession?.runActive ?? false;
	const modelInfo = models.find(
		(candidate) => candidate.provider === model?.provider && candidate.id === model?.modelId,
	);
	const hasImages = attachments.some((pending) => isImageAttachment(pending.attachment));
	const imagesBlocked = hasImages && modelInfo !== undefined && !modelInfo.input.includes("image");
	const skills = useSessionSkills(activeSessionId, text.startsWith("/"));
	const completion = useSkillCompletion(text, caret, skills);
	const invoked = invokedSkill(text);
	// Only a loaded list can say a skill is unknown; the server rejects it either way.
	const unknownSkill =
		invoked !== undefined && skills !== undefined && !skills.some((skill) => skill.name === invoked) ? invoked : undefined;
	const canSend =
		(text.trim() !== "" || attachments.length > 0) &&
		model !== undefined &&
		status === "connected" &&
		!imagesBlocked &&
		unknownSkill === undefined;

	useLayoutEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		const resize = () => {
			element.style.height = "auto";
			element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
			element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
		};
		resize();
		// The line height changes between the mobile and desktop font sizes, so remeasure on resize.
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [text]);

	const addFiles = async (files: readonly File[]) => {
		if (files.length === 0) return;
		setAttachError(undefined);
		const accepted: PendingAttachment[] = [];
		const problems: string[] = [];
		let count = attachments.length;
		let total = attachments.reduce((sum, pending) => sum + pending.size, 0);
		for (const file of files) {
			if (count >= ATTACHMENT_LIMITS.maxPerMessage) {
				problems.push(`A message can carry at most ${ATTACHMENT_LIMITS.maxPerMessage} attachments.`);
				break;
			}
			try {
				const pending = await readAttachment(file);
				if (total + pending.size > ATTACHMENT_LIMITS.maxTotalBytes) {
					problems.push(
						`${file.name} would take the attachments past ${formatBytes(ATTACHMENT_LIMITS.maxTotalBytes)}.`,
					);
					continue;
				}
				accepted.push(pending);
				count += 1;
				total += pending.size;
			} catch (error) {
				problems.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
		if (problems.length > 0) setAttachError(problems.join(" "));
	};

	const complete = (skill: SkillInfo) => {
		const next = completeInvocation(text, skill.name);
		setText(next.text);
		setCaret(next.caret);
		requestAnimationFrame(() => {
			textareaRef.current?.focus();
			textareaRef.current?.setSelectionRange(next.caret, next.caret);
		});
	};

	const submit = async () => {
		if (!canSend) return;
		const value = text;
		const files = attachments.map((pending) => pending.attachment);
		setText("");
		setAttachments([]);
		setAttachError(undefined);
		await sendPrompt(value, files);
		textareaRef.current?.focus();
	};

	return (
		<div
			ref={ref}
			hidden={hidden}
			className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4"
		>
			<div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-1.5">
				{completion.open && (
					<SkillSuggestions
						matches={completion.matches}
						selected={completion.selected}
						onHover={completion.select}
						onPick={complete}
					/>
				)}
				<div
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
					}}
					onDrop={(event) => {
						event.preventDefault();
						setDragging(false);
						void addFiles([...event.dataTransfer.files]);
					}}
					className={`flex flex-wrap items-end gap-2 rounded-2xl border bg-panel p-2 shadow-lg shadow-black/5 focus-within:border-line-strong dark:shadow-black/40 ${
						dragging ? "border-line-strong ring-2 ring-fg/10" : "border-line"
					}`}
				>
					{attachments.length > 0 && (
						<div className="flex w-full flex-wrap gap-1.5 px-1 pt-0.5">
							{attachments.map((pending) => (
								<AttachmentChip
									key={pending.key}
									pending={pending}
									onRemove={() =>
										setAttachments((current) =>
											current.filter((candidate) => candidate.key !== pending.key),
										)
									}
								/>
							))}
						</div>
					)}
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept={attachmentAccept()}
						className="hidden"
						onChange={(event) => {
							void addFiles([...(event.target.files ?? [])]);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						title="Attach files"
						aria-label="Attach files"
						className="mb-0.5 rounded-lg p-2 text-fg-subtle hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
					>
						<PaperclipIcon />
					</button>
					<textarea
						ref={textareaRef}
						data-composer-input
						value={text}
						rows={1}
						placeholder="Send a message…"
						onChange={(event) => {
							setText(event.target.value);
							setCaret(event.target.selectionStart);
						}}
						onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
						onPaste={(event) => {
							const files = [...(event.clipboardData?.files ?? [])];
							if (files.length === 0) return;
							event.preventDefault();
							void addFiles(files);
						}}
						onKeyDown={(event) => {
							if (completion.open && !event.nativeEvent.isComposing) {
								if (event.key === "ArrowDown" || event.key === "ArrowUp") {
									event.preventDefault();
									completion.move(event.key === "ArrowDown" ? 1 : -1);
									return;
								}
								if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
									event.preventDefault();
									const skill = completion.matches[completion.selected];
									if (skill !== undefined) complete(skill);
									return;
								}
								if (event.key === "Escape") {
									event.preventDefault();
									event.stopPropagation();
									completion.dismiss();
									return;
								}
							}
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void submit();
							}
						}}
						className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-fg-faint sm:text-sm"
					/>
					{runActive ? (
						<button
							type="button"
							onClick={() => void abortSession()}
							title="Stop"
							className="mb-0.5 rounded-lg bg-red-500/90 p-2 text-white hover:bg-red-500 pointer-coarse:p-2.5"
						>
							<StopIcon />
						</button>
					) : (
						<button
							type="button"
							onClick={() => void submit()}
							disabled={!canSend}
							title="Send"
							className="mb-0.5 rounded-lg bg-fg p-2 text-canvas hover:bg-fg/90 disabled:opacity-30 disabled:hover:bg-fg pointer-coarse:p-2.5"
						>
							<SendIcon />
						</button>
					)}
					<div className="flex w-full flex-wrap items-center gap-1 px-1">
						<ModelChip />
						<ThinkingChip />
						<TargetChip />
						{imagesBlocked && (
							<span className="text-[11px] text-warn">
								This model cannot read images. Remove them or switch to a vision model.
							</span>
						)}
						{attachError !== undefined && <span className="text-[11px] text-red-500">{attachError}</span>}
						{unknownSkill !== undefined && (
							<span className="text-[11px] text-warn">
								{unknownSkill === "" ? "Name a skill after /skill:" : `Unknown skill: ${unknownSkill}`}
							</span>
						)}
						{runActive && (
							<span className="ml-auto flex flex-wrap items-center justify-end gap-x-1.5 text-[11px] text-fg-faint">
								<span className="flex items-center gap-1.5">
									<span
										aria-hidden="true"
										className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-warn motion-safe:animate-spin"
									/>
									<span className="text-warn">Working</span>
								</span>
								<span>Sending another message queues it as a follow-up.</span>
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The session's skills, fetched each time the message starts to look like an invocation. Keeps the
 * last list while a new one loads, so the card does not flicker.
 */
function useSessionSkills(sessionId: string | undefined, wanted: boolean): SkillInfo[] | undefined {
	const { listSkills } = useHarness();
	const [loaded, setLoaded] = useState<{ sessionId: string; skills: SkillInfo[] } | undefined>(undefined);
	useEffect(() => {
		if (!wanted || sessionId === undefined) return;
		let cancelled = false;
		void listSkills(sessionId).then((result) => {
			if (!cancelled && result !== undefined) setLoaded({ sessionId, skills: result.skills });
		});
		return () => {
			cancelled = true;
		};
	}, [wanted, sessionId, listSkills]);
	return loaded !== undefined && loaded.sessionId === sessionId ? loaded.skills : undefined;
}

type SkillCompletion = {
	open: boolean;
	matches: SkillInfo[];
	selected: number;
	select(index: number): void;
	move(step: number): void;
	dismiss(): void;
};

/** Which skills the card offers for the leading token, which one is highlighted, and whether `esc` hid it. */
function useSkillCompletion(text: string, caret: number, skills: SkillInfo[] | undefined): SkillCompletion {
	const query = skillQuery(text, caret);
	const matches = query === undefined || skills === undefined ? [] : matchSkills(skills, query);
	const [selected, setSelected] = useState(0);
	const [dismissedFor, setDismissedFor] = useState<string | undefined>(undefined);
	// A new query starts from the best match; `esc` hides the card until the token changes.
	useEffect(() => setSelected(0), [query]);
	const open = matches.length > 0 && dismissedFor !== query;
	return {
		open,
		matches,
		selected: Math.min(selected, Math.max(matches.length - 1, 0)),
		select: setSelected,
		move: (step) => setSelected((current) => (current + step + matches.length) % matches.length),
		dismiss: () => setDismissedFor(query),
	};
}

/** The card above the message box listing the skills an invocation can name. */
function SkillSuggestions({
	matches,
	selected,
	onHover,
	onPick,
}: {
	matches: SkillInfo[];
	selected: number;
	onHover: (index: number) => void;
	onPick: (skill: SkillInfo) => void;
}) {
	const listRef = useRef<HTMLUListElement>(null);
	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	return (
		<div
			data-skill-suggestions
			className="overflow-hidden rounded-xl border border-line bg-panel shadow-lg shadow-black/5 dark:shadow-black/40"
		>
			<ul ref={listRef} role="listbox" aria-label="Skills" className="max-h-60 overflow-y-auto p-1">
				{matches.map((skill, index) => (
					<li
						key={skill.name}
						data-index={index}
						role="option"
						aria-selected={index === selected}
						onMouseEnter={() => onHover(index)}
						// Keep focus in the textarea: picking must not blur it.
						onMouseDown={(event) => {
							event.preventDefault();
							onPick(skill);
						}}
						className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${
							index === selected ? "bg-raised" : ""
						}`}
					>
						<BookIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
						<span className="shrink-0 font-mono text-fg">/skill:{skill.name}</span>
						<span className="min-w-0 flex-1 truncate text-fg-subtle">{skill.description}</span>
						<span className="hidden shrink-0 text-[11px] text-fg-faint sm:inline">{skill.scope}</span>
					</li>
				))}
			</ul>
			<div className="border-t border-line px-3 py-1 text-[11px] text-fg-faint">
				↑↓ to move · tab or ↵ to complete · esc to close
			</div>
		</div>
	);
}

/** One file waiting to be sent: a thumbnail for images, a name and size for text files. */
function AttachmentChip({ pending, onRemove }: { pending: PendingAttachment; onRemove: () => void }) {
	const { attachment, size } = pending;
	return (
		<div className="flex items-center gap-1.5 rounded-lg border border-line bg-raised py-1 pr-1 pl-1.5 text-[11px]">
			{isImageAttachment(attachment) ? (
				<img
					src={`data:${attachment.mimeType};base64,${attachment.data}`}
					alt={attachment.name}
					className="h-8 w-8 shrink-0 rounded object-cover"
				/>
			) : (
				<FileIcon className="h-4 w-4 shrink-0 text-fg-subtle" />
			)}
			<span className="max-w-40 truncate text-fg-muted">{attachment.name}</span>
			<span className="shrink-0 text-fg-faint">{formatBytes(size)}</span>
			<button
				type="button"
				onClick={onRemove}
				title={`Remove ${attachment.name}`}
				aria-label={`Remove ${attachment.name}`}
				className="rounded p-0.5 text-fg-faint hover:bg-panel hover:text-fg"
			>
				<XIcon className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

/** Opens the model page, or the provider page when no provider is configured yet. */
function ModelChip() {
	const { models, activeSession } = useHarness();
	const modelPalette = useModelPalette();
	const providersPalette = useProviderPalette();
	const current = activeSession?.agent.model;
	const info = models.find((model) => model.provider === current?.provider && model.id === current.modelId);
	const configured = models.length > 0;
	return (
		<button
			type="button"
			data-model-chip
			onClick={() => (configured ? modelPalette.open() : providersPalette.open())}
			title={info === undefined ? "Choose a model" : `Model: ${info.providerName} · ${info.name}`}
			className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-raised ${
				info === undefined ? "text-warn" : "text-fg-subtle hover:text-fg"
			}`}
		>
			<CpuIcon className="h-3.5 w-3.5 shrink-0" />
			<span className="max-w-44 truncate">{info?.name ?? current?.modelId ?? "Choose a model"}</span>
		</button>
	);
}

/** Only shown when the current model has more than one thinking level. */
function ThinkingChip() {
	const { activeSession } = useHarness();
	const thinkingPalette = useThinkingPalette();
	if (thinkingPalette.levels.length <= 1) return null;
	return (
		<button
			type="button"
			data-thinking-chip
			onClick={thinkingPalette.open}
			title="Change thinking level"
			className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-fg-subtle hover:bg-raised hover:text-fg"
		>
			<BrainIcon className="h-3.5 w-3.5 shrink-0" />
			<span>{activeSession?.agent.thinkingLevel ?? "off"}</span>
		</button>
	);
}

/** Where this session's tools run. Locked while a run is in flight, like the model and level. */
function TargetChip() {
	const { sessions, sandboxes, activeSessionId, activeSession, targetStatus } = useHarness();
	const targetPalette = useTargetPalette();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	const target = session?.target;
	const status = activeSessionId === undefined ? undefined : targetStatus[activeSessionId];
	const phase = status?.phase;
	const runActive = activeSession?.runActive ?? false;
	const sandbox =
		target?.kind === "sandbox" && target.sandboxId !== undefined
			? sandboxes.find((candidate) => candidate.id === target.sandboxId)
			: undefined;
	const otherWorking =
		sandbox?.working === true && sandbox.sessions.some((id) => id !== activeSessionId);
	const label =
		phase === "starting"
			? "starting…"
			: phase === "gone"
				? "gone"
				: phase === "error"
					? "error"
					: targetLabel(target);
	const title =
		phase === "starting"
			? (status?.message ?? "Creating the sandbox…")
			: phase === "gone"
				? (status?.message ?? "The sandbox is gone")
				: phase === "error"
					? (status?.message ?? "Could not start the sandbox")
					: runActive
						? "The target is locked while the agent is working"
						: otherWorking
							? "Another session is working in this sandbox"
							: target === undefined
								? "Choose where tools run"
								: `Target: ${targetLabel(target)}`;
	return (
		<button
			type="button"
			data-target-chip
			onClick={targetPalette.open}
			disabled={runActive}
			title={title}
			className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent ${
				phase === "gone" || phase === "error" || otherWorking ? "text-warn" : "text-fg-subtle hover:text-fg"
			}`}
		>
			{target !== undefined && target.kind === "sandbox" ? (
				<LayersIcon className="h-3.5 w-3.5 shrink-0" />
			) : target !== undefined && !target.scratch ? (
				<FolderIcon className="h-3.5 w-3.5 shrink-0" />
			) : (
				<TerminalIcon className="h-3.5 w-3.5 shrink-0" />
			)}
			<span className="max-w-44 truncate">{label}</span>
			{target?.kind === "sandbox" && target.forwardAgent === true && (
				<KeyIcon className="h-3 w-3 shrink-0 text-fg-faint" />
			)}
		</button>
	);
}
