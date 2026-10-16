/**
 * Provider-agnostic sandbox contract. Nothing here imports a provider SDK; adapters under
 * `sandboxes/` implement these types. The harness talks to sandboxes only through this contract,
 * and `SandboxExecutionEnv` turns one into a pi-durable `ExecutionEnv`.
 */

export type SandboxState = "running" | "paused" | "stopped";

/** Where a new sandbox gets its files. */
export type SandboxSource = { kind: "empty" } | { kind: "git"; url: string };

export type SandboxSpec = {
	/** Provider template or image; the provider decides the default. */
	template?: string;
	/** Directory that holds the project inside the sandbox. */
	workspaceDir: string;
	env?: Record<string, string>;
	/** Discovery labels, mapped to provider metadata. */
	labels?: Record<string, string>;
	idleTimeoutMs?: number;
	/** Pause on idle instead of killing. */
	autoPause?: boolean;
};

export type SandboxInfo = {
	id: string;
	provider: string;
	state: SandboxState;
	name?: string;
	labels: Record<string, string>;
	workspaceDir: string;
	template?: string;
	/** Milliseconds since the epoch. */
	createdAt?: number;
	lastUsedAt?: number;
};

export type SandboxFileKind = "file" | "directory" | "symlink";

export type SandboxFileInfo = {
	name: string;
	path: string;
	kind: SandboxFileKind;
	size: number;
	/** Milliseconds since the epoch. */
	mtimeMs: number;
	/** Target of a symbolic link, when the provider reports one. */
	symlinkTarget?: string;
};

export type SandboxExecOptions = {
	cwd?: string;
	env?: Record<string, string>;
	/** 0 disables any provider-side timeout. */
	timeoutMs?: number;
	signal?: AbortSignal;
	onStdout?: (text: string) => void;
	onStderr?: (text: string) => void;
};

export type SandboxConnectOptions = {
	workspaceDir?: string;
	/** Preset the sandbox's idle timeout, in milliseconds. */
	idleTimeoutMs?: number;
};

export type SandboxMetrics = {
	cpuCount?: number;
	/** CPU usage percentage across all cores. */
	cpuUsedPct?: number;
	memoryUsedBytes?: number;
	memoryTotalBytes?: number;
	diskUsedBytes?: number;
	diskTotalBytes?: number;
};

/** A live forward of the host SSH agent into a sandbox. */
export interface AgentForwarding {
	/** Path of the forwarded agent socket inside the sandbox. */
	sandboxSocket: string;
	/** Stop forwarding. Safe to call more than once. */
	close(): Promise<void>;
}

export interface SandboxHandle {
	readonly id: string;
	readonly provider: string;
	readonly workspaceDir: string;
	/**
	 * How long the sandbox keeps running without activity, in milliseconds. A provider that has no
	 * idle timeout omits it, and then nothing renews the sandbox.
	 */
	readonly lifetimeMs?: number;

	exec(command: string, options?: SandboxExecOptions): Promise<{ exitCode: number | null }>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	listDir(path: string): Promise<SandboxFileInfo[]>;
	/** `undefined` when the path does not exist; other failures throw. */
	stat(path: string): Promise<SandboxFileInfo | undefined>;
	makeDir(path: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;

	/** Pause keeps the files and, with E2B, the memory. */
	pause?(): Promise<void>;
	kill(): Promise<void>;
	metrics?(): Promise<SandboxMetrics | undefined>;

	/**
	 * Optional. Reset the sandbox's idle clock so it stays running longer. `SandboxExecutionEnv`
	 * calls it while a command runs, so a long build is not cut off by the idle timeout.
	 */
	keepAlive?(): Promise<void>;

	/**
	 * Optional. Forward the host SSH agent into the sandbox. The private key stays on the host; the
	 * sandbox can only use it while connected.
	 */
	forwardAgent?(hostSocket: string): Promise<AgentForwarding>;
}

export interface SandboxProvider {
	readonly name: string;
	/** Human-readable name for user-facing text, e.g. "E2B". */
	readonly displayName: string;
	readonly capabilities: {
		pauseResume: boolean;
		metrics: boolean;
		agentForwarding: boolean;
	};

	create(spec: SandboxSpec): Promise<SandboxHandle>;
	/** Connect to a sandbox; the provider resumes it when paused. */
	connect(id: string, options?: SandboxConnectOptions): Promise<SandboxHandle>;
	list(filter?: { labels?: Record<string, string> }): Promise<SandboxInfo[]>;
	kill(id: string): Promise<void>;
}

export type SandboxErrorCode =
	| "auth"
	| "not_found"
	| "timeout"
	| "aborted"
	| "unavailable"
	| "invalid"
	| "unknown";

/** Every failure an adapter reports; the harness maps it to a `FileError` or `ExecutionError`. */
export class SandboxError extends Error {
	readonly code: SandboxErrorCode;

	constructor(code: SandboxErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SandboxError";
		this.code = code;
	}
}

export type SandboxProviderConfig = {
	/** Default template when a spec names none. */
	template?: string;
	/** Directory for provider state, e.g. the SSH hop key and known hosts. */
	stateDir?: string;
};

export interface SandboxProviderFactory {
	readonly name: string;
	/** Human-readable name for user-facing text, e.g. "E2B". */
	readonly displayName: string;
	/** Environment variable the adapter also honors, e.g. "E2B_API_KEY". */
	readonly envVar?: string;
	/** False when the provider works without a credential, e.g. a local Docker daemon. */
	readonly needsApiKey: boolean;
	create(config: SandboxProviderConfig, credentials: { apiKey?: string }): SandboxProvider;
	/** Cheap call that throws when the credentials are invalid. */
	validate(credentials: { apiKey?: string }): Promise<void>;
}
