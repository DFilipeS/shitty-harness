import type { SessionsSkillsResult, SkillInfo } from "@harness/protocol";
import type { Command, CommandPage } from "./commands.tsx";
import { useHarness } from "./store.tsx";
import { BookIcon } from "../components/icons.tsx";

function skillGroup(skill: SkillInfo): string {
	if (skill.scope === "project") return "Project skills";
	return skill.mirrored ? "User skills (from this machine)" : "User skills";
}

function skillDetail(skill: SkillInfo): string {
	const notes: string[] = [];
	if (!skill.modelInvocable) notes.push("invoke only");
	notes.push(...skill.warnings);
	return notes.join(" · ");
}

/**
 * The session's skills and the ones left out, read-only: what the agent can activate, where each
 * comes from, and why a skill is missing.
 */
export function buildSkillsPage(result: SessionsSkillsResult | undefined): CommandPage {
	if (result === undefined) {
		return {
			kind: "commands",
			title: "Skills",
			commands: [
				{
					id: "skills.error",
					title: "Could not list the skills",
					group: "Skills",
					keepOpen: true,
					run: () => {},
				},
			],
		};
	}
	const commands: Command[] = result.skills.map((skill) => ({
		id: `skills.skill.${skill.scope}.${skill.name}`,
		title: skill.name,
		group: skillGroup(skill),
		keywords: [skill.description, skill.path],
		detail: skillDetail(skill) || skill.path,
		icon: <BookIcon />,
		keepOpen: true,
		run: () => {},
	}));
	result.issues.forEach((issue, index) => {
		commands.push({
			id: `skills.issue.${index}`,
			title: issue.name ?? issue.path,
			group: "Left out",
			keywords: [issue.path, issue.reason],
			detail: issue.reason,
			keepOpen: true,
			run: () => {},
		});
	});
	if (commands.length === 0) {
		commands.push({
			id: "skills.none",
			title: "No skills found",
			group: "Skills",
			detail: "Add one under .agents/skills/<name>/SKILL.md",
			keepOpen: true,
			run: () => {},
		});
	}
	return { kind: "commands", title: "Skills", placeholder: "Search skills…", commands };
}

/** Opens the Skills page for the open session. */
export function useSkillsPalette() {
	const { activeSessionId, listSkills } = useHarness();
	return {
		page(): CommandPage | undefined {
			const id = activeSessionId;
			if (id === undefined) return undefined;
			return {
				kind: "loading",
				title: "Skills",
				load: async () => buildSkillsPage(await listSkills(id)),
			};
		},
	};
}
