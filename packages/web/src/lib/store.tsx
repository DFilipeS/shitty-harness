import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type {
	AgentEvent,
	AgentState,
	EntryRecord,
	ModelInfo,
	ModelRef,
	ModelThinkingLevel,
	ProviderInfo,
	SessionSummary,
	SnapshotEvent,
	UsageState,
} from "@harness/protocol";
import { HarnessClient, type ConnectionStatus } from "./client.ts";
import { errorMessage } from "./format.ts";
import { applyMessageChanges, fromAssistantMessage, type LiveMessage } from "./messages.ts";

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
	activeSessionId?: string;
	sessionsById: Record<string, SessionState>;
	error?: string;
};

type Action =
	| { type: "status"; status: ConnectionStatus }
	| { type: "sessions/set"; sessions: SessionSummary[] }
	| { type: "sessions/upsert"; session: SessionSummary }
	| { type: "providers/set"; providers: ProviderInfo[]; models: ModelInfo[] }
	| { type: "session/activate"; id: string }
	| { type: "session/attached"; id: string; snapshot: SnapshotEvent }
	| { type: "session/event"; id: string; event: AgentEvent }
	| { type: "session/live-done"; id: string }
	| { type: "session/agent"; id: string; agent: AgentState }
	| { type: "error/set"; error: string }
	| { type: "error/clear" };

const initialState: State = {
	status: "disconnected",
	sessions: [],
	sessionsLoaded: false,
	providers: [],
	models: [],
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
			return { ...state, providers: action.providers, models: action.models };
		case "session/activate":
			return {
				...state,
				activeSessionId: action.id,
				sessionsById: { ...state.sessionsById, [action.id]: state.sessionsById[action.id] ?? emptySession(action.id) },
			};
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
	}
}

type HarnessContextValue = {
	status: ConnectionStatus;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	providers: ProviderInfo[];
	models: ModelInfo[];
	activeSessionId?: string;
	activeSession?: SessionState;
	error?: string;
	createSession(): Promise<void>;
	selectSession(id: string): void;
	renameSession(id: string, title: string): Promise<void>;
	deleteSession(id: string): Promise<void>;
	sendPrompt(text: string): Promise<void>;
	abortSession(): Promise<void>;
	finishLive(sessionId: string): void;
	configureModel(model: ModelRef): Promise<void>;
	configureThinkingLevel(level: ModelThinkingLevel): Promise<void>;
	configureProvider(providerId: string, apiKey: string | null): Promise<void>;
	refreshProviders(): Promise<void>;
	clearError(): void;
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
			} else {
				dispatch({
					type: "providers/set",
					providers: event.providers,
					models: event.models,
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
				const [sessions, providers] = await Promise.all([
					client.send({ type: "sessions.list" }),
					client.send({ type: "providers.list" }),
				]);
				dispatch({ type: "sessions/set", sessions: sessions.sessions });
				dispatch({
					type: "providers/set",
					providers: providers.providers,
					models: providers.models,
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
				if (!cancelled) dispatch({ type: "error/set", error: errorMessage(error) });
			}
		})();
		return () => {
			cancelled = true;
			void client.send({ type: "sessions.detach", sessionId: id }).catch(() => undefined);
		};
	}, [state.status, state.activeSessionId, client]);

	const createSession = useCallback(async () => {
		try {
			const { session } = await client.send({ type: "sessions.create" });
			dispatch({ type: "sessions/upsert", session });
			dispatch({ type: "session/activate", id: session.id });
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
		}
	}, [client]);

	const selectSession = useCallback((id: string) => {
		dispatch({ type: "session/activate", id });
	}, []);

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
		async (text: string) => {
			const id = state.activeSessionId;
			if (id === undefined) return;
			try {
				await client.send({ type: "sessions.prompt", sessionId: id, text, requestId: crypto.randomUUID() });
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
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client],
	);

	const configureProvider = useCallback(
		async (providerId: string, apiKey: string | null) => {
			try {
				const providers = await client.send({ type: "providers.configure", providerId, apiKey });
				dispatch({
					type: "providers/set",
					providers: providers.providers,
					models: providers.models,
				});
			} catch (error) {
				dispatch({ type: "error/set", error: errorMessage(error) });
			}
		},
		[client],
	);

	const refreshProviders = useCallback(async () => {
		try {
			const providers = await client.send({ type: "providers.refresh" });
			dispatch({
				type: "providers/set",
				providers: providers.providers,
				models: providers.models,
			});
		} catch (error) {
			dispatch({ type: "error/set", error: errorMessage(error) });
		}
	}, [client]);

	const value = useMemo<HarnessContextValue>(
		() => ({
			status: state.status,
			sessions: state.sessions,
			sessionsLoaded: state.sessionsLoaded,
			providers: state.providers,
			models: state.models,
			...(state.activeSessionId === undefined ? {} : { activeSessionId: state.activeSessionId }),
			...(state.activeSessionId === undefined || state.sessionsById[state.activeSessionId] === undefined
				? {}
				: { activeSession: state.sessionsById[state.activeSessionId] }),
			...(state.error === undefined ? {} : { error: state.error }),
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
			refreshProviders,
			clearError: () => dispatch({ type: "error/clear" }),
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
			refreshProviders,
		],
	);

	return <HarnessContext.Provider value={value}>{children}</HarnessContext.Provider>;
}

export function useHarness(): HarnessContextValue {
	const value = useContext(HarnessContext);
	if (value === undefined) throw new Error("useHarness must be used inside HarnessProvider");
	return value;
}
