import { dirname, join } from "node:path/posix";
import type { Context } from "@earendil-works/chord";
import { section, type ConversationId, type DocumentReader } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { envHome, envSkillFs, hostSkillFs, type SkillFs } from "./skills/fs.ts";
import type { ResolvedTarget } from "./targets.ts";

/**
 * Project instructions: the context files a workspace carries. One file per directory, the first
 * of these names (Pi's candidates, so projects behave the same under either agent), plus a
 * user-global file from the target's `<home>/.agents/`. The walk covers every ancestor of the
 * workspace up to the filesystem root, so a home-directory file reaches scratch sessions too.
 */
export const CONTEXT_FILE_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

/** A context file larger than this is truncated, with a note saying so. */
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

/** One loaded context file. */
export type ContextFile = {
	/** As the target sees it. */
	path: string;
	text: string;
	/** True when `text` was cut down from a larger file. */
	truncated: boolean;
};

/** A file found in a directory but not yet read. */
type Found = ContextFile;

export type ProjectInstructionsOptions = {
	/** The host's home directory, for the local target's global file; without it, none loads. */
	home?: string;
	resolveTarget: (read: DocumentReader, conversationId: ConversationId, context: Context) => Promise<ResolvedTarget>;
	/** Overrides the host file access, for tests. */
	hostFs?: SkillFs;
};

type CachedFiles = {
	files: ContextFile[];
	/** Which target the files came from; another target means a rescan. */
	targetKey: string;
	stale: boolean;
};

function targetKey(target: ResolvedTarget): string {
	return target.kind === "local"
		? `local:${target.path}`
		: `sandbox:${target.provider}:${target.sandboxId ?? ""}:${target.workspaceDir}`;
}

/**
 * Finds a conversation's context files and caches them per conversation, mirroring the skills
 * library: the service marks them stale with each new prompt, so a run sees fresh files while
 * the requests within it keep the prompt cache warm. A sandbox is read only through `env`,
 * which the caller already holds open; without one, the last scan stands.
 */
export class ProjectInstructionsLibrary {
	readonly #options: ProjectInstructionsOptions;
	readonly #host: SkillFs;
	readonly #cache = new Map<ConversationId, CachedFiles>();
	readonly #homes = new Map<string, string>();

	constructor(options: ProjectInstructionsOptions) {
		this.#options = options;
		this.#host = options.hostFs ?? hostSkillFs;
	}

	/** Rescan before the conversation's next request. */
	invalidate(conversationId: ConversationId): void {
		const cached = this.#cache.get(conversationId);
		if (cached !== undefined) cached.stale = true;
	}

	/** The conversation's context files, global slot first, then ancestors outermost-first. */
	async files(
		read: DocumentReader,
		conversationId: ConversationId,
		env: ExecutionEnv | undefined,
		context: Context,
	): Promise<ContextFile[]> {
		const target = await this.#options.resolveTarget(read, conversationId, context);
		const key = targetKey(target);
		const cached = this.#cache.get(conversationId);
		if (cached !== undefined && !cached.stale && cached.targetKey === key) return cached.files;
		const files = await this.#scan(target, env, context);
		if (files === undefined) return cached?.targetKey === key ? cached.files : [];
		this.#cache.set(conversationId, { files, targetKey: key, stale: false });
		return files;
	}

	async #scan(target: ResolvedTarget, env: ExecutionEnv | undefined, context: Context): Promise<ContextFile[] | undefined> {
		if (target.kind === "local") {
			return loadContextFiles(this.#host, target.path, this.#options.home);
		}
		if (env === undefined) return undefined;
		const home = await this.#sandboxHome(env, context);
		if (home === undefined) return undefined;
		return loadContextFiles(envSkillFs(env, context), target.workspaceDir, home);
	}

	async #sandboxHome(env: ExecutionEnv, context: Context): Promise<string | undefined> {
		const known = this.#homes.get(env.id);
		if (known !== undefined) return known;
		const home = await envHome(env, context);
		if (home !== undefined) this.#homes.set(env.id, home);
		return home;
	}
}

/**
 * The first candidate `dir` carries, read. A symlink counts as a candidate (listings report
 * them apart from files, and a linked AGENTS.md is a normal setup); a broken or directory
 * link fails the read and the next candidate gets its chance, as Pi's `existsSync` would.
 */
async function contextFileIn(fs: SkillFs, dir: string): Promise<ContextFile | undefined> {
	const entries = await fs.list(dir);
	if (entries === undefined) return undefined;
	const listed = new Set(entries.filter((entry) => entry.kind !== "directory").map((entry) => entry.name));
	for (const candidate of CONTEXT_FILE_CANDIDATES) {
		if (!listed.has(candidate)) continue;
		const file = await readContextFile(fs, join(dir, candidate));
		if (file !== undefined) return file;
	}
	return undefined;
}

/**
 * Load the context files of one workspace: the global slot, then one file per ancestor of the
 * workspace up to the filesystem root, ordered outermost-first so nearer files read last.
 */
export async function loadContextFiles(
	fs: SkillFs,
	workspace: string,
	home: string | undefined,
): Promise<ContextFile[]> {
	const files: ContextFile[] = [];
	const seen = new Set<string>();
	const push = (file: ContextFile | undefined) => {
		if (file === undefined || seen.has(file.path)) return;
		seen.add(file.path);
		files.push(file);
	};
	push(home === undefined ? undefined : await contextFileIn(fs, join(home, ".agents")));
	const ancestors: Found[] = [];
	let dir = workspace;
	for (;;) {
		const file = await contextFileIn(fs, dir);
		// `push` owns the dedup mark; the walk only checks, so ancestors still load.
		if (file !== undefined && !seen.has(file.path)) ancestors.unshift(file);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const found of ancestors) push(found);
	return files;
}

/** Read one file, strip its BOM, and cut it down to the size cap with a note when it exceeds it. */
async function readContextFile(fs: SkillFs, path: string): Promise<ContextFile | undefined> {
	const raw = await fs.readText(path);
	if (raw === undefined) return undefined;
	const text = raw.replace(/^\uFEFF/, "");
	const bytes = byteLength(text);
	if (bytes <= MAX_CONTEXT_FILE_BYTES) return { path, text, truncated: false };
	return { path, text: truncateBytes(text), truncated: true };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** The longest prefix that fits the cap; UTF-8 bytes are never fewer than chars, so `max` bounds it. */
function truncateBytes(text: string): string {
	let end = MAX_CONTEXT_FILE_BYTES;
	while (end > 0 && byteLength(text.slice(0, end)) > MAX_CONTEXT_FILE_BYTES) end = Math.floor(end / 2);
	return text.slice(0, end);
}

/**
 * The `project-instructions` prompt section: each loaded file framed by its path, exactly as Pi
 * frames them. Renders nothing when the target carries no context files.
 */
export function createProjectInstructionsSection(library: ProjectInstructionsLibrary) {
	return section("project-instructions", async (input, context) => {
		const files = await library.files(input.read, input.conversationId, input.env, context);
		if (files.length === 0) return undefined;
		return files
			.map((file) =>
				[
					`<project_instructions path="${file.path}">`,
					file.text,
					file.truncated ? `[Truncated: this file exceeds the ${MAX_CONTEXT_FILE_BYTES}-byte cap.]` : "",
					"</project_instructions>",
				]
					.filter((line) => line !== "")
					.join("\n"),
			)
			.join("\n\n");
	});
}
