import { parse as parseYaml } from "yaml";

/** Spec limits; going over them only warns, so skills written for other clients still load. */
const NAME_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One `SKILL.md`, parsed. */
export type ParsedSkill = {
	name: string;
	description: string;
	/** The Markdown after the frontmatter, trimmed. */
	body: string;
	/** False when the frontmatter sets Claude Code's `disable-model-invocation: true`. */
	modelInvocable: boolean;
	/** `allowed-tools`, kept for display; the harness does not enforce it. */
	allowedTools?: string;
	compatibility?: string;
	license?: string;
	/** Problems that did not stop the skill from loading. */
	warnings: string[];
};

export type ParseSkillResult = { ok: true; skill: ParsedSkill } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Split `---` frontmatter from the body; undefined when the file has none. */
function splitFrontmatter(text: string): { yaml: string; body: string } | undefined {
	const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
	const match = /^---[ \t]*\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(normalized);
	if (match === null) return undefined;
	return { yaml: match[1] ?? "", body: normalized.slice(match[0].length).trim() };
}

/**
 * Quote plain scalar values that contain `: `, the most common YAML mistake in skills written for
 * parsers that accept it (`description: Use when: the user asks`).
 */
function quoteColonValues(yaml: string): string {
	return yaml
		.split("\n")
		.map((line) => {
			const match = /^([A-Za-z0-9_-]+):[ \t]+(.+)$/.exec(line);
			if (match === null) return line;
			const [, key, value] = match;
			if (key === undefined || value === undefined) return line;
			if (!value.includes(": ") || /^["'|>[{]/.test(value)) return line;
			return `${key}: ${JSON.stringify(value)}`;
		})
		.join("\n");
}

function parseFrontmatter(yaml: string): Record<string, unknown> | undefined {
	for (const candidate of [yaml, quoteColonValues(yaml)]) {
		try {
			const value: unknown = parseYaml(candidate);
			if (isRecord(value)) return value;
		} catch {
			// Try the repaired form next.
		}
	}
	return undefined;
}

function stringField(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

/**
 * Parse a `SKILL.md` leniently, as the Agent Skills client guide recommends: cosmetic problems warn,
 * and only a missing description or unreadable frontmatter skips the skill. `directoryName` is the
 * skill's folder, which names the skill when the frontmatter does not.
 */
export function parseSkill(text: string, directoryName: string): ParseSkillResult {
	const split = splitFrontmatter(text);
	if (split === undefined) return { ok: false, reason: "SKILL.md has no YAML frontmatter" };
	const frontmatter = parseFrontmatter(split.yaml);
	if (frontmatter === undefined) return { ok: false, reason: "The frontmatter is not valid YAML" };

	const description = stringField(frontmatter.description);
	if (description === undefined) return { ok: false, reason: "The frontmatter has no description" };

	const warnings: string[] = [];
	let name = stringField(frontmatter.name);
	if (name === undefined) {
		warnings.push(`No name in the frontmatter; using the folder name "${directoryName}"`);
		name = directoryName;
	} else if (name !== directoryName) {
		warnings.push(`The name "${name}" does not match its folder "${directoryName}"`);
	}
	if (name.length > NAME_MAX_LENGTH) warnings.push(`The name is longer than ${NAME_MAX_LENGTH} characters`);
	if (!NAME_PATTERN.test(name)) {
		warnings.push("The name should use only lowercase letters, digits, and single hyphens");
	}
	if (description.length > DESCRIPTION_MAX_LENGTH) {
		warnings.push(`The description is longer than ${DESCRIPTION_MAX_LENGTH} characters`);
	}

	const allowedTools = stringField(frontmatter["allowed-tools"]);
	const compatibility = stringField(frontmatter.compatibility);
	const license = stringField(frontmatter.license);
	return {
		ok: true,
		skill: {
			name,
			description,
			body: split.body,
			modelInvocable: frontmatter["disable-model-invocation"] !== true,
			...(allowedTools === undefined ? {} : { allowedTools }),
			...(compatibility === undefined ? {} : { compatibility }),
			...(license === undefined ? {} : { license }),
			warnings,
		},
	};
}
