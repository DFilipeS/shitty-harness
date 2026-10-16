import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentState, EntryRecord, SnapshotEvent, UsageState } from "@earendil-works/pi-durable";
import type { PromptAttachment } from "./attachments.ts";

export type { AgentEvent, AgentState, EntryRecord, ModelThinkingLevel, SnapshotEvent, UsageState };
export {
	ATTACHMENT_IMAGE_MIME_TYPES,
	ATTACHMENT_LIMITS,
	ATTACHMENT_TEXT_EXTENSIONS,
	ATTACHMENT_TEXT_FILE_NAMES,
	ATTACHMENT_TEXT_MIME_TYPES,
	classifyAttachmentFile,
	isImageMimeType,
	isTextMimeType,
	type AttachmentKind,
	type PromptAttachment,
} from "./attachments.ts";

/** A provider + model pair, as stored in a conversation's agent. */
export type ModelRef = {
	provider: string;
	modelId: string;
};

/** Where a session's tools run. */
export type TargetInfo =
	| {
			kind: "local";
			path: string;
			/** True when the path is the session's own scratch directory. */
			scratch: boolean;
		}
	| {
			kind: "sandbox";
			provider: string;
			/** Human-readable provider name, e.g. "E2B". */
			providerName: string;
			/** Absent while the sandbox has not been created yet. */
			sandboxId?: string;
			name?: string;
			workspaceDir: string;
			/** Whether this target asks for the host SSH agent. */
			forwardAgent?: boolean;
		};

/** Where a new sandbox gets its files. */
export type SandboxSourceChoice = { kind: "empty" } | { kind: "git"; url: string };

/** A new sandbox to create, or an existing one to connect to. */
export type SandboxChoice = {
	provider?: string;
	/** An existing sandbox; absent means create a new one. */
	sandboxId?: string;
	name?: string;
	template?: string;
	source?: SandboxSourceChoice;
	workspaceDir?: string;
	/** Whether the sandbox forwards the host SSH agent; defaults to the stored setting. */
	forwardAgent?: boolean;
};

/** What the client asks for: a local folder, a scratch directory, or a sandbox. */
export type TargetChoice =
	| { kind: "local"; path?: string }
	| ({ kind: "sandbox" } & SandboxChoice);

/** A sandbox as the client lists it. */
export type SandboxInfo = {
	provider: string;
	/** Human-readable provider name, e.g. "E2B". */
	providerName: string;
	id: string;
	name?: string;
	state: "running" | "paused" | "stopped";
	workspaceDir: string;
	template?: string;
	createdAt?: number;
	lastUsedAt?: number;
	/** Ids of sessions whose current target is this sandbox. */
	sessions: string[];
	/** True while the harness holds a live SSH agent forward into this sandbox. */
	forwarding: boolean;
};

export type SandboxSettingsInfo = {
	provider: string;
	/** Human-readable provider name, e.g. "E2B". */
	providerName: string;
	template?: string;
	idleTimeoutMs: number;
	autoPause: boolean;
	/** Host SSH agent socket to forward; unset means discovery. */
	sshAgentSocket?: string;
	/** Whether new sandboxes forward the host agent unless their target says otherwise. */
	forwardAgent: boolean;
	/** True when the provider has a usable credential. */
	configured: boolean;
};

export type SandboxesState = {
	provider: string;
	settings: SandboxSettingsInfo;
	sandboxes: SandboxInfo[];
};

export type SandboxMetricsInfo = {
	cpuCount?: number;
	cpuUsedPct?: number;
	memoryUsedBytes?: number;
	memoryTotalBytes?: number;
	diskUsedBytes?: number;
	diskTotalBytes?: number;
};

/** Progress of a sandbox a session is lazily opening. */
export type TargetStatus = {
	sessionId: string;
	phase: "starting" | "ready" | "gone" | "error";
	sandboxId?: string;
	message?: string;
};

/** One directory offered by the local folder browser. */
export type BrowseDirectory = {
	name: string;
	path: string;
};

/** One session as shown in the sidebar. */
export type SessionSummary = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** True while the durable harness has live work for this session. */
	working: boolean;
	/** Where this session's tools run. */
	target: TargetInfo;
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
	/** The provider lists an image model with the same id, so `generate_image` can use it. */
	imageGeneration: boolean;
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

/** Model and thinking level applied to new sessions, plus the model `generate_image` uses. */
export type DefaultsState = {
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
	imageModel?: ModelRef;
	/** Where new sessions run; unset means the local machine in a scratch directory. */
	target?: TargetChoice;
};

/**
 * An image-generation model the `generate_image` tool can drive. pi-ai's OpenRouter image API
 * speaks chat completions, so models that answer only on `/images` are left out.
 */
export type ImageModelInfo = {
	provider: string;
	providerName: string;
	id: string;
	name: string;
};

export type ProvidersListResult = {
	providers: ProviderInfo[];
	models: ModelInfo[];
	imageModels: ImageModelInfo[];
	defaults: DefaultsState;
};

export type DefaultsSetResult = {
	defaults: DefaultsState;
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

export type SessionsSetTargetResult = {
	session: SessionSummary;
};

export type WorkspacesBrowseResult = {
	path: string;
	/** Parent directory; absent at the filesystem root. */
	parent?: string;
	directories: BrowseDirectory[];
};

export type WorkspacesCreateFolderResult = {
	path: string;
};

export type SandboxesListResult = SandboxesState;

export type SandboxesMetricsResult = {
	metrics?: SandboxMetricsInfo;
};

/** Commands the client sends to the server. Every command carries a correlation `id`. */
export type ClientCommand =
	| { id: string; type: "sessions.list" }
	| { id: string; type: "sessions.create" }
	| { id: string; type: "sessions.rename"; sessionId: string; title: string }
	| { id: string; type: "sessions.delete"; sessionId: string }
	| { id: string; type: "sessions.attach"; sessionId: string }
	| { id: string; type: "sessions.detach"; sessionId: string }
	| {
			id: string;
			type: "sessions.prompt";
			sessionId: string;
			text: string;
			attachments?: PromptAttachment[];
			requestId: string;
		}
	| { id: string; type: "sessions.abort"; sessionId: string }
	| {
			id: string;
			type: "sessions.configure";
			sessionId: string;
			model?: ModelRef | null;
			thinkingLevel?: ModelThinkingLevel | null;
	  }
	| { id: string; type: "sessions.setTarget"; sessionId: string; target: TargetChoice }
	| { id: string; type: "workspaces.browse"; path?: string }
	| { id: string; type: "workspaces.createFolder"; parent: string; name: string }
	| { id: string; type: "sandboxes.list" }
	| { id: string; type: "sandboxes.create"; choice: SandboxChoice }
	| { id: string; type: "sandboxes.pause"; provider: string; sandboxId: string }
	| { id: string; type: "sandboxes.resume"; provider: string; sandboxId: string }
	| { id: string; type: "sandboxes.kill"; provider: string; sandboxId: string }
	| { id: string; type: "sandboxes.metrics"; provider: string; sandboxId: string }
	| { id: string; type: "sandboxes.configure"; provider: string; apiKey: string | null }
	| {
			id: string;
			type: "sandboxes.settings";
			provider?: string;
			template?: string | null;
			idleTimeoutMs?: number | null;
			autoPause?: boolean | null;
			sshAgentSocket?: string | null;
			forwardAgent?: boolean | null;
	  }
	| { id: string; type: "providers.list" }
	| { id: string; type: "providers.configure"; providerId: string; apiKey: string | null }
	| { id: string; type: "providers.refresh" }
	| {
			id: string;
			type: "defaults.set";
			model?: ModelRef | null;
			thinkingLevel?: ModelThinkingLevel | null;
			imageModel?: ModelRef | null;
			target?: TargetChoice | null;
	  };

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
	"sessions.setTarget": SessionsSetTargetResult;
	"workspaces.browse": WorkspacesBrowseResult;
	"workspaces.createFolder": WorkspacesCreateFolderResult;
	"sandboxes.list": SandboxesListResult;
	"sandboxes.create": SandboxesListResult;
	"sandboxes.pause": SandboxesListResult;
	"sandboxes.resume": SandboxesListResult;
	"sandboxes.kill": SandboxesListResult;
	"sandboxes.metrics": SandboxesMetricsResult;
	"sandboxes.configure": SandboxesListResult;
	"sandboxes.settings": SandboxesListResult;
	"providers.list": ProvidersListResult;
	"providers.configure": ProvidersListResult;
	"providers.refresh": ProvidersRefreshResult;
	"defaults.set": DefaultsSetResult;
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
	| ({ type: "sandboxes.changed" } & SandboxesState)
	| { type: "session.target"; status: TargetStatus }
	| {
			type: "providers.changed";
			providers: ProviderInfo[];
			models: ModelInfo[];
			imageModels: ImageModelInfo[];
			defaults: DefaultsState;
	  };

export type ServerMessage = ServerResponse | ServerEvent;
