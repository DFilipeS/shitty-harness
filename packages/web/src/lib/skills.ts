import type { SkillInfo } from "@harness/protocol";

/** What a message starts with to invoke a skill. */
export const INVOCATION_PREFIX = "/skill:";

/**
 * The autocomplete query while the caret is in a leading `/` token, without the `skill:` prefix;
 * undefined when the popup should not open. A partly typed prefix (`/ski`) also matches skills
 * whose names contain it, and `/skill` alone lists them all.
 */
export function skillQuery(text: string, caret: number): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const tokenEnd = text.search(/\s/);
	if (tokenEnd !== -1 && caret > tokenEnd) return undefined;
	const token = text.slice(1, tokenEnd === -1 ? text.length : tokenEnd);
	if (token.startsWith("skill:")) return token.slice("skill:".length);
	if (token.length >= 2 && "skill:".startsWith(token)) return "";
	return token;
}

/** Skills matching the query: name prefix first, then a name substring, then the description. */
export function matchSkills(skills: readonly SkillInfo[], query: string): SkillInfo[] {
	const needle = query.toLowerCase();
	const ranked: { skill: SkillInfo; rank: number }[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		const rank = name.startsWith(needle)
			? 0
			: name.includes(needle)
				? 1
				: skill.description.toLowerCase().includes(needle)
					? 2
					: undefined;
		if (rank !== undefined) ranked.push({ skill, rank });
	}
	return ranked
		.sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
		.map((entry) => entry.skill);
}

/** Replace the leading token with a complete invocation, keeping the rest of the message. */
export function completeInvocation(text: string, name: string): { text: string; caret: number } {
	const tokenEnd = text.search(/\s/);
	const rest = tokenEnd === -1 ? "" : text.slice(tokenEnd).replace(/^[ \t]+/, "");
	const head = `${INVOCATION_PREFIX}${name} `;
	return { text: `${head}${rest}`, caret: head.length };
}

/** The skill a message invokes, when it starts with `/skill:`; `""` when no name follows yet. */
export function invokedSkill(text: string): string | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(INVOCATION_PREFIX)) return undefined;
	return /^\S*/.exec(trimmed.slice(INVOCATION_PREFIX.length))?.[0] ?? "";
}
