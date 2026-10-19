import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { Question } from "@harness/protocol";
import {
	changeDraft,
	draftAnswered,
	draftDone,
	draftsComplete,
	EMPTY_DRAFT,
	nextPending,
	replyFromDrafts,
	skipDraft,
	toggleOption,
	toggleOther,
	type QuestionDraft,
} from "../lib/questions.ts";
import { useHarness } from "../lib/store.tsx";
import { CheckIcon, QuestionIcon, StopIcon } from "./icons.tsx";

/** How long a picked single-select option stays on screen before the form moves to the next question. */
const ADVANCE_DELAY_MS = 150;

/**
 * The open question, docked where the composer usually sits (ADR 0006): the run waits on it, so the
 * form is the way forward, along with Stop. It shows one question at a time, with a tab per question
 * to jump between them; each question is answered or skipped on its own. ChatPanel keys it by tool call id, so a new question starts from
 * empty drafts.
 */
export function QuestionForm({
	ref,
	callId,
	questions,
}: {
	ref?: Ref<HTMLDivElement>;
	callId: string;
	/** Undefined when the call's arguments cannot be read; the user can still skip or stop. */
	questions: Question[] | undefined;
}) {
	const { answerQuestion, abortSession, status } = useHarness();
	// Missing drafts read as empty: the form can open before the call's questions have loaded.
	const [drafts, setDrafts] = useState<QuestionDraft[]>([]);
	const [current, setCurrent] = useState(0);
	const [sending, setSending] = useState(false);
	const advanceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const connected = status === "connected";
	const complete = questions !== undefined && draftsComplete(questions, drafts);
	const question = questions?.[current];
	const next = questions === undefined ? undefined : nextPending(questions, drafts, current);
	const draft = drafts[current] ?? EMPTY_DRAFT;

	useEffect(() => () => clearTimeout(advanceTimer.current), []);

	const show = (index: number) => {
		clearTimeout(advanceTimer.current);
		setCurrent(index);
	};

	/** Change one draft; `advance` moves on to the next pending question once the change answers or skips it. */
	const update = (
		index: number,
		change: (draft: QuestionDraft) => QuestionDraft,
		advance: boolean,
	) => {
		if (questions === undefined) return;
		const changed = changeDraft(questions, drafts, index, change);
		setDrafts(changed);
		if (!advance || !draftDone(changed[index])) return;
		const to = nextPending(questions, changed, index);
		if (to === undefined) return;
		clearTimeout(advanceTimer.current);
		advanceTimer.current = setTimeout(() => setCurrent(to), ADVANCE_DELAY_MS);
	};

	const send = async (reply: Parameters<typeof answerQuestion>[1]) => {
		setSending(true);
		// On success the session update closes the form; on failure the user can try again.
		if (!(await answerQuestion(callId, reply))) setSending(false);
	};

	const submit = () => {
		if (questions === undefined || !complete || sending || !connected) return;
		void send(replyFromDrafts(questions, drafts));
	};

	/** Enter in the Other field: on to the next pending question, or submit once none is left. */
	const moveOn = () => {
		if (!draftAnswered(draft)) return;
		if (next !== undefined) show(next);
		else submit();
	};

	return (
		<div
			ref={ref}
			className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4"
		>
			<form
				data-question-form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						submit();
					}
				}}
				className="pointer-events-auto mx-auto flex max-h-[min(36rem,70dvh)] max-w-3xl flex-col rounded-2xl border border-line bg-panel shadow-lg shadow-black/5 dark:shadow-black/40"
			>
				{questions !== undefined && questions.length > 1 && (
					<QuestionTabs questions={questions} drafts={drafts} current={current} onSelect={show} />
				)}
				<div className="flex flex-col overflow-y-auto p-3 sm:p-4">
					{question === undefined ? (
						<p className="text-sm text-fg-muted">
							The agent asked a question this page cannot show. Skip it or stop the run.
						</p>
					) : (
						<QuestionFields
							key={current}
							question={question}
							showHeader={questions?.length === 1}
							draft={draft}
							onChange={(change, advance) => update(current, change, advance)}
							onEnter={moveOn}
						/>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
					<span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-link">
						<QuestionIcon className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">The agent is waiting for your answer</span>
					</span>
					<button
						type="button"
						onClick={() => void abortSession()}
						title="Stop the run"
						className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/10"
					>
						<StopIcon className="h-3.5 w-3.5" />
						Stop
					</button>
					{questions === undefined ? (
						<button
							type="button"
							onClick={() => void send({ kind: "skipped" })}
							disabled={sending || !connected}
							title="Let the agent continue on its own judgment"
							className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40"
						>
							Skip
						</button>
					) : (
						<button
							type="button"
							data-question-skip
							onClick={() => update(current, skipDraft, true)}
							disabled={draft.skipped || sending}
							title="Leave this question to the agent's judgment"
							className="rounded-lg px-2.5 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
						>
							Skip question
						</button>
					)}
					{complete || questions === undefined || questions.length === 1 ? (
						<button
							type="submit"
							data-question-submit
							disabled={!complete || sending || !connected}
							title={complete ? "Send your answers (⌘↵)" : "Answer or skip the question first"}
							className="rounded-lg bg-fg px-3 py-1.5 text-xs font-medium text-canvas hover:bg-fg/90 disabled:opacity-30 disabled:hover:bg-fg"
						>
							Submit
						</button>
					) : (
						<button
							type="button"
							data-question-next
							onClick={() => next !== undefined && show(next)}
							disabled={next === undefined}
							title={
								next === undefined
									? "Answer or skip this question first"
									: "Go to the next unanswered question"
							}
							className="rounded-lg bg-fg px-3 py-1.5 text-xs font-medium text-canvas hover:bg-fg/90 disabled:opacity-30 disabled:hover:bg-fg"
						>
							Next
						</button>
					)}
				</div>
			</form>
		</div>
	);
}

/** One tab per question: its header, checked once answered, dashed once skipped. Arrow keys move between tabs. */
function QuestionTabs({
	questions,
	drafts,
	current,
	onSelect,
}: {
	questions: readonly Question[];
	drafts: readonly QuestionDraft[];
	current: number;
	onSelect: (index: number) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-index="${current}"]`)
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [current]);
	return (
		<div
			ref={listRef}
			role="tablist"
			aria-label="Questions"
			onKeyDown={(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const to =
					(current + (event.key === "ArrowRight" ? 1 : -1) + questions.length) % questions.length;
				onSelect(to);
				listRef.current?.querySelector<HTMLElement>(`[data-index="${to}"]`)?.focus();
			}}
			className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
		>
			{questions.map((question, index) => {
				const answered = draftAnswered(drafts[index]);
				const skipped = drafts[index]?.skipped === true;
				const selected = index === current;
				return (
					<button
						key={index}
						type="button"
						role="tab"
						data-index={index}
						aria-selected={selected}
						tabIndex={selected ? 0 : -1}
						onClick={() => onSelect(index)}
						title={question.question}
						className={`flex shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs ${
							selected ? "border-fg text-fg" : "border-transparent text-fg-subtle hover:text-fg"
						}`}
					>
						{answered ? (
							<CheckIcon className="h-3 w-3 shrink-0 text-ok" />
						) : skipped ? (
							<span aria-label="skipped" className="w-3 shrink-0 text-center text-fg-faint">
								–
							</span>
						) : (
							<span className="w-3 shrink-0 text-center text-[11px] text-fg-faint">
								{index + 1}
							</span>
						)}
						<span className="max-w-32 truncate">{question.header || `Question ${index + 1}`}</span>
					</button>
				);
			})}
		</div>
	);
}

function QuestionFields({
	question,
	showHeader,
	draft,
	onChange,
	onEnter,
}: {
	question: Question;
	/** The tabs carry the header when there are several questions. */
	showHeader: boolean;
	draft: QuestionDraft;
	onChange: (change: (draft: QuestionDraft) => QuestionDraft, advance: boolean) => void;
	/** Enter in the Other field. */
	onEnter: () => void;
}) {
	const multi = question.multiSelect === true;
	return (
		<fieldset className="flex min-w-0 flex-col gap-2">
			<legend className="contents">
				<span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					{showHeader && question.header !== "" && (
						<span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
							{question.header}
						</span>
					)}
					<span className="text-sm text-fg">{question.question}</span>
					{multi && <span className="text-[11px] text-fg-faint">Pick any</span>}
				</span>
			</legend>
			{draft.skipped && (
				<p className="text-xs text-fg-subtle">
					Skipped: the agent will use its own judgment. Pick an answer to undo.
				</p>
			)}
			<div role={multi ? "group" : "radiogroup"} className="flex flex-col gap-1">
				{question.options.map((option) => (
					<Choice
						key={option.label}
						multi={multi}
						checked={draft.selected.includes(option.label)}
						onToggle={() =>
							onChange((current) => toggleOption(question, current, option.label), !multi)
						}
					>
						<span className="text-sm text-fg">{option.label}</span>
						{option.description !== "" && (
							<span className="text-xs text-fg-subtle">{option.description}</span>
						)}
					</Choice>
				))}
				<Choice
					multi={multi}
					checked={draft.otherChosen}
					onToggle={() => onChange((current) => toggleOther(question, current), false)}
				>
					<input
						value={draft.other}
						placeholder="Other: answer in your own words"
						aria-label={`Other answer to: ${question.question}`}
						onClick={(event) => event.stopPropagation()}
						onChange={(event) => {
							const other = event.target.value;
							// Typing chooses Other; clearing the text leaves the choice for the user to undo.
							onChange(
								(current) => ({
									...(current.otherChosen || other === ""
										? current
										: toggleOther(question, current)),
									other,
								}),
								false,
							);
						}}
						onKeyDown={(event) => {
							// ⌘↵ goes on to the form, which submits.
							if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) return;
							if (event.nativeEvent.isComposing) return;
							event.preventDefault();
							onEnter();
						}}
						className="w-full bg-transparent text-base outline-none placeholder:text-fg-faint sm:text-sm"
					/>
					{draft.otherChosen && draft.other.trim() !== "" && (
						<span className="text-[11px] text-fg-faint">↵ to continue</span>
					)}
				</Choice>
			</div>
		</fieldset>
	);
}

/** One selectable row: a radio dot or a checkbox, then its content. */
function Choice({
	multi,
	checked,
	onToggle,
	children,
}: {
	multi: boolean;
	checked: boolean;
	onToggle: () => void;
	children: ReactNode;
}) {
	return (
		<div
			role={multi ? "checkbox" : "radio"}
			aria-checked={checked}
			tabIndex={0}
			onClick={onToggle}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (event.key === " " || (event.key === "Enter" && !event.metaKey && !event.ctrlKey)) {
					event.preventDefault();
					onToggle();
				}
			}}
			className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-fg/20 ${
				checked ? "border-line-strong bg-raised" : "border-line hover:bg-raised/60"
			}`}
		>
			<span
				aria-hidden="true"
				className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-[1.5px] ${
					multi ? "rounded" : "rounded-full"
				} ${checked ? "border-fg bg-fg text-canvas" : "border-line-strong"}`}
			>
				{checked &&
					(multi ? (
						<CheckIcon className="h-3 w-3" />
					) : (
						<span className="h-1.5 w-1.5 rounded-full bg-canvas" />
					))}
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
		</div>
	);
}
