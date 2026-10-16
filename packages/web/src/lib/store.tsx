import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type {
	AgentEvent,
	AgentState,
	DefaultsState,
	EntryRecord,
	ImageModelInfo,
	ModelInfo,
	ModelRef,
	ModelThinkingLevel,
	PromptAttachment,
	ProviderInfo,
	ProviderRefreshReport,
	SandboxChoice,
	SandboxInfo,
	SandboxMetricsInfo,
	SandboxSettingsInfo,
	SessionSummary,
	SnapshotEvent,
	TargetChoice,
	TargetStatus,
	UsageState,
	WorkspacesBrowseResult,
} from "@harness/protocol";
import { HarnessClient, ServerCommandError, type ConnectionStatus } from "./client.ts";
import { errorMessage, formatRefreshNotice } from "./format.ts";
import { applyMessageChanges, fromAssistantMessage, type LiveMessage } from "./messages.ts";
import { sessionIdFromPath, sessionPath } from "./url.ts";

/**
 * The in-flight assistant message plus what the typing animation needs: a stable `key` so the
 * animation restarts per message, the committed `entryId` once the message is durable, and
 * `finished` once no more text will arrive.
 */
export type LiveMessageState = LiveMessage & {
	key: string;
	entryId?: EntryRecord["id"];
	finished?: boolean;
};

export type SessionState = {
	id: string;
	attached: boolean;
	entries: EntryRecord[];
	live?: LiveMessageState;
	runActive: boolean;
	agent: AgentState;
	inbox: { id: string; mode: string }[];
	usage?: UsageState;
};

type State = {
	status: ConnectionStatus;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	providers: ProviderInfo[];
	models: ModelInfo[];
	imageModels: ImageModelInfo[];
	defaults: DefaultsState;
	sandboxProvider: string;
	sandboxSettings?: SandboxSettingsInfo;
	sandboxes: SandboxInfo[];
	targetStatus: Record<string, TargetStatus>;
	activeSessionId?: string;
	sessionsById: Record<string, SessionState>;
	error?: string;
	notice?: Notice;
};

/** Transient feedback, e.g. what a model catalog refresh did. */
export type Notice = {
	text: string;
	tone: "info" | "error";
};

type Action =
	| { type: "status"; status: ConnectionStatus }
	| { type: "sessions/set"; sessions: SessionSummary[] }
	| { type: "sessions/upsert"; session: SessionSummary }
	| {
			type: "providers/set";
			providers: ProviderInfo[];
			models: ModelInfo[];
			imageModels: ImageModelInfo[];
			defaults: DefaultsState;
	  }
	| { type: "defaults/set"; defaults: DefaultsState }
	| {
			type: "sandboxes/set";
			provider: string;
			settings: SandboxSettingsInfo;
			sandboxes: SandboxInfo[];
	  }
	| { type: "target/status"; status: TargetStatus }
	| { type: "target/clear"; sessionId: string }
	| { type: "session/activate"; id: string }
	| { type: "session/deactivate" }
	| { type: "session/attached"; id: string; snapshot: SnapshotEvent }
	| { type: "session/event"; id: string; event: AgentEvent }
	| { type: "session/live-done"; id: string }
	| { type: "session/agent"; id: string; agent: AgentState }
	| { type: "error/set"; error: string }
	| { type: "error/clear" }
	| { type: "notice/set"; notice: Notice }
	| { type: "notice/clear" };

const initialState: State = {
	status: "disconnected",
	sessions: [],
	sessionsLoaded: false,
	providers: [],
	models: [],
	imageModels: [],
	defaults: {},
	sandboxProvider: "e2b",
	sandboxes: [],
	targetStatus: {},
	sessionsById: {},
};

function emptySession(id: string): SessionState {
	return { id, attached: false, entries: [], runActive: false, agent: {}, inbox: [] };
}

function fromSnapshot(id: string, snapshot: SnapshotEvent): SessionState {
	return {
		id,
		attached: true,
		entries: [...snapshot.entries],
		...(snapshot.generation?.message === undefined
			? {}
			: {
					live: {
						...fromAssistantMessage(snapshot.generation.message),
						key: String(snapshot.generation.message.timestamp),
					},
				}),
		runActive: snapshot.run !== undefined,
		agent: snapshot.agent,
		inbox: snapshot.inbox.map((item) => ({ id: String(item.id), mode: item.mode })),
		usage: snapshot.usage,
	};
}

function appendEntry(entries: EntryRecord[], entry: EntryRecord): EntryRecord[] {
	if (entries.some((candidate) => candidate.id === entry.id)) return entries;
	return [...entries, entry];
}

function applyEvent(session: SessionState, event: AgentEvent): SessionState {
	switch (event.type) {
		case "snapshot":
			return fromSnapshot(session.id, event);
		case "run_start":
			return { ...session, runActive: true };
		case "run_end":
			return { ...session, runActive: false };
		case "message_start":
			return event.message.role === "assistant"
				? { ...session, live: { ...fromAssistantMessage(event.message), key: String(event.message.timestamp) } }
				: session;
		case "message_update":
			if (session.live === undefined) return session;
			return {
				...session,
				live: {
					...applyMessageChanges(session.live, event.usage, event.changes),
					key: session.live.key,
					...(session.live.entryId === undefined ? {} : { entryId: session.live.entryId }),
					...(session.live.finished === undefined ? {} : { finished: session.live.finished }),
				},
			};
		case "message_end": {
			const entries = appendEntry(session.entries, event.entry);
			if (session.live === undefined) return { ...session, entries };
			return {
				...session,
				entries,
				live: { ...session.live, entryId: event.entry.id, finished: true },
			};
		}
		case "entry_appended":
			return { ...session, entries: appendEntry(session.entries, event.entry) };
		case "inbox_update":
			return { ...session, inbox: event.items.map((item) => ({ id: String(item.id), mode: item.mode })) };
		case "agent_changed":
			return { ...session, agent: event.agent };
		case "usage_changed":
			return { ...session, usage: event.usage };
		default:
			return session;
	}
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "status":
			return { ...state, status: action.status };
		case "sessions/set": {
			// A session can disappear when it is deleted, here or in another tab.
			const activeGone =
				state.activeSessionId !== undefined &&
				!action.sessions.some((session) => session.id === state.activeSessionId);
			if (!activeGone) return { ...state, sessions: action.sessions, sessionsLoaded: true };
			const sessionsById = { ...state.sessionsById };
			if (state.activeSessionId !== undefined) delete sessionsById[state.activeSessionId];
			return { ...state, sessions: action.sessions, sessionsLoaded: true, activeSessionId: undefined, sessionsById };
		}
		case "sessions/upsert": {
			const without = state.sessions.filter((session) => session.id !== action.session.id);
			return { ...state, sessions: [action.session, ...without], sessionsLoaded: true };
		}
		case "providers/set":
			return {
				...state,
				providers: action.providers,
				models: action.models,
				imageModels: action.imageModels,
				defaults: action.defaults,
			};
		case "defaults/set":
			return { ...state, defaults: action.defaults };
		case "sandboxes/set":
			return {
				...state,
				sandboxProvider: action.provider,
				sandboxSettings: action.settings,
				sandboxes: action.sandboxes,
			};
		case "target/status":
			return {
				...state,
				targetStatus: { ...state.targetStatus, [action.status.sessionId]: action.status },
			};
		case "target/clear": {
			if (state.targetStatus[action.sessionId] === undefined) return state;
			const targetStatus = { ...state.targetStatus };
			delete targetStatus[action.sessionId];
			return { ...state, targetStatus };
		}
		case "session/activate":
			return {
				...state,
				activeSessionId: action.id,
				sessionsById: { ...state.sessionsById, [action.id]: state.sessionsById[action.id] ?? emptySession(action.id) },
			};
		case "session/deactivate":
			return { ...state, activeSessionId: undefined };
		case "session/attached":
			return {
				...state,
				sessionsById: { ...state.sessionsById, [action.id]: fromSnapshot(action.id, action.snapshot) },
			};
		case "session/event": {
			const current = state.sessionsById[action.id] ?? emptySession(action.id);
			return {
				...state,
				sessionsById: { ...state.sessionsById, [action.id]: applyEvent(current, action.event) },
			};
		}
		case "session/live-done": {
			const current = state.sessionsById[action.id];
			if (current === undefined || current.live === undefined) return state;
			return { ...state, sessionsById: { ...state.sessionsById, [action.id]: { ...current, live: undefined } } };
		}
		case "session/agent": {
			const current = state.sessionsById[action.id];
			if (current === undefined) return state;
			return { ...state, sessionsById: { ...state.sessionsById, [action.id]: { ...current, agent: action.agent } } };
		}
		case "error/set":
			return { ...state, error: action.error };
		case "error/clear":
			return { ...state, error: undefined };
		case "notice/set":
			return { ...state, notice: action.notice };
		case "notice/clear":
			return { ...state, notice: undefined };
	}
}

type HarnessContextValue = {
	status: ConnectionStatus;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	providers: ProviderInfo[];
	models: ModelInfo[];
	imageModels: ImageModelInfo[];
	defaults: DefaultsState;
	sandboxProvider: string;
	sandboxSettings?: SandboxSettingsInfo;
	sandboxes: SandboxInfo[];
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
	finishLive(sessionId: string): void;
	configureModel(model: ModelRef): Promise<void>;
	configureThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	configureProvider(providerId: string, apiKey: string | null): Promise<void>;
	setTarget(target: TargetChoice): Promise<void>;
	browseWorkspaces(path?: string): Promise<WorkspacesBrowseResult>;
	createWorkspaceFolder(parent: string, name: string): Promise<{ path: string } | undefined>;
	refreshSandboxes(): Promise<void>;
	createSandbox(choice: SandboxChoice): Promise<SandboxInfo | undefined>;
	pauseSandbox(provider: string, sandboxId: string): Promise<void>;
	resumeSandbox(provider: string, sandboxId: string): Promise<void>;
	killSandbox(provider: string, sandboxId: string): Promise<void>;
	configureSandbox(provider: string, apiKey: string | null): Promise<void>;
	setSandboxSettings(change: {
		provider?: string;
		template?: string | null;
		idleTimeoutMs?: number | null;
		autoPause?: boolean | null;
		sshAgentSocket?: string | null;
		forwardAgent?: boolean | null;
	}): Promise<void>;
	sandboxMetrics(provider: string, sandboxId: string): Promise<SandboxMetricsInfo | undefined>;
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
				const [sessions, providers, sandboxes] = await Promise.all([
					client.send({ type: "sessions.list" }),
					client.send({ type: "providers.list" }),
					client.send({ type: "sandboxes.list" }),
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
	const activateSession = useCallback((id: string | undefined, mode: "push" | "replace" = "push") => {
		if (id === undefined) dispatch({ type: "session/deactivate" });
		else dispatch({ type: "session/activate", id });
		const path = id === undefined ? "/" : sessionPath(id);
		if (window.location.pathname === path) return;
		if (mode === "push") window.history.pushState(null, "", path);
		else window.history.replaceState(null, "", path);
	}, []);

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
					...(attachments === undefined || attachments.length === 0 ? {} : { attachments: [...attachments] }),
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
				const { agent } = await client.send({ type: "sessions.configure", sessionId: id, thinkingLevel });
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
				if (sessionIdFromPath(window.location.pathname) === id) activateSession(undefined, "replace");
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
				const { session } = await client.send({ type: "sessions.setTarget", sessionId: id, target });
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
			applySandboxes(await client.send({ type: "sandboxes.list" }));
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
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
				applySandboxes(await client.send({ type: "sandboxes.pause", provider, sandboxId }));
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client, applySandboxes],
	);

	const resumeSandbox = useCallback(
		async (provider: string, sandboxId: string) => {
			try {
				applySandboxes(await client.send({ type: "sandboxes.resume", provider, sandboxId }));
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
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
				applySandboxes(await client.send({ type: "sandboxes.settings", ...change }));
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
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
			providers: state.providers,
			models: state.models,
			imageModels: state.imageModels,
			defaults: state.defaults,
			sandboxProvider: state.sandboxProvider,
			...(state.sandboxSettings === undefined ? {} : { sandboxSettings: state.sandboxSettings }),
			sandboxes: state.sandboxes,
			targetStatus: state.targetStatus,
			...(state.activeSessionId === undefined ? {} : { activeSessionId: state.activeSessionId }),
			...(state.activeSessionId === undefined || state.sessionsById[state.activeSessionId] === undefined
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
			finishLive,
			configureModel,
			configureThinkingLevel,
			configureProvider,
			setTarget,
			browseWorkspaces,
			createWorkspaceFolder,
			refreshSandboxes,
			createSandbox,
			pauseSandbox,
			resumeSandbox,
			killSandbox,
			configureSandbox,
			setSandboxSettings,
			sandboxMetrics,
			setDefaults,
			refreshProviders,
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
			finishLive,
			configureModel,
			configureThinkingLevel,
			configureProvider,
			setTarget,
			browseWorkspaces,
			createWorkspaceFolder,
			refreshSandboxes,
			createSandbox,
			pauseSandbox,
			resumeSandbox,
			killSandbox,
			configureSandbox,
			setSandboxSettings,
			sandboxMetrics,
			setDefaults,
			refreshProviders,
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
