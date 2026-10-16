import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	err,
	ok,
	ExecutionError,
	FileError,
	LineScanner,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileWatcher,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellSpillOptions,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { SandboxError, type SandboxFileInfo, type SandboxHandle } from "./provider.ts";
import { shellQuote } from "./shell.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** Poll interval of the file watcher; E2B has no filesystem notifications we can rely on. */
const WATCH_INTERVAL_MS = 150;
const MAX_SYMLINK_HOPS = 40;

function aborted(path: string, context: Context): Result<never, FileError> | undefined {
	return isAborted(context) ? err(new FileError("aborted", "Aborted", path)) : undefined;
}

/** Read through a function so TypeScript does not narrow the signal across an await. */
function isAborted(context: Context): boolean {
	return context.abortSignal?.aborted === true;
}

function toFileError(error: unknown, path: string): FileError {
	if (error instanceof SandboxError) {
		const code =
			error.code === "not_found"
				? "not_found"
				: error.code === "invalid"
					? "invalid"
					: error.code === "auth"
						? "permission_denied"
						: "unknown";
		return new FileError(code, error.message, path, error);
	}
	return new FileError(
		"unknown",
		error instanceof Error ? error.message : String(error),
		path,
		error instanceof Error ? error : undefined,
	);
}

function toExecutionError(error: unknown, context: Context): ExecutionError {
	if (isAborted(context)) return new ExecutionError("aborted", "Aborted", error instanceof Error ? error : undefined);
	if (error instanceof SandboxError) {
		const code =
			error.code === "timeout"
				? "timeout"
				: error.code === "aborted"
					? "aborted"
					: error.code === "invalid"
						? "spawn_error"
						: "unknown";
		return new ExecutionError(code, error.message, error);
	}
	return new ExecutionError(
		"unknown",
		error instanceof Error ? error.message : String(error),
		error instanceof Error ? error : undefined,
	);
}

function toFileInfo(info: SandboxFileInfo): FileInfo {
	return {
		name: info.name,
		path: info.path,
		kind: info.kind,
		size: info.size,
		mtimeMs: info.mtimeMs,
	};
}

/** Positional reads over a file snapshot, so a rename cannot change what an open reader sees. */
class SandboxBinaryReader implements BinaryReader {
	readonly #info: FileInfo;
	readonly #bytes: Uint8Array;
	#closed = false;

	constructor(info: FileInfo, bytes: Uint8Array) {
		this.#info = info;
		this.#bytes = bytes;
	}

	async info(context: Context): Promise<Result<FileInfo, FileError>> {
		const abortedResult = aborted(this.#info.path, context);
		if (abortedResult !== undefined) return abortedResult;
		if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
		return ok(this.#info);
	}

	async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		const abortedResult = aborted(this.#info.path, context);
		if (abortedResult !== undefined) return abortedResult;
		if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
		if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
			return err(new FileError("invalid", "Invalid read range", this.#info.path));
		}
		const start = Math.min(offset, this.#bytes.length);
		const end = Math.min(start + length, this.#bytes.length);
		return ok(this.#bytes.subarray(start, end));
	}

	async scanLines(
		options: { startLine: number; endLine?: number },
		context: Context,
	): Promise<Result<import("@earendil-works/pi-durable/env").LineScan, FileError>> {
		const abortedResult = aborted(this.#info.path, context);
		if (abortedResult !== undefined) return abortedResult;
		if (this.#closed) return err(new FileError("invalid", "Binary reader is closed", this.#info.path));
		let scanner: LineScanner;
		try {
			scanner = new LineScanner(options.startLine, options.endLine);
		} catch {
			return err(new FileError("invalid", "Invalid line range", this.#info.path));
		}
		scanner.push(this.#bytes);
		return ok(scanner.finish());
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}
}

/** Strict LF line reader over a file snapshot, matching pi-durable's local reader. */
class SandboxTextLineReader implements TextLineReader {
	readonly #path: string;
	readonly #lines: TextLine[];
	#index = 0;
	#closed = false;

	constructor(path: string, lines: TextLine[]) {
		this.#path = path;
		this.#lines = lines;
	}

	async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		const abortedResult = aborted(this.#path, context);
		if (abortedResult !== undefined) return abortedResult;
		if (this.#closed) return err(new FileError("invalid", "Text line reader is closed", this.#path));
		const line = this.#lines[this.#index];
		if (line === undefined) return ok(undefined);
		this.#index += 1;
		return ok(line);
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}
}

/** Directory pages over a snapshot of names; each name is re-checked so removals are skipped. */
class SandboxDirReader implements DirReader {
	readonly #sandbox: SandboxHandle;
	readonly #paths: string[];
	#index = 0;
	#closed = false;

	constructor(sandbox: SandboxHandle, paths: string[]) {
		this.#sandbox = sandbox;
		this.#paths = paths;
	}

	async next(
		maxEntries: number,
		context: Context,
	): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		const abortedResult = aborted(this.#paths[0] ?? "", context);
		if (abortedResult !== undefined) return abortedResult;
		if (this.#closed) return err(new FileError("invalid", "Directory reader is closed"));
		if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
			return err(new FileError("invalid", "maxEntries must be a positive integer"));
		}
		const entries: FileInfo[] = [];
		while (this.#index < this.#paths.length && entries.length < maxEntries) {
			const path = this.#paths[this.#index];
			this.#index += 1;
			if (path === undefined) break;
			const info = await this.#sandbox.stat(path).catch(() => undefined);
			if (info !== undefined) entries.push(toFileInfo(info));
		}
		return ok({ entries, done: this.#index >= this.#paths.length });
	}

	async close(_context: Context): Promise<void> {
		this.#closed = true;
	}
}

function fingerprint(info: SandboxFileInfo): string {
	return `${info.kind}:${info.size}:${info.mtimeMs}`;
}

export type SandboxExecutionEnvOptions = {
	/** Path of the forwarded SSH agent socket inside the sandbox, when forwarding is active. */
	agentSocket?: string;
};

/**
 * A pi-durable `ExecutionEnv` over one sandbox. Readers and line scans work on a file snapshot, the
 * watcher polls, and commands run through the provider's exec API.
 */
export class SandboxExecutionEnv implements ExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	readonly sandboxId: string;
	readonly provider: string;
	readonly handle: SandboxHandle;
	readonly #agentSocket: string | undefined;
	readonly #active = new Set<AbortController>();

	constructor(sandbox: SandboxHandle, options: SandboxExecutionEnvOptions = {}) {
		this.handle = sandbox;
		this.sandboxId = sandbox.id;
		this.provider = sandbox.provider;
		this.id = `sandbox:${sandbox.provider}:${sandbox.id}`;
		this.cwd = sandbox.workspaceDir;
		this.#agentSocket = options.agentSocket;
	}

	/** The forwarded agent socket, when one is active. */
	get agentSocket(): string | undefined {
		return this.#agentSocket;
	}

	#absolute(path: string): string {
		return posix.isAbsolute(path) ? posix.normalize(path) : posix.resolve(this.cwd, path);
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#absolute(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			if (info.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${path}`, resolved));
			return ok(decoder.decode(await this.handle.readFile(resolved)));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const opened = await this.openTextLineReader(path, context);
		if (!opened.ok) return opened;
		const lines: string[] = [];
		try {
			while (options?.maxLines === undefined || lines.length < options.maxLines) {
				const line = await opened.value.readLine(context);
				if (!line.ok) return line;
				if (line.value === undefined) break;
				lines.push(line.value.text);
			}
			return ok(lines);
		} finally {
			await opened.value.close(context);
		}
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			if (info.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${path}`, resolved));
			const text = decoder.decode(await this.handle.readFile(resolved));
			const lines: TextLine[] = [];
			let start = 0;
			for (;;) {
				const newline = text.indexOf("\n", start);
				if (newline === -1) {
					if (start < text.length) lines.push({ text: text.slice(start), terminated: false });
					break;
				}
				lines.push({ text: text.slice(start, newline), terminated: true });
				start = newline + 1;
			}
			return ok(new SandboxTextLineReader(resolved, lines));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			if (info.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${path}`, resolved));
			return ok(await this.handle.readFile(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<Result<BinaryReader, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			if (info.kind === "directory") return err(new FileError("is_directory", `Is a directory: ${path}`, resolved));
			if (options?.noFollow === true && info.kind === "symlink") {
				return err(new FileError("invalid", `Symbolic link refused: ${path}`, resolved));
			}
			const bytes = await this.handle.readFile(resolved);
			const afterReadAbort = aborted(resolved, context);
			if (afterReadAbort !== undefined) return afterReadAbort;
			return ok(
				new SandboxBinaryReader(
					{ name: posix.basename(resolved), path: resolved, kind: "file", size: bytes.length, mtimeMs: info.mtimeMs },
					bytes,
				),
			);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			await this.handle.writeFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const existing = await this.readBinaryFile(path, context);
		const prefix = existing.ok ? existing.value : existing.error.code === "not_found" ? new Uint8Array() : undefined;
		if (prefix === undefined) return err(existing.ok ? new FileError("unknown", "Unreachable") : existing.error);
		const suffix = typeof content === "string" ? encoder.encode(content) : content;
		const combined = new Uint8Array(prefix.length + suffix.length);
		combined.set(prefix, 0);
		combined.set(suffix, prefix.length);
		return this.writeFile(path, combined, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const resolved = this.#absolute(path);
		if (!Number.isInteger(size) || size < 0) return err(new FileError("invalid", "Invalid size", resolved));
		const existing = await this.readBinaryFile(path, context);
		const bytes = existing.ok ? existing.value : existing.error.code === "not_found" ? new Uint8Array() : undefined;
		if (bytes === undefined) return err(existing.ok ? new FileError("unknown", "Unreachable") : existing.error);
		const next = new Uint8Array(size);
		next.set(bytes.subarray(0, size), 0);
		return this.writeFile(path, next, context);
	}

	async flushFile(_path: string, _context: Context): Promise<Result<void, FileError>> {
		return ok(undefined);
	}

	async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		const source = this.#absolute(sourcePath);
		const destination = this.#absolute(destinationPath);
		const abortedResult = aborted(source, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			await this.handle.rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			return ok(toFileInfo(info));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `Directory not found: ${path}`, resolved));
			if (info.kind !== "directory") {
				return err(new FileError("not_directory", `Not a directory: ${path}`, resolved));
			}
			return ok((await this.handle.listDir(resolved)).map(toFileInfo));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `Directory not found: ${path}`, resolved));
			if (info.kind !== "directory") {
				return err(new FileError("not_directory", `Not a directory: ${path}`, resolved));
			}
			const entries = await this.handle.listDir(resolved);
			return ok(new SandboxDirReader(this.handle, entries.map((entry) => entry.path)));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async watch(
		targets: readonly WatchTarget[],
		onChange: (change: WatchChange) => void,
		context: Context,
	): Promise<Result<FileWatcher, FileError>> {
		const abortedResult = aborted(this.cwd, context);
		if (abortedResult !== undefined) return abortedResult;
		const roots = targets.map((target) => ({ target, path: this.#absolute(target.path) }));
		const fingerprints = new Map<string, string>();
		const snapshot = async (): Promise<Map<string, string>> => {
			const next = new Map<string, string>();
			for (const root of roots) {
				next.set(root.path, await this.#snapshotRoot(root.target));
			}
			return next;
		};
		for (const [path, value] of await snapshot()) fingerprints.set(path, value);
		let closed = false;
		let busy = false;
		const timer = setInterval(() => {
			if (closed || busy) return;
			busy = true;
			void (async () => {
				const next = await snapshot();
				const changed: string[] = [];
				for (const [path, value] of next) {
					if (fingerprints.get(path) !== value) changed.push(path);
				}
				for (const path of fingerprints.keys()) {
					if (!next.has(path)) changed.push(path);
				}
				fingerprints.clear();
				for (const [path, value] of next) fingerprints.set(path, value);
				if (changed.length > 0) onChange({ paths: changed });
			})()
				.catch(() => undefined)
				.finally(() => {
					busy = false;
				});
		}, WATCH_INTERVAL_MS);
		timer.unref?.();
		return ok({
			mode: "polling",
			close: async () => {
				closed = true;
				clearInterval(timer);
			},
		});
	}

	/** Follow a symlink chain to the file or directory it names. */
	async #followStat(path: string, hop = 0): Promise<SandboxFileInfo | undefined> {
		if (hop > MAX_SYMLINK_HOPS) return undefined;
		const info = await this.handle.stat(path);
		if (info === undefined || info.kind !== "symlink") return info;
		const target = info.symlinkTarget;
		if (target === undefined) return info;
		const resolved = posix.isAbsolute(target) ? target : posix.resolve(posix.dirname(path), target);
		return this.#followStat(resolved, hop + 1);
	}

	/** One fingerprint per path under a watch target; a change anywhere under it changes the root. */
	async #snapshotRoot(target: WatchTarget): Promise<string> {
		const parts: string[] = [];
		const visit = async (path: string, recursive: boolean): Promise<void> => {
			const info = await this.#followStat(path).catch(() => undefined);
			if (info === undefined) return;
			parts.push(`${path}\u0000${fingerprint(info)}`);
			if (info.kind !== "directory") return;
			const entries = await this.handle.listDir(path).catch(() => []);
			for (const entry of entries) {
				if (target.exclude?.hidden === true && entry.name.startsWith(".")) continue;
				if (target.exclude?.names?.includes(entry.name) === true) continue;
				parts.push(`${entry.path}\u0000${fingerprint(entry)}`);
				if (recursive && entry.kind === "directory") await visit(entry.path, true);
			}
		};
		await visit(this.#absolute(target.path), target.recursive === true);
		return parts.sort().join("\u0001");
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			const info = await this.handle.stat(resolved);
			if (info === undefined) return err(new FileError("not_found", `File not found: ${path}`, resolved));
			const result = await this.#runText(`realpath -- ${shellQuote(resolved)}`, context);
			const canonical = result.stdout.trim();
			if (result.code !== 0 || canonical === "") {
				return err(new FileError("not_found", `Cannot resolve ${path}`, resolved));
			}
			return ok(canonical);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			return ok((await this.handle.stat(resolved)) !== undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createDir(
		path: string,
		_options: { recursive?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			await this.handle.makeDir(resolved);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<Result<void, FileError>> {
		const resolved = this.#absolute(path);
		const abortedResult = aborted(resolved, context);
		if (abortedResult !== undefined) return abortedResult;
		try {
			await this.handle.remove(resolved);
			return ok(undefined);
		} catch (error) {
			if (options?.force === true && error instanceof SandboxError && error.code === "not_found") {
				return ok(undefined);
			}
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#createTemp(`mktemp -d`, prefix ?? "tmp", context);
	}

	async createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): Promise<Result<string, FileError>> {
		return this.#createTemp(`mktemp`, options?.prefix ?? "tmp", context, options?.suffix);
	}

	async #createTemp(
		command: string,
		prefix: string,
		context: Context,
		suffix?: string,
	): Promise<Result<string, FileError>> {
		const abortedResult = aborted("/tmp", context);
		if (abortedResult !== undefined) return abortedResult;
		const template = `/tmp/${prefix}.XXXXXX${suffix ?? ""}`;
		try {
			const result = await this.#runText(`${command} ${shellQuote(template)}`, context);
			const path = result.stdout.trim();
			if (result.code !== 0 || path === "") {
				return err(new FileError("unknown", `Could not create a temporary path: ${result.stderr.trim()}`));
			}
			return ok(path);
		} catch (error) {
			return err(toFileError(error, "/tmp"));
		}
	}

	async #runText(
		command: string,
		context: Context,
	): Promise<{ code: number | null; stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		const result = await this.handle.exec(command, {
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
			onStdout: (text) => {
				stdout += text;
			},
			onStderr: (text) => {
				stderr += text;
			},
		});
		return { code: result.exitCode, stdout, stderr };
	}

	/**
	 * Renew the sandbox's idle timeout while a command runs, so a build that outlives the timeout
	 * is not cut off midway. Returns a stop function, or `undefined` when the sandbox has none.
	 */
	#startKeepAlive(): (() => void) | undefined {
		const handle = this.handle;
		const lifetimeMs = handle.lifetimeMs;
		if (handle.keepAlive === undefined || lifetimeMs === undefined || lifetimeMs <= 0) return undefined;
		const renew = (): void => {
			const pending = handle.keepAlive?.();
			if (pending === undefined) return;
			void pending.catch((error: unknown) => {
				console.warn("[sandbox] could not renew the sandbox idle timeout:", error);
			});
		};
		renew();
		// Half the idle timeout leaves room for one slow renewal without a pause.
		const timer = setInterval(renew, Math.max(1, Math.floor(lifetimeMs / 2)));
		timer.unref();
		return () => clearInterval(timer);
	}

	async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		if (isAborted(context)) return err(new ExecutionError("aborted", "Aborted"));
		const argv = Array.isArray(command) ? [...command] : undefined;
		if (argv !== undefined && argv.length === 0) {
			return err(new ExecutionError("spawn_error", "Empty argv"));
		}
		const script =
			argv === undefined ? (command as string) : `exec ${argv.map((argument) => shellQuote(argument)).join(" ")}`;
		const controller = new AbortController();
		this.#active.add(controller);
		const signals = [controller.signal];
		if (context.abortSignal !== undefined) signals.push(context.abortSignal);
		const signal = AbortSignal.any(signals);
		const env = {
			...(options?.env ?? {}),
			...(this.#agentSocket === undefined ? {} : { SSH_AUTH_SOCK: this.#agentSocket }),
		};
		let full = "";
		const stopKeepAlive = this.#startKeepAlive();
		try {
			const result = await this.handle.exec(script, {
				cwd: options?.cwd === undefined ? this.cwd : this.#absolute(options.cwd),
				...(Object.keys(env).length === 0 ? {} : { env }),
				...(options?.timeout === undefined || options.timeout <= 0 ? {} : { timeoutMs: options.timeout * 1000 }),
				signal,
				onStdout: (text) => {
					full += text;
					options?.onOutput?.(text, context, { stream: "stdout" });
				},
				onStderr: (text) => {
					full += text;
					options?.onOutput?.(text, context, { stream: "stderr" });
				},
			});
			if (isAborted(context)) return err(new ExecutionError("aborted", "Aborted"));
			if (argv !== undefined && result.exitCode === 127) {
				return err(new ExecutionError("spawn_error", `Command not found: ${argv[0] ?? ""}`));
			}
			const spillPath = options?.spill === undefined ? undefined : await this.#spill(full, options.spill, context);
			return ok({ exitCode: result.exitCode ?? 0, ...(spillPath === undefined ? {} : { spillPath }) });
		} catch (error) {
			return err(toExecutionError(error, context));
		} finally {
			stopKeepAlive?.();
			this.#active.delete(controller);
		}
	}

	/** Write the complete output to a temporary file once it crosses the spill thresholds. */
	async #spill(full: string, spill: ShellSpillOptions, context: Context): Promise<string | undefined> {
		const bytes = encoder.encode(full).length;
		const lines = full.split("\n").length - 1;
		if (bytes <= spill.afterBytes && lines <= spill.afterLines) return undefined;
		const temp = await this.createTempFile({ prefix: "harness-output", suffix: ".log" }, context);
		if (!temp.ok) return undefined;
		const written = await this.writeFile(temp.value, full, context);
		return written.ok ? temp.value : undefined;
	}

	async cleanup(_context: Context): Promise<void> {
		for (const controller of [...this.#active]) controller.abort();
		this.#active.clear();
	}
}
