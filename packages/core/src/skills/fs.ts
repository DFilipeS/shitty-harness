import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path/posix";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";

/** One directory entry, as skill discovery and mirroring need it. */
export type SkillDirEntry = {
	name: string;
	kind: "file" | "directory" | "symlink";
	size: number;
};

/**
 * The few file operations skill discovery needs. The host's skills are read with Node directly; a
 * sandbox's go through its `ExecutionEnv`. Every method answers `undefined` instead of failing.
 */
export interface SkillFs {
	list(path: string): Promise<SkillDirEntry[] | undefined>;
	readText(path: string): Promise<string | undefined>;
	readBytes(path: string): Promise<Uint8Array | undefined>;
	realPath(path: string): Promise<string | undefined>;
	isDirectory(path: string): Promise<boolean>;
}

/** This machine's files. Used for local targets too, so scanning never creates a scratch directory. */
export const hostSkillFs: SkillFs = {
	async list(path) {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return Promise.all(
				entries.map(async (entry): Promise<SkillDirEntry> => {
					const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
					const size = kind === "file" ? ((await stat(join(path, entry.name)).catch(() => undefined))?.size ?? 0) : 0;
					return { name: entry.name, kind, size };
				}),
			);
		} catch {
			return undefined;
		}
	},
	async readText(path) {
		return readFile(path, "utf8").catch(() => undefined);
	},
	async readBytes(path) {
		return readFile(path).then(
			(buffer) => new Uint8Array(buffer),
			() => undefined,
		);
	},
	async realPath(path) {
		return realpath(path).catch(() => undefined);
	},
	async isDirectory(path) {
		return (await stat(path).catch(() => undefined))?.isDirectory() === true;
	},
};

function entryOf(info: FileInfo): SkillDirEntry {
	return { name: info.name, kind: info.kind, size: info.size };
}

/** A target's files through its execution environment, e.g. a sandbox's. */
export function envSkillFs(env: ExecutionEnv, context: Context): SkillFs {
	return {
		async list(path) {
			const result = await env.listDir(path, context);
			return result.ok ? result.value.map(entryOf) : undefined;
		},
		async readText(path) {
			const result = await env.readTextFile(path, context);
			return result.ok ? result.value : undefined;
		},
		async readBytes(path) {
			const result = await env.readBinaryFile(path, context);
			return result.ok ? result.value : undefined;
		},
		async realPath(path) {
			const result = await env.canonicalPath(path, context);
			return result.ok ? result.value : undefined;
		},
		async isDirectory(path) {
			const result = await env.fileInfo(path, context);
			if (!result.ok) return false;
			if (result.value.kind === "directory") return true;
			if (result.value.kind !== "symlink") return false;
			const listed = await env.listDir(path, context);
			return listed.ok;
		},
	};
}

/** The environment's home directory, from its shell. */
export async function envHome(env: ExecutionEnv, context: Context): Promise<string | undefined> {
	let output = "";
	const result = await env.exec(
		'printf %s "$HOME"',
		{
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") output += text;
			},
		},
		context,
	);
	if (!result.ok || result.value.exitCode !== 0) return undefined;
	const home = output.trim();
	return home === "" ? undefined : home;
}
