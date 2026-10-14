import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent, UsageState } from "@earendil-works/pi-durable";

export type { AgentEvent, AgentState, EntryRecord, ModelThinkingLevel, SnapshotEvent, UsageState };

/** A provider + model pair, as stored in a conversation's agent. */
export type ModelRef = {
	provider: string;
	modelId: string;
};

/** One session as shown in the sidebar. */
export type SessionSummary = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** True while the durable harness has live work for this session. */
	working: boolean;
};

/** A model the client may offer for selection. */
export type ModelInfo = {
	provider: string;
	providerName: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	input: readonly string[];
	thinkingLevels: readonly ModelThinkingLevel[];
};

/** A provider and whether the server has credentials for it. */
export type ProviderInfo = {
	id: string;
	name: string;
	configured: boolean;
	authSource?: string;
	modelCount: number;
};

export type SessionsListResult = {
	sessions: SessionSummary[];
};

export type ProvidersListResult = {
	providers: ProviderInfo[];
	models: ModelInfo[];
};

/** How a provider's model catalog refresh ended. */
export type ProviderRefreshOutcome = "fetched" | "not-modified" | "unavailable" | "throttled" | "failed";

/** Result of refreshing one provider's catalog, shown to the user after a manual refresh. */
export type ProviderRefreshReport = {
	providerId: string;
	name: string;
	outcome: ProviderRefreshOutcome;
	/** Chat models available after the refresh. */
	models: number;
	/** Change in available chat models caused by the refresh. */
	added: number;
	error?: string;
};

export type ProvidersRefreshResult = ProvidersListResult & {
	refresh: ProviderRefreshReport[];
};

export type SessionsAttachResult = {
	snapshot: SnapshotEvent;
};

export type SessionsConfigureResult = {
	agent: AgentState;
};

/** Commands the client sends to the server. Every command carries a correlation `id`. */
export type ClientCommand =
	| { id: string; type: "sessions.list" }
	| { id: string; type: "sessions.create" }
	| { id: string; type: "sessions.rename"; sessionId: string; title: string }
	| { id: string; type: "sessions.delete"; sessionId: string }
	| { id: string; type: "sessions.attach"; sessionId: string }
	| { id: string; type: "sessions.detach"; sessionId: string }
	| { id: string; type: "sessions.prompt"; sessionId: string; text: string; requestId: string }
	| { id: string; type: "sessions.abort"; sessionId: string }
	| {
			id: string;
			type: "sessions.configure";
			sessionId: string;
			model?: ModelRef | null;
			thinkingLevel?: ModelThinkingLevel | null;
	  }
	| { id: string; type: "providers.list" }
	| { id: string; type: "providers.configure"; providerId: string; apiKey: string | null }
	| { id: string; type: "providers.refresh" };

export type CommandType = ClientCommand["type"];

/** Result payload for each command type. */
export type CommandResult = {
	"sessions.list": SessionsListResult;
	"sessions.create": { session: SessionSummary };
	"sessions.rename": { session: SessionSummary };
	"sessions.delete": Record<string, never>;
	"sessions.attach": SessionsAttachResult;
	"sessions.detach": Record<string, never>;
	"sessions.prompt": { submissionId: string };
	"sessions.abort": Record<string, never>;
	"sessions.configure": SessionsConfigureResult;
	"providers.list": ProvidersListResult;
	"providers.configure": ProvidersListResult;
	"providers.refresh": ProvidersRefreshResult;
};

export type ServerError = {
	code: string;
	message: string;
};

export type ServerResponse =
	| { id: string; type: "response"; ok: true; data: CommandResult[CommandType] }
	| { id: string; type: "response"; ok: false; error: ServerError };

/** Push messages the server sends without a preceding command. */
export type ServerEvent =
	| { type: "session.event"; sessionId: string; event: AgentEvent }
	| { type: "sessions.changed"; sessions: SessionSummary[] }
	| {
			type: "providers.changed";
			providers: ProviderInfo[];
			models: ModelInfo[];
	  };

export type ServerMessage = ServerResponse | ServerEvent;
