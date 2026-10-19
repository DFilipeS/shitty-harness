import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	type ReactNode,
} from "react";
import type {
	AgentState,
	DefaultsState,
	ImageModelInfo,
	ModelInfo,
	ModelRef,
	ModelThinkingLevel,
	PromptAttachment,
	ProviderInfo,
	ProviderRefreshReport,
	ProviderTemplateInfo,
	QuestionReply,
	SandboxChoice,
	SandboxInfo,
	SandboxMetricsInfo,
	SandboxSettingsInfo,
	SandboxesState,
	SessionSummary,
	SessionsSkillsResult,
	SessionsSystemPromptResult,
	TargetChoice,
	TargetStatus,
	TemplateInfo,
	TemplateRecipeInput,
	TemplatesLogsResult,
	TemplatesState,
	WorkspacesBrowseResult,
} from "@harness/protocol";
import { HarnessClient, ServerCommandError, type ConnectionStatus } from "./client.ts";
import { errorMessage, formatRefreshNotice } from "./format.ts";
import { initialState, reducer, type Notice, type SessionState } from "./session-state.ts";
import { sessionIdFromPath, sessionPath } from "./url.ts";

type HarnessContextValue = {
	status: ConnectionStatus;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	/** Every session's live state, keyed by id; the web client keeps a few visited ones mounted. */
	sessionStates: Record<string, SessionState>;
	providers: ProviderInfo[];
	models: ModelInfo[];
	imageModels: ImageModelInfo[];
	defaults: DefaultsState;
	sandboxProvider: string;
	sandboxSettings?: SandboxSettingsInfo;
	sandboxes: SandboxInfo[];
	templatesProvider: string;
	templatesProviderName: string;
	templatesConfigured: boolean;
	templates: TemplateInfo[];
	templatesDefault?: string;
	templatesOther: ProviderTemplateInfo[];
	targetStatus: Record<string, TargetStatus>;
	activeSessionId?: string;
	activeSession?: SessionState;
	error?: string;
	notice?: Notice;
	createSession(): Promise<void>;
	selectSession(id: string): void;
	renameSession(id: string, title: string): Promise<void>;
	deleteSession(id: string): Promise<void>;
	sendPrompt(text: string, attachments?: readonly PromptAttachment[]): Promise<void>;
	abortSession(): Promise<void>;
	/** Remove one message from the active session's queue; a notice reports races with the run. */
	withdrawQueued(submissionId: string): Promise<void>;
	/** Reply to the active session's open question; false when the server refused it. */
	answerQuestion(callId: string, reply: QuestionReply): Promise<boolean>;
	finishLive(sessionId: string): void;
	configureModel(model: ModelRef): Promise<void>;
	configureThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	configureProvider(providerId: string, apiKey: string | null): Promise<void>;
	setTarget(target: TargetChoice): Promise<void>;
	browseWorkspaces(path?: string): Promise<WorkspacesBrowseResult>;
	/** A session's skills; undefined when the server could not list them. */
	listSkills(sessionId: string): Promise<SessionsSkillsResult | undefined>;
	/** A session's system prompt sections; undefined when the server could not replay them. */
	systemPrompt(sessionId: string): Promise<SessionsSystemPromptResult | undefined>;
	createWorkspaceFolder(parent: string, name: string): Promise<{ path: string } | undefined>;
	refreshSandboxes(): Promise<SandboxesState | undefined>;
	createSandbox(choice: SandboxChoice): Promise<SandboxInfo | undefined>;
	pauseSandbox(provider: string, sandboxId: string): Promise<SandboxesState | undefined>;
	resumeSandbox(provider: string, sandboxId: string): Promise<SandboxesState | undefined>;
	killSandbox(provider: string, sandboxId: string): Promise<void>;
	configureSandbox(provider: string, apiKey: string | null): Promise<void>;
	setSandboxSettings(change: {
		provider?: string;
		template?: string | null;
		idleTimeoutMs?: number | null;
		autoPause?: boolean | null;
		sshAgentSocket?: string | null;
		forwardAgent?: boolean | null;
	}): Promise<SandboxesState | undefined>;
	sandboxMetrics(provider: string, sandboxId: string): Promise<SandboxMetricsInfo | undefined>;
	refreshTemplates(): Promise<TemplatesState | undefined>;
	createTemplate(name: string, recipe?: TemplateRecipeInput): Promise<TemplatesState | undefined>;
	createStarterTemplate(): Promise<TemplatesState | undefined>;
	updateTemplate(name: string, recipe: TemplateRecipeInput): Promise<TemplatesState | undefined>;
	buildTemplate(name: string): Promise<TemplatesState | undefined>;
	templateLogs(name: string): Promise<TemplatesLogsResult | undefined>;
	removeTemplate(name: string): Promise<TemplatesState | undefined>;
	deleteTemplate(name: string): Promise<TemplatesState | undefined>;
	deleteProviderTemplate(templateId: string): Promise<TemplatesState | undefined>;
	setDefaults(change: {
		model?: ModelRef | null;
		thinkingLevel?: ModelThinkingLevel | null;
		imageModel?: ModelRef | null;
		target?: TargetChoice | null;
	}): Promise<void>;
	refreshProviders(): Promise<void>;
	clearError(): void;
	clearNotice(): void;
};

const HarnessContext = createContext<HarnessContextValue | undefined>(undefined);

export function HarnessProvider({ children }: { children: ReactNode }) {
	const client = useMemo(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return new HarnessClient(`${protocol}//${window.location.host}/ws`);
	}, []);
	const [state, dispatch] = useReducer(reducer, initialState);
	const templatesDefault = state.templatesDefault;

	useEffect(() => {
		const unsubscribeEvents = client.onEvent((event) => {
			if (event.type === "session.event") {
				dispatch({ type: "session/event", id: event.sessionId, event: event.event });
			} else if (event.type === "sessions.changed") {
				dispatch({ type: "sessions/set", sessions: event.sessions });
			} else if (event.type === "sandboxes.changed") {
				dispatch({
					type: "sandboxes/set",
					provider: event.provider,
					settings: event.settings,
					sandboxes: event.sandboxes,
				});
			} else if (event.type === "session.target") {
				dispatch({ type: "target/status", status: event.status });
			} else if (event.type === "templates.changed") {
				dispatch({
					type: "templates/set",
					provider: event.provider,
					providerName: event.providerName,
					configured: event.configured,
					templates: event.templates,
					...(event.default === undefined ? {} : { default: event.default }),
					other: event.other,
				});
			} else {
				dispatch({
					type: "providers/set",
					providers: event.providers,
					models: event.models,
					imageModels: event.imageModels,
					defaults: event.defaults,
				});
			}
		});
		const unsubscribeStatus = client.onStatus((status) => dispatch({ type: "status", status }));
		client.connect();
		return () => {
			unsubscribeEvents();
			unsubscribeStatus();
		};
	}, [client]);

	// Refresh the lists whenever a connection is (re)established.
	useEffect(() => {
		if (state.status !== "connected") return;
		void (async () => {
			try {
				const [sessions, providers, sandboxes, templates] = await Promise.all([
					client.send({ type: "sessions.list" }),
					client.send({ type: "providers.list" }),
					client.send({ type: "sandboxes.list" }),
					client.send({ type: "templates.list" }),
				]);
				dispatch({ type: "sessions/set", sessions: sessions.sessions });
				dispatch({
					type: "providers/set",
					providers: providers.providers,
					models: providers.models,
					imageModels: providers.imageModels,
					defaults: providers.defaults,
				});
				dispatch({
					type: "sandboxes/set",
					provider: sandboxes.provider,
					settings: sandboxes.settings,
					sandboxes: sandboxes.sandboxes,
				});
				dispatch({
					type: "templates/set",
					provider: templates.provider,
					providerName: templates.providerName,
					configured: templates.configured,
					templates: templates.templates,
					...(templates.default === undefined ? {} : { default: templates.default }),
					other: templates.other,
				});
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		})();
	}, [state.status, client]);

	// Attach to the active session while it is selected and the connection is up.
	useEffect(() => {
		const id = state.activeSessionId;
		if (state.status !== "connected" || id === undefined) return;
		let cancelled = false;
		void (async () => {
			try {
				const { snapshot } = await client.send({ type: "sessions.attach", sessionId: id });
				if (!cancelled) dispatch({ type: "session/attached", id, snapshot });
			} catch (error) {
				if (cancelled) return;
				// The session is gone (deleted here or in another tab): drop it and clean the URL.
				if (error instanceof ServerCommandError && error.code === "not_found") {
					window.history.replaceState(null, "", "/");
					dispatch({ type: "session/deactivate" });
					return;
				}
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		})();
		return () => {
			cancelled = true;
			void client.send({ type: "sessions.detach", sessionId: id }).catch(() => undefined);
		};
	}, [state.status, state.activeSessionId, client]);

	// The event stream carries only the queued ids, so fetch their text whenever the ids change.
	// Re-attaching re-runs this too, so a queue that changed in another tab while detached heals.
	const queuedIds =
		state.activeSessionId === undefined
			? undefined
			: state.sessionsById[state.activeSessionId]?.inbox.map((item) => item.id).join(",");
	useEffect(() => {
		const id = state.activeSessionId;
		if (state.status !== "connected" || id === undefined || queuedIds === undefined) return;
		let cancelled = false;
		void (async () => {
			try {
				const { items } = await client.send({ type: "sessions.queue", sessionId: id });
				if (!cancelled) dispatch({ type: "session/queue", id, ids: queuedIds, items });
			} catch (error) {
				// The session is gone; the session list cleans it up.
				if (cancelled || (error instanceof ServerCommandError && error.code === "not_found"))
					return;
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [state.status, state.activeSessionId, queuedIds, client]);

	// Back and forward move between sessions, following the URL.
	useEffect(() => {
		const onPopState = () => {
			const id = sessionIdFromPath(window.location.pathname);
			if (id === undefined) dispatch({ type: "session/deactivate" });
			else dispatch({ type: "session/activate", id });
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	// Open the session named in the URL once the list is known; drop ids that no longer exist.
	useEffect(() => {
		if (!state.sessionsLoaded) return;
		const id = sessionIdFromPath(window.location.pathname);
		if (id === undefined) return;
		if (state.sessions.some((session) => session.id === id)) {
			if (state.activeSessionId !== id) dispatch({ type: "session/activate", id });
			return;
		}
		window.history.replaceState(null, "", "/");
		dispatch({ type: "session/deactivate" });
	}, [state.sessionsLoaded, state.sessions, state.activeSessionId]);

	/** Select a session and keep the URL in step, so reloads and shared links open it. */
	const activateSession = useCallback(
		(id: string | undefined, mode: "push" | "replace" = "push") => {
			if (id === undefined) dispatch({ type: "session/deactivate" });
			else dispatch({ type: "session/activate", id });
			const path = id === undefined ? "/" : sessionPath(id);
			if (window.location.pathname === path) return;
			if (mode === "push") window.history.pushState(null, "", path);
			else window.history.replaceState(null, "", path);
		},
		[],
	);

	const createSession = useCallback(async () => {
		try {
			const { session } = await client.send({ type: "sessions.create" });
			dispatch({ type: "sessions/upsert", session });
			activateSession(session.id);
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
		}
	}, [client, activateSession]);

	const selectSession = useCallback(
		(id: string) => {
			activateSession(id);
		},
		[activateSession],
	);

	const renameSession = useCallback(
		async (id: string, title: string) => {
			try {
				const { session } = await client.send({ type: "sessions.rename", sessionId: id, title });
				dispatch({ type: "sessions/upsert", session });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client],
	);

	const sendPrompt = useCallback(
		async (text: string, attachments?: readonly PromptAttachment[]) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				await client.send({
					type: "sessions.prompt",
					sessionId: id,
					text,
					requestId: crypto.randomUUID(),
					...(attachments === undefined || attachments.length === 0
						? {}
						: { attachments: [...attachments] }),
				});
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, state.activeSessionId],
	);

	const abortSession = useCallback(async () => {
		const id = state.activeSessionId;
		if (id === undefined) return;
		try {
			await client.send({ type: "sessions.abort", sessionId: id });
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
		}
	}, [client, state.activeSessionId]);

	/** Remove one queued message; the queue updates through the session's next inbox event. */
	const withdrawQueued = useCallback(
		async (submissionId: string) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				const { outcome } = await client.send({
					type: "sessions.withdraw",
					sessionId: id,
					submissionId,
				});
				if (outcome === "already_placed") {
					dispatch({
						type: "notice/set",
						notice: { text: "The run picked that message up already.", tone: "info" },
					});
				} else if (outcome === "settled") {
					dispatch({
						type: "notice/set",
						notice: { text: "That message is no longer queued.", tone: "info" },
					});
				}
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, state.activeSessionId],
	);

	const answerQuestion = useCallback(
		async (callId: string, reply: QuestionReply) => {
			const id = state.activeSessionId;
			if (id === undefined) return false;
			try {
				await client.send({ type: "sessions.answer", sessionId: id, callId, reply });
				return true;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return false;
			}
		},
		[client, state.activeSessionId],
	);

	const finishLive = useCallback((sessionId: string) => {
		dispatch({ type: "session/live-done", id: sessionId });
	}, []);

	const configureModel = useCallback(
		async (model: ModelRef) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				const { agent } = await client.send({ type: "sessions.configure", sessionId: id, model });
				dispatch({ type: "session/agent", id, agent });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, state.activeSessionId],
	);

	const configureThinkingLevel = useCallback(
		async (thinkingLevel: ModelThinkingLevel) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				const { agent } = await client.send({
					type: "sessions.configure",
					sessionId: id,
					thinkingLevel,
				});
				dispatch({ type: "session/agent", id, agent });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, state.activeSessionId],
	);

	const deleteSession = useCallback(
		async (id: string) => {
			try {
				await client.send({ type: "sessions.delete", sessionId: id });
				if (sessionIdFromPath(window.location.pathname) === id)
					activateSession(undefined, "replace");
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, activateSession],
	);

	const configureProvider = useCallback(
		async (providerId: string, apiKey: string | null) => {
			try {
				const providers = await client.send({ type: "providers.configure", providerId, apiKey });
				dispatch({
					type: "providers/set",
					providers: providers.providers,
					models: providers.models,
					imageModels: providers.imageModels,
					defaults: providers.defaults,
				});
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client],
	);

	const setTarget = useCallback(
		async (target: TargetChoice) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				const { session } = await client.send({
					type: "sessions.setTarget",
					sessionId: id,
					target,
				});
				dispatch({ type: "sessions/upsert", session });
				dispatch({ type: "target/clear", sessionId: id });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, state.activeSessionId],
	);

	const applySandboxes = useCallback(
		(state: { provider: string; settings: SandboxSettingsInfo; sandboxes: SandboxInfo[] }) => {
			dispatch({
				type: "sandboxes/set",
				provider: state.provider,
				settings: state.settings,
				sandboxes: state.sandboxes,
			});
		},
		[],
	);

	const refreshSandboxes = useCallback(async () => {
		try {
			const state = await client.send({ type: "sandboxes.list" });
			applySandboxes(state);
			return state;
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
			return undefined;
		}
	}, [client, applySandboxes]);

	const createSandbox = useCallback(
		async (choice: SandboxChoice) => {
			try {
				const state = await client.send({ type: "sandboxes.create", choice });
				applySandboxes(state);
				const id = state.sandboxes[0]?.id;
				return state.sandboxes.find((sandbox) => sandbox.id === id);
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client, applySandboxes],
	);

	const pauseSandbox = useCallback(
		async (provider: string, sandboxId: string) => {
			try {
				const state = await client.send({ type: "sandboxes.pause", provider, sandboxId });
				applySandboxes(state);
				return state;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client, applySandboxes],
	);

	const resumeSandbox = useCallback(
		async (provider: string, sandboxId: string) => {
			try {
				const state = await client.send({ type: "sandboxes.resume", provider, sandboxId });
				applySandboxes(state);
				return state;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client, applySandboxes],
	);

	const killSandbox = useCallback(
		async (provider: string, sandboxId: string) => {
			try {
				applySandboxes(await client.send({ type: "sandboxes.kill", provider, sandboxId }));
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, applySandboxes],
	);

	const configureSandbox = useCallback(
		async (provider: string, apiKey: string | null) => {
			try {
				applySandboxes(await client.send({ type: "sandboxes.configure", provider, apiKey }));
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, applySandboxes],
	);

	const setSandboxSettings = useCallback(
		async (change: {
			provider?: string;
			template?: string | null;
			idleTimeoutMs?: number | null;
			autoPause?: boolean | null;
			sshAgentSocket?: string | null;
			forwardAgent?: boolean | null;
		}) => {
			try {
				const state = await client.send({ type: "sandboxes.settings", ...change });
				applySandboxes(state);
				return state;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client, applySandboxes],
	);

	const sandboxMetrics = useCallback(
		async (provider: string, sandboxId: string) => {
			try {
				return (await client.send({ type: "sandboxes.metrics", provider, sandboxId })).metrics;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client],
	);

	const applyTemplates = useCallback(
		(state: {
			provider: string;
			providerName: string;
			configured: boolean;
			templates: TemplateInfo[];
			default?: string;
			other: ProviderTemplateInfo[];
		}) => {
			dispatch({
				type: "templates/set",
				provider: state.provider,
				providerName: state.providerName,
				configured: state.configured,
				templates: state.templates,
				...(state.default === undefined ? {} : { default: state.default }),
				other: state.other,
			});
		},
		[],
	);

	/** Tell the user when a removal left new sandboxes on the provider default. */
	const noteDefaultReset = useCallback(
		(previous: string | undefined, name: string, next: TemplatesState | undefined) => {
			if (previous !== name || next?.default !== undefined) return;
			dispatch({
				type: "notice/set",
				notice: {
					text: `Template ${name} was the default; new sandboxes will use the provider default.`,
					tone: "info",
				},
			});
		},
		[],
	);

	/** Run a template command that returns the whole list, reporting failures as a toast. */
	const templateCommand = useCallback(
		async (send: () => Promise<TemplatesState>): Promise<TemplatesState | undefined> => {
			try {
				const state = await send();
				applyTemplates(state);
				return state;
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[applyTemplates],
	);

	const refreshTemplates = useCallback(
		async () => await templateCommand(() => client.send({ type: "templates.list" })),
		[templateCommand, client],
	);

	const createTemplate = useCallback(
		async (name: string, recipe?: TemplateRecipeInput) =>
			await templateCommand(() =>
				client.send({
					type: "templates.create",
					name,
					...(recipe === undefined ? {} : { recipe }),
				}),
			),
		[templateCommand, client],
	);

	const createStarterTemplate = useCallback(
		async () => await templateCommand(() => client.send({ type: "templates.createStarter" })),
		[templateCommand, client],
	);

	const updateTemplate = useCallback(
		async (name: string, recipe: TemplateRecipeInput) =>
			await templateCommand(() => client.send({ type: "templates.update", name, recipe })),
		[templateCommand, client],
	);

	const buildTemplate = useCallback(
		async (name: string) =>
			await templateCommand(() => client.send({ type: "templates.build", name })),
		[templateCommand, client],
	);

	const templateLogs = useCallback(
		async (name: string) => {
			try {
				return await client.send({ type: "templates.logs", name });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client],
	);

	const removeTemplate = useCallback(
		async (name: string) => {
			const state = await templateCommand(() => client.send({ type: "templates.remove", name }));
			noteDefaultReset(templatesDefault, name, state);
			return state;
		},
		[templateCommand, client, noteDefaultReset, templatesDefault],
	);

	const deleteTemplate = useCallback(
		async (name: string) => {
			const state = await templateCommand(() => client.send({ type: "templates.delete", name }));
			noteDefaultReset(templatesDefault, name, state);
			return state;
		},
		[templateCommand, client, noteDefaultReset, templatesDefault],
	);

	const deleteProviderTemplate = useCallback(
		async (templateId: string) =>
			await templateCommand(() => client.send({ type: "templates.deleteProvider", templateId })),
		[templateCommand, client],
	);

	const listSkills = useCallback(
		async (sessionId: string) => {
			try {
				return await client.send({ type: "sessions.skills", sessionId });
			} catch (error) {
				console.warn("[skills] listing failed:", error);
				return undefined;
			}
		},
		[client],
	);

	/** The session's system prompt sections; undefined when the server could not replay them. */
	const systemPrompt = useCallback(
		async (sessionId: string) => {
			try {
				return await client.send({ type: "sessions.systemPrompt", sessionId });
			} catch (error) {
				console.warn("[session-panel] loading the system prompt failed:", error);
				return undefined;
			}
		},
		[client],
	);

	const browseWorkspaces = useCallback(
		async (path?: string) =>
			client.send({ type: "workspaces.browse", ...(path === undefined ? {} : { path }) }),
		[client],
	);

	const createWorkspaceFolder = useCallback(
		async (parent: string, name: string) => {
			try {
				return await client.send({ type: "workspaces.createFolder", parent, name });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
				return undefined;
			}
		},
		[client],
	);

	const setDefaults = useCallback(
		async (change: {
			model?: ModelRef | null;
			thinkingLevel?: ModelThinkingLevel | null;
			imageModel?: ModelRef | null;
			target?: TargetChoice | null;
		}) => {
			try {
				const result = await client.send({ type: "defaults.set", ...change });
				dispatch({ type: "defaults/set", defaults: result.defaults });
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client],
	);

	const refreshProviders = useCallback(async () => {
		try {
			const result = await client.send({ type: "providers.refresh" });
			dispatch({
				type: "providers/set",
				providers: result.providers,
				models: result.models,
				imageModels: result.imageModels,
				defaults: result.defaults,
			});
			const notice = formatRefreshNotice(result.refresh);
			if (notice !== undefined) dispatch({ type: "notice/set", notice });
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
		}
	}, [client]);

	const clearNotice = useCallback(() => dispatch({ type: "notice/clear" }), []);

	const value = useMemo<HarnessContextValue>(
		() => ({
			status: state.status,
			sessions: state.sessions,
			sessionsLoaded: state.sessionsLoaded,
			sessionStates: state.sessionsById,
			providers: state.providers,
			models: state.models,
			imageModels: state.imageModels,
			defaults: state.defaults,
			sandboxProvider: state.sandboxProvider,
			...(state.sandboxSettings === undefined ? {} : { sandboxSettings: state.sandboxSettings }),
			sandboxes: state.sandboxes,
			templatesProvider: state.templatesProvider,
			templatesProviderName: state.templatesProviderName,
			templatesConfigured: state.templatesConfigured,
			templates: state.templates,
			...(state.templatesDefault === undefined ? {} : { templatesDefault: state.templatesDefault }),
			templatesOther: state.templatesOther,
			targetStatus: state.targetStatus,
			...(state.activeSessionId === undefined ? {} : { activeSessionId: state.activeSessionId }),
			...(state.activeSessionId === undefined ||
			state.sessionsById[state.activeSessionId] === undefined
				? {}
				: { activeSession: state.sessionsById[state.activeSessionId] }),
			...(state.error === undefined ? {} : { error: state.error }),
			...(state.notice === undefined ? {} : { notice: state.notice }),
			createSession,
			selectSession,
			renameSession,
			deleteSession,
			sendPrompt,
			abortSession,
			withdrawQueued,
			answerQuestion,
			finishLive,
			configureModel,
			configureThinkingLevel,
			configureProvider,
			setTarget,
			browseWorkspaces,
			listSkills,
			createWorkspaceFolder,
			refreshSandboxes,
			createSandbox,
			pauseSandbox,
			resumeSandbox,
			killSandbox,
			configureSandbox,
			setSandboxSettings,
			sandboxMetrics,
			refreshTemplates,
			createTemplate,
			createStarterTemplate,
			updateTemplate,
			buildTemplate,
			templateLogs,
			removeTemplate,
			deleteTemplate,
			deleteProviderTemplate,
			setDefaults,
			refreshProviders,
			systemPrompt,
			clearError: () => dispatch({ type: "error/clear" }),
			clearNotice,
		}),
		[
			state,
			createSession,
			selectSession,
			renameSession,
			deleteSession,
			sendPrompt,
			abortSession,
			withdrawQueued,
			answerQuestion,
			finishLive,
			configureModel,
			configureThinkingLevel,
			configureProvider,
			setTarget,
			browseWorkspaces,
			listSkills,
			createWorkspaceFolder,
			refreshSandboxes,
			createSandbox,
			pauseSandbox,
			resumeSandbox,
			killSandbox,
			configureSandbox,
			setSandboxSettings,
			sandboxMetrics,
			refreshTemplates,
			createTemplate,
			createStarterTemplate,
			updateTemplate,
			buildTemplate,
			templateLogs,
			removeTemplate,
			deleteTemplate,
			deleteProviderTemplate,
			setDefaults,
			refreshProviders,
			systemPrompt,
			clearNotice,
		],
	);

	return <HarnessContext.Provider value={value}>{children}</HarnessContext.Provider>;
}

export function useHarness(): HarnessContextValue {
	const value = useContext(HarnessContext);
	if (value === undefined) throw new Error("useHarness must be used inside HarnessProvider");
	return value;
}
