import { section } from "@earendil-works/pi-durable";
import { PRODUCT_NAME } from "@harness/protocol";
import type { DefaultTargetConfig } from "./config.ts";
import { resolveTarget } from "./targets.ts";

export type AgentGuidanceOptions = {
	workspacesDir?: string;
	defaultTarget: () => DefaultTargetConfig | undefined;
	sandboxDefaults: () => {
		provider: string;
		template?: string;
		workspaceDir?: string;
		forwardAgent?: boolean;
	};
};

const IDENTITY = `You are an expert coding agent operating inside ${PRODUCT_NAME}, a durable coding agent harness. You help the user by reading files, executing commands, editing code, and writing new files.`;

const RULES = [
	"Use bash for file operations like ls, rg, and find; there are no dedicated search tools.",
	"Read a file before editing it; make targeted edits rather than rewriting whole files.",
	"Show file paths clearly when working with files, with line numbers where possible.",
	"Be concise: summarize what you did and what changed; do not dump file contents you read unless asked.",
];

/** The one rule that varies with the target: care on the user's machine, freedom in a sandbox. */
const LOCAL_TARGET_RULE =
	"Your tools run on the user's local machine: prefer asking before destructive commands there.";
const SANDBOX_TARGET_RULE = "Your tools run in a sandbox you may freely experiment in.";

const QUESTION_RULE =
	"Ask with ask_user when a wrong guess would waste significant work or touch something hard to undo; otherwise proceed and state your assumptions.";

/**
 * The `agent` prompt section: the general guidance every conversation starts with — identity,
 * tool rules, output style, and question policy. Installed first, so it renders before the
 * target and skills sections. Code owns the text; pi-durable's reserved `instructions` field
 * stays free for future per-session customization.
 */
export function createAgentGuidanceSection(options: AgentGuidanceOptions) {
	return section("agent", async (input, context) => {
		const target = await resolveTarget(input.read, input.conversationId, context, {
			...(options.workspacesDir === undefined ? {} : { workspacesDir: options.workspacesDir }),
			defaultTarget: options.defaultTarget(),
			sandboxDefaults: options.sandboxDefaults(),
		});
		const targetRule = target.kind === "sandbox" ? SANDBOX_TARGET_RULE : LOCAL_TARGET_RULE;
		return [
			IDENTITY,
			"",
			...RULES.map((rule) => `- ${rule}`),
			`- ${targetRule}`,
			`- ${QUESTION_RULE}`,
		].join("\n");
	});
}
