import { mkdir, readlink } from "node:fs/promises";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
	SandboxError,
	type AgentForwarding,
	type SandboxConnectOptions,
	type SandboxExecOptions,
	type SandboxFileInfo,
	type SandboxHandle,
	type SandboxInfo,
	type SandboxProvider,
	type SandboxSpec,
} from "../../src/sandboxes/provider.ts";
import { registerSandboxProvider } from "../../src/sandboxes/registry.ts";
import {
	DEFAULT_SANDBOX_SETTINGS,
	type SandboxSettings,
	type SandboxSettingsChange,
	type SandboxSettingsStore,
} from "../../src/sandboxes/settings.ts";

/**
 * In-memory sandbox backed by a local `NodeExecutionEnv`, so the conformance suite exercises
 * `SandboxExecutionEnv` against faithful files and processes without an E2B account.
 */
export class FakeSandboxHandle implements SandboxHandle {
	readonly id: string;
	readonly provider = "fake";
	readonly workspaceDir: string;
	/** Renewed through `keepAlive`; tests set it through the provider. */
	lifetimeMs: number | undefined;
	readonly #env: NodeExecutionEnv;
	#paused = false;
	#killed = false;
	#keepAliveCalls = 0;
	/** When true, `keepAlive` fails, for tests of error handling. */
	keepAliveFails = false;
	#forwarding: { hostSocket: string; closed: boolean } | undefined;
	#lastExecEnv: Record<string, string> | undefined;

	constructor(id: string, workspaceDir: string, lifetimeMs?: number) {
		this.id = id;
		this.workspaceDir = workspaceDir;
		this.lifetimeMs = lifetimeMs;
		this.#env = new NodeExecutionEnv({ cwd: workspaceDir });
	}

	/** How many times the sandbox lifetime was renewed, for tests. */
	get keepAliveCalls(): number {
		return this.#keepAliveCalls;
	}

	get paused(): boolean {
		return this.#paused;
	}

	get killed(): boolean {
		return this.#killed;
	}

	/** The last `forwardAgent` call, for tests. */
	get forwarding(): { hostSocket: string; closed: boolean } | undefined {
		return this.#forwarding;
	}

	/** The environment of the last command, for tests. */
	get lastExecEnv(): Record<string, string> | undefined {
		return this.#lastExecEnv;
	}

	async exec(command: string, options: SandboxExecOptions = {}): Promise<{ exitCode: number | null }> {
		this.#requireAlive();
		this.#lastExecEnv = options.env;
		const context =
			options.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(options.signal, BACKGROUND_CONTEXT);
		const result = await this.#env.exec(
			command,
			{
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.env === undefined ? {} : { env: options.env }),
				...(options.timeoutMs === undefined || options.timeoutMs <= 0 ? {} : { timeout: options.timeoutMs / 1000 }),
				onOutput: (text, _context, info) => {
					if (info.stream === "stdout") options.onStdout?.(text);
					else options.onStderr?.(text);
				},
			},
			context,
		);
		if (result.ok) return { exitCode: result.value.exitCode };
		const code =
			result.error.code === "timeout" ? "timeout" : result.error.code === "aborted" ? "aborted" : "unknown";
		throw new SandboxError(code, result.error.message, { cause: result.error });
	}

	async readFile(path: string): Promise<Uint8Array> {
		this.#requireAlive();
		return getOrThrow(await this.#env.readBinaryFile(path, BACKGROUND_CONTEXT));
	}

	async writeFile(path: string, data: string | Uint8Array): Promise<void> {
		this.#requireAlive();
		getOrThrow(await this.#env.writeFile(path, data, BACKGROUND_CONTEXT));
	}

	async listDir(path: string): Promise<SandboxFileInfo[]> {
		this.#requireAlive();
		const infos = getOrThrow(await this.#env.listDir(path, BACKGROUND_CONTEXT));
		return Promise.all(infos.map((info) => this.#describe(info.path, info.name, info.kind, info.size, info.mtimeMs)));
	}

	async stat(path: string): Promise<SandboxFileInfo | undefined> {
		this.#requireAlive();
		const result = await this.#env.fileInfo(path, BACKGROUND_CONTEXT);
		if (!result.ok) {
			if (result.error.code === "not_found") return undefined;
			throw new SandboxError("unknown", result.error.message, { cause: result.error });
		}
		const info = result.value;
		return this.#describe(info.path, info.name, info.kind, info.size, info.mtimeMs);
	}

	async makeDir(path: string): Promise<void> {
		this.#requireAlive();
		getOrThrow(await this.#env.createDir(path, { recursive: true }, BACKGROUND_CONTEXT));
	}

	async remove(path: string): Promise<void> {
		this.#requireAlive();
		getOrThrow(await this.#env.remove(path, { recursive: true, force: true }, BACKGROUND_CONTEXT));
	}

	async rename(source: string, destination: string): Promise<void> {
		this.#requireAlive();
		getOrThrow(await this.#env.renameFile(source, destination, BACKGROUND_CONTEXT));
	}

	async pause(): Promise<void> {
		this.#requireAlive();
		this.#paused = true;
	}

	async keepAlive(): Promise<void> {
		this.#requireAlive();
		this.#keepAliveCalls += 1;
		if (this.keepAliveFails) throw new SandboxError("unavailable", "Sandbox is gone");
	}

	resume(): void {
		this.#requireAlive();
		this.#paused = false;
	}

	async kill(): Promise<void> {
		this.#killed = true;
	}

	async metrics(): Promise<{ cpuCount: number; memoryUsedBytes: number }> {
		return { cpuCount: 2, memoryUsedBytes: 64 * 1024 * 1024 };
	}

	async forwardAgent(hostSocket: string): Promise<AgentForwarding> {
		this.#requireAlive();
		const state = { hostSocket, closed: false };
		this.#forwarding = state;
		return {
			sandboxSocket: "/tmp/fake-agent.sock",
			close: async () => {
				state.closed = true;
			},
		};
	}

	#requireAlive(): void {
		if (this.#killed) throw new SandboxError("not_found", `Sandbox ${this.id} is gone`);
	}

	async #describe(
		path: string,
		name: string,
		kind: "file" | "directory" | "symlink",
		size: number,
		mtimeMs: number,
	): Promise<SandboxFileInfo> {
		const info: SandboxFileInfo = { path, name, kind, size, mtimeMs };
		if (kind === "symlink") {
			const target = await readlink(path).catch(() => undefined);
			if (target !== undefined) info.symlinkTarget = target;
		}
		return info;
	}
}

/** A provider that hands out local directories as sandboxes. */
export class FakeSandboxProvider implements SandboxProvider {
	readonly name = "fake";
	readonly displayName = "Fake";
	readonly capabilities = { pauseResume: true, metrics: true, agentForwarding: true };
	readonly #sandboxes = new Map<string, FakeSandboxHandle>();
	#nextId = 1;
	#listCount = 0;

	/** How many times the provider was asked to list its sandboxes, for tests. */
	get listCount(): number {
		return this.#listCount;
	}

	/** Every sandbox this provider created, for tests. */
	get handles(): readonly FakeSandboxHandle[] {
		return [...this.#sandboxes.values()];
	}

	async create(spec: SandboxSpec): Promise<FakeSandboxHandle> {
		await mkdir(spec.workspaceDir, { recursive: true });
		const handle = new FakeSandboxHandle(`fake-${this.#nextId++}`, spec.workspaceDir, spec.idleTimeoutMs);
		this.#sandboxes.set(handle.id, handle);
		return handle;
	}

	async connect(id: string, options?: SandboxConnectOptions): Promise<FakeSandboxHandle> {
		const handle = this.#sandboxes.get(id);
		if (handle === undefined) throw new SandboxError("not_found", `Unknown sandbox: ${id}`);
		handle.lifetimeMs = options?.idleTimeoutMs;
		handle.resume();
		return handle;
	}

	async list(): Promise<SandboxInfo[]> {
		this.#listCount += 1;
		return [...this.#sandboxes.values()].map((handle) => ({
			id: handle.id,
			provider: this.name,
			state: handle.killed ? "stopped" : handle.paused ? "paused" : "running",
			labels: {},
			workspaceDir: handle.workspaceDir,
		}));
	}

	async kill(id: string): Promise<void> {
		const handle = this.#sandboxes.get(id);
		if (handle === undefined) throw new SandboxError("not_found", `Unknown sandbox: ${id}`);
		await handle.kill();
	}
}

/** Registers one `FakeSandboxProvider` under the name `fake` for the next test. */
export function registerFakeSandboxProvider(
	provider: FakeSandboxProvider,
	validate: () => Promise<void> = async () => {},
): void {
	registerSandboxProvider({
		name: "fake",
		displayName: "Fake",
		needsApiKey: true,
		create: () => provider,
		validate,
	});
}

/** In-memory sandbox settings with a fake key, so tests never touch `config.json`. */
export class FakeSandboxSettingsStore implements SandboxSettingsStore {
	#settings: SandboxSettings;

	constructor(settings: Partial<SandboxSettings> = {}) {
		this.#settings = {
			...DEFAULT_SANDBOX_SETTINGS,
			provider: "fake",
			providers: { fake: { apiKey: "test-key" } },
			...settings,
		};
	}

	getSandboxSettings(): SandboxSettings {
		return this.#settings;
	}

	async setSandboxSettings(change: SandboxSettingsChange): Promise<SandboxSettings> {
		const next: SandboxSettings = { ...this.#settings, providers: { ...this.#settings.providers } };
		if (change.provider !== undefined) next.provider = change.provider;
		if (change.template !== undefined) {
			if (change.template === null) delete next.template;
			else next.template = change.template;
		}
		if (change.idleTimeoutMs !== undefined) {
			if (change.idleTimeoutMs === null) next.idleTimeoutMs = DEFAULT_SANDBOX_SETTINGS.idleTimeoutMs;
			else next.idleTimeoutMs = change.idleTimeoutMs;
		}
		if (change.autoPause !== undefined) {
			if (change.autoPause === null) next.autoPause = DEFAULT_SANDBOX_SETTINGS.autoPause;
			else next.autoPause = change.autoPause;
		}
		if (change.apiKey !== undefined) {
			if (change.apiKey.key === null || change.apiKey.key === "") delete next.providers[change.apiKey.provider];
			else next.providers[change.apiKey.provider] = { apiKey: change.apiKey.key };
		}
		if (change.sshAgentSocket !== undefined) {
			if (change.sshAgentSocket === null || change.sshAgentSocket === "") delete next.ssh.agentSocket;
			else next.ssh.agentSocket = change.sshAgentSocket;
		}
		if (change.forwardAgent !== undefined) {
			next.ssh.forwardAgent = change.forwardAgent ?? DEFAULT_SANDBOX_SETTINGS.ssh.forwardAgent;
		}
		this.#settings = next;
		return next;
	}
}
