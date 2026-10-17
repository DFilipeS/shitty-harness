import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessService } from "../src/index.ts";
import { discoverSkills, skillRoots } from "../src/skills/discover.ts";
import { hostSkillFs } from "../src/skills/fs.ts";
import { MIRROR_MANIFEST, mirrorSkills } from "../src/skills/mirror.ts";
import { parseSkill } from "../src/skills/parse.ts";
import { parseInvocation, restoreSkills, SkillLibrary } from "../src/skills/index.ts";
import { createFauxProviders } from "./helpers/fake-providers.ts";

const temps: string[] = [];

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeSkill(root: string, name: string, frontmatter: string, body = "Do the thing."): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
	return dir;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("parseSkill", () => {
	it("reads the spec fields and the body", () => {
		const result = parseSkill(
			"---\nname: pdf\ndescription: Work with PDFs.\nallowed-tools: Read\n---\n\n# PDF\n\nSteps.\n",
			"pdf",
		);
		expect(result).toEqual({
			ok: true,
			skill: {
				name: "pdf",
				description: "Work with PDFs.",
				body: "# PDF\n\nSteps.",
				modelInvocable: true,
				allowedTools: "Read",
				warnings: [],
			},
		});
	});

	it("skips a skill without a description or frontmatter", () => {
		expect(parseSkill("---\nname: x\n---\nbody", "x")).toEqual({
			ok: false,
			reason: "The frontmatter has no description",
		});
		expect(parseSkill("# just markdown", "x").ok).toBe(false);
	});

	it("repairs unquoted colons and warns about a mismatched name", () => {
		const result = parseSkill("---\nname: Other\ndescription: Use when: the user asks\n---\nbody", "folder");
		if (!result.ok) throw new Error(result.reason);
		expect(result.skill.description).toBe("Use when: the user asks");
		expect(result.skill.warnings).toEqual([
			'The name "Other" does not match its folder "folder"',
			"The name should use only lowercase letters, digits, and single hyphens",
		]);
	});

	it("honours disable-model-invocation", () => {
		const result = parseSkill("---\ndescription: d\ndisable-model-invocation: true\n---\n", "deploy");
		if (!result.ok) throw new Error(result.reason);
		expect(result.skill).toMatchObject({ name: "deploy", modelInvocable: false });
	});
});

describe("parseInvocation", () => {
	it("reads the skill name and the rest of the message", () => {
		expect(parseInvocation("/skill:grill-me plan the thing\nmore")).toEqual({
			name: "grill-me",
			rest: "plan the thing\nmore",
		});
		expect(parseInvocation("/skill:grill-me")).toEqual({ name: "grill-me", rest: "" });
		expect(parseInvocation("/usr/bin/foo is broken")).toBeUndefined();
		expect(parseInvocation("please /skill:x")).toBeUndefined();
	});
});

describe("discoverSkills", () => {
	it("applies precedence, follows symlinks once, and reports skipped skills", async () => {
		const workspace = await temp("skills-ws-");
		const home = await temp("skills-home-");
		const agents = join(workspace, ".agents", "skills");
		const claude = join(workspace, ".claude", "skills");
		const shared = await writeSkill(agents, "shared", "name: shared\ndescription: In both places.");
		await mkdir(claude, { recursive: true });
		await symlink(shared, join(claude, "shared"));
		await writeSkill(claude, "review", "name: review\ndescription: Project review.");
		await writeSkill(join(home, ".agents", "skills"), "review", "name: review\ndescription: User review.");
		await writeSkill(join(home, ".agents", "skills"), "broken", "name: broken");

		const catalog = await discoverSkills(hostSkillFs, skillRoots(workspace, home));
		expect(catalog.skills.map((skill) => [skill.name, skill.scope, skill.description])).toEqual([
			["shared", "project", "In both places."],
			["review", "project", "Project review."],
		]);
		expect(catalog.issues).toEqual([
			{ path: join(home, ".agents", "skills", "broken", "SKILL.md"), name: "broken", reason: "The frontmatter has no description" },
			{
				path: join(home, ".agents", "skills", "review", "SKILL.md"),
				name: "review",
				reason: `Shadowed by ${join(claude, "review", "SKILL.md")}`,
			},
		]);
	});
});

describe("mirrorSkills", () => {
	it("copies host skills, keeps the sandbox's own, and removes what the host dropped", async () => {
		const hostHome = await temp("skills-host-");
		const sandbox = await temp("skills-sandbox-");
		const hostSkills = join(hostHome, ".agents", "skills");
		const tool = await writeSkill(hostSkills, "tool", "name: tool\ndescription: Has a script.");
		await mkdir(join(tool, "scripts"));
		await writeFile(join(tool, "scripts", "run.sh"), "echo hi\n");
		await writeFile(join(tool, ".hidden"), "skip me");
		await writeSkill(hostSkills, "native", "name: native\ndescription: Host copy.");
		const targetDir = join(sandbox, ".agents", "skills");
		await writeSkill(targetDir, "native", "name: native\ndescription: Sandbox copy.");

		const env = new NodeExecutionEnv({ cwd: sandbox });
		const host = await discoverSkills(hostSkillFs, skillRoots(undefined, hostHome));
		const first = await mirrorSkills(hostSkillFs, host.skills, env, targetDir, BACKGROUND_CONTEXT);
		expect(first.mirrored).toEqual(["tool"]);
		expect(first.issues.map((issue) => issue.reason)).toEqual([
			"Not mirrored: the sandbox has its own skill with this name",
		]);
		expect(await readFile(join(targetDir, "tool", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
		await expect(readFile(join(targetDir, "tool", ".hidden"), "utf8")).rejects.toThrow();
		expect(await readFile(join(targetDir, "native", "SKILL.md"), "utf8")).toContain("Sandbox copy.");
		const manifest = JSON.parse(await readFile(join(targetDir, MIRROR_MANIFEST), "utf8")) as {
			skills: Record<string, string>;
		};
		expect(Object.keys(manifest.skills)).toEqual(["tool"]);

		const second = await mirrorSkills(hostSkillFs, host.skills, env, targetDir, BACKGROUND_CONTEXT);
		expect(second.mirrored).toEqual(["tool"]);

		const none = await mirrorSkills(hostSkillFs, [], env, targetDir, BACKGROUND_CONTEXT);
		expect(none.mirrored).toEqual([]);
		await expect(readFile(join(targetDir, "tool", "SKILL.md"), "utf8")).rejects.toThrow();
		expect(await readFile(join(targetDir, "native", "SKILL.md"), "utf8")).toContain("Sandbox copy.");
	});
});

describe("restoreSkills", () => {
	const block = '<skill name="pdf" scope="user">\nSteps.\n</skill>';
	const active = [{ name: "pdf", block, activatedAt: 1 }];

	it("leaves messages that still carry the skill alone", () => {
		const messages: Message[] = [{ role: "user", content: `${block}\nhello`, timestamp: 1 }];
		expect(restoreSkills(messages, active)).toBeUndefined();
	});

	it("puts a skill that was compacted away in front of the first message", () => {
		const messages: Message[] = [{ role: "user", content: "Summary of earlier work", timestamp: 1 }];
		const restored = restoreSkills(messages, active);
		expect(restored).toHaveLength(1);
		const content = restored?.[0]?.content;
		expect(Array.isArray(content) && content[0]?.type === "text" ? content[0].text : "").toContain(block);
		expect(JSON.stringify(restored)).toContain("Summary of earlier work");
	});
});

describe("skills in a session", () => {
	it("lists skills, invokes one from the message, and lets the model activate another", async () => {
		const workspace = await temp("skills-session-");
		await writeSkill(join(workspace, ".agents", "skills"), "greet", "name: greet\ndescription: Greet people warmly.", "Say hello.");
		await writeSkill(
			join(workspace, ".agents", "skills"),
			"deploy",
			"name: deploy\ndescription: Ship it.\ndisable-model-invocation: true",
			"Run the deploy.",
		);
		await writeSkill(
			join(workspace, ".agents", "skills"),
			"secret",
			"name: secret\ndescription: Only for people.\ndisable-model-invocation: true",
		);
		const { providers, faux } = createFauxProviders();
		let systemPrompt = "";
		let firstUser = "";
		faux.setResponses([
			(context) => {
				systemPrompt = context.messages
					.filter((message) => message.role === "system")
					.map((message) => JSON.stringify(message))
					.join("\n");
				firstUser = JSON.stringify(context.messages.find((message) => message.role === "user"));
				return fauxAssistantMessage([fauxToolCall("skill", { name: "greet" })], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxToolCall("skill", { name: "greet" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("skill", { name: "secret" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done."),
		]);
		const service = await HarnessService.create({
			storage: new MemoryStorage(),
			providers,
			environment: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
		});
		try {
			const created = await service.createSession();
			await service.setTarget(created.id, { kind: "local", path: workspace });

			const listed = await service.listSkills(created.id);
			expect(listed.skills.map((skill) => [skill.name, skill.modelInvocable])).toEqual([
				["deploy", false],
				["greet", true],
				["secret", false],
			]);

			await expect(service.prompt(created.id, "/skill:nope hi", "request-unknown")).rejects.toThrow(
				"Unknown skill: nope",
			);
			await service.prompt(created.id, "/skill:deploy to staging", "request-invoke");
			await waitFor(async () => (await service.listSessions())[0]?.working === true);
			await waitFor(async () => (await service.listSessions())[0]?.working === false);

			expect((await service.listSessions())[0]?.title).toBe("to staging");
			expect(firstUser).toContain('<skill name=\\"deploy\\" scope=\\"project\\">');
			expect(firstUser).toContain("Run the deploy.");
			expect(firstUser).toContain("to staging");
			expect(systemPrompt).toContain("<name>greet</name>");
			expect(systemPrompt).not.toContain("<name>deploy</name>");

			const { snapshot, unsubscribe } = await service.subscribeSession(created.id, () => {});
			unsubscribe();
			const results = snapshot.entries
				.filter((entry) => entry.kind === "pi.tool-result")
				.map((entry) => JSON.stringify(entry.model));
			expect(results).toHaveLength(3);
			expect(results[0]).toContain("Say hello.");
			expect(results[1]).toContain("already active");
			expect(results[2]).toContain('Unknown skill \\"secret\\". Available skills: greet.');
		} finally {
			await service.close();
		}
	});
});

describe("SkillLibrary on a sandbox target", () => {
	it("mirrors host skills, scans through the environment, and lists offline from the last scan", async () => {
		const hostHome = await temp("skills-lib-host-");
		const sandboxHome = await temp("skills-lib-sandbox-");
		const workspace = join(sandboxHome, "workspace");
		await writeSkill(join(hostHome, ".agents", "skills"), "mine", "name: mine\ndescription: From the host.");
		await writeSkill(join(workspace, ".agents", "skills"), "repo", "name: repo\ndescription: From the repo.");

		const local = new NodeExecutionEnv({ cwd: workspace });
		// The sandbox's shell reports its own home; everything else is a plain local environment.
		const env = new Proxy(local, {
			get(target, property, receiver) {
				if (property === "id") return "sandbox:test:1";
				if (property === "exec") {
					return async (_command: unknown, options: { onOutput?: (text: string, context: unknown, info: { stream: string }) => void } | undefined) => {
						options?.onOutput?.(sandboxHome, BACKGROUND_CONTEXT, { stream: "stdout" });
						return { ok: true, value: { exitCode: 0 } };
					};
				}
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
			},
		});
		const library = new SkillLibrary({
			home: hostHome,
			resolveTarget: async () => ({ kind: "sandbox", provider: "test", sandboxId: "1", workspaceDir: workspace, forwardAgent: false }),
		});
		const read = {} as DocumentReader;
		const id = 1 as ConversationId;

		const scanned = await library.catalog(read, id, env, BACKGROUND_CONTEXT);
		expect(scanned.skills.map((skill) => [skill.name, skill.scope, skill.mirrored === true, skill.dir])).toEqual([
			["repo", "project", false, join(workspace, ".agents", "skills", "repo")],
			["mine", "user", true, join(sandboxHome, ".agents", "skills", "mine")],
		]);
		expect(await readFile(join(sandboxHome, ".agents", "skills", "mine", "SKILL.md"), "utf8")).toContain("From the host.");

		await writeSkill(join(hostHome, ".agents", "skills"), "later", "name: later\ndescription: Added after the scan.");
		library.invalidate(id);
		const offline = await library.list(read, id, BACKGROUND_CONTEXT);
		expect(offline.skills.map((skill) => skill.name)).toEqual(["repo", "mine", "later"]);
	});
});
