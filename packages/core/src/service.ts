import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { buildPromptContent, saveAttachment } from "./attachments.ts";
import { ServiceError } from "./errors.ts";
import { createImageTools } from "./image-tool.ts";
import {
	createRegistry,
	defineExtension,
	Harness,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type DocumentWatch,
	type EnvTarget,
	type SnapshotEvent,
	type Storage,
	type TaskGraph,
	type TaskGraphWatch,
} from "@earendil-works/pi-durable";
import type {
	BrowseDirectory,
	DefaultsState,
	ImageModelInfo,
	ModelInfo,
	ModelRef,
	ModelThinkingLevel,
	PromptAttachment,
	ProviderInfo,
	ProviderRefreshReport,
	SandboxChoice,
	SandboxMetricsInfo,
	SandboxesState,
	SandboxSettingsInfo,
	SessionSummary,
	TargetChoice,
	TargetInfo,
	TargetStatus,
	SessionsSkillsResult,
	TemplateRecipeInput,
	TemplatesLogsResult,
	TemplatesState,
	WorkspacesBrowseResult,
} from "@harness/protocol";
import type { EnvironmentFactory } from "./environment.ts";
import { sortModelsForDisplay } from "./model-order.ts";
import type { Providers } from "./providers.ts";
import { SandboxManager, type ResolvedSandboxTarget, type SandboxStatus } from "./sandboxes/manager.ts";
import type { SandboxSource } from "./sandboxes/provider.ts";
import { sandboxProviderFactory } from "./sandboxes/registry.ts";
import {
	DEFAULT_SANDBOX_SETTINGS,
	DEFAULT_SANDBOX_WORKSPACE,
	type SandboxSettings,
} from "./sandboxes/settings.ts";
import { normalizeRecipe } from "./sandboxes/recipe.ts";
import type { TemplateManager } from "./sandboxes/templates.ts";
import { SessionIndex, type SessionIndexEntry, type SessionIndexState } from "./session-index.ts";
import {
	createSkillsExtension,
	parseInvocation,
	recordActivation,
	SkillLibrary,
	SkillsDoc,
	type SkillCatalog,
} from "./skills/index.ts";
import {
	createTargetSection,
	resolveTarget,
	sandboxTargetState,
	scratchPath,
	SessionTargetDoc,
	TargetChangeEntry,
	type ResolvedTarget,
	type SessionTargetState,
	type TargetChangeData,
} from "./targets.ts";

const NEW_SESSION_TITLE = "New session";
const TITLE_MAX_LENGTH = 48;

function deriveTitle(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= TITLE_MAX_LENGTH) return singleLine;
	return `${singleLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/** Set equality for the small conversation-ID sets tracked below. */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}

/** Conversation IDs are branded numbers; the protocol carries them as strings. */
function parseConversationId(value: string): ConversationId {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ServiceError("not_found", `Unknown session: ${value}`);
	}
	return parsed as ConversationId;
}

type SessionAgentChange = {
	model?: ModelRef | null;
	thinkingLevel?: AgentState["thinkingLevel"] | null;
};

export { ServiceError };

/** Provider, session-list, sandbox, template, and target changes the server forwards to every client. */
export type ServiceEvent =
	| { type: "sessions"; sessions: SessionSummary[] }
	| { type: "target"; status: TargetStatus }
	| ({ type: "sandboxes" } & SandboxesState)
	| ({ type: "templates" } & TemplatesState)
	| ({ type: "providers" } & ProvidersState);

export type ProvidersState = {
	providers: ProviderInfo[];
	models: ModelInfo[];
	imageModels: ImageModelInfo[];
	defaults: DefaultsState;
};

export type HarnessServiceDependencies = {
	storage: Storage;
	providers: Providers;
	/** Builds each conversation's execution environment. Without one, the coding tools fail. */
	environment?: EnvironmentFactory;
	/** Root directory that holds per-session scratch workspaces. */
	workspacesDir?: string;
	/** Sandbox providers and their per-session environments. */
	sandboxes?: SandboxManager;
	/** Sandbox template recipes, their builds, and their state. */
	templates?: TemplateManager;
	/** The host's home directory, for user skills; without one, only project skills load. */
	skillsHome?: string;
};

/** The protocol view of a resolved target. */
function targetInfo(target: ResolvedTarget, providerName?: string): TargetInfo {
	if (target.kind === "local") return { kind: "local", path: target.path, scratch: target.scratch };
	return {
		kind: "sandbox",
		provider: target.provider,
		providerName: providerName ?? target.provider,
		...(target.sandboxId === undefined ? {} : { sandboxId: target.sandboxId }),
		...(target.name === undefined ? {} : { name: target.name }),
		workspaceDir: target.workspaceDir,
		forwardAgent: target.forwardAgent,
	};
}

/** Defaults for a sandbox target that names no provider or workspace of its own. */
function sandboxDefaults(manager: SandboxManager | undefined): {
	provider: string;
	template?: string;
	workspaceDir: string;
	forwardAgent: boolean;
} {
	const settings = manager?.settings;
	const template = manager?.defaultTemplate();
	return {
		provider: settings?.provider ?? DEFAULT_SANDBOX_SETTINGS.provider,
		...(template === undefined ? {} : { template }),
		workspaceDir: DEFAULT_SANDBOX_WORKSPACE,
		forwardAgent: settings?.ssh.forwardAgent ?? DEFAULT_SANDBOX_SETTINGS.ssh.forwardAgent,
	};
}

function sandboxSettingsInfo(
	settings: SandboxSettings,
	configured: boolean,
	providerName: string,
	providerDefault?: string,
): SandboxSettingsInfo {
	// A stored template equal to the provider's own default is the same as no choice at all.
	const template = settings.template === providerDefault ? undefined : settings.template;
	return {
		provider: settings.provider,
		providerName,
		...(template === undefined ? {} : { template }),
		idleTimeoutMs: settings.idleTimeoutMs,
		autoPause: settings.autoPause,
		...(settings.ssh.agentSocket === undefined ? {} : { sshAgentSocket: settings.ssh.agentSocket }),
		forwardAgent: settings.ssh.forwardAgent,
		configured,
	};
}

/** The protocol view of a skill catalog. */
function skillsResult(catalog: SkillCatalog): SessionsSkillsResult {
	return {
		skills: catalog.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			scope: skill.scope,
			path: skill.path,
			modelInvocable: skill.modelInvocable,
			mirrored: skill.mirrored === true,
			warnings: skill.warnings,
		})),
		issues: catalog.issues.map((issue) => ({
			path: issue.path,
			...(issue.name === undefined ? {} : { name: issue.name }),
			reason: issue.reason,
		})),
	};
}

type ComposeEnvironmentOptions = {
	local: EnvironmentFactory;
	workspacesDir?: string;
	providers: Providers;
	sandboxes?: SandboxManager;
	sandboxDefaults: () => { provider: string; template?: string; workspaceDir?: string };
};

/** Resolve the session's target, then build the local environment or open its sandbox. */
function composeEnvironment(options: ComposeEnvironmentOptions): EnvironmentFactory {
	return async (target, context) => {
		const resolved = await resolveTarget(target.read, target.conversationId, context, {
			...(options.workspacesDir === undefined ? {} : { workspacesDir: options.workspacesDir }),
			defaultTarget: options.providers.getDefaults().target,
			sandboxDefaults: options.sandboxDefaults(),
		});
		if (resolved.kind === "local") {
			return options.local({ ...target, ...(resolved.path === "" ? {} : { cwd: resolved.path }) }, context);
		}
		if (options.sandboxes === undefined) {
			throw new ServiceError("sandbox_unavailable", "Sandboxes are not configured");
		}
		return options.sandboxes.environment(resolved, String(target.conversationId), context);
	};
}

/**
 * The core of the harness: it owns the durable `Harness`, provider credentials, and the session
 * index. It knows nothing about HTTP or WebSockets; clients subscribe through the methods below.
 */
export class HarnessService {
	readonly #harness: Harness;
	readonly #providers: Providers;
	readonly #environment: EnvironmentFactory | undefined;
	readonly #workspacesDir: string | undefined;
	readonly #sandboxes: SandboxManager | undefined;
	readonly #templates: TemplateManager | undefined;
	readonly #skills: SkillLibrary;
	/** Live session event streams, one per `subscribeSession` caller. */
	readonly #streams = new Set<AgentEventStream>();
	readonly #listeners = new Set<(event: ServiceEvent) => void>();
	#indexWatch: DocumentWatch<SessionIndexState> | undefined;
	#taskGraphWatch: TaskGraphWatch | undefined;
	#working = new Set<string>();
	#closed = false;

	private constructor(
		harness: Harness,
		providers: Providers,
		environment: EnvironmentFactory | undefined,
		workspacesDir: string | undefined,
		sandboxes: SandboxManager | undefined,
		templates: TemplateManager | undefined,
		skills: SkillLibrary,
	) {
		this.#harness = harness;
		this.#providers = providers;
		this.#environment = environment;
		this.#workspacesDir = workspacesDir;
		this.#sandboxes = sandboxes;
		this.#templates = templates;
		this.#skills = skills;
	}

	/**
	 * Open the harness over the given storage and providers. Callers supply the adapters;
	 * `openHarnessService` in `./node.ts` wires the Node ones for production.
	 */
	static async create(dependencies: HarnessServiceDependencies): Promise<HarnessService> {
		const { providers } = dependencies;
		// Every conversation selects every installed extension, so installing the coding tools is
		// all it takes for agents to read, write, edit, and run commands.
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(
			createImageTools({
				models: providers.models,
				defaultImageModel: () => providers.getDefaults().imageModel,
			}),
		);
		registry.install(
			defineExtension({
				name: "execution-target",
				sections: [
					createTargetSection({
						...(dependencies.workspacesDir === undefined
							? {}
							: { workspacesDir: dependencies.workspacesDir }),
						defaultTarget: () => providers.getDefaults().target,
						sandboxDefaults: () => sandboxDefaults(dependencies.sandboxes),
						providerName: (provider) => dependencies.sandboxes?.displayName(provider) ?? provider,
					}),
				],
			}),
		);
		const skills = new SkillLibrary({
			...(dependencies.skillsHome === undefined ? {} : { home: dependencies.skillsHome }),
			resolveTarget: (read, conversationId, context) =>
				resolveTarget(read, conversationId, context, {
					...(dependencies.workspacesDir === undefined ? {} : { workspacesDir: dependencies.workspacesDir }),
					defaultTarget: providers.getDefaults().target,
					sandboxDefaults: sandboxDefaults(dependencies.sandboxes),
				}),
		});
		registry.install(createSkillsExtension(skills));
		const environment =
			dependencies.environment === undefined
				? undefined
				: composeEnvironment({
						local: dependencies.environment,
						...(dependencies.workspacesDir === undefined ? {} : { workspacesDir: dependencies.workspacesDir }),
						providers,
						...(dependencies.sandboxes === undefined ? {} : { sandboxes: dependencies.sandboxes }),
						sandboxDefaults: () => sandboxDefaults(dependencies.sandboxes),
					});
		const harness = await Harness.open(
			dependencies.storage,
			{
				models: providers.models,
				registry,
				...(environment === undefined ? {} : { env: environment }),
				conversationCreated: async (tx, conversation) => {
					if (conversation.owner !== undefined) return;
					const index = await tx.doc(SessionIndex);
					const now = Date.now();
					index.sessions.push({
						id: String(conversation.id),
						title: NEW_SESSION_TITLE,
						createdAt: now,
						updatedAt: now,
					});
				},
			},
			BACKGROUND_CONTEXT,
		);
		// Create the index document even before the first conversation exists, so its watch attaches.
		await harness.commit(async (tx) => {
			await tx.doc(SessionIndex);
		}, BACKGROUND_CONTEXT);
		harness.resume();

		const service = new HarnessService(
			harness,
			providers,
			environment,
			dependencies.workspacesDir,
			dependencies.sandboxes,
			dependencies.templates,
			skills,
		);
		if (dependencies.templates !== undefined) {
			dependencies.templates.onChanged = () => {
				void service.#emitTemplates();
			};
		}
		if (dependencies.sandboxes !== undefined) {
			dependencies.sandboxes.rememberSandboxId = async (conversationId, sandboxId) => {
				await harness.commit(async (tx) => {
					const doc = await tx.doc(SessionTargetDoc, parseConversationId(conversationId));
					if (doc.kind === "sandbox" && doc.sandbox !== null && doc.sandbox.sandboxId === null) {
						doc.sandbox.sandboxId = sandboxId;
					}
				}, BACKGROUND_CONTEXT);
			};
			dependencies.sandboxes.onStatus = (status) => service.#handleSandboxStatus(status);
		}
		await service.#watchSessionIndex();
		await service.#watchTaskGraph();
		// Startup uses the cached catalog when it is fresh; the client can force a refresh.
		void service.#refreshProviders(undefined, false).catch((error: unknown) => {
			console.warn("[core] model refresh failed:", error);
		});
		return service;
	}

	on(listener: (event: ServiceEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(event: ServiceEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}

	async #emitSessions(): Promise<void> {
		this.#emit({ type: "sessions", sessions: await this.listSessions() });
	}

	/** Announce the template list after a recipe, build, or provider change. */
	async #emitTemplates(): Promise<void> {
		if (this.#templates === undefined) return;
		this.#emit({ type: "templates", ...(await this.#templateState()) });
	}

	/** The template list the client sees, with a provider-default stored template read as unset. */
	async #templateState(): Promise<TemplatesState> {
		const state = await this.#requireTemplates().list();
		const providerDefault = this.#sandboxes?.providerDefaultTemplate();
		if (providerDefault === undefined || state.default !== providerDefault) return state;
		const { default: _providerDefault, ...rest } = state;
		return rest;
	}

	/** Lists once, announces the result to every client, and returns the same state to the caller. */
	async #listAndEmitSandboxes(): Promise<SandboxesState> {
		const state = await this.listSandboxes();
		this.#emit({ type: "sandboxes", ...state });
		return state;
	}

	/** Lazy sandbox progress: the target chip updates, and a ready sandbox refreshes both lists. */
	#handleSandboxStatus(status: SandboxStatus): void {
		this.#emit({
			type: "target",
			status: {
				sessionId: status.conversationId,
				phase: status.phase,
				...(status.sandboxId === undefined ? {} : { sandboxId: status.sandboxId }),
				...(status.message === undefined ? {} : { message: status.message }),
			},
		});
		if (status.phase === "ready") {
			void this.#emitSessions();
			void this.#listAndEmitSandboxes();
		}
	}

	async #watchSessionIndex(): Promise<void> {
		const watch = await this.#harness.watchDoc(SessionIndex, BACKGROUND_CONTEXT);
		if (watch === undefined) return;
		this.#indexWatch = watch;
		watch.start(async () => {
			this.#emit({ type: "sessions", sessions: await this.listSessions() });
		});
	}

	/**
	 * Track which sessions have live work so clients can show a working indicator, including for
	 * sessions they are not attached to. The task graph is one small watch over every live task;
	 * only the set of conversations changes the session list, so phase updates are ignored.
	 */
	async #watchTaskGraph(): Promise<void> {
		const watch = await this.#harness.watchTaskGraph(BACKGROUND_CONTEXT);
		this.#taskGraphWatch = watch;
		const sync = async (graph: TaskGraph): Promise<void> => {
			const next = new Set(Object.values(graph.tasks).map((task) => String(task.conversationId)));
			if (sameIds(next, this.#working)) return;
			this.#working = next;
			this.#emit({ type: "sessions", sessions: await this.listSessions() });
		};
		await sync(watch.value);
		watch.start(sync);
	}

	async listSessions(): Promise<SessionSummary[]> {
		const index = await this.#harness.snapshot(SessionIndex, BACKGROUND_CONTEXT);
		const entries = [...(index?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
		return Promise.all(
			entries.map(async (entry) => {
				const resolved = await this.#resolveTarget(parseConversationId(entry.id));
				return {
					id: entry.id,
					title: entry.title,
					createdAt: entry.createdAt,
					updatedAt: entry.updatedAt,
					working: this.#working.has(entry.id),
					target: targetInfo(
						resolved,
						resolved.kind === "sandbox" ? this.#sandboxes?.displayName(resolved.provider) : undefined,
					),
				};
			}),
		);
	}

	/** Where one session's tools run, following the default when the session stores none. */
	async #resolveTarget(conversationId: ConversationId): Promise<ResolvedTarget> {
		return resolveTarget(this.#harness, conversationId, BACKGROUND_CONTEXT, {
			...(this.#workspacesDir === undefined ? {} : { workspacesDir: this.#workspacesDir }),
			defaultTarget: this.#providers.getDefaults().target,
			sandboxDefaults: sandboxDefaults(this.#sandboxes),
		});
	}

	async createSession(): Promise<SessionSummary> {
		const conversation = await this.#harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		const change = await this.#initialAgentChange();
		if (Object.keys(change).length > 0) await conversation.configure(change, BACKGROUND_CONTEXT);
		// Snapshot the default target, so changing the setting later leaves this session alone.
		await this.#harness.commit(async (tx) => {
			const target = await tx.doc(SessionTargetDoc, conversation.id);
			this.#writeDefaultTarget(target);
		}, BACKGROUND_CONTEXT);
		return this.#requireSession(String(conversation.id));
	}

	#writeDefaultTarget(doc: SessionTargetState): void {
		const defaults = this.#providers.getDefaults().target;
		if (defaults?.kind === "sandbox") {
			const sandbox = sandboxDefaults(this.#sandboxes);
			doc.kind = "sandbox";
			doc.path = null;
			doc.sandbox = sandboxTargetState({
				provider: sandbox.provider,
				...(sandbox.template === undefined ? {} : { template: sandbox.template }),
				workspaceDir: sandbox.workspaceDir,
				forwardAgent: sandbox.forwardAgent,
			});
			return;
		}
		doc.kind = "local";
		doc.path = defaults?.path ?? null;
		doc.sandbox = null;
	}

	async renameSession(id: string, title: string): Promise<SessionSummary> {
		const trimmed = title.trim();
		if (trimmed === "") throw new ServiceError("invalid", "Title must not be empty");
		await this.#updateSession(id, (entry) => {
			entry.title = trimmed;
		});
		return this.#requireSession(id);
	}

	/**
	 * Remove a session from the app. Durable storage is append-only, so the underlying records stay
	 * in SQLite; the session disappears from the index and can no longer be opened or resumed.
	 */
	async deleteSession(id: string): Promise<void> {
		await this.#requireSession(id);
		const conversationId = parseConversationId(id);

		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation !== undefined) {
			try {
				await conversation.abort(BACKGROUND_CONTEXT);
			} catch (error) {
				console.warn(`[core] aborting session ${id} before delete failed:`, error);
			}
		}

		await this.#harness.commit(async (tx) => {
			const index = await tx.doc(SessionIndex);
			index.sessions = index.sessions.filter((entry) => entry.id !== id);
		}, BACKGROUND_CONTEXT);
	}

	async prompt(
		id: string,
		text: string,
		requestId: string,
		attachments: readonly PromptAttachment[] = [],
	): Promise<{ submissionId: string }> {
		const trimmed = text.trim();
		if (trimmed === "" && attachments.length === 0) {
			throw new ServiceError("invalid", "Message must not be empty");
		}
		const conversationId = parseConversationId(id);
		const conversation = await this.#requireConversation(conversationId);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		if (agent.model === undefined) throw new ServiceError("no_model", "Select a model before sending a message");
		const model = this.#providers.models.getModel(agent.model.provider, agent.model.modelId);
		// Each prompt starts or extends a run, which rescans the target's skills.
		this.#skills.invalidate(conversationId);
		const invocation = parseInvocation(trimmed);
		const message = invocation?.rest ?? trimmed;
		const env =
			attachments.length === 0 && invocation === undefined ? undefined : await this.#buildEnvironment(conversationId);
		const skill = invocation === undefined ? undefined : await this.#invokeSkill(conversationId, env, invocation.name);
		let content = await buildPromptContent(message, attachments, model?.input, (attachment, index) =>
			env === undefined ? Promise.resolve(undefined) : saveAttachment(env, id, attachment, index, BACKGROUND_CONTEXT),
		);
		if (skill !== undefined) {
			const rest = typeof content === "string" ? (content === "" ? [] : [{ type: "text" as const, text: content }]) : content;
			content = [{ type: "text", text: skill.block }, ...rest];
			await this.#harness.commit(async (tx) => {
				recordActivation(await tx.doc(SkillsDoc, conversationId), skill.name, skill.block);
			}, BACKGROUND_CONTEXT);
		}

		await this.#updateSession(id, (entry) => {
			if (entry.title === NEW_SESSION_TITLE) {
				entry.title = deriveTitle(
					message !== ""
						? message
						: skill !== undefined
							? skill.name
							: attachments.map((attachment) => attachment.name).join(", "),
				);
			}
		});
		const submission = await conversation.submit(
			{ type: "input", content, requestId },
			BACKGROUND_CONTEXT,
		);
		return { submissionId: String(submission.id) };
	}

	/** Resolve a `/skill:name` invocation, reading the skill fresh from the session's target. */
	async #invokeSkill(
		conversationId: ConversationId,
		env: ExecutionEnv | undefined,
		name: string,
	): Promise<{ name: string; block: string }> {
		if (name === "") throw new ServiceError("unknown_skill", "Name a skill after /skill:");
		const result = await this.#skills.activate(
			this.#harness,
			conversationId,
			env,
			name,
			{ modelOnly: false },
			BACKGROUND_CONTEXT,
		);
		if ("available" in result) throw new ServiceError("unknown_skill", `Unknown skill: ${name}`);
		return { name: result.skill.name, block: result.block };
	}

	/** The session's skills and the ones left out, for autocomplete and the Skills page. Never opens a sandbox. */
	async listSkills(id: string): Promise<SessionsSkillsResult> {
		const conversationId = parseConversationId(id);
		await this.#requireConversation(conversationId);
		return skillsResult(await this.#skills.list(this.#harness, conversationId, BACKGROUND_CONTEXT));
	}

	async abort(id: string): Promise<void> {
		const conversation = await this.#requireConversation(parseConversationId(id));
		await conversation.abort(BACKGROUND_CONTEXT);
	}

	async configureSession(id: string, change: SessionAgentChange): Promise<AgentState> {
		const conversation = await this.#requireConversation(parseConversationId(id));
		const current = await conversation.agent(BACKGROUND_CONTEXT);

		const agentChange: SessionAgentChange = {};
		if (change.model !== undefined) agentChange.model = change.model;
		if (change.thinkingLevel !== undefined) {
			let level = change.thinkingLevel;
			if (level !== null) {
				const target = change.model === undefined ? current.model : (change.model ?? undefined);
				if (target !== undefined) {
					const resolved = this.#providers.models.getModel(target.provider, target.modelId);
					if (resolved !== undefined) level = clampThinkingLevel(resolved, level);
				}
			}
			agentChange.thinkingLevel = level;
		}
		if (change.model !== undefined && change.model !== null) {
			const resolved = this.#providers.models.getModel(change.model.provider, change.model.modelId);
			if (resolved === undefined) {
				throw new ServiceError("unknown_model", `Unknown model: ${change.model.provider}/${change.model.modelId}`);
			}
		}
		if (Object.keys(agentChange).length > 0) await conversation.configure(agentChange, BACKGROUND_CONTEXT);

		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		return { model: agent.model, thinkingLevel: agent.thinkingLevel };
	}

	/**
	 * Point a session at a local folder, its scratch directory, or a sandbox. The change takes effect
	 * on the next run; a visible entry records it so the transcript and the model stay honest.
	 */
	async setTarget(id: string, choice: TargetChoice): Promise<SessionSummary> {
		const conversationId = parseConversationId(id);
		await this.#requireConversation(conversationId);
		if (this.#working.has(id)) {
			throw new ServiceError("busy", "Wait for the run to finish before changing the target");
		}
		const prepared = choice.kind === "local" ? await this.#localTarget(conversationId, choice.path) : this.#sandboxTarget(choice);
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(SessionTargetDoc, conversationId);
			if (prepared.target.kind === "local") {
				doc.kind = "local";
				doc.path = prepared.target.scratch ? null : prepared.target.path;
				doc.sandbox = null;
			} else {
				doc.kind = "sandbox";
				doc.path = null;
				doc.sandbox = sandboxTargetState(prepared.target);
			}
			await tx.appendEntry(TargetChangeEntry, conversationId, { data: prepared.entry });
		}, BACKGROUND_CONTEXT);
		this.#sandboxes?.forget(id);
		this.#skills.invalidate(conversationId);
		await this.#emitSessions();
		return this.#requireSession(id);
	}

	async #localTarget(
		conversationId: ConversationId,
		path: string | undefined,
	): Promise<{ target: ResolvedTarget; entry: TargetChangeData }> {
		const trimmed = path?.trim();
		if (trimmed !== undefined && trimmed !== "") {
			const info = await stat(trimmed).catch(() => undefined);
			if (info === undefined || !info.isDirectory()) {
				throw new ServiceError("invalid", `Not a directory: ${trimmed}`);
			}
			return {
				target: { kind: "local", path: trimmed, scratch: false },
				entry: { kind: "local", path: trimmed, scratch: false },
			};
		}
		const scratch = scratchPath(this.#workspacesDir, conversationId);
		return {
			target: { kind: "local", path: scratch, scratch: true },
			entry: { kind: "local", path: scratch, scratch: true },
		};
	}

	#sandboxTarget(choice: SandboxChoice): { target: ResolvedSandboxTarget; entry: TargetChangeData } {
		const manager = this.#requireSandboxes();
		if (!manager.configured()) {
			throw new ServiceError("sandbox_unavailable", "Configure a sandbox provider first");
		}
		const provider = choice.provider ?? manager.settings.provider;
		const workspaceDir = choice.workspaceDir ?? DEFAULT_SANDBOX_WORKSPACE;
		if (choice.sandboxId !== undefined) {
			return {
				target: {
					kind: "sandbox",
					provider,
					sandboxId: choice.sandboxId,
					workspaceDir,
					forwardAgent: choice.forwardAgent ?? manager.settings.ssh.forwardAgent,
				},
				entry: {
					kind: "sandbox",
					path: workspaceDir,
					scratch: false,
					provider,
					providerName: manager.displayName(provider),
					sandboxId: choice.sandboxId,
				},
			};
		}
		const name = choice.name?.trim();
		const template =
			choice.template === null ? manager.defaultTemplate() : (choice.template?.trim() ?? manager.defaultTemplate());
		const source = this.#sandboxSource(choice.source);
		const forwardAgent = choice.forwardAgent ?? manager.settings.ssh.forwardAgent;
		const target: ResolvedSandboxTarget = {
			kind: "sandbox",
			provider,
			workspaceDir,
			forwardAgent,
			...(name === undefined || name === "" ? {} : { name }),
			...(template === undefined || template === "" ? {} : { template }),
			...(source === undefined ? {} : { source }),
		};
		return {
			target,
			entry: {
				kind: "sandbox",
				path: workspaceDir,
				scratch: false,
				provider,
				providerName: manager.displayName(provider),
				forwardAgent,
				...(target.name === undefined ? {} : { name: target.name }),
			},
		};
	}

	#sandboxSource(source: SandboxSource | undefined): SandboxSource | undefined {
		if (source === undefined) return undefined;
		if (source.kind === "empty") return source;
		const url = source.url.trim();
		if (url === "") throw new ServiceError("invalid", "Git URL must not be empty");
		return { kind: "git", url };
	}

	/** Sandboxes the harness created, with the sessions currently attached to each. */
	async listSandboxes(): Promise<SandboxesState> {
		const manager = this.#sandboxes;
		const settings = manager?.settings ?? DEFAULT_SANDBOX_SETTINGS;
		const configured = manager?.configured() ?? false;
		const sandboxes = configured && manager !== undefined ? await manager.list().catch((error: unknown) => {
			console.warn("[core] listing sandboxes failed:", error);
			return [];
		}) : [];
		const attached = new Map<string, { sessions: string[]; working: boolean }>();
		for (const session of await this.listSessions()) {
			const target = session.target;
			if (target.kind !== "sandbox" || target.sandboxId === undefined) continue;
			const entry = attached.get(target.sandboxId) ?? { sessions: [], working: false };
			entry.sessions.push(session.id);
			entry.working ||= session.working;
			attached.set(target.sandboxId, entry);
		}
		return {
			provider: settings.provider,
			settings: sandboxSettingsInfo(
				settings,
				configured,
				this.#sandboxes?.displayName(settings.provider) ?? settings.provider,
				this.#sandboxes?.providerDefaultTemplate(),
			),
			sandboxes: sandboxes.map((sandbox) => ({
				...sandbox,
				sessions: attached.get(sandbox.id)?.sessions ?? [],
				working: attached.get(sandbox.id)?.working ?? false,
			})),
		};
	}

	async createSandbox(choice: SandboxChoice): Promise<SandboxesState> {
		const manager = this.#requireSandboxes();
		if (!manager.configured()) throw new ServiceError("sandbox_unavailable", "Configure a sandbox provider first");
		const source = this.#sandboxSource(choice.source);
		const name = choice.name?.trim();
		const template = choice.template?.trim();
		await manager.create({
			workspaceDir: choice.workspaceDir ?? DEFAULT_SANDBOX_WORKSPACE,
			...(name === undefined || name === "" ? {} : { name }),
			...(choice.template === null
				? { template: null }
				: template === undefined || template === ""
					? {}
					: { template }),
			...(source === undefined ? {} : { source }),
			...(choice.forwardAgent === undefined ? {} : { forwardAgent: choice.forwardAgent }),
		});
		return await this.#listAndEmitSandboxes();
	}

	async pauseSandbox(provider: string, sandboxId: string): Promise<SandboxesState> {
		await this.#requireSandboxes().pause(provider, sandboxId);
		return await this.#listAndEmitSandboxes();
	}

	async resumeSandbox(provider: string, sandboxId: string): Promise<SandboxesState> {
		await this.#requireSandboxes().resume(provider, sandboxId);
		return await this.#listAndEmitSandboxes();
	}

	async killSandbox(provider: string, sandboxId: string): Promise<SandboxesState> {
		await this.#requireSandboxes().kill(provider, sandboxId);
		return await this.#listAndEmitSandboxes();
	}

	async sandboxMetrics(provider: string, sandboxId: string): Promise<SandboxMetricsInfo | undefined> {
		return this.#requireSandboxes().metrics(provider, sandboxId);
	}

	async configureSandboxProvider(provider: string, apiKey: string | null): Promise<SandboxesState> {
		const manager = this.#requireSandboxes();
		if (apiKey !== null && apiKey !== "") {
			// Validate before storing, so a bad key fails here instead of on the next use.
			await sandboxProviderFactory(provider).validate({ apiKey });
		}
		await manager.setSettings({ apiKey: { provider, key: apiKey } });
		return await this.#listAndEmitSandboxes();
	}

	async setSandboxSettings(change: {
		provider?: string;
		template?: string | null;
		idleTimeoutMs?: number | null;
		autoPause?: boolean | null;
		sshAgentSocket?: string | null;
		forwardAgent?: boolean | null;
	}): Promise<SandboxesState> {
		await this.#requireSandboxes().setSettings(change);
		// The default template is part of the template list too, so keep both in step.
		if (change.template !== undefined) await this.#emitTemplates();
		return await this.#listAndEmitSandboxes();
	}

	#requireSandboxes(): SandboxManager {
		if (this.#sandboxes === undefined) {
			throw new ServiceError("sandbox_unavailable", "Sandboxes are not configured");
		}
		return this.#sandboxes;
	}

	/** Every sandbox template the harness manages, merged with the provider's own list. */
	async listTemplates(): Promise<TemplatesState> {
		return await this.#templateState();
	}

	async createTemplate(name: string, recipe: TemplateRecipeInput | undefined): Promise<TemplatesState> {
		await this.#requireTemplates().create(name, normalizeRecipe(recipe ?? {}));
		return await this.#listAndEmitTemplates();
	}

	/** Create the starter template the Templates page offers. */
	async createStarterTemplate(): Promise<TemplatesState> {
		await this.#requireTemplates().createStarter();
		return await this.#listAndEmitTemplates();
	}

	async updateTemplate(name: string, recipe: TemplateRecipeInput): Promise<TemplatesState> {
		await this.#requireTemplates().update(name, normalizeRecipe(recipe));
		return await this.#listAndEmitTemplates();
	}

	/** Queue a background build; the state the caller gets back already shows it. */
	async buildTemplate(name: string): Promise<TemplatesState> {
		await this.#requireTemplates().startBuild(name);
		return await this.#listAndEmitTemplates();
	}

	async templateLogs(name: string): Promise<TemplatesLogsResult> {
		return await this.#requireTemplates().logs(name);
	}

	/** Forget a template in the harness; the provider's template stays. */
	async removeTemplate(name: string): Promise<TemplatesState> {
		await this.#requireTemplates().remove(name);
		await this.#resetDefaultTemplate(name);
		return await this.#listAndEmitTemplates();
	}

	/** Delete a template the harness manages, in the provider first. */
	async deleteTemplate(name: string): Promise<TemplatesState> {
		await this.#requireTemplates().deleteTemplate(name);
		await this.#resetDefaultTemplate(name);
		return await this.#listAndEmitTemplates();
	}

	/** A deliberate removal should not leave new sandboxes pointing at a template that is gone. */
	async #resetDefaultTemplate(name: string): Promise<void> {
		if (this.#sandboxes === undefined) return;
		if (this.#sandboxes.settings.template !== name) return;
		await this.#sandboxes.setSettings({ template: null });
		await this.#listAndEmitSandboxes();
	}

	async deleteProviderTemplate(templateId: string): Promise<TemplatesState> {
		await this.#requireTemplates().deleteProviderTemplate(templateId);
		return await this.#listAndEmitTemplates();
	}

	async #listAndEmitTemplates(): Promise<TemplatesState> {
		const state = await this.#templateState();
		this.#emit({ type: "templates", ...state });
		return state;
	}

	#requireTemplates(): TemplateManager {
		if (this.#templates === undefined) {
			throw new ServiceError("sandbox_unavailable", "Sandbox templates are not configured");
		}
		return this.#templates;
	}

	/** List the directories under `path` for the local folder picker; defaults to the home directory. */
	async browseWorkspaces(path?: string): Promise<WorkspacesBrowseResult> {
		const directory = path === undefined || path === "" ? homedir() : resolve(path);
		const info = await stat(directory).catch(() => undefined);
		if (info === undefined || !info.isDirectory()) {
			throw new ServiceError("not_found", `Not a directory: ${directory}`);
		}
		const entries = await readdir(directory, { withFileTypes: true });
		const directories: BrowseDirectory[] = [];
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			const isDirectory =
				entry.isDirectory() ||
				(entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory() === true);
			if (isDirectory) directories.push({ name: entry.name, path: entryPath });
		}
		directories.sort((a, b) => a.name.localeCompare(b.name));
		const parent = dirname(directory);
		return { path: directory, ...(parent === directory ? {} : { parent }), directories };
	}

	/** Create one directory inside an existing folder, for the picker's "new folder" flow. */
	async createWorkspaceFolder(parent: string, name: string): Promise<{ path: string }> {
		const clean = name.trim();
		if (clean === "" || clean === "." || clean === ".." || /[/\\]/.test(clean)) {
			throw new ServiceError("invalid", "Folder name must not be empty or contain path separators");
		}
		const path = join(resolve(parent), clean);
		try {
			await mkdir(path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") throw new ServiceError("invalid", `A file or folder named ${clean} already exists`);
			if (code === "ENOENT") throw new ServiceError("not_found", `Not a directory: ${parent}`);
			throw error;
		}
		return { path };
	}

	/**
	 * Attach a listener to one conversation. Each caller gets its own event stream, so its snapshot
	 * is captured at attach time: a client that joins while another is already attached sees the
	 * current transcript and usage, not the state from when the first stream was created.
	 */
	async subscribeSession(
		id: string,
		listener: (events: readonly AgentEvent[]) => void,
	): Promise<{ snapshot: SnapshotEvent; unsubscribe: () => void }> {
		const conversationId = parseConversationId(id);
		await this.#requireConversation(conversationId);
		const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
		this.#streams.add(stream);
		stream.start(async (events) => listener(events));
		return {
			snapshot: stream.snapshot,
			unsubscribe: () => {
				if (!this.#streams.delete(stream)) return;
				void stream.stop();
			},
		};
	}

	async listProviders(): Promise<ProvidersState> {
		const [providers, models, imageModels] = await Promise.all([
			this.#providers.listProviders(),
			this.#providers.listModels(),
			this.#providers.listImageModels(),
		]);
		return {
			providers,
			models: sortModelsForDisplay(models),
			imageModels,
			defaults: this.#providers.getDefaults(),
		};
	}

	/** Store the model, thinking level, and target new sessions start with. */
	async setDefaults(change: {
		model?: ModelRef | null;
		thinkingLevel?: ModelThinkingLevel | null;
		imageModel?: ModelRef | null;
		target?: TargetChoice | null;
	}): Promise<DefaultsState> {
		if (change.model !== undefined && change.model !== null) {
			const resolved = this.#providers.models.getModel(change.model.provider, change.model.modelId);
			if (resolved === undefined) {
				throw new ServiceError("unknown_model", `Unknown model: ${change.model.provider}/${change.model.modelId}`);
			}
		}
		if (change.imageModel !== undefined && change.imageModel !== null) {
			const resolved = this.#providers.models.getModelOfType(
				"image",
				change.imageModel.provider,
				change.imageModel.modelId,
			);
			if (resolved === undefined) {
				throw new ServiceError(
					"unknown_model",
					`Unknown image model: ${change.imageModel.provider}/${change.imageModel.modelId}`,
				);
			}
		}
		if (change.target !== undefined && change.target !== null) {
			if (change.target.kind === "sandbox") {
				const manager = this.#requireSandboxes();
				if (!manager.configured()) {
					throw new ServiceError("sandbox_unavailable", "Configure a sandbox provider first");
				}
			} else {
				const path = change.target.path?.trim();
				if (path !== undefined && path !== "") {
					const info = await stat(path).catch(() => undefined);
					if (info === undefined || !info.isDirectory()) {
						throw new ServiceError("invalid", `Not a directory: ${path}`);
					}
				}
			}
		}
		const defaults = await this.#providers.setDefaults(change);
		await this.#emitProviders();
		return defaults;
	}

	async configureProvider(providerId: string, apiKey: string | null): Promise<void> {
		await this.#providers.setApiKey(providerId, apiKey);
		await this.#refreshProviders(providerId, true);
	}

	/** Refresh every configured provider and report what each refresh did. */
	async refreshProviders(): Promise<ProviderRefreshReport[]> {
		return this.#refreshProviders(undefined, true);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#indexWatch?.stop();
		} catch (error) {
			console.warn("[core] stopping session index watch failed:", error);
		}
		try {
			await this.#taskGraphWatch?.stop();
		} catch (error) {
			console.warn("[core] stopping task graph watch failed:", error);
		}
		const streams = [...this.#streams];
		this.#streams.clear();
		for (const stream of streams) {
			try {
				await stream.stop();
			} catch (error) {
				console.warn("[core] stopping session subscription failed:", error);
			}
		}
		await this.#harness.close(BACKGROUND_CONTEXT);
		await this.#sandboxes?.close();
	}

	/** Build the environment a conversation's tools run in, or undefined when none is configured. */
	async #buildEnvironment(conversationId: ConversationId): Promise<ExecutionEnv | undefined> {
		if (this.#environment === undefined) return undefined;
		try {
			const target: EnvTarget = { conversationId, read: this.#harness };
			return await this.#environment(target, BACKGROUND_CONTEXT);
		} catch (error) {
			console.warn("[core] building the attachment environment failed:", error);
			return undefined;
		}
	}

	async #refreshProviders(providerId?: string, force = false): Promise<ProviderRefreshReport[]> {
		const reports = await this.#providers.refresh({
			...(providerId === undefined ? {} : { providerId }),
			force,
		});
		await this.#emitProviders();
		return reports;
	}

	async #emitProviders(): Promise<void> {
		this.#emit({ type: "providers", ...(await this.listProviders()) });
	}

	/** The model and thinking level a new session starts with, honouring the stored defaults. */
	async #initialAgentChange(): Promise<SessionAgentChange> {
		// Same order as the model picker, so "first available" is the first row users see.
		const available = sortModelsForDisplay(await this.#providers.models.getAvailable());
		const preferred = this.#providers.getDefaults().model;
		const chosen =
			(preferred === undefined
				? undefined
				: available.find(
						(model) => model.provider === preferred.provider && model.id === preferred.modelId,
					)) ?? available[0];
		const change: SessionAgentChange = {};
		if (chosen !== undefined) change.model = { provider: chosen.provider, modelId: chosen.id };

		const level = this.#providers.getDefaults().thinkingLevel;
		if (level !== undefined && chosen !== undefined) {
			change.thinkingLevel = clampThinkingLevel(chosen, level);
		}
		return change;
	}

	async #requireSession(id: string): Promise<SessionSummary> {
		const session = (await this.listSessions()).find((candidate) => candidate.id === id);
		if (session === undefined) throw new ServiceError("not_found", `Unknown session: ${id}`);
		return session;
	}

	async #requireConversation(id: ConversationId): Promise<Conversation> {
		// Deleted sessions stay in storage; the index is what makes them reachable.
		await this.#requireSession(String(id));
		const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new ServiceError("not_found", `Unknown session: ${id}`);
		return conversation;
	}

	async #updateSession(id: string, change: (entry: SessionIndexEntry) => void): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const index = await tx.doc(SessionIndex);
			const entry = index.sessions.find((candidate) => candidate.id === id);
			if (entry === undefined) throw new ServiceError("not_found", `Unknown session: ${id}`);
			change(entry);
			entry.updatedAt = Date.now();
		}, BACKGROUND_CONTEXT);
	}
}
