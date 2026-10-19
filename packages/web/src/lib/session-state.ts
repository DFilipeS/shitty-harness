import type {
	AgentEvent,
	AgentState,
	DefaultsState,
	EntryRecord,
	ImageModelInfo,
	ModelInfo,
	ProviderInfo,
	ProviderTemplateInfo,
	QueuedMessageInfo,
	SandboxInfo,
	SandboxSettingsInfo,
	SessionSummary,
	SnapshotEvent,
	TargetStatus,
	TemplateInfo,
	UsageState,
} from "@harness/protocol";
import type { ConnectionStatus } from "./client.ts";
import {
	applyToolOutput,
	liveToolsFromSnapshot,
	nestedArgsOf,
	nestedToolsFromSnapshot,
	type LiveTool,
	type NestedToolView,
} from "./live-tools.ts";
import { applyMessageChanges, fromAssistantMessage, type LiveMessage } from "./messages.ts";

/**
 * The whole client state and its reducer, kept out of the React provider so the event handling is
 * unit-testable: `packages/web/test/session-state.test.ts` covers what the server's events do.
 */

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
	/** Output of the tool calls that are running, keyed by tool call id. */
	liveTools: Record<string, LiveTool>;
	/** Nested calls of running tool calls (code mode scripts), in creation order. */
	nestedTools: NestedToolView[];
	runActive: boolean;
	agent: AgentState;
	inbox: { id: string; mode: string }[];
	/** Queued messages with their display text, fetched whenever the queued ids change. */
	queue: QueuedMessageInfo[];
	usage?: UsageState;
};

export type State = {
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
	templatesProvider: string;
	templatesProviderName: string;
	templatesConfigured: boolean;
	templates: TemplateInfo[];
	templatesDefault?: string;
	templatesOther: ProviderTemplateInfo[];
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

export type Action =
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
	| {
			type: "templates/set";
			provider: string;
			providerName: string;
			configured: boolean;
			templates: TemplateInfo[];
			default?: string;
			other: ProviderTemplateInfo[];
	  }
	| { type: "target/status"; status: TargetStatus }
	| { type: "target/clear"; sessionId: string }
	| { type: "session/activate"; id: string }
	| { type: "session/deactivate" }
	| { type: "session/attached"; id: string; snapshot: SnapshotEvent }
	| { type: "session/event"; id: string; event: AgentEvent }
	| { type: "session/queue"; id: string; ids: string; items: QueuedMessageInfo[] }
	| { type: "session/live-done"; id: string }
	| { type: "session/agent"; id: string; agent: AgentState }
	| { type: "error/set"; error: string }
	| { type: "error/clear" }
	| { type: "notice/set"; notice: Notice }
	| { type: "notice/clear" };

export const initialState: State = {
	status: "disconnected",
	sessions: [],
	sessionsLoaded: false,
	providers: [],
	models: [],
	imageModels: [],
	defaults: {},
	sandboxProvider: "e2b",
	sandboxes: [],
	templatesProvider: "e2b",
	templatesProviderName: "E2B",
	templatesConfigured: false,
	templates: [],
	templatesOther: [],
	targetStatus: {},
	sessionsById: {},
};

function emptySession(id: string): SessionState {
	return {
		id,
		attached: false,
		entries: [],
		liveTools: {},
		nestedTools: [],
		runActive: false,
		agent: {},
		inbox: [],
		queue: [],
	};
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
		liveTools: liveToolsFromSnapshot(snapshot.tools),
		nestedTools: nestedToolsFromSnapshot(snapshot.nestedTools),
		runActive: snapshot.run !== undefined,
		agent: snapshot.agent,
		inbox: snapshot.inbox.map((item) => ({ id: String(item.id), mode: item.mode })),
		// The queue's text is fetched on attach; a snapshot replaces only the event-stream view.
		queue: [],
		usage: snapshot.usage,
	};
}

function appendEntry(entries: EntryRecord[], entry: EntryRecord): EntryRecord[] {
	if (entries.some((candidate) => candidate.id === entry.id)) return entries;
	return [...entries, entry];
}

/** Drop a tool's live state once its result is committed; the entry takes over. */
function withoutResultTool(
	liveTools: Record<string, LiveTool>,
	nestedTools: NestedToolView[],
	entry: EntryRecord,
): { liveTools: Record<string, LiveTool>; nestedTools: NestedToolView[] } {
	const message = entry.model?.[0];
	if (message?.role !== "toolResult") return { liveTools, nestedTools };
	const hasLive = liveTools[message.toolCallId] !== undefined;
	const hasNested = nestedTools.some((tool) => tool.parentCallId === message.toolCallId);
	if (!hasLive && !hasNested) return { liveTools, nestedTools };
	const next = { ...liveTools };
	delete next[message.toolCallId];
	return {
		liveTools: next,
		nestedTools: nestedTools.filter((tool) => tool.parentCallId !== message.toolCallId),
	};
}

function applyEvent(session: SessionState, event: AgentEvent): SessionState {
	switch (event.type) {
		case "snapshot":
			return { ...fromSnapshot(session.id, event), queue: session.queue };
		case "run_start":
			return { ...session, runActive: true };
		case "run_end":
			// Live tool output belongs to the run; committed entries carry the results afterwards.
			return { ...session, runActive: false, liveTools: {}, nestedTools: [] };
		case "message_start":
			return event.message.role === "assistant"
				? {
						...session,
						live: { ...fromAssistantMessage(event.message), key: String(event.message.timestamp) },
					}
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
			const settled = withoutResultTool(session.liveTools, session.nestedTools, event.entry);
			if (session.live === undefined)
				return {
					...session,
					entries,
					liveTools: settled.liveTools,
					nestedTools: settled.nestedTools,
				};
			return {
				...session,
				entries,
				liveTools: settled.liveTools,
				nestedTools: settled.nestedTools,
				live: { ...session.live, entryId: event.entry.id, finished: true },
			};
		}
		case "entry_appended":
			return {
				...session,
				entries: appendEntry(session.entries, event.entry),
				...withoutResultTool(session.liveTools, session.nestedTools, event.entry),
			};
		case "tool_execution_start": {
			// A nested call belongs to its parent's block, not the session's own list of running calls.
			if (event.parentToolCallId !== undefined) {
				return {
					...session,
					nestedTools: [
						...session.nestedTools,
						{
							callId: event.toolCallId,
							parentCallId: event.parentToolCallId,
							name: event.toolName,
							args: nestedArgsOf(event.args),
							status: "running",
						},
					],
				};
			}
			return {
				...session,
				liveTools: {
					...session.liveTools,
					[event.toolCallId]: { name: event.toolName, output: "", running: true },
				},
			};
		}
		case "tool_execution_update": {
			// Nested calls show as plain lines; their streaming output is not kept.
			if (event.parentToolCallId !== undefined) return session;
			const existing = session.liveTools[event.toolCallId] ?? {
				name: event.toolName,
				output: "",
				running: true,
			};
			const output =
				event.output === undefined
					? existing.output
					: applyToolOutput(existing.output, event.output);
			return {
				...session,
				liveTools: { ...session.liveTools, [event.toolCallId]: { ...existing, output } },
			};
		}
		case "tool_execution_end": {
			if (event.parentToolCallId !== undefined) {
				const known = session.nestedTools.some((tool) => tool.callId === event.toolCallId);
				if (!known) return session;
				return {
					...session,
					nestedTools: session.nestedTools.map((tool) =>
						tool.callId === event.toolCallId
							? { ...tool, status: event.result?.isError === true ? "error" : "ok" }
							: tool,
					),
				};
			}
			const existing = session.liveTools[event.toolCallId];
			if (existing === undefined) return session;
			// A committed result replaces the live window; without one, keep the output for reading.
			if (event.entry !== undefined) {
				const settled = withoutResultTool(session.liveTools, session.nestedTools, event.entry);
				return { ...session, liveTools: settled.liveTools, nestedTools: settled.nestedTools };
			}
			return {
				...session,
				liveTools: { ...session.liveTools, [event.toolCallId]: { ...existing, running: false } },
			};
		}
		case "inbox_update":
			return {
				...session,
				inbox: event.items.map((item) => ({ id: String(item.id), mode: item.mode })),
			};
		case "agent_changed":
			return { ...session, agent: event.agent };
		case "usage_changed":
			return { ...session, usage: event.usage };
		default:
			return session;
	}
}

export function reducer(state: State, action: Action): State {
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
			return {
				...state,
				sessions: action.sessions,
				sessionsLoaded: true,
				activeSessionId: undefined,
				sessionsById,
			};
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
		case "templates/set":
			return {
				...state,
				templatesProvider: action.provider,
				templatesProviderName: action.providerName,
				templatesConfigured: action.configured,
				templates: action.templates,
				templatesDefault: action.default,
				templatesOther: action.other,
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
				sessionsById: {
					...state.sessionsById,
					[action.id]: state.sessionsById[action.id] ?? emptySession(action.id),
				},
			};
		case "session/deactivate":
			return { ...state, activeSessionId: undefined };
		case "session/attached":
			return {
				...state,
				sessionsById: {
					...state.sessionsById,
					[action.id]: fromSnapshot(action.id, action.snapshot),
				},
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
			return {
				...state,
				sessionsById: { ...state.sessionsById, [action.id]: { ...current, live: undefined } },
			};
		}
		case "session/queue": {
			const current = state.sessionsById[action.id];
			if (current === undefined) return state;
			// A fetch that lost the race with a newer inbox change is dropped; its own refetch follows.
			if (current.inbox.map((item) => item.id).join(",") !== action.ids) return state;
			return {
				...state,
				sessionsById: { ...state.sessionsById, [action.id]: { ...current, queue: action.items } },
			};
		}
		case "session/agent": {
			const current = state.sessionsById[action.id];
			if (current === undefined) return state;
			return {
				...state,
				sessionsById: { ...state.sessionsById, [action.id]: { ...current, agent: action.agent } },
			};
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
