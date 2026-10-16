import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { lazyEnvironment } from "../src/environment.ts";
import { HarnessService } from "../src/index.ts";
import { localEnvironment } from "../src/node.ts";
import { targetPrompt } from "../src/targets.ts";
import { createFakeProviders, createFauxProviders } from "./helpers/fake-providers.ts";

/** Poll a predicate until it holds or `timeoutMs` passes. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function exists(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined)) !== undefined;
}

describe("targets", () => {
	it("names the provider in the target prompt", () => {
		expect(
			targetPrompt({ kind: "sandbox", provider: "e2b", sandboxId: "abc123", workspaceDir: "/home/user/workspace" }, "E2B"),
		).toContain("sandbox E2B:abc123");
	});

	it("gives a new session a scratch target under the workspaces root", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			const session = await service.createSession();
			expect(session.target).toEqual({
				kind: "local",
				path: join(workspacesDir, session.id),
				scratch: true,
			});
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("switches to a picked folder and records the change in the transcript", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const folder = await mkdtemp(join(tmpdir(), "harness-folder-"));
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			const session = await service.createSession();
			const updated = await service.setTarget(session.id, { kind: "local", path: folder });
			expect(updated.target).toEqual({ kind: "local", path: folder, scratch: false });

			const { snapshot, unsubscribe } = await service.subscribeSession(session.id, () => {});
			unsubscribe();
			const changes = snapshot.entries.filter((entry) => entry.kind === "app.target");
			expect(changes).toHaveLength(1);
			expect(changes[0]?.data).toEqual({ kind: "local", path: folder, scratch: false });

			const back = await service.setTarget(session.id, { kind: "local" });
			expect(back.target).toEqual({
				kind: "local",
				path: join(workspacesDir, session.id),
				scratch: true,
			});
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(folder, { recursive: true, force: true });
		}
	});

	it("rejects a target that is not a directory", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const file = join(workspacesDir, "note.txt");
		await writeFile(file, "not a folder");
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			const session = await service.createSession();
			await expect(service.setTarget(session.id, { kind: "local", path: file })).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(service.setTarget(session.id, { kind: "local", path: join(workspacesDir, "missing") })).rejects.toMatchObject({
				code: "invalid",
			});
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("snapshots the default target for new sessions", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const folder = await mkdtemp(join(tmpdir(), "harness-default-"));
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			await service.setDefaults({ target: { kind: "local", path: folder } });
			const first = await service.createSession();
			expect(first.target).toEqual({ kind: "local", path: folder, scratch: false });

			await service.setDefaults({ target: null });
			const second = await service.createSession();
			expect(second.target.kind).toBe("local");
			if (second.target.kind === "local") expect(second.target.scratch).toBe(true);

			// The first session keeps the target it started with.
			const listed = (await service.listSessions()).find((candidate) => candidate.id === first.id);
			expect(listed?.target).toEqual({ kind: "local", path: folder, scratch: false });
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
			await rm(folder, { recursive: true, force: true });
		}
	});

	it("rejects a default target that is not a directory", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			await expect(
				service.setDefaults({ target: { kind: "local", path: join(workspacesDir, "missing") } }),
			).rejects.toMatchObject({ code: "invalid" });
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("browses and creates folders", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const providers = createFakeProviders();
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			const listing = await service.browseWorkspaces(workspacesDir);
			expect(listing.path).toBe(workspacesDir);
			expect(listing.parent).toBe(dirname(workspacesDir));
			expect(listing.directories).toEqual([]);

			const created = await service.createWorkspaceFolder(workspacesDir, "project");
			expect(created.path).toBe(join(workspacesDir, "project"));
			const next = await service.browseWorkspaces(workspacesDir);
			expect(next.directories.map((directory) => directory.name)).toEqual(["project"]);

			await expect(service.createWorkspaceFolder(workspacesDir, "project")).rejects.toMatchObject({
				code: "invalid",
			});
			await expect(service.createWorkspaceFolder(workspacesDir, "a/b")).rejects.toMatchObject({ code: "invalid" });
			await expect(service.browseWorkspaces(join(workspacesDir, "missing"))).rejects.toMatchObject({
				code: "not_found",
			});
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("refuses to change the target while a run is active", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const { providers, faux } = createFauxProviders({ text: "thinking about it ".repeat(50), tokensPerSecond: 5 });
		faux.setResponses([fauxAssistantMessage("thinking about it ".repeat(50))]);
		const service = await HarnessService.create({ storage: new MemoryStorage(), providers, workspacesDir });
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "Go", "request-busy");
			const started = await waitFor(async () => (await service.listSessions())[0]?.working === true);
			expect(started).toBe(true);
			await expect(service.setTarget(session.id, { kind: "local" })).rejects.toMatchObject({ code: "busy" });
			await service.abort(session.id);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("tells the model where its tools run", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const { providers, faux } = createFauxProviders();
		let prompt = "";
		faux.setResponses([
			(context) => {
				prompt = context.messages
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify(message))
					.join("\n");
				return fauxAssistantMessage("ok");
			},
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			workspacesDir,
			environment: localEnvironment(),
		});
		try {
			const session = await service.createSession();
			await service.prompt(session.id, "hello", "request-prompt");
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(prompt).toContain("Your tools run on the local machine in");
			expect(prompt).toContain(join(workspacesDir, session.id));
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});

	it("creates the scratch directory only when the environment is first used", async () => {
		const workspacesDir = await mkdtemp(join(tmpdir(), "harness-targets-"));
		const { providers, faux } = createFauxProviders();
		faux.setResponses([
			fauxAssistantMessage("Just chatting."),
			fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi from the tool\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			workspacesDir,
			environment: localEnvironment(),
		});
		try {
			const session = await service.createSession();
			const scratch = join(workspacesDir, session.id);

			// A chat-only run builds the environment but never touches it.
			await service.prompt(session.id, "Hello", "request-chat");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(await exists(scratch)).toBe(false);

			// The first tool call materializes it.
			await service.prompt(session.id, "Write hello.txt", "request-tool");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);
			expect(await exists(scratch)).toBe(true);
			expect(await readFile(join(scratch, "hello.txt"), "utf8")).toBe("hi from the tool\n");
		} finally {
			await service.close();
			await rm(workspacesDir, { recursive: true, force: true });
		}
	});
});

describe("lazyEnvironment", () => {
	it("resolves the real environment on first use and is not thenable", async () => {
		const root = await mkdtemp(join(tmpdir(), "harness-lazy-"));
		try {
			let built = 0;
			const env = lazyEnvironment("test:lazy", root, async () => {
				built += 1;
				return new NodeExecutionEnv({ cwd: root });
			});
			expect(env.id).toBe("test:lazy");
			expect(env.cwd).toBe(root);
			// Awaiting it must not call the resolver through a `then` probe.
			expect(await Promise.resolve(env)).toBe(env);
			expect(built).toBe(0);

			const written = await env.writeFile("note.txt", "hi", BACKGROUND_CONTEXT);
			expect(written.ok).toBe(true);
			expect(built).toBe(1);
			expect(await readFile(join(root, "note.txt"), "utf8")).toBe("hi");

			await env.writeFile("again.txt", "hi", BACKGROUND_CONTEXT);
			expect(built).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
