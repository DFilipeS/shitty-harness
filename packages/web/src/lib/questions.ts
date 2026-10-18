import type { EntryRecord, Question, QuestionAnswer, QuestionReply } from "@harness/protocol";
import { assistantMessageOf, parseToolArguments, type LiveBlock } from "./messages.ts";

export const ASK_USER_TOOL = "ask_user";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The questions of an `ask_user` call; undefined while its arguments stream in or when they are malformed. */
export function parseQuestions(args: Record<string, unknown> | undefined): Question[] | undefined {
	if (!Array.isArray(args?.questions)) return undefined;
	const questions: Question[] = [];
	for (const item of args.questions) {
		const question = record(item);
		if (typeof question?.question !== "string" || !Array.isArray(question.options)) return undefined;
		const options = question.options.map(record);
		if (options.some((option) => typeof option?.label !== "string")) return undefined;
		questions.push({
			question: question.question,
			header: typeof question.header === "string" ? question.header : "",
			options: options.map((option) => ({
				label: option?.label as string,
				description: typeof option?.description === "string" ? option.description : "",
			})),
			...(question.multiSelect === true ? { multiSelect: true } : {}),
		});
	}
	return questions;
}

/** The reply an `ask_user` result carries in its details. */
export function questionReplyOf(details: unknown): QuestionReply | undefined {
	const reply = record(record(details)?.reply);
	if (reply?.kind === "skipped") return { kind: "skipped" };
	if (reply?.kind !== "answered" || !Array.isArray(reply.answers)) return undefined;
	return {
		kind: "answered",
		answers: reply.answers.map((item): QuestionAnswer => {
			const answer = record(item);
			if (answer?.skipped === true) return { selected: [], skipped: true };
			const selected = Array.isArray(answer?.selected)
				? answer.selected.filter((label): label is string => typeof label === "string")
				: [];
			return typeof answer?.other === "string" ? { selected, other: answer.other } : { selected };
		}),
	};
}

/** The questions of the open call, found among the committed entries or the live message. */
export function findQuestions(
	entries: readonly EntryRecord[],
	live: readonly LiveBlock[] | undefined,
	callId: string,
): Question[] | undefined {
	for (const block of live ?? []) {
		if (block.type === "toolCall" && block.id === callId) return parseQuestions(parseToolArguments(block.argumentsText));
	}
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const assistant = assistantMessageOf(entries[index]!);
		const call = assistant?.content.find((block) => block.type === "toolCall" && block.id === callId);
		if (call?.type === "toolCall") return parseQuestions(call.arguments);
	}
	return undefined;
}

/** One answer as a single line: the picked labels, then the user's own words. */
export function answerText(answer: QuestionAnswer | undefined): string {
	if (answer === undefined) return "";
	if (answer.skipped === true) return "skipped";
	return [...answer.selected, ...(answer.other === undefined ? [] : [`“${answer.other}”`])].join(", ");
}

/**
 * What the user has chosen so far for one question. `other` is the typed text; `otherChosen` whether it
 * counts. A skipped question has no choices; choosing anything undoes the skip.
 */
export type QuestionDraft = {
	selected: string[];
	otherChosen: boolean;
	other: string;
	skipped: boolean;
};

export const EMPTY_DRAFT: QuestionDraft = { selected: [], otherChosen: false, other: "", skipped: false };

/** Pick an option: a single-select question swaps its choice, a multi-select one toggles it. */
export function toggleOption(question: Question, draft: QuestionDraft, label: string): QuestionDraft {
	if (question.multiSelect === true) {
		const selected = draft.selected.includes(label)
			? draft.selected.filter((candidate) => candidate !== label)
			: [...draft.selected, label];
		return { ...draft, selected, skipped: false };
	}
	return { ...draft, selected: [label], otherChosen: false, skipped: false };
}

/** Pick "Other": a single-select question drops its option, a multi-select one keeps them. */
export function toggleOther(question: Question, draft: QuestionDraft): QuestionDraft {
	if (question.multiSelect === true) return { ...draft, otherChosen: !draft.otherChosen, skipped: false };
	return { ...draft, selected: [], otherChosen: true, skipped: false };
}

/** Skip one question: its choices go, the typed text stays in case the user comes back to it. */
export function skipDraft(draft: QuestionDraft): QuestionDraft {
	return { ...EMPTY_DRAFT, other: draft.other, skipped: true };
}

function draftAnswer(draft: QuestionDraft): QuestionAnswer {
	if (draft.skipped) return { selected: [], skipped: true };
	const other = draft.other.trim();
	return draft.otherChosen && other !== "" ? { selected: draft.selected, other } : { selected: draft.selected };
}

/**
 * The drafts with one changed, one per question. Built from the questions rather than the drafts,
 * since the drafts can start out shorter: the form opens before the call's arguments are loaded.
 */
export function changeDraft(
	questions: readonly Question[],
	drafts: readonly QuestionDraft[],
	index: number,
	change: (draft: QuestionDraft) => QuestionDraft,
): QuestionDraft[] {
	return questions.map((_, at) => {
		const draft = drafts[at] ?? EMPTY_DRAFT;
		return at === index ? change(draft) : draft;
	});
}

/** Whether a draft answers its question: an option picked, or Other chosen with text. */
export function draftAnswered(draft: QuestionDraft | undefined): boolean {
	const answer = draftAnswer(draft ?? EMPTY_DRAFT);
	return answer.selected.length > 0 || answer.other !== undefined;
}

/** Whether the user is done with a question: they answered or skipped it. */
export function draftDone(draft: QuestionDraft | undefined): boolean {
	return draft?.skipped === true || draftAnswered(draft);
}

/** Whether every question is answered or skipped, which is what Submit waits for. */
export function draftsComplete(questions: readonly Question[], drafts: readonly QuestionDraft[]): boolean {
	return questions.every((_, index) => draftDone(drafts[index]));
}

/**
 * The first question after `from`, wrapping around, that is neither answered nor skipped; undefined when
 * every other one is done.
 */
export function nextPending(
	questions: readonly Question[],
	drafts: readonly QuestionDraft[],
	from: number,
): number | undefined {
	for (let step = 1; step < questions.length; step += 1) {
		const index = (from + step) % questions.length;
		if (!draftDone(drafts[index])) return index;
	}
	return undefined;
}

/** The reply to send; skipping every question skips the call. */
export function replyFromDrafts(questions: readonly Question[], drafts: readonly QuestionDraft[]): QuestionReply {
	const answers = questions.map((_, index) => draftAnswer(drafts[index] ?? EMPTY_DRAFT));
	return answers.every((answer) => answer.skipped === true) ? { kind: "skipped" } : { kind: "answered", answers };
}
