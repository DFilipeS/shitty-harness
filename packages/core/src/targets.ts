import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	defineDoc,
	defineEntry,
	section,
	type ConversationId,
	type DocumentReader,
} from "@earendil-works/pi-durable";
import type { DefaultTargetConfig } from "./config.ts";

/**
 * Stored target of one session. `unset` means the session follows the current default; `local`
 * with a null path means the session's own scratch directory.
 */
export type SessionTargetState = {
	kind: "unset" | "local";
	path: string | null;
};

/**
 * Conversation-scoped document holding where a session's tools run. The environment factory and
 * the prompt section both read it; `sessions.setTarget` is the only writer.
 */
export const SessionTargetDoc = defineDoc<SessionTargetState>({
	kind: "app.session-target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ kind: "unset", path: null }),
});

/** A target ready to use: today always the local machine. */
export type ResolvedTarget = {
	kind: "local";
	path: string;
	scratch: boolean;
};

export type TargetResolutionOptions = {
	defaultTarget?: DefaultTargetConfig;
	/** Root that holds per-session scratch directories. Without it, scratch paths resolve to "". */
	workspacesDir?: string;
};

/** The scratch directory of one session; `""` when the harness has no workspaces root. */
export function scratchPath(workspacesDir: string | undefined, conversationId: ConversationId): string {
	return workspacesDir === undefined ? "" : join(workspacesDir, String(conversationId));
}

/** Where a session's tools run, following the default when the session stores none. */
export async function resolveTarget(
	read: DocumentReader,
	conversationId: ConversationId,
	context: Context,
	options: TargetResolutionOptions,
): Promise<ResolvedTarget> {
	const stored = await read.snapshot(SessionTargetDoc, conversationId, context);
	const fallback = options.defaultTarget?.path ?? null;
	const path = stored !== undefined && stored.kind === "local" ? stored.path : fallback;
	if (path !== null && path !== "") return { kind: "local", path, scratch: false };
	return { kind: "local", path: scratchPath(options.workspacesDir, conversationId), scratch: true };
}

/** A visible transcript entry recording a target change. */
export type TargetChangeData = {
	path: string;
	scratch: boolean;
};

export const TargetChangeEntry = defineEntry<TargetChangeData>("app.target");

/** The system prompt line that tells the model where its tools run. */
export function targetPrompt(target: ResolvedTarget): string {
	const note = target.scratch ? " (the session's scratch directory)" : "";
	return `Your tools run on the local machine in \`${target.path}\`${note}. Saved file paths refer to this target.`;
}

export type TargetSectionOptions = {
	workspacesDir?: string;
	defaultTarget: () => DefaultTargetConfig | undefined;
};

/** The `execution-target` prompt section: it renders only the current target, never changes it. */
export function createTargetSection(options: TargetSectionOptions) {
	return section("execution-target", async (input, context) => {
		const target = await resolveTarget(input.read, input.conversationId, context, {
			...(options.workspacesDir === undefined ? {} : { workspacesDir: options.workspacesDir }),
			defaultTarget: options.defaultTarget(),
		});
		return targetPrompt(target);
	});
}
