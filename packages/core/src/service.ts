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
	SessionSummary,
	TargetChoice,
	TargetInfo,
	WorkspacesBrowseResult,
} from "@harness/protocol";
import type { EnvironmentFactory } from "./environment.ts";
import { sortModelsForDisplay } from "./model-order.ts";
import type { Providers } from "./providers.ts";
import { SessionIndex, type SessionIndexEntry, type SessionIndexState } from "./session-index.ts";
import {
	createTargetSection,
	resolveTarget,
	scratchPath,
	SessionTargetDoc,
	TargetChangeEntry,
	type ResolvedTarget,
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

/** Provider and session-list changes the server forwards to every connected client. */
export type ServiceEvent =
	| { type: "sessions"; sessions: SessionSummary[] }
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
};

/** The protocol view of a resolved target. */
function targetInfo(target: ResolvedTarget): TargetInfo {
	return { kind: "local", path: target.path, scratch: target.scratch };
}

/** Resolve the session's target, then build the local environment at its directory. */
function composeEnvironment(
	local: EnvironmentFactory,
	workspacesDir: string | undefined,
	providers: Providers,
): EnvironmentFactory {
	return async (target, context) => {
		const resolved = await resolveTarget(target.read, target.conversationId, context, {
			...(workspacesDir === undefined ? {} : { workspacesDir }),
			defaultTarget: providers.getDefaults().target,
		});
		return local({ ...target, ...(resolved.path === "" ? {} : { cwd: resolved.path }) }, context);
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
	) {
		this.#harness = harness;
		this.#providers = providers;
		this.#environment = environment;
		this.#workspacesDir = workspacesDir;
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
					}),
				],
			}),
		);
		const environment =
			dependencies.environment === undefined
				? undefined
				: composeEnvironment(dependencies.environment, dependencies.workspacesDir, providers);
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

		const service = new HarnessService(harness, providers, environment, dependencies.workspacesDir);
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
			entries.map(async (entry) => ({
				id: entry.id,
				title: entry.title,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				working: this.#working.has(entry.id),
				target: targetInfo(await this.#resolveTarget(parseConversationId(entry.id))),
			})),
		);
	}

	/** Where one session's tools run, following the default when the session stores none. */
	async #resolveTarget(conversationId: ConversationId): Promise<ResolvedTarget> {
		return resolveTarget(this.#harness, conversationId, BACKGROUND_CONTEXT, {
			...(this.#workspacesDir === undefined ? {} : { workspacesDir: this.#workspacesDir }),
			defaultTarget: this.#providers.getDefaults().target,
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
			target.kind = "local";
			target.path = this.#providers.getDefaults().target?.path ?? null;
		}, BACKGROUND_CONTEXT);
		return this.#requireSession(String(conversation.id));
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
		const env = attachments.length === 0 ? undefined : await this.#buildEnvironment(conversationId);
		const content = await buildPromptContent(trimmed, attachments, model?.input, (attachment, index) =>
			env === undefined ? Promise.resolve(undefined) : saveAttachment(env, id, attachment, index, BACKGROUND_CONTEXT),
		);

		await this.#updateSession(id, (entry) => {
			if (entry.title === NEW_SESSION_TITLE) {
				entry.title = deriveTitle(
					trimmed === "" ? attachments.map((attachment) => attachment.name).join(", ") : trimmed,
				);
			}
		});
		const submission = await conversation.submit(
			{ type: "input", content, requestId },
			BACKGROUND_CONTEXT,
		);
		return { submissionId: String(submission.id) };
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
	 * Point a session at a local folder, or back at its scratch directory. The change takes effect on
	 * the next run; a visible entry records it so the transcript and the model stay honest.
	 */
	async setTarget(id: string, choice: TargetChoice): Promise<SessionSummary> {
		const conversationId = parseConversationId(id);
		await this.#requireConversation(conversationId);
		if (this.#working.has(id)) {
			throw new ServiceError("busy", "Wait for the run to finish before changing the target");
		}
		const path = choice.path?.trim();
		if (path !== undefined && path !== "") {
			const info = await stat(path).catch(() => undefined);
			if (info === undefined || !info.isDirectory()) {
				throw new ServiceError("invalid", `Not a directory: ${path}`);
			}
		}
		const target: ResolvedTarget =
			path === undefined || path === ""
				? { kind: "local", path: scratchPath(this.#workspacesDir, conversationId), scratch: true }
				: { kind: "local", path, scratch: false };
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(SessionTargetDoc, conversationId);
			doc.kind = "local";
			doc.path = target.scratch ? null : target.path;
			await tx.appendEntry(TargetChangeEntry, conversationId, {
				data: { path: target.path, scratch: target.scratch },
			});
		}, BACKGROUND_CONTEXT);
		await this.#emitSessions();
		return this.#requireSession(id);
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
			const path = change.target.path?.trim();
			if (path !== undefined && path !== "") {
				const info = await stat(path).catch(() => undefined);
				if (info === undefined || !info.isDirectory()) {
					throw new ServiceError("invalid", `Not a directory: ${path}`);
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
