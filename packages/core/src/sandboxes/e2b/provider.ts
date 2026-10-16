import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	SandboxError,
	type AgentForwarding,
	type SandboxExecOptions,
	type SandboxFileInfo,
	type SandboxHandle,
	type SandboxInfo,
	type SandboxMetrics,
	type SandboxProvider,
	type SandboxProviderConfig,
	type SandboxProviderFactory,
	type SandboxSpec,
} from "../provider.ts";
import { shellQuote } from "../shell.ts";

const execFileAsync = promisify(execFile);

/** Port inside the sandbox where websocat bridges WebSocket to sshd. */
const WEBSOCAT_PORT = 8081;
/** Path of the forwarded agent socket inside the sandbox. */
const AGENT_SOCKET = "/tmp/harness-agent.sock";
const WEBSOCAT_BASE_URL = "https://github.com/vi/websocat/releases/latest/download";
const WS_PROXY_PATH = fileURLToPath(new URL("./ws-proxy.mjs", import.meta.url));

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

interface RawResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Run a command and return its result instead of throwing on failure. */
async function runRaw(sandbox: import("e2b").Sandbox, command: string, timeoutMs = 120_000): Promise<RawResult> {
	try {
		const result = await sandbox.commands.run(command, { timeoutMs });
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const exitCode = (error as { exitCode?: number }).exitCode;
		if (typeof exitCode === "number") {
			const raw = error as { stdout?: string; stderr?: string };
			return { exitCode, stdout: raw.stdout ?? "", stderr: raw.stderr ?? "" };
		}
		throw error;
	}
}

/**
 * Create the hop key on first use. It only authenticates the host to the sandbox; it is never used
 * against a forge.
 */
async function ensureHopKey(stateDir: string): Promise<{ privateKeyPath: string; publicKey: string }> {
	const privateKeyPath = join(stateDir, "hop-key");
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	try {
		await readFile(privateKeyPath);
	} catch {
		await execFileAsync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "harness hop", "-f", privateKeyPath]);
	}
	const { stdout } = await execFileAsync("ssh-keygen", ["-y", "-f", privateKeyPath]);
	return { privateKeyPath, publicKey: stdout.trim() };
}

/** Trust the hop key in the sandbox. Idempotent. */
async function authorizeHopKey(sandbox: import("e2b").Sandbox, publicKey: string): Promise<void> {
	const result = await runRaw(
		sandbox,
		[
			"umask 077",
			"mkdir -p ~/.ssh",
			"touch ~/.ssh/authorized_keys",
			`grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys`,
		].join("; "),
	);
	if (result.exitCode !== 0) {
		throw new SandboxError("unknown", `Could not authorize the hop key: ${result.stderr.trim() || "unknown error"}`);
	}
}

/** The base image has sshd but not websocat. Install it on first use. */
async function ensureWebsocat(sandbox: import("e2b").Sandbox): Promise<void> {
	const existing = await runRaw(sandbox, "command -v websocat", 15_000);
	if (existing.exitCode === 0) return;
	const arch = (await runRaw(sandbox, "uname -m", 15_000)).stdout.trim();
	const asset =
		arch === "aarch64" || arch === "arm64"
			? "websocat.aarch64-unknown-linux-musl"
			: "websocat.x86_64-unknown-linux-musl";
	const install = await runRaw(
		sandbox,
		`sudo curl -fsSL -o /usr/local/bin/websocat ${WEBSOCAT_BASE_URL}/${asset} && sudo chmod +x /usr/local/bin/websocat`,
		180_000,
	);
	if (install.exitCode !== 0) {
		throw new SandboxError("unknown", `Could not install websocat: ${install.stderr.trim() || "unknown error"}`);
	}
}

/** True when something listens on the websocat port inside the sandbox. */
async function websocatListening(sandbox: import("e2b").Sandbox): Promise<boolean> {
	const result = await runRaw(
		sandbox,
		`(ss -tln 2>/dev/null || netstat -tln 2>/dev/null) | grep -q ':${WEBSOCAT_PORT} '`,
		15_000,
	);
	return result.exitCode === 0;
}

/** Start the WebSocket-to-sshd bridge inside the sandbox. Idempotent. */
async function startWebsocat(sandbox: import("e2b").Sandbox): Promise<void> {
	if (await websocatListening(sandbox)) return;
	await runRaw(
		sandbox,
		`sudo nohup websocat -b --exit-on-eof ws-l:0.0.0.0:${WEBSOCAT_PORT} tcp:127.0.0.1:22 >/tmp/harness-websocat.log 2>&1 &`,
		15_000,
	);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await websocatListening(sandbox)) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const log = await runRaw(sandbox, "tail -n 5 /tmp/harness-websocat.log", 15_000);
	const detail = log.stdout.trim() || log.stderr.trim();
	throw new SandboxError("unknown", `websocat did not listen on port ${WEBSOCAT_PORT}${detail ? `: ${detail}` : ""}`);
}

interface TunnelOptions {
	sandboxId: string;
	/** Public host for the websocat port, e.g. "8081-abc.e2b.app". */
	host: string;
	privateKeyPath: string;
	hostSocket: string;
	knownHostsPath: string;
	remoteSocket: string;
	/** Collects the last stderr lines, for error reporting. */
	errors: string[];
	/** Called before each connection attempt. */
	onceBeforeConnect: () => Promise<void>;
}

/**
 * Keep an SSH connection alive that forwards the host agent socket into the sandbox. Restarts with
 * backoff when it drops.
 */
function startTunnel(options: TunnelOptions): AgentForwarding {
	let closed = false;
	let child: ChildProcess | undefined;
	let failures = 0;

	const spawnOnce = async (): Promise<void> => {
		try {
			await options.onceBeforeConnect();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[sandbox] ssh bridge: ${message}`);
		}
		if (closed) return;

		const proxyCommand = `${shellQuote(process.execPath)} ${shellQuote(WS_PROXY_PATH)} wss://${options.host}`;
		child = spawn(
			"ssh",
			[
				"-N",
				"-i",
				options.privateKeyPath,
				"-o",
				`ProxyCommand=${proxyCommand}`,
				"-o",
				"StrictHostKeyChecking=accept-new",
				"-o",
				`UserKnownHostsFile=${options.knownHostsPath}`,
				"-o",
				"StreamLocalBindUnlink=yes",
				"-o",
				"ExitOnForwardFailure=yes",
				"-o",
				"ServerAliveInterval=15",
				"-o",
				"ServerAliveCountMax=3",
				"-o",
				"LogLevel=ERROR",
				"-R",
				`${options.remoteSocket}:${options.hostSocket}`,
				`user@${options.sandboxId}`,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		child.stderr?.on("data", (chunk) => {
			for (const line of chunk.toString().trim().split("\n")) {
				if (!line) continue;
				options.errors.push(line);
				if (options.errors.length > 20) options.errors.shift();
			}
		});
		child.on("exit", () => {
			if (closed) return;
			failures += 1;
			const delay = Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000);
			const timer = setTimeout(() => void spawnOnce(), delay);
			timer.unref();
		});
	};

	void spawnOnce();

	return {
		sandboxSocket: options.remoteSocket,
		close: async () => {
			closed = true;
			child?.kill("SIGTERM");
		},
	};
}

/** Wait until the forwarded socket exists inside the sandbox. */
async function waitForSocket(
	sandbox: SandboxHandle,
	socketPath: string,
	errors: string[],
): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const result = await sandbox.exec(`test -S ${shellQuote(socketPath)}`);
		if (result.exitCode === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	const detail = errors.at(-1);
	throw new SandboxError("unknown", `Forwarded agent socket did not appear at ${socketPath}${detail ? `: ${detail}` : ""}`);
}

/** One connected E2B sandbox. */
class E2BSandboxHandle implements SandboxHandle {
	readonly id: string;
	readonly provider = "e2b";
	readonly workspaceDir: string;
	readonly #sandbox: import("e2b").Sandbox;
	readonly #stateDir: string | undefined;

	constructor(sandbox: import("e2b").Sandbox, workspaceDir: string, stateDir: string | undefined) {
		this.#sandbox = sandbox;
		this.#stateDir = stateDir;
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

	async forwardAgent(hostSocket: string): Promise<AgentForwarding> {
		const stateDir = this.#stateDir;
		if (stateDir === undefined) {
			throw new SandboxError("invalid", "The E2B provider is missing its state directory");
		}
		try {
			const { privateKeyPath, publicKey } = await ensureHopKey(stateDir);
			await ensureWebsocat(this.#sandbox);
			await authorizeHopKey(this.#sandbox, publicKey);
			await startWebsocat(this.#sandbox);
			const host = this.#sandbox.getHost(WEBSOCAT_PORT);
			const errors: string[] = [];
			const forwarding = startTunnel({
				sandboxId: this.id,
				host,
				privateKeyPath,
				hostSocket,
				knownHostsPath: join(stateDir, "known_hosts"),
				remoteSocket: AGENT_SOCKET,
				errors,
				onceBeforeConnect: async () => {
					await startWebsocat(this.#sandbox);
					// Clear a stale socket left by a previous connection.
					await runRaw(this.#sandbox, `rm -f ${shellQuote(AGENT_SOCKET)}`, 15_000);
				},
			});
			await waitForSocket(this, AGENT_SOCKET, errors);
			return forwarding;
		} catch (error) {
			if (error instanceof SandboxError) throw error;
			throw mapError(error);
		}
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

class E2BProvider implements SandboxProvider {
	readonly name = "e2b";
	readonly displayName = "E2B";
	readonly capabilities = { pauseResume: true, metrics: true, agentForwarding: true };
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
			return new E2BSandboxHandle(sandbox, spec.workspaceDir, this.#config.stateDir);
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
			return new E2BSandboxHandle(sandbox, workspaceDir, this.#config.stateDir);
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

	async buildTemplate(name: string, onLog?: (line: string) => void): Promise<void> {
		const { Template } = await loadSdk();
		try {
			const template = Template()
				.fromBaseImage()
				.runCmd(
					[
						'ARCH=$(uname -m); case "$ARCH" in aarch64|arm64) ASSET=websocat.aarch64-unknown-linux-musl ;; *) ASSET=websocat.x86_64-unknown-linux-musl ;; esac; curl -fsSL -o /usr/local/bin/websocat "https://github.com/vi/websocat/releases/latest/download/$ASSET" && chmod +x /usr/local/bin/websocat',
					],
					{ user: "root" },
				);
			await Template.build(template, name, {
				...(this.#credentials.apiKey === undefined ? {} : { apiKey: this.#credentials.apiKey }),
				cpuCount: 2,
				memoryMB: 2048,
				onBuildLogs: (entry) => onLog?.(entry.message),
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
