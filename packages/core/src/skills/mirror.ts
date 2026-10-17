import { createHash } from "node:crypto";
import { join } from "node:path/posix";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Skill, SkillIssue } from "./discover.ts";
import type { SkillFs } from "./fs.ts";

/** The manifest the harness keeps in the sandbox's skills directory. See ADR 0005. */
export const MIRROR_MANIFEST = ".harness-mirror.json";
export const MAX_MIRROR_SKILL_BYTES = 10 * 1024 * 1024;
export const MAX_MIRROR_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_WALK_DEPTH = 6;
const SKIPPED_NAMES = new Set(["node_modules"]);

/** The folders the harness wrote, with the content hash each was written from. */
type MirrorManifest = {
	version: 1;
	skills: Record<string, string>;
};

/** One file of a skill, relative to the skill's directory. */
type SkillFile = {
	path: string;
	size: number;
};

/**
 * The files of one skill directory, skipping dotfiles, `.git`, and `node_modules`. Symlinked
 * directories are not followed, so a link cycle cannot run away.
 */
export async function listSkillFiles(fs: SkillFs, dir: string, limit = Number.POSITIVE_INFINITY): Promise<SkillFile[]> {
	const files: SkillFile[] = [];
	const walk = async (relative: string, depth: number): Promise<void> => {
		if (depth > MAX_WALK_DEPTH || files.length >= limit) return;
		const entries = await fs.list(relative === "" ? dir : join(dir, relative));
		if (entries === undefined) return;
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			if (files.length >= limit) return;
			if (entry.name.startsWith(".") || SKIPPED_NAMES.has(entry.name)) continue;
			const path = relative === "" ? entry.name : join(relative, entry.name);
			if (entry.kind === "directory") await walk(path, depth + 1);
			else if (entry.kind === "file") files.push({ path, size: entry.size });
			else if (!(await fs.isDirectory(join(dir, path)))) files.push({ path, size: entry.size });
		}
	};
	await walk("", 0);
	return files;
}

function parseManifest(text: string | undefined): MirrorManifest {
	if (text === undefined) return { version: 1, skills: {} };
	try {
		const value = JSON.parse(text) as Partial<MirrorManifest>;
		const skills: Record<string, string> = {};
		if (typeof value.skills === "object" && value.skills !== null) {
			for (const [name, hash] of Object.entries(value.skills)) if (typeof hash === "string") skills[name] = hash;
		}
		return { version: 1, skills };
	} catch {
		return { version: 1, skills: {} };
	}
}

export type MirrorResult = {
	/** Names of the skills the mirror holds after this sync. */
	mirrored: string[];
	issues: SkillIssue[];
};

type PreparedSkill = {
	skill: Skill;
	files: { path: string; content: Uint8Array }[];
	hash: string;
};

async function prepare(host: SkillFs, skill: Skill): Promise<PreparedSkill | SkillIssue> {
	const listed = await listSkillFiles(host, skill.realDir);
	const size = listed.reduce((sum, file) => sum + file.size, 0);
	if (size > MAX_MIRROR_SKILL_BYTES) {
		return { path: skill.path, name: skill.name, reason: "Not mirrored into the sandbox: the skill is over 10 MB" };
	}
	const hash = createHash("sha256");
	const files: PreparedSkill["files"] = [];
	for (const file of listed) {
		const content = await host.readBytes(join(skill.realDir, file.path));
		if (content === undefined) continue;
		hash.update(file.path).update("\0").update(content).update("\0");
		files.push({ path: file.path, content });
	}
	return { skill, files, hash: hash.digest("hex") };
}

/**
 * Mirror the host's user skills into a sandbox's skills directory (ADR 0005). Only folders the
 * manifest lists are ever written or removed; a folder of the same name that the sandbox already
 * has wins, and the host skill is reported instead. Unchanged skills cost nothing but the manifest
 * read.
 */
export async function mirrorSkills(
	host: SkillFs,
	skills: readonly Skill[],
	target: ExecutionEnv,
	targetDir: string,
	context: Context,
): Promise<MirrorResult> {
	const issues: SkillIssue[] = [];
	const manifestPath = join(targetDir, MIRROR_MANIFEST);
	const manifestText = await target.readTextFile(manifestPath, context);
	const manifest = parseManifest(manifestText.ok ? manifestText.value : undefined);
	const listing = await target.listDir(targetDir, context);
	const existing = new Set(listing.ok ? listing.value.map((entry) => entry.name) : []);

	const next: Record<string, string> = {};
	let total = 0;
	let changed = false;
	for (const skill of skills) {
		const owned = manifest.skills[skill.name] !== undefined;
		if (existing.has(skill.name) && !owned) {
			issues.push({
				path: skill.path,
				name: skill.name,
				reason: "Not mirrored: the sandbox has its own skill with this name",
			});
			continue;
		}
		const prepared = await prepare(host, skill);
		if (!("hash" in prepared)) {
			issues.push(prepared);
			continue;
		}
		const size = prepared.files.reduce((sum, file) => sum + file.content.byteLength, 0);
		if (total + size > MAX_MIRROR_TOTAL_BYTES) {
			issues.push({ path: skill.path, name: skill.name, reason: "Not mirrored: the mirror is over 50 MB" });
			continue;
		}
		total += size;
		if (manifest.skills[skill.name] === prepared.hash && existing.has(skill.name)) {
			next[skill.name] = prepared.hash;
			continue;
		}
		changed = true;
		const dir = join(targetDir, skill.name);
		if (existing.has(skill.name)) await target.remove(dir, { recursive: true, force: true }, context);
		// Record the folder before writing into it, so a failed write is still cleaned up next time.
		next[skill.name] = "";
		const written = await writeSkill(target, dir, prepared, context);
		if (written) next[skill.name] = prepared.hash;
		else issues.push({ path: skill.path, name: skill.name, reason: "Could not copy the skill into the sandbox" });
	}

	for (const name of Object.keys(manifest.skills)) {
		if (next[name] !== undefined) continue;
		changed = true;
		await target.remove(join(targetDir, name), { recursive: true, force: true }, context);
	}

	if (changed) {
		const content = `${JSON.stringify({ version: 1, skills: next } satisfies MirrorManifest, null, "\t")}\n`;
		await target.createDir(targetDir, { recursive: true }, context);
		await target.writeFile(manifestPath, content, context);
	}
	return { mirrored: Object.keys(next).filter((name) => next[name] !== ""), issues };
}

async function writeSkill(target: ExecutionEnv, dir: string, prepared: PreparedSkill, context: Context): Promise<boolean> {
	const dirs = new Set<string>([dir]);
	for (const file of prepared.files) {
		const parts = file.path.split("/").slice(0, -1);
		for (let index = 1; index <= parts.length; index++) dirs.add(join(dir, ...parts.slice(0, index)));
	}
	for (const path of [...dirs].sort((a, b) => a.length - b.length)) {
		const created = await target.createDir(path, { recursive: true }, context);
		if (!created.ok) return false;
	}
	for (const file of prepared.files) {
		const written = await target.writeFile(join(dir, file.path), file.content, context);
		if (!written.ok) return false;
	}
	return true;
}
