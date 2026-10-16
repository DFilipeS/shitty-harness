import {
	SandboxError,
	type SandboxExecOptions,
	type SandboxFileInfo,
	type SandboxHandle,
	type SandboxInfo,
	type SandboxMetrics,
	type SandboxProvider,
	type SandboxProviderConfig,
	type SandboxProviderFactory,
	type SandboxSource,
	type SandboxSpec,
} from "../provider.ts";
import { shellQuote } from "../shell.ts";

/** The `e2b` module, loaded only when a sandbox is actually used. */
function importSdk() {
	return import("e2b");
}

type E2BSdk = Awaited<ReturnType<typeof importSdk>>;

let sdkPromise: ReturnType<typeof importSdk> | undefined;

function loadSdk(): ReturnType<typeof importSdk> {
	sdkPromise ??= importSdk();
	return sdkPromise;
}

/** Map any SDK failure to the harness's provider error codes, by class name so no SDK import is needed. */
function mapError(error: unknown): SandboxError {
	if (error instanceof SandboxError) return error;
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);
	const options = { cause: error };
	if (name === "AuthenticationError" || name === "GitAuthError") return new SandboxError("auth", message, options);
	if (name === "NotFoundError" || name === "FileNotFoundError" || name === "SandboxNotFoundError") {
		return new SandboxError("not_found", message, options);
	}
	if (name === "TimeoutError" || name === "SandboxNotRunningError" || name === "SandboxUnreachableError") {
		return new SandboxError("timeout", message, options);
	}
	if (name === "InvalidArgumentError") return new SandboxError("invalid", message, options);
	return new SandboxError("unknown", message, options);
}

function fileKind(type: string | undefined): SandboxFileInfo["kind"] {
	if (type === "dir") return "directory";
	if (type === "symlink") return "symlink";
	return "file";
}

/** One connected E2B sandbox. */
class E2BSandboxHandle implements SandboxHandle {
	readonly id: string;
	readonly provider = "e2b";
	readonly workspaceDir: string;
	readonly #sandbox: import("e2b").Sandbox;
	readonly #apiKey: string | undefined;

	constructor(sandbox: import("e2b").Sandbox, workspaceDir: string, apiKey: string | undefined) {
		this.#sandbox = sandbox;
		this.#apiKey = apiKey;
		this.id = sandbox.sandboxId;
		this.workspaceDir = workspaceDir;
	}

	async exec(command: string, options: SandboxExecOptions = {}): Promise<{ exitCode: number | null }> {
		try {
			const handle = await this.#sandbox.commands.run(command, {
				background: true,
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				...(options.env === undefined ? {} : { envs: options.env }),
				timeoutMs: options.timeoutMs ?? 0,
				onStdout: (data) => options.onStdout?.(data),
				onStderr: (data) => options.onStderr?.(data),
			});
			const onAbort = () => void handle.kill();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			try {
				if (options.signal?.aborted === true) {
					await handle.kill();
					throw new SandboxError("aborted", "Command aborted");
				}
				const result = await handle.wait();
				return { exitCode: result.exitCode };
			} catch (error) {
				if (options.signal?.aborted === true) throw new SandboxError("aborted", "Command aborted");
				if (error instanceof Error && error.name === "CommandExitError") {
					const exitCode = (error as Error & { exitCode?: number }).exitCode;
					return { exitCode: exitCode ?? 1 };
				}
				throw mapError(error);
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}
		} catch (error) {
			throw mapError(error);
		}
	}

	async readFile(path: string): Promise<Uint8Array> {
		try {
			return await this.#sandbox.files.read(path, { format: "bytes" });
		} catch (error) {
			throw mapError(error);
		}
	}

	async writeFile(path: string, data: string | Uint8Array): Promise<void> {
		try {
			const payload: string | ArrayBuffer =
				typeof data === "string"
					? data
					: (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength);
			await this.#sandbox.files.write(path, payload);
		} catch (error) {
			throw mapError(error);
		}
	}

	async listDir(path: string): Promise<SandboxFileInfo[]> {
		try {
			return (await this.#sandbox.files.list(path)).map(describe);
		} catch (error) {
			throw mapError(error);
		}
	}

	async stat(path: string): Promise<SandboxFileInfo | undefined> {
		try {
			return describe(await this.#sandbox.files.getInfo(path));
		} catch (error) {
			if (mapError(error).code === "not_found") return undefined;
			throw mapError(error);
		}
	}

	async makeDir(path: string): Promise<void> {
		try {
			await this.#sandbox.files.makeDir(path);
		} catch (error) {
			throw mapError(error);
		}
	}

	async remove(path: string): Promise<void> {
		try {
			await this.#sandbox.files.remove(path);
		} catch (error) {
			throw mapError(error);
		}
	}

	async rename(source: string, destination: string): Promise<void> {
		try {
			await this.#sandbox.files.rename(source, destination);
		} catch (error) {
			throw mapError(error);
		}
	}

	async pause(): Promise<void> {
		try {
			await this.#sandbox.pause();
		} catch (error) {
			throw mapError(error);
		}
	}

	async kill(): Promise<void> {
		try {
			await this.#sandbox.kill();
		} catch (error) {
			throw mapError(error);
		}
	}

	async metrics(): Promise<SandboxMetrics | undefined> {
		try {
			const latest = (await this.#sandbox.getMetrics()).at(-1);
			if (latest === undefined) return undefined;
			return {
				cpuCount: latest.cpuCount,
				cpuUsedPct: latest.cpuUsedPct,
				memoryUsedBytes: latest.memUsed,
				memoryTotalBytes: latest.memTotal,
				diskUsedBytes: latest.diskUsed,
				diskTotalBytes: latest.diskTotal,
			};
		} catch (error) {
			throw mapError(error);
		}
	}

	/** Kept so a future agent-forwarding step can reuse the connection. */
	get apiKey(): string | undefined {
		return this.#apiKey;
	}
}

function describe(info: import("e2b").EntryInfo): SandboxFileInfo {
	return {
		name: info.name,
		path: info.path,
		kind: fileKind(info.type),
		size: info.size,
		mtimeMs: info.modifiedTime?.getTime() ?? 0,
		...(info.symlinkTarget === undefined ? {} : { symlinkTarget: info.symlinkTarget }),
	};
}

async function cloneInto(
	sandbox: import("e2b").Sandbox,
	workspaceDir: string,
	url: string,
): Promise<void> {
	const result = await sandbox.commands.run(`git clone ${shellQuote(url)} .`, {
		cwd: workspaceDir,
		timeoutMs: 10 * 60 * 1000,
	});
	if (result.exitCode !== 0) {
		throw new SandboxError("unknown", `git clone failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
	}
}

class E2BProvider implements SandboxProvider {
	readonly name = "e2b";
	readonly displayName = "E2B";
	readonly capabilities = { pauseResume: true, metrics: true };
	readonly #config: SandboxProviderConfig;
	readonly #credentials: { apiKey?: string };

	constructor(config: SandboxProviderConfig, credentials: { apiKey?: string }) {
		this.#config = config;
		this.#credentials = credentials;
	}

	async create(spec: SandboxSpec): Promise<SandboxHandle> {
		const { Sandbox } = await loadSdk();
		const template = spec.template ?? this.#config.template ?? "base";
		let sandbox: import("e2b").Sandbox | undefined;
		try {
			sandbox = await Sandbox.create(template, {
				...(this.#credentials.apiKey === undefined ? {} : { apiKey: this.#credentials.apiKey }),
				...(spec.labels === undefined ? {} : { metadata: spec.labels }),
				...(spec.env === undefined ? {} : { envs: spec.env }),
				...(spec.idleTimeoutMs === undefined ? {} : { timeoutMs: spec.idleTimeoutMs }),
				lifecycle: {
					onTimeout: spec.autoPause === true ? "pause" : "kill",
					autoResume: spec.autoPause === true,
				},
			});
			await sandbox.files.makeDir(spec.workspaceDir);
			if (spec.source?.kind === "git") await cloneInto(sandbox, spec.workspaceDir, spec.source.url);
			return new E2BSandboxHandle(sandbox, spec.workspaceDir, this.#credentials.apiKey);
		} catch (error) {
			await sandbox?.kill().catch(() => undefined);
			throw mapError(error);
		}
	}

	async connect(id: string, options?: { workspaceDir?: string }): Promise<SandboxHandle> {
		const { Sandbox } = await loadSdk();
		try {
			const sandbox = await Sandbox.connect(id, {
				...(this.#credentials.apiKey === undefined ? {} : { apiKey: this.#credentials.apiKey }),
			});
			const workspaceDir = options?.workspaceDir ?? "/home/user/workspace";
			await sandbox.files.makeDir(workspaceDir);
			return new E2BSandboxHandle(sandbox, workspaceDir, this.#credentials.apiKey);
		} catch (error) {
			throw mapError(error);
		}
	}

	async list(filter?: { labels?: Record<string, string> }): Promise<SandboxInfo[]> {
		const { Sandbox } = await loadSdk();
		try {
			const paginator = Sandbox.list({
				...(this.#credentials.apiKey === undefined ? {} : { apiKey: this.#credentials.apiKey }),
				...(filter?.labels === undefined ? {} : { query: { metadata: filter.labels } }),
			});
			const items: import("e2b").SandboxInfo[] = [];
			for (;;) {
				items.push(...(await paginator.nextItems()));
				if (!paginator.hasNext) break;
			}
			return items.map((info) => ({
				id: info.sandboxId,
				provider: this.name,
				state: info.state === "paused" ? "paused" : "running",
				...(info.metadata?.name === undefined ? {} : { name: info.metadata.name }),
				labels: info.metadata ?? {},
				workspaceDir: info.metadata?.workspaceDir ?? "/home/user/workspace",
				...(info.templateId === undefined ? {} : { template: info.templateId }),
				...(info.startedAt === undefined ? {} : { createdAt: info.startedAt.getTime() }),
			}));
		} catch (error) {
			throw mapError(error);
		}
	}

	async kill(id: string): Promise<void> {
		const { Sandbox } = await loadSdk();
		try {
			await Sandbox.kill(id, {
				...(this.#credentials.apiKey === undefined ? {} : { apiKey: this.#credentials.apiKey }),
			});
		} catch (error) {
			throw mapError(error);
		}
	}
}

export const E2BProviderFactory: SandboxProviderFactory = {
	name: "e2b",
	displayName: "E2B",
	envVar: "E2B_API_KEY",
	needsApiKey: true,
	create: (config, credentials) => new E2BProvider(config, credentials),
	async validate(credentials) {
		const { Sandbox } = await loadSdk();
		try {
			const paginator = Sandbox.list({
				...(credentials.apiKey === undefined ? {} : { apiKey: credentials.apiKey }),
				limit: 1,
			});
			await paginator.nextItems();
		} catch (error) {
			throw mapError(error);
		}
	},
};
