import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { buildPromptContent, saveAttachment } from "./attachments.ts";
import { ServiceError } from "./errors.ts";
import { createImageTools } from "./image-tool.ts";
import {
	createRegistry,
	Harness,
	watchEvents,
	type AgentEvent,
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type DocumentWatch,
	type SnapshotEvent,
	type Storage,
	type TaskGraph,
	type TaskGraphWatch,
} from "@earendil-works/pi-durable";
import type {
	DefaultsState,
	ImageModelInfo,
	ModelInfo,
	ModelRef,
	ModelThinkingLevel,
	PromptAttachment,
	ProviderInfo,
	ProviderRefreshReport,
	SessionSummary,
} from "@harness/protocol";
import type { EnvironmentFactory } from "./environment.ts";
import { sortModelsForDisplay } from "./model-order.ts";
import type { Providers } from "./providers.ts";
import { SessionIndex, type SessionIndexEntry, type SessionIndexState } from "./session-index.ts";

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

type SessionSubscription = {
	stream: AgentEventStream;
	listeners: Set<(events: readonly AgentEvent[]) => void>;
};

export type HarnessServiceDependencies = {
	storage: Storage;
	providers: Providers;
	/** Builds each conversation's execution environment. Without one, the coding tools fail. */
	environment?: EnvironmentFactory;
};

/**
 * The core of the harness: it owns the durable `Harness`, provider credentials, and the session
 * index. It knows nothing about HTTP or WebSockets; clients subscribe through the methods below.
 */
export class HarnessService {
	readonly #harness: Harness;
	readonly #providers: Providers;
	readonly #environment: EnvironmentFactory | undefined;
	readonly #subscriptions = new Map<ConversationId, Promise<SessionSubscription>>();
	readonly #listeners = new Set<(event: ServiceEvent) => void>();
	#indexWatch: DocumentWatch<SessionIndexState> | undefined;
	#taskGraphWatch: TaskGraphWatch | undefined;
	#working = new Set<string>();
	#closed = false;

	private constructor(harness: Harness, providers: Providers, environment: EnvironmentFactory | undefined) {
		this.#harness = harness;
		this.#providers = providers;
		this.#environment = environment;
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
		const harness = await Harness.open(
			dependencies.storage,
			{
				models: providers.models,
				registry,
				...(dependencies.environment === undefined ? {} : { env: dependencies.environment }),
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

		const service = new HarnessService(harness, providers, dependencies.environment);
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
		return (index?.sessions ?? [])
			.map((entry) => ({
				id: entry.id,
				title: entry.title,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
				working: this.#working.has(entry.id),
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async createSession(): Promise<SessionSummary> {
		const conversation = await this.#harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		const change = await this.#initialAgentChange();
		if (Object.keys(change).length > 0) await conversation.configure(change, BACKGROUND_CONTEXT);
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

		const pending = this.#subscriptions.get(conversationId);
		if (pending !== undefined) {
			this.#subscriptions.delete(conversationId);
			try {
				const subscription = await pending;
				await subscription.stream.stop();
			} catch (error) {
				console.warn(`[core] stopping session ${id} events before delete failed:`, error);
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
		const env =
			attachments.length === 0 ? undefined : await this.#buildEnvironment(conversationId, agent.cwd);
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

	async subscribeSession(
		id: string,
		listener: (events: readonly AgentEvent[]) => void,
	): Promise<{ snapshot: SnapshotEvent; unsubscribe: () => void }> {
		const conversationId = parseConversationId(id);
		await this.#requireConversation(conversationId);
		const subscription = await this.#getSubscription(conversationId);
		subscription.listeners.add(listener);
		return {
			snapshot: subscription.stream.snapshot,
			unsubscribe: () => {
				const pending = this.#subscriptions.get(conversationId);
				if (pending === undefined) return;
				void pending.then((current) => {
					current.listeners.delete(listener);
					if (current.listeners.size === 0 && this.#subscriptions.get(conversationId) === pending) {
						this.#subscriptions.delete(conversationId);
						void current.stream.stop();
					}
				});
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

	/** Store the model and thinking level new sessions start with. */
	async setDefaults(change: {
		model?: ModelRef | null;
		thinkingLevel?: ModelThinkingLevel | null;
		imageModel?: ModelRef | null;
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
		const pending = [...this.#subscriptions.values()];
		this.#subscriptions.clear();
		for (const subscription of pending) {
			try {
				const current = await subscription;
				await current.stream.stop();
			} catch (error) {
				console.warn("[core] stopping session subscription failed:", error);
			}
		}
		await this.#harness.close(BACKGROUND_CONTEXT);
	}

	#getSubscription(id: ConversationId): Promise<SessionSubscription> {
		const existing = this.#subscriptions.get(id);
		if (existing !== undefined) return existing;
		const created = (async () => {
			const stream = await watchEvents(this.#harness, id, BACKGROUND_CONTEXT);
			const subscription: SessionSubscription = { stream, listeners: new Set() };
			stream.start(async (events) => {
				for (const listener of [...subscription.listeners]) listener(events);
			});
			return subscription;
		})();
		created.catch(() => {
			if (this.#subscriptions.get(id) === created) this.#subscriptions.delete(id);
		});
		this.#subscriptions.set(id, created);
		return created;
	}

	/** Build the environment a conversation's tools run in, or undefined when none is configured. */
	async #buildEnvironment(conversationId: ConversationId, cwd: string | undefined): Promise<ExecutionEnv | undefined> {
		if (this.#environment === undefined) return undefined;
		try {
			return await this.#environment(
				{ conversationId, ...(cwd === undefined ? {} : { cwd }), read: this.#harness },
				BACKGROUND_CONTEXT,
			);
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
