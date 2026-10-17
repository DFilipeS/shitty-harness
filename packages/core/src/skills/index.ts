import { join } from "node:path/posix";
import type { Context } from "@earendil-works/chord";
import { Type, type Message, type TextContent } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineExtension,
	defineTool,
	GenerationTask,
	hook,
	section,
	type ConversationId,
	type DocumentReader,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ResolvedTarget } from "../targets.ts";
import {
	discoverSkills,
	EMPTY_CATALOG,
	mergeCatalogs,
	skillRoots,
	type Skill,
	type SkillCatalog,
} from "./discover.ts";
import { envHome, envSkillFs, hostSkillFs, type SkillFs } from "./fs.ts";
import { listSkillFiles, mirrorSkills, type MirrorResult } from "./mirror.ts";

export { parseSkill, type ParsedSkill, type ParseSkillResult } from "./parse.ts";
export {
	discoverSkills,
	mergeCatalogs,
	skillRoots,
	type Skill,
	type SkillCatalog,
	type SkillIssue,
	type SkillRoot,
	type SkillScope,
} from "./discover.ts";
export { hostSkillFs, envSkillFs, type SkillFs } from "./fs.ts";
export { mirrorSkills, MIRROR_MANIFEST } from "./mirror.ts";

/** The name of the tool the model activates skills with. */
export const SKILL_TOOL_NAME = "skill";

/** At most this many of a skill's files are listed when it is activated; none are read. */
const MAX_LISTED_FILES = 50;

/** One activated skill, with the content the model was given. */
export type ActiveSkill = {
	name: string;
	block: string;
	activatedAt: number;
};

export type SkillsState = {
	active: ActiveSkill[];
};

/**
 * Conversation-scoped record of the skills activated in a conversation, by the model or the user.
 * The `beforeRequest` hook reads it to put back skills a compaction summarized away.
 */
export const SkillsDoc = defineDoc<SkillsState>({
	kind: "app.skills",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ active: [] }),
});

/** Remember one activation; activating a skill again replaces its earlier content. */
export function recordActivation(state: SkillsState, name: string, block: string): void {
	state.active = state.active.filter((entry) => entry.name !== name);
	state.active.push({ name, block, activatedAt: Date.now() });
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function escapeText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The start of every skill block; the marker the compaction hook looks for. */
function skillMarker(name: string): string {
	return `<skill name="${escapeAttribute(name)}"`;
}

/**
 * The content a skill is activated with, by the tool or by an invocation: its instructions, its
 * directory, and its files, which the model reads on demand.
 */
export function skillBlock(skill: Skill, files: readonly string[], truncated: boolean): string {
	const lines = [`${skillMarker(skill.name)} scope="${skill.scope}">`, skill.body, ""];
	lines.push(`Skill directory: ${skill.dir}`);
	lines.push("Relative paths in this skill are relative to the skill directory.");
	if (files.length > 0) {
		lines.push("<skill_resources>");
		for (const file of files) lines.push(`<file>${escapeText(file)}</file>`);
		if (truncated) lines.push("<!-- more files not listed -->");
		lines.push("</skill_resources>");
	}
	lines.push("</skill>");
	return lines.join("\n");
}

/** A `/skill:name` invocation at the start of a message, and the text after it. */
export function parseInvocation(text: string): { name: string; rest: string } | undefined {
	const match = /^\/skill:(\S*)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (match === null) return undefined;
	return { name: match[1] ?? "", rest: (match[2] ?? "").trim() };
}

export type SkillLibraryOptions = {
	/** The host's home directory, for user skills; without one, only project skills load. */
	home?: string;
	resolveTarget: (read: DocumentReader, conversationId: ConversationId, context: Context) => Promise<ResolvedTarget>;
	/** Overrides the host file access, for tests. */
	hostFs?: SkillFs;
};

type CachedCatalog = {
	catalog: SkillCatalog;
	/** Which target the catalog was scanned on; another target means a rescan. */
	targetKey: string;
	stale: boolean;
};

function targetKey(target: ResolvedTarget): string {
	return target.kind === "local"
		? `local:${target.path}`
		: `sandbox:${target.provider}:${target.sandboxId ?? ""}:${target.workspaceDir}`;
}

/**
 * Finds the skills of each session's target and caches them per conversation. A conversation
 * rescans when the service marks it stale (each new prompt), so a run sees fresh skills while
 * the requests within it keep the prompt cache warm.
 */
export class SkillLibrary {
	readonly #options: SkillLibraryOptions;
	readonly #host: SkillFs;
	readonly #cache = new Map<ConversationId, CachedCatalog>();
	/** One mirror sync at a time per sandbox environment. */
	readonly #mirrors = new Map<string, Promise<MirrorResult>>();
	readonly #homes = new Map<string, string>();

	constructor(options: SkillLibraryOptions) {
		this.#options = options;
		this.#host = options.hostFs ?? hostSkillFs;
	}

	/** Rescan before the conversation's next request. */
	invalidate(conversationId: ConversationId): void {
		const cached = this.#cache.get(conversationId);
		if (cached !== undefined) cached.stale = true;
	}

	/**
	 * The conversation's skills. A sandbox target is scanned only through `env`, which the caller
	 * already holds open; without one, the last scan stands, merged with the host's user skills.
	 */
	async catalog(
		read: DocumentReader,
		conversationId: ConversationId,
		env: ExecutionEnv | undefined,
		context: Context,
	): Promise<SkillCatalog> {
		const target = await this.#options.resolveTarget(read, conversationId, context);
		const key = targetKey(target);
		const cached = this.#cache.get(conversationId);
		if (cached !== undefined && !cached.stale && cached.targetKey === key) return cached.catalog;
		const catalog = await this.#scan(target, env, context);
		if (catalog === undefined) return this.#offline(cached?.targetKey === key ? cached.catalog : undefined);
		this.#cache.set(conversationId, { catalog, targetKey: key, stale: false });
		return catalog;
	}

	/** The skills a client lists without opening a sandbox. */
	async list(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<SkillCatalog> {
		return this.catalog(read, conversationId, undefined, context);
	}

	/**
	 * Resolve one skill and build the block it is activated with. `modelOnly` hides the skills that
	 * opted out of model invocation, as the tool must.
	 */
	async activate(
		read: DocumentReader,
		conversationId: ConversationId,
		env: ExecutionEnv | undefined,
		name: string,
		options: { modelOnly: boolean },
		context: Context,
	): Promise<{ skill: Skill; block: string } | { available: string[] }> {
		const catalog = await this.catalog(read, conversationId, env, context);
		const usable = catalog.skills.filter((skill) => !options.modelOnly || skill.modelInvocable);
		const skill = usable.find((candidate) => candidate.name === name);
		if (skill === undefined) return { available: usable.map((candidate) => candidate.name) };
		const target = await this.#options.resolveTarget(read, conversationId, context);
		const fs = target.kind === "sandbox" && env !== undefined ? envSkillFs(env, context) : this.#host;
		const files = (await listSkillFiles(fs, skill.dir, MAX_LISTED_FILES + 2)).map((file) => file.path);
		const resources = files.filter((file) => file !== "SKILL.md");
		const truncated = resources.length > MAX_LISTED_FILES;
		return { skill, block: skillBlock(skill, resources.slice(0, MAX_LISTED_FILES), truncated) };
	}

	async #scan(target: ResolvedTarget, env: ExecutionEnv | undefined, context: Context): Promise<SkillCatalog | undefined> {
		if (target.kind === "local") {
			return discoverSkills(this.#host, skillRoots(target.path, this.#options.home));
		}
		if (env === undefined) return undefined;
		const home = await this.#sandboxHome(env, context);
		if (home === undefined) return undefined;
		const mirrorDir = join(home, ".agents", "skills");
		const hostSkills = await this.#hostUserSkills();
		const mirror = await this.#mirror(env, hostSkills.skills, mirrorDir, context);
		const found = await discoverSkills(envSkillFs(env, context), skillRoots(target.workspaceDir, home));
		const mirrored = new Set(mirror.mirrored);
		const skills = found.skills.map((skill) =>
			skill.scope === "user" && mirrored.has(skill.name) && skill.dir === join(mirrorDir, skill.name)
				? { ...skill, mirrored: true }
				: skill,
		);
		return { skills, issues: [...hostSkills.issues, ...mirror.issues, ...found.issues] };
	}

	/** Without the sandbox: the last scan, then the host's user skills it may not have mirrored yet. */
	async #offline(last: SkillCatalog | undefined): Promise<SkillCatalog> {
		const host = await this.#hostUserSkills();
		return mergeCatalogs([last ?? EMPTY_CATALOG, { skills: host.skills.map((skill) => ({ ...skill, mirrored: true })), issues: [] }]);
	}

	async #hostUserSkills(): Promise<SkillCatalog> {
		if (this.#options.home === undefined) return EMPTY_CATALOG;
		return discoverSkills(this.#host, skillRoots(undefined, this.#options.home));
	}

	async #sandboxHome(env: ExecutionEnv, context: Context): Promise<string | undefined> {
		const known = this.#homes.get(env.id);
		if (known !== undefined) return known;
		const home = await envHome(env, context);
		if (home !== undefined) this.#homes.set(env.id, home);
		return home;
	}

	async #mirror(env: ExecutionEnv, skills: readonly Skill[], dir: string, context: Context): Promise<MirrorResult> {
		const running = this.#mirrors.get(env.id);
		if (running !== undefined) return running;
		const promise = mirrorSkills(this.#host, skills, env, dir, context).finally(() => {
			this.#mirrors.delete(env.id);
		});
		this.#mirrors.set(env.id, promise);
		return promise;
	}
}

/** True when a message carries the block of the skill with this marker. */
function mentions(message: Message, marker: string): boolean {
	if (message.role === "assistant") return false;
	const content = message.content;
	if (typeof content === "string") return content.includes(marker);
	return content.some((part) => part.type === "text" && part.text.includes(marker));
}

/**
 * Put skills back in front of a request whose messages no longer carry them, which is what a
 * compaction does to a skill activated before it. The added text is the same for every request, so
 * the prompt cache still covers it.
 */
export function restoreSkills(messages: readonly Message[], active: readonly ActiveSkill[]): readonly Message[] | undefined {
	const missing = active.filter((entry) => !messages.some((message) => mentions(message, skillMarker(entry.name))));
	if (missing.length === 0) return undefined;
	const note: TextContent = {
		type: "text",
		text: `Skills activated earlier in this conversation; keep following them:\n\n${missing.map((entry) => entry.block).join("\n\n")}`,
	};
	const [first, ...rest] = messages;
	if (first?.role === "user") {
		const content = typeof first.content === "string" ? [{ type: "text" as const, text: first.content }] : first.content;
		return [{ ...first, content: [note, ...content] }, ...rest];
	}
	return [{ role: "user", content: [note], timestamp: first?.timestamp ?? 0 }, ...messages];
}

function skillParameters() {
	return Type.Object({
		name: Type.String({ description: "The skill's name, exactly as listed." }),
	});
}

const SKILL_INSTRUCTIONS = [
	"The skills below provide specialized instructions for specific tasks.",
	`When a task matches a skill's description, call the \`${SKILL_TOOL_NAME}\` tool with its name to load the full instructions before you start.`,
	"A message that begins with a <skill> block means the user activated that skill: follow its instructions.",
	"When a skill refers to a relative path, resolve it against the skill directory and pass the absolute path to your tools.",
].join(" ");

/** What the `skill` tool reports to UIs. */
export type SkillToolDetails = {
	name: string;
	scope?: string;
	path?: string;
	alreadyActive?: boolean;
};

/** The `skills` extension: the catalog section, the activation tool, and the compaction guard. */
export function createSkillsExtension(library: SkillLibrary) {
	const tool = defineTool<ReturnType<typeof skillParameters>, SkillToolDetails>({
		name: SKILL_TOOL_NAME,
		description:
			"Load a skill's full instructions into the conversation. Use it when a task matches one of the skills listed in your instructions, before doing the task.",
		parameters: skillParameters(),
		execute: async (args, api, context) => {
			const state = await api.snapshot(SkillsDoc, api.conversationId, context);
			if (state?.active.some((entry) => entry.name === args.name) === true) {
				return {
					output: [
						{
							type: "text",
							text: `The ${args.name} skill is already active: its instructions are earlier in this conversation.`,
						},
					],
					details: { name: args.name, alreadyActive: true } satisfies SkillToolDetails,
				};
			}
			const result = await library.activate(api, api.conversationId, api.env, args.name, { modelOnly: true }, context);
			if ("available" in result) {
				const names = result.available.length === 0 ? "none" : result.available.join(", ");
				throw new Error(`Unknown skill "${args.name}". Available skills: ${names}.`);
			}
			await api.commit(async (tx) => {
				recordActivation(await tx.doc(SkillsDoc, api.conversationId), result.skill.name, result.block);
			}, context);
			return {
				output: [{ type: "text", text: result.block }],
				details: { name: result.skill.name, scope: result.skill.scope, path: result.skill.path } satisfies SkillToolDetails,
			};
		},
	});

	return defineExtension({
		name: "skills",
		tools: [tool],
		sections: [
			section("skills", async (input, context) => {
				if (!input.agent.tools.some((candidate) => candidate.name === SKILL_TOOL_NAME)) return undefined;
				const catalog = await library.catalog(input.read, input.conversationId, input.env, context);
				const offered = catalog.skills.filter((skill) => skill.modelInvocable);
				if (offered.length === 0) return undefined;
				const lines = [SKILL_INSTRUCTIONS, "<available_skills>"];
				for (const skill of offered) {
					lines.push(
						"<skill>",
						`<name>${escapeText(skill.name)}</name>`,
						`<description>${escapeText(skill.description)}</description>`,
						"</skill>",
					);
				}
				lines.push("</available_skills>");
				return lines.join("\n");
			}),
		],
		hooks: [
			hook(GenerationTask, {
				beforeRequest: async (request, api, context) => {
					const state = await api.snapshot(SkillsDoc, api.conversationId, context);
					if (state === undefined || state.active.length === 0) return undefined;
					const messages = restoreSkills(request.messages, state.active);
					return messages === undefined ? undefined : { messages };
				},
			}),
		],
	});
}
