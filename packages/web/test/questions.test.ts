import type { Question } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import {
	answerText,
	changeDraft,
	draftsComplete,
	EMPTY_DRAFT,
	nextPending,
	parseQuestions,
	questionReplyOf,
	replyFromDrafts,
	skipDraft,
	toggleOption,
	toggleOther,
} from "../src/lib/questions.ts";

const single: Question = {
	question: "Which database?",
	header: "Database",
	options: [
		{ label: "Postgres", description: "Relational" },
		{ label: "SQLite", description: "Embedded" },
	],
};

const multi: Question = {
	...single,
	question: "Which features?",
	header: "Features",
	multiSelect: true,
};

describe("parseQuestions", () => {
	it("reads the call's questions", () => {
		expect(parseQuestions({ questions: [single, multi] })).toEqual([single, multi]);
	});

	it("waits for arguments that are still streaming", () => {
		expect(parseQuestions(undefined)).toBeUndefined();
		expect(parseQuestions({ questions: [{ question: "Which?" }] })).toBeUndefined();
	});
});

describe("questionReplyOf", () => {
	it("reads answers and skips from the result details", () => {
		expect(questionReplyOf({ reply: { kind: "skipped" } })).toEqual({ kind: "skipped" });
		expect(
			questionReplyOf({
				reply: { kind: "answered", answers: [{ selected: ["SQLite"], other: "x" }] },
			}),
		).toEqual({
			kind: "answered",
			answers: [{ selected: ["SQLite"], other: "x" }],
		});
		expect(questionReplyOf({ provider: "fake" })).toBeUndefined();
	});
});

describe("drafts", () => {
	it("swaps a single-select choice, including for Other", () => {
		let draft = toggleOption(single, EMPTY_DRAFT, "Postgres");
		draft = toggleOption(single, draft, "SQLite");
		expect(draft.selected).toEqual(["SQLite"]);
		draft = toggleOther(single, draft);
		expect(draft).toMatchObject({ selected: [], otherChosen: true });
		draft = toggleOption(single, draft, "Postgres");
		expect(draft).toMatchObject({ selected: ["Postgres"], otherChosen: false });
	});

	it("toggles multi-select choices alongside Other", () => {
		let draft = toggleOption(multi, EMPTY_DRAFT, "Postgres");
		draft = toggleOption(multi, draft, "SQLite");
		draft = toggleOther(multi, draft);
		draft = toggleOption(multi, draft, "Postgres");
		expect(draft).toMatchObject({ selected: ["SQLite"], otherChosen: true });
	});

	it("needs every question answered, and Other needs text", () => {
		const chosen = toggleOption(single, EMPTY_DRAFT, "Postgres");
		const otherEmpty = toggleOther(multi, EMPTY_DRAFT);
		expect(draftsComplete([single, multi], [chosen])).toBe(false);
		expect(draftsComplete([single, multi], [chosen, otherEmpty])).toBe(false);
		const otherTyped = { ...otherEmpty, other: "  Export  " };
		expect(draftsComplete([single, multi], [chosen, otherTyped])).toBe(true);
		expect(replyFromDrafts([single, multi], [chosen, otherTyped])).toEqual({
			kind: "answered",
			answers: [{ selected: ["Postgres"] }, { selected: [], other: "Export" }],
		});
	});

	it("leaves out typed text once Other is unchosen", () => {
		const draft = { ...toggleOption(single, EMPTY_DRAFT, "SQLite"), other: "draft" };
		expect(replyFromDrafts([single], [draft])).toEqual({
			kind: "answered",
			answers: [{ selected: ["SQLite"] }],
		});
	});
});

describe("skipping", () => {
	it("counts a skipped question as done, and choosing an answer undoes the skip", () => {
		const skipped = skipDraft(toggleOption(single, EMPTY_DRAFT, "SQLite"));
		expect(skipped).toMatchObject({ selected: [], skipped: true });
		expect(draftsComplete([single], [skipped])).toBe(true);
		expect(nextPending([single, multi], [EMPTY_DRAFT, skipped], 0)).toBeUndefined();
		expect(toggleOption(single, skipped, "Postgres")).toMatchObject({
			selected: ["Postgres"],
			skipped: false,
		});
		expect(toggleOther(single, skipped)).toMatchObject({ otherChosen: true, skipped: false });
	});

	it("marks skipped questions in the reply, and skipping all of them skips the call", () => {
		const chosen = toggleOption(single, EMPTY_DRAFT, "SQLite");
		const skipped = skipDraft(EMPTY_DRAFT);
		expect(replyFromDrafts([single, multi], [chosen, skipped])).toEqual({
			kind: "answered",
			answers: [{ selected: ["SQLite"] }, { selected: [], skipped: true }],
		});
		expect(replyFromDrafts([single, multi], [skipped, skipped])).toEqual({ kind: "skipped" });
		expect(answerText({ selected: [], skipped: true })).toBe("skipped");
	});
});

describe("changeDraft", () => {
	it("changes a draft the form never set up, as after opening before the questions loaded", () => {
		const drafts = changeDraft([single, multi], [], 0, (draft) =>
			toggleOption(single, draft, "SQLite"),
		);
		expect(drafts).toEqual([{ ...EMPTY_DRAFT, selected: ["SQLite"] }, EMPTY_DRAFT]);
	});
});

describe("nextPending", () => {
	const third: Question = { ...single, question: "Which host?", header: "Host" };
	const chosen = toggleOption(single, EMPTY_DRAFT, "Postgres");

	it("finds the next unanswered question, wrapping around", () => {
		expect(nextPending([single, multi, third], [EMPTY_DRAFT, chosen, EMPTY_DRAFT], 0)).toBe(2);
		expect(nextPending([single, multi, third], [EMPTY_DRAFT, chosen, chosen], 1)).toBe(0);
	});

	it("is undefined once every other question is answered", () => {
		expect(nextPending([single, multi], [EMPTY_DRAFT, chosen], 0)).toBeUndefined();
		expect(nextPending([single], [EMPTY_DRAFT], 0)).toBeUndefined();
	});
});

describe("answerText", () => {
	it("lists picked options, then the user's own words", () => {
		expect(answerText({ selected: ["Auth", "Search"], other: "Dark mode" })).toBe(
			"Auth, Search, “Dark mode”",
		);
	});
});
