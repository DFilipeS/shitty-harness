import { join } from "node:path/posix";
import type { SkillFs } from "./fs.ts";
import { parseSkill, type ParsedSkill } from "./parse.ts";

/** Most skills one skills directory may hold; the rest are reported, not loaded. */
export const MAX_SKILLS_PER_DIR = 500;

/** Project skills come from the workspace; user skills from the target's home. */
export type SkillScope = "project" | "user";

/** A directory that holds skills, one per subdirectory. */
export type SkillRoot = {
	dir: string;
	scope: SkillScope;
};

/** A skill found on a target. */
export type Skill = ParsedSkill & {
	scope: SkillScope;
	/** The skill's `SKILL.md`, as the target sees it. */
	path: string;
	/** The skill's directory, as the target sees it. */
	dir: string;
	/** The directory with symlinks resolved, so one skill reached twice counts once. */
	realDir: string;
	/** True when the harness mirrored this skill from the host into a sandbox. */
	mirrored?: boolean;
};

/** A skill that was skipped or shadowed, and why. */
export type SkillIssue = {
	path: string;
	name?: string;
	reason: string;
};

/** The skills available on one target, in precedence order, and what was left out. */
export type SkillCatalog = {
	skills: Skill[];
	issues: SkillIssue[];
};

export const EMPTY_CATALOG: SkillCatalog = { skills: [], issues: [] };

/** The four conventional skill directories, project before user and `.agents` before `.claude`. */
export function skillRoots(workspace: string | undefined, home: string | undefined): SkillRoot[] {
	const roots: SkillRoot[] = [];
	if (workspace !== undefined && workspace !== "") {
		roots.push({ dir: join(workspace, ".agents", "skills"), scope: "project" });
		roots.push({ dir: join(workspace, ".claude", "skills"), scope: "project" });
	}
	if (home !== undefined && home !== "") {
		roots.push({ dir: join(home, ".agents", "skills"), scope: "user" });
		roots.push({ dir: join(home, ".claude", "skills"), scope: "user" });
	}
	return roots;
}

type Candidate = { skill: Skill } | { issue: SkillIssue };

/** Every `<root>/<name>/SKILL.md` of one root. A missing root is simply empty. */
async function scanRoot(fs: SkillFs, root: SkillRoot): Promise<Candidate[]> {
	const entries = await fs.list(root.dir);
	if (entries === undefined) return [];
	const realRoot = (await fs.realPath(root.dir)) ?? root.dir;
	const folders = entries
		.filter((entry) => entry.kind !== "file" && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	const candidates: Candidate[] = [];
	if (folders.length > MAX_SKILLS_PER_DIR) {
		candidates.push({
			issue: {
				path: root.dir,
				reason: `Only the first ${MAX_SKILLS_PER_DIR} of ${folders.length} skills in this folder are loaded`,
			},
		});
	}
	const scanned = await Promise.all(
		folders.slice(0, MAX_SKILLS_PER_DIR).map(async (entry): Promise<Candidate | undefined> => {
			const dir = join(root.dir, entry.name);
			const path = join(dir, "SKILL.md");
			let realDir = join(realRoot, entry.name);
			if (entry.kind === "symlink") {
				if (!(await fs.isDirectory(dir))) return undefined;
				realDir = (await fs.realPath(dir)) ?? realDir;
			}
			const text = await fs.readText(path);
			if (text === undefined) return undefined;
			const parsed = parseSkill(text, entry.name);
			if (!parsed.ok) return { issue: { path, name: entry.name, reason: parsed.reason } };
			return { skill: { ...parsed.skill, scope: root.scope, path, dir, realDir } };
		}),
	);
	for (const candidate of scanned) if (candidate !== undefined) candidates.push(candidate);
	return candidates;
}

/**
 * Find the skills under `roots`, which come in precedence order. A skill whose name is already
 * taken is shadowed and reported; one whose directory was already seen through another path (a
 * symlink) is dropped silently.
 */
export async function discoverSkills(
	fs: SkillFs,
	roots: readonly SkillRoot[],
): Promise<SkillCatalog> {
	const scanned = await Promise.all(roots.map((root) => scanRoot(fs, root)));
	return mergeCandidates(scanned.flat());
}

function mergeCandidates(candidates: readonly Candidate[]): SkillCatalog {
	const skills: Skill[] = [];
	const issues: SkillIssue[] = [];
	const byName = new Map<string, Skill>();
	const seenDirs = new Set<string>();
	for (const candidate of candidates) {
		if ("issue" in candidate) {
			issues.push(candidate.issue);
			continue;
		}
		const { skill } = candidate;
		if (seenDirs.has(skill.realDir)) continue;
		seenDirs.add(skill.realDir);
		const winner = byName.get(skill.name);
		if (winner !== undefined) {
			issues.push({ path: skill.path, name: skill.name, reason: `Shadowed by ${winner.path}` });
			continue;
		}
		byName.set(skill.name, skill);
		skills.push(skill);
	}
	return { skills, issues };
}

/** Merge catalogs in precedence order, as if their skills had been found together. */
export function mergeCatalogs(catalogs: readonly SkillCatalog[]): SkillCatalog {
	const merged = mergeCandidates(
		catalogs.flatMap((catalog) => catalog.skills.map((skill) => ({ skill }))),
	);
	return {
		skills: merged.skills,
		issues: [...catalogs.flatMap((catalog) => catalog.issues), ...merged.issues],
	};
}
