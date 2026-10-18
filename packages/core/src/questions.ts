import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Question, QuestionAnswer, QuestionReply } from "@harness/protocol";
import { ServiceError } from "./errors.ts";

export const ASK_USER_TOOL = "ask_user";

/** One open question: the call that asked it, what it asked, and the reply once the user gave one. */
export type OpenQuestion = {
	callId: string;
	questions: Question[];
	reply: QuestionReply | null;
};

export type OpenQuestionsState = {
	/** Keyed by conversation ID; a conversation has at most one open question, since the tool runs sequentially. */
	open: Record<string, OpenQuestion>;
};

/**
 * Every open question, in one session-scoped document so the sidebar can tell which sessions need
 * input without scanning conversations. The tool writes the question and waits on this document;
 * `sessions.answer` writes the reply. A reply lands here before the tool reads it, so a restart in
 * between loses nothing: the tool reruns, finds the reply, and returns it.
 */
export const OpenQuestionsDoc = defineDoc<OpenQuestionsState>({
	kind: "app.open-questions",
	version: 1,
	scope: "session",
	initial: () => ({ open: {} }),
});

const askUserSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The full question, ending with a question mark." }),
			header: Type.String({
				description: 'A very short label for the question, at most 12 characters, such as "Database" or "Approach".',
			}),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "The choice as the user sees it, in 1 to 5 words." }),
					description: Type.String({ description: "What the choice means or what follows from it." }),
				}),
				{ minItems: 2, maxItems: 4, description: "2 to 4 distinct choices. Do not add an \"Other\" option: the user can always answer in their own words." },
			),
			multiSelect: Type.Optional(
				Type.Boolean({ description: "Whether the user may pick more than one option. Default false." }),
			),
		}),
		{ minItems: 1, description: "The questions to ask, all shown at once." },
	),
});

/** Close the call's question: a rerun after this finds nothing and asks again, which never happens once settled. */
async function closeQuestion(api: ToolExecutionApi, key: string, context: Context): Promise<void> {
	await api.commit(async (tx) => {
		const doc = await tx.doc(OpenQuestionsDoc);
		if (doc.open[key]?.callId !== api.callId) return;
		const { [key]: _closed, ...rest } = doc.open;
		doc.open = rest;
	}, context);
}

/** Wait until `sessions.answer` stores a reply for this call. Rejects when the call is aborted. */
async function waitForReply(api: ToolExecutionApi, key: string, context: Context): Promise<QuestionReply> {
	const watch = await api.watchDoc(OpenQuestionsDoc, context);
	if (watch === undefined) throw new Error("The open questions document is missing");
	const replyOf = (state: Readonly<OpenQuestionsState> | null): QuestionReply | undefined => {
		const open = state?.open[key];
		return open?.callId === api.callId && open.reply !== null ? open.reply : undefined;
	};
	try {
		const ready = replyOf(watch.value);
		if (ready !== undefined) return ready;
		return await new Promise<QuestionReply>((resolve, reject) => {
			const signal = context.abortSignal;
			const onAbort = () => reject(signal?.reason ?? new Error("Aborted"));
			if (signal?.aborted === true) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			watch.start(async (state) => {
				const reply = replyOf(state);
				if (reply !== undefined) resolve(reply);
			});
			void watch.closed.then((end) => reject(new Error(`Stopped waiting for an answer: ${end.reason}`)));
		});
	} finally {
		await watch.stop();
	}
}

/** The reply as the model reads it. */
export function replyText(questions: readonly Question[], reply: QuestionReply): string {
	if (reply.kind === "skipped") {
		return "The user skipped the questions without answering. Continue with your own best judgment, and say which assumptions you made.";
	}
	const lines = questions.map((question, index) => {
		const answer = reply.answers[index];
		if (answer?.skipped === true) return `${index + 1}. ${question.question}\n   (skipped; use your own judgment)`;
		const parts = [...(answer?.selected ?? [])];
		if (answer?.other !== undefined) parts.push(`(in their own words) ${answer.other}`);
		return `${index + 1}. ${question.question}\n   ${parts.join("; ")}`;
	});
	return `The user answered:\n${lines.join("\n")}`;
}

/**
 * Check a reply against the questions it answers; throws a `ServiceError` the client can show. A reply
 * that skips every question becomes a skip of the call.
 */
export function validateReply(questions: readonly Question[], reply: QuestionReply): QuestionReply {
	if (reply.kind === "skipped") return { kind: "skipped" };
	if (reply.answers.length !== questions.length) {
		throw new ServiceError("invalid", `Expected ${questions.length} answers, got ${reply.answers.length}`);
	}
	const answers = questions.map((question, index): QuestionAnswer => {
		const answer = reply.answers[index]!;
		if (answer.skipped === true) return { selected: [], skipped: true };
		const labels = new Set(question.options.map((option) => option.label));
		const selected = [...new Set(answer.selected)];
		const unknown = selected.find((label) => !labels.has(label));
		if (unknown !== undefined) throw new ServiceError("invalid", `Not an option of question ${index + 1}: ${unknown}`);
		const other = answer.other?.trim();
		const count = selected.length + (other === undefined || other === "" ? 0 : 1);
		if (count === 0) throw new ServiceError("invalid", `Question ${index + 1} has no answer`);
		if (question.multiSelect !== true && count > 1) {
			throw new ServiceError("invalid", `Question ${index + 1} takes one answer`);
		}
		return { selected, ...(other === undefined || other === "" ? {} : { other }) };
	});
	if (answers.every((answer) => answer.skipped === true)) return { kind: "skipped" };
	return { kind: "answered", answers };
}

/**
 * Asks the user and waits, with no timeout, for the reply; the reply is the call's result (ADR 0006).
 * It is replay-safe, so a restart reruns it: the rerun finds its open question, or the reply that
 * arrived meanwhile, instead of asking again. Sequential, so only one question is ever open per session.
 */
export const AskUserTool = defineTool({
	name: ASK_USER_TOOL,
	description: [
		"Ask the user one or more multiple-choice questions and wait for the answers.",
		"Use it when you need a decision only the user can make, such as a preference, a trade-off, or an ambiguous requirement, and a wrong guess would waste work. Do not use it for facts you can find yourself.",
		"Each question offers 2 to 4 options; the user can always answer in their own words instead. If you recommend an option, put it first and end its label with \"(Recommended)\".",
		"The user may skip the questions; then continue on your own judgment.",
	].join(" "),
	parameters: askUserSchema,
	replay: "safe",
	executionMode: "sequential",
	callers: ["model"],
	execute: async (args, api, context) => {
		const key = String(api.conversationId);
		const questions: Question[] = args.questions.map((question) => ({
			question: question.question,
			header: question.header,
			options: question.options.map((option) => ({ label: option.label, description: option.description })),
			...(question.multiSelect === true ? { multiSelect: true } : {}),
		}));
		await api.commit(async (tx) => {
			const doc = await tx.doc(OpenQuestionsDoc);
			// A rerun keeps its question, and any reply stored while the process was down.
			if (doc.open[key]?.callId === api.callId) return;
			doc.open = { ...doc.open, [key]: { callId: api.callId, questions, reply: null } };
		}, context);
		const reply = await waitForReply(api, key, context);
		await closeQuestion(api, key, context);
		return { output: [{ type: "text", text: replyText(questions, reply) }], details: { reply } };
	},
});

export const QuestionsExtension = defineExtension({
	name: "questions",
	tools: [AskUserTool],
});
