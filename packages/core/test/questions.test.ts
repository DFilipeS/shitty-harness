import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Question, SessionSummary } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { HarnessService } from "../src/index.ts";
import { replyText, validateReply } from "../src/questions.ts";
import { createFauxProviders } from "./helpers/fake-providers.ts";

/** Poll a predicate until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const QUESTIONS: Question[] = [
	{
		question: "Which database should we use?",
		header: "Database",
		options: [
			{ label: "Postgres", description: "Relational" },
			{ label: "SQLite", description: "Embedded" },
		],
	},
	{
		question: "Which features do you want?",
		header: "Features",
		options: [
			{ label: "Auth", description: "Sign-in" },
			{ label: "Search", description: "Full text" },
			{ label: "Export", description: "CSV" },
		],
		multiSelect: true,
	},
];

async function session(service: HarnessService, id: string): Promise<SessionSummary | undefined> {
	return (await service.listSessions()).find((candidate) => candidate.id === id);
}

async function toolResults(service: HarnessService, id: string) {
	const { snapshot, unsubscribe } = await service.subscribeSession(id, () => {});
	unsubscribe();
	return snapshot.entries.filter((entry) => entry.kind === "pi.tool-result");
}

describe("ask_user", () => {
	it("waits for the answer and returns it as the call's result", async () => {
		const { providers, faux } = createFauxProviders({ tokensPerSecond: 5_000 });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { questions: QUESTIONS }, { id: "ask-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Thanks."),
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const { id } = await service.createSession();
			await service.prompt(id, "Plan the app", "request-ask");
			expect(await waitFor(async () => (await session(service, id))?.needsInput === true)).toBe(true);
			expect(await session(service, id)).toMatchObject({ working: false, needsInput: true, questionCallId: "ask-1" });

			await expect(
				service.answer(id, "ask-1", { kind: "answered", answers: [{ selected: ["Postgres", "SQLite"] }, { selected: ["Auth"] }] }),
			).rejects.toThrow("takes one answer");
			await service.answer(id, "ask-1", {
				kind: "answered",
				answers: [{ selected: ["SQLite"] }, { selected: ["Auth", "Search"], other: " Dark mode " }],
			});
			// The first reply wins.
			await expect(service.answer(id, "ask-1", { kind: "skipped" })).rejects.toThrow("no longer open");

			expect(await waitFor(async () => (await session(service, id))?.working === false && (await toolResults(service, id)).length === 1)).toBe(true);
			const [result] = await toolResults(service, id);
			const text = JSON.stringify(result?.model);
			expect(text).toContain("SQLite");
			expect(text).toContain("Auth; Search; (in their own words) Dark mode");
			expect(await session(service, id)).toMatchObject({ needsInput: false });
		} finally {
			await service.close();
		}
	});

	it("tells the model when the user skipped", async () => {
		const { providers, faux } = createFauxProviders({ tokensPerSecond: 5_000 });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { questions: QUESTIONS }, { id: "ask-skip" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Going with defaults."),
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const { id } = await service.createSession();
			await service.prompt(id, "Plan the app", "request-skip");
			expect(await waitFor(async () => (await session(service, id))?.needsInput === true)).toBe(true);
			await service.answer(id, "ask-skip", { kind: "skipped" });
			expect(await waitFor(async () => (await toolResults(service, id)).length === 1)).toBe(true);
			expect(JSON.stringify((await toolResults(service, id))[0]?.model)).toContain("skipped the questions");
		} finally {
			await service.close();
		}
	});

	it("closes the question when the run is stopped", async () => {
		const { providers, faux } = createFauxProviders({ tokensPerSecond: 5_000 });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ask_user", { questions: QUESTIONS }, { id: "ask-stop" })], {
				stopReason: "toolUse",
			}),
		]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers });
		try {
			const { id } = await service.createSession();
			await service.prompt(id, "Plan the app", "request-stop");
			expect(await waitFor(async () => (await session(service, id))?.needsInput === true)).toBe(true);
			await service.abort(id);
			expect(await session(service, id)).toMatchObject({ working: false, needsInput: false });
			await expect(service.answer(id, "ask-stop", { kind: "skipped" })).rejects.toThrow("no longer open");
		} finally {
			await service.close();
		}
	});

	it("keeps the question open across a restart", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harness-questions-"));
		const open = (): Promise<Storage> => openNodeSqliteStorage(join(dir, "sessions.sqlite"));
		try {
			const first = createFauxProviders({ tokensPerSecond: 5_000 });
			first.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("ask_user", { questions: QUESTIONS }, { id: "ask-restart" })], {
					stopReason: "toolUse",
				}),
			]);
			const before = await HarnessService.create({ storage: await open(), providers: first.providers });
			const { id } = await before.createSession();
			await before.prompt(id, "Plan the app", "request-restart");
			expect(await waitFor(async () => (await session(before, id))?.needsInput === true)).toBe(true);
			await before.close();

			const second = createFauxProviders({ tokensPerSecond: 5_000 });
			second.faux.setResponses([fauxAssistantMessage("Thanks.")]);
			const after = await HarnessService.create({ storage: await open(), providers: second.providers });
			try {
				expect(await waitFor(async () => (await session(after, id))?.needsInput === true)).toBe(true);
				await after.answer(id, "ask-restart", { kind: "answered", answers: [{ selected: ["Postgres"] }, { selected: ["Export"] }] });
				expect(await waitFor(async () => (await toolResults(after, id)).length === 1)).toBe(true);
				expect(JSON.stringify((await toolResults(after, id))[0]?.model)).toContain("Postgres");
			} finally {
				await after.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("question replies", () => {
	it("rejects answers that do not fit the questions", () => {
		expect(() => validateReply(QUESTIONS, { kind: "answered", answers: [{ selected: ["SQLite"] }] })).toThrow(
			"Expected 2 answers",
		);
		expect(() =>
			validateReply(QUESTIONS, { kind: "answered", answers: [{ selected: ["MySQL"] }, { selected: ["Auth"] }] }),
		).toThrow("Not an option");
		expect(() =>
			validateReply(QUESTIONS, { kind: "answered", answers: [{ selected: [], other: "  " }, { selected: ["Auth"] }] }),
		).toThrow("has no answer");
	});

	it("keeps skipped questions apart, and turns skipping all of them into a skip", () => {
		const reply = validateReply(QUESTIONS, {
			kind: "answered",
			answers: [{ selected: [], skipped: true }, { selected: ["Auth"] }],
		});
		expect(replyText(QUESTIONS, reply)).toBe(
			"The user answered:\n1. Which database should we use?\n   (skipped; use your own judgment)\n2. Which features do you want?\n   Auth",
		);
		expect(
			validateReply(QUESTIONS, {
				kind: "answered",
				answers: [{ selected: [], skipped: true }, { selected: [], skipped: true }],
			}),
		).toEqual({ kind: "skipped" });
	});

	it("reads each answer on its own line", () => {
		const reply = validateReply(QUESTIONS, {
			kind: "answered",
			answers: [{ selected: [], other: "DuckDB" }, { selected: ["Export"] }],
		});
		expect(replyText(QUESTIONS, reply)).toBe(
			"The user answered:\n1. Which database should we use?\n   (in their own words) DuckDB\n2. Which features do you want?\n   Export",
		);
	});
});
