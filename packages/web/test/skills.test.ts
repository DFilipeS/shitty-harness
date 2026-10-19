import type { SkillInfo } from "@harness/protocol";
import { describe, expect, it } from "vitest";
import { parseSkillBlock, userParts } from "../src/lib/messages.ts";
import { buildSkillsPage } from "../src/lib/skill-commands.tsx";
import { completeInvocation, invokedSkill, matchSkills, skillQuery } from "../src/lib/skills.ts";

function skill(
	name: string,
	description = `${name} things`,
	overrides: Partial<SkillInfo> = {},
): SkillInfo {
	return {
		name,
		description,
		scope: "project",
		path: `/repo/.agents/skills/${name}/SKILL.md`,
		modelInvocable: true,
		mirrored: false,
		warnings: [],
		...overrides,
	};
}

describe("skillQuery", () => {
	it("opens on a leading slash while the caret is in the first token", () => {
		expect(skillQuery("/", 1)).toBe("");
		expect(skillQuery("/pdf", 4)).toBe("pdf");
		expect(skillQuery("/skill:pd", 9)).toBe("pd");
		expect(skillQuery("/skill", 6)).toBe("");
		expect(skillQuery("/skill:pdf rest", 15)).toBeUndefined();
		expect(skillQuery("hello /pdf", 10)).toBeUndefined();
	});
});

describe("matchSkills", () => {
	it("ranks name prefixes, then name substrings, then descriptions", () => {
		const skills = [
			skill("review-pdf"),
			skill("pdf"),
			skill("forms", "Fill PDF forms"),
			skill("other"),
		];
		expect(matchSkills(skills, "pdf").map((entry) => entry.name)).toEqual([
			"pdf",
			"review-pdf",
			"forms",
		]);
		expect(matchSkills(skills, "").map((entry) => entry.name)).toEqual([
			"forms",
			"other",
			"pdf",
			"review-pdf",
		]);
	});
});

describe("completeInvocation", () => {
	it("replaces the leading token and keeps the rest", () => {
		expect(completeInvocation("/pd", "pdf")).toEqual({ text: "/skill:pdf ", caret: 11 });
		expect(completeInvocation("/pd  extract tables", "pdf")).toEqual({
			text: "/skill:pdf extract tables",
			caret: 11,
		});
	});
});

describe("invokedSkill", () => {
	it("reads the invoked name", () => {
		expect(invokedSkill("/skill:pdf go")).toBe("pdf");
		expect(invokedSkill("/skill:")).toBe("");
		expect(invokedSkill("/pdf")).toBeUndefined();
	});
});

describe("parseSkillBlock", () => {
	const block = [
		'<skill name="pdf" scope="user">',
		"# PDF",
		"",
		"Use scripts/extract.py.",
		"",
		"Skill directory: /home/user/.agents/skills/pdf",
		"Relative paths in this skill are relative to the skill directory.",
		"<skill_resources>",
		"<file>scripts/extract.py</file>",
		"</skill_resources>",
		"</skill>",
	].join("\n");

	it("splits the instructions from the directory and files", () => {
		expect(parseSkillBlock(block)).toEqual({
			name: "pdf",
			scope: "user",
			instructions: "# PDF\n\nUse scripts/extract.py.",
			directory: "/home/user/.agents/skills/pdf",
			files: ["scripts/extract.py"],
		});
		expect(parseSkillBlock("plain text")).toBeUndefined();
	});

	it("shows an invocation as a skill part of the user message", () => {
		const parts = userParts({
			role: "user",
			content: [
				{ type: "text", text: block },
				{ type: "text", text: "extract the tables" },
			],
			timestamp: 1,
		});
		expect(parts.map((part) => part.type)).toEqual(["skill", "text"]);
	});
});

describe("buildSkillsPage", () => {
	it("groups skills by scope and lists the ones left out", () => {
		const page = buildSkillsPage({
			skills: [
				skill("pdf"),
				skill("mine", "Mine", {
					scope: "user",
					mirrored: true,
					modelInvocable: false,
					warnings: ["Odd name"],
				}),
			],
			issues: [
				{
					path: "/repo/.agents/skills/bad/SKILL.md",
					name: "bad",
					reason: "The frontmatter has no description",
				},
			],
		});
		if (page.kind !== "commands") throw new Error("expected a command page");
		expect(page.commands.map((command) => [command.group, command.title, command.detail])).toEqual([
			["Project skills", "pdf", "/repo/.agents/skills/pdf/SKILL.md"],
			["User skills (from this machine)", "mine", "invoke only · Odd name"],
			["Left out", "bad", "The frontmatter has no description"],
		]);
	});
});
