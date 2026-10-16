import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxError, type ProviderTemplate, type SandboxProvider } from "./provider.ts";
import {
	parseRecipe,
	serializeRecipe,
	STARTER_RECIPE,
	STARTER_TEMPLATE_NAME,
	templateName,
	type TemplateRecipe,
} from "./recipe.ts";

const RECIPE_FILE = "recipe.yaml";
const BUILD_FILE = "build.json";
const LOG_FILE = "build.log";
/** The live log kept in memory while a build runs; the full log is written to disk at the end. */
const MAX_LOG_LINES = 5_000;
/** Cap the provider template listing so a bad `nextToken` cannot loop forever. */
const MAX_TEMPLATE_PAGES = 20;

export type TemplateBuildStatus = "building" | "succeeded" | "failed";

/** What the last build of one template did, stored beside its recipe. */
export type TemplateBuildState = {
	templateId?: string;
	buildId?: string;
	status: TemplateBuildStatus;
	/** Hash of the recipe the build used, so a later edit marks the template stale. */
	recipeHash: string;
	startedAt: number;
	finishedAt?: number;
	error?: string;
};

/** The lifecycle state of a sandbox template. */
export type TemplateState = "draft" | "building" | "ready" | "stale" | "failed" | "missing";

/** One sandbox template as the UI lists it. */
export type TemplateInfo = {
	name: string;
	description?: string;
	source: TemplateRecipe["source"];
	run: string[];
	state: TemplateState;
	/** Set when the recipe file cannot be read or parsed. */
	error?: string;
	lastBuild?: {
		templateId?: string;
		buildId?: string;
		startedAt: number;
		finishedAt?: number;
		error?: string;
	};
};

export type TemplatesState = {
	provider: string;
	providerName: string;
	configured: boolean;
	templates: TemplateInfo[];
	/** The template new sandboxes use by default, when one is stored. */
	default?: string;
	/** Templates the provider knows about that the harness does not manage. */
	other: ProviderTemplate[];
};

export type TemplateLogs = {
	lines: string[];
	/** True when no build is running for this template. */
	done: boolean;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hashRecipe(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** The short name of a provider template name: the last path segment, without its tag. */
function shortName(name: string): string {
	const colon = name.indexOf(":");
	const withoutTag = colon === -1 ? name : name.slice(0, colon);
	const slash = withoutTag.lastIndexOf("/");
	return slash === -1 ? withoutTag : withoutTag.slice(slash + 1);
}

function stateOf(hash: string, build: TemplateBuildState | undefined): TemplateState {
	if (build === undefined) return "draft";
	if (build.status === "building") return "building";
	if (build.status === "failed") return "failed";
	return build.recipeHash === hash ? "ready" : "stale";
}

/** Reads and writes one template's files under `data/templates/<name>/`. */
export class TemplateStore {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	/** The directory that holds every template. */
	get dir(): string {
		return this.#dir;
	}

	path(name: string): string {
		return join(this.#dir, name);
	}

	/** Template names, sorted; a missing directory reads as empty. */
	async listNames(): Promise<string[]> {
		const entries = await readdir(this.#dir, { withFileTypes: true }).catch(() => []);
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	}

	async readRecipe(name: string): Promise<{ recipe: TemplateRecipe; hash: string }> {
		const text = await readFile(join(this.path(name), RECIPE_FILE), "utf8");
		return { recipe: parseRecipe(text), hash: hashRecipe(text) };
	}

	async writeRecipe(name: string, recipe: TemplateRecipe): Promise<{ hash: string }> {
		const text = serializeRecipe(recipe);
		await mkdir(this.path(name), { recursive: true });
		await writeFile(join(this.path(name), RECIPE_FILE), text, "utf8");
		return { hash: hashRecipe(text) };
	}

	async readBuild(name: string): Promise<TemplateBuildState | undefined> {
		const text = await readFile(join(this.path(name), BUILD_FILE), "utf8").catch(() => undefined);
		if (text === undefined) return undefined;
		try {
			return JSON.parse(text) as TemplateBuildState;
		} catch {
			return undefined;
		}
	}

	async writeBuild(name: string, state: TemplateBuildState): Promise<void> {
		await mkdir(this.path(name), { recursive: true });
		await writeFile(join(this.path(name), BUILD_FILE), JSON.stringify(state, null, "\t"), "utf8");
	}

	async readLog(name: string): Promise<string> {
		return await readFile(join(this.path(name), LOG_FILE), "utf8").catch(() => "");
	}

	async writeLog(name: string, text: string): Promise<void> {
		await mkdir(this.path(name), { recursive: true });
		await writeFile(join(this.path(name), LOG_FILE), text, "utf8");
	}

	async remove(name: string): Promise<void> {
		await rm(this.path(name), { recursive: true, force: true });
	}
}

export type TemplateManagerOptions = {
	store: TemplateStore;
	/** The provider used for builds and the provider's template list. */
	provider: () => SandboxProvider;
	/** Whether the provider has a usable credential. */
	configured: () => boolean;
	/** Provider id and human-readable name for the state the UI shows. */
	identity: () => { id: string; displayName: string };
	/** The sandbox default template, when one is stored. */
	defaultTemplate?: () => string | undefined;
};

/**
 * Owns the template recipes, their builds, and their state. Builds run one at a time in call
 * order; a build outlives the command that started it, and its state reaches clients through
 * `onChanged` and `logs`.
 */
export class TemplateManager {
	/** Called when a template's state changes, so the service can emit an event. */
	onChanged?: () => void;
	readonly #options: TemplateManagerOptions;
	/** The tail of the build queue; every build waits for the previous one. */
	#queue: Promise<unknown> = Promise.resolve();
	/** In-flight or queued builds, keyed by template name. */
	readonly #jobs = new Map<string, Promise<void>>();
	/** Templates waiting to build, including the one running. */
	readonly #pending = new Set<string>();
	#active: { name: string; lines: string[] } | undefined;

	constructor(options: TemplateManagerOptions) {
		this.#options = options;
	}

	get store(): TemplateStore {
		return this.#options.store;
	}

	/** Every template the harness manages, merged with the provider's own list. */
	async list(): Promise<TemplatesState> {
		const { id, displayName } = this.#options.identity();
		const configured = this.#options.configured();
		const names = await this.#options.store.listNames();
		const templates = await Promise.all(names.map((name) => this.#info(name)));

		let providerTemplates: ProviderTemplate[] = [];
		let listed = false;
		if (configured) {
			try {
				providerTemplates = (await this.#options.provider().listTemplates?.()) ?? [];
				listed = true;
			} catch (error) {
				console.warn("[sandbox] listing provider templates failed:", error);
			}
		}

		const knownNames = new Set(templates.map((template) => template.name));
		const other = providerTemplates.filter(
			(template) => !template.names.some((name) => knownNames.has(shortName(name))),
		);
		if (listed) {
			for (const template of templates) {
				if (template.lastBuild?.templateId === undefined) continue;
				const found = providerTemplates.some(
					(candidate) =>
						candidate.templateId === template.lastBuild?.templateId ||
						candidate.names.some((name) => shortName(name) === template.name),
				);
				if (!found && template.state !== "building") template.state = "missing";
			}
		}

		const defaultTemplate = this.#options.defaultTemplate?.();
		return {
			provider: id,
			providerName: displayName,
			configured,
			templates,
			...(defaultTemplate === undefined ? {} : { default: defaultTemplate }),
			other,
		};
	}

	async #info(name: string): Promise<TemplateInfo> {
		const base: TemplateInfo = { name, source: { kind: "default" }, run: [], state: "draft" };
		try {
			const { recipe, hash } = await this.#options.store.readRecipe(name);
			const build = await this.#options.store.readBuild(name);
			return {
				name,
				...(recipe.description === undefined ? {} : { description: recipe.description }),
				source: recipe.source,
				run: recipe.run,
				state: this.#pending.has(name) ? "building" : stateOf(hash, build),
				...(build === undefined
					? {}
					: {
							lastBuild: {
								...(build.templateId === undefined ? {} : { templateId: build.templateId }),
								...(build.buildId === undefined ? {} : { buildId: build.buildId }),
								startedAt: build.startedAt,
								...(build.finishedAt === undefined ? {} : { finishedAt: build.finishedAt }),
								...(build.error === undefined ? {} : { error: build.error }),
							},
						}),
			};
		} catch (error) {
			return { ...base, error: messageOf(error) };
		}
	}

	/** Create a template from a recipe. Refuses a name that already exists. */
	async create(name: string, recipe: TemplateRecipe): Promise<void> {
		const clean = this.#requireName(name);
		const existing = await this.#options.store.readRecipe(clean).catch(() => undefined);
		if (existing !== undefined) throw new SandboxError("invalid", `Template ${clean} already exists`);
		await this.#options.store.writeRecipe(clean, recipe);
		this.onChanged?.();
	}

	/** Create the starter template, if it does not exist yet. */
	async createStarter(): Promise<void> {
		await this.create(STARTER_TEMPLATE_NAME, STARTER_RECIPE);
	}

	/** Replace a template's recipe. */
	async update(name: string, recipe: TemplateRecipe): Promise<void> {
		const clean = this.#requireName(name);
		const existing = await this.#options.store.readRecipe(clean).catch(() => undefined);
		if (existing === undefined) throw new SandboxError("not_found", `Unknown template: ${clean}`);
		await this.#options.store.writeRecipe(clean, recipe);
		this.onChanged?.();
	}

	/**
	 * Queue a build and return as soon as it is queued. The build runs in the background; its
	 * state and logs are observable through `list` and `logs`, and `onChanged` fires on each
	 * transition. A second build for the same template joins the first.
	 */
	async startBuild(name: string): Promise<void> {
		const clean = this.#requireName(name);
		// Validate now, so the client sees a bad recipe or a missing provider immediately.
		await this.#options.store.readRecipe(clean);
		this.#provider();
		if (this.#jobs.has(clean)) return;
		this.#pending.add(clean);
		this.onChanged?.();
		const job = this.#enqueue(clean);
		this.#jobs.set(clean, job);
		void job
			.catch((error: unknown) => {
				console.warn(`[sandbox] building template ${clean} failed:`, error);
			})
			.finally(() => {
				if (this.#jobs.get(clean) === job) this.#jobs.delete(clean);
			});
	}

	async #enqueue(name: string): Promise<void> {
		const run = this.#queue.then(() => this.#runBuild(name));
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #runBuild(name: string): Promise<void> {
		const { recipe, hash } = await this.#options.store.readRecipe(name);
		const provider = this.#provider();
		if (provider.buildTemplate === undefined) {
			throw new SandboxError("invalid", `Provider ${provider.displayName} cannot build templates`);
		}
		const startedAt = Date.now();
		await this.#options.store.writeBuild(name, { status: "building", recipeHash: hash, startedAt });
		const lines: string[] = [];
		this.#active = { name, lines };
		this.onChanged?.();
		// The log is written before the build state, so a reader that sees a finished state can
		// always read the whole log that belongs to it.
		const writeLog = async (): Promise<void> => {
			try {
				await this.#options.store.writeLog(name, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
			} catch (error) {
				console.warn(`[sandbox] writing the build log for ${name} failed:`, error);
			}
		};
		try {
			const result = await provider.buildTemplate(
				{ name, source: recipe.source, run: recipe.run },
				(line) => {
					lines.push(line);
					if (lines.length > MAX_LOG_LINES) lines.shift();
				},
			);
			await writeLog();
			await this.#options.store.writeBuild(name, {
				templateId: result.templateId,
				buildId: result.buildId,
				status: "succeeded",
				recipeHash: hash,
				startedAt,
				finishedAt: Date.now(),
			});
		} catch (error) {
			await writeLog();
			await this.#options.store.writeBuild(name, {
				status: "failed",
				recipeHash: hash,
				startedAt,
				finishedAt: Date.now(),
				error: messageOf(error),
			});
			throw error;
		} finally {
			this.#active = undefined;
			this.#pending.delete(name);
			this.onChanged?.();
		}
	}

	/** The live log while a build runs, or the last build's log afterwards. */
	async logs(name: string): Promise<TemplateLogs> {
		const clean = this.#requireName(name);
		if (this.#active?.name === clean) return { lines: [...this.#active.lines], done: false };
		const text = await this.#options.store.readLog(clean);
		const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
		return { lines, done: !this.#pending.has(clean) };
	}

	/** Forget a template: its recipe, build state, and log go away. The E2B template stays. */
	async remove(name: string): Promise<void> {
		const clean = this.#requireName(name);
		await this.#options.store.remove(clean);
		this.onChanged?.();
	}

	/** Delete a template the harness manages, in E2B first and then locally. */
	async deleteTemplate(name: string): Promise<void> {
		const clean = this.#requireName(name);
		const build = await this.#options.store.readBuild(clean);
		if (build?.templateId !== undefined) await this.deleteProviderTemplate(build.templateId);
		await this.#options.store.remove(clean);
		this.onChanged?.();
	}

	/** Delete a template by its provider id, e.g. one from the "other templates" list. */
	async deleteProviderTemplate(templateId: string): Promise<void> {
		const provider = this.#provider();
		if (provider.deleteTemplate === undefined) {
			throw new SandboxError("invalid", `Provider ${provider.displayName} cannot delete templates`);
		}
		await provider.deleteTemplate(templateId);
		this.onChanged?.();
	}

	#provider(): SandboxProvider {
		if (!this.#options.configured()) {
			throw new SandboxError("auth", "Configure a sandbox provider first");
		}
		return this.#options.provider();
	}

	#requireName(value: string): string {
		const name = templateName(value);
		if (name === undefined) {
			throw new SandboxError(
				"invalid",
				"Template names use lowercase letters, numbers, dashes, and underscores",
			);
		}
		return name;
	}
}
