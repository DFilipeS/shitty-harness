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
import type { SandboxSource } from "./sandboxes/provider.ts";
import { DEFAULT_SANDBOX_WORKSPACE } from "./sandboxes/settings.ts";

/** The stored sandbox binding of one session, before or after the sandbox exists. */
export type SandboxTargetState = {
	provider: string;
	sandboxId: string | null;
	name: string | null;
	template: string | null;
	sourceKind: "empty" | "git" | null;
	sourceUrl: string | null;
	workspaceDir: string;
	/** null follows the stored setting; true forwards the host SSH agent. */
	forwardAgent: boolean | null;
};

/**
 * Stored target of one session. `unset` means the session follows the current default; `local`
 * with a null path means the session's own scratch directory; `sandbox` carries its binding.
 */
export type SessionTargetState = {
	kind: "unset" | "local" | "sandbox";
	path: string | null;
	sandbox: SandboxTargetState | null;
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
	initial: () => ({ kind: "unset", path: null, sandbox: null }),
});

/** A target ready to use. */
export type ResolvedTarget =
	| { kind: "local"; path: string; scratch: boolean }
	| {
			kind: "sandbox";
			provider: string;
			sandboxId?: string;
			name?: string;
			template?: string;
			source?: SandboxSource;
			workspaceDir: string;
			/** Whether this sandbox forwards the host SSH agent. */
			forwardAgent: boolean;
		};

export type TargetResolutionOptions = {
	defaultTarget?: DefaultTargetConfig;
	/** Root that holds per-session scratch directories. Without it, scratch paths resolve to "". */
	workspacesDir?: string;
	/** Defaults for a default-target sandbox that names no provider or workspace of its own. */
	sandboxDefaults?: { provider: string; template?: string; workspaceDir?: string; forwardAgent?: boolean };
};

/** The stored state for a sandbox target. */
export function sandboxTargetState(target: {
	provider: string;
	sandboxId?: string;
	name?: string;
	template?: string;
	source?: SandboxSource;
	workspaceDir: string;
	forwardAgent?: boolean;
}): SandboxTargetState {
	return {
		provider: target.provider,
		sandboxId: target.sandboxId ?? null,
		name: target.name ?? null,
		template: target.template ?? null,
		sourceKind: target.source?.kind ?? null,
		sourceUrl: target.source?.kind === "git" ? target.source.url : null,
		workspaceDir: target.workspaceDir,
		forwardAgent: target.forwardAgent ?? null,
	};
}

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
	if (stored?.kind === "sandbox" && stored.sandbox !== null) return sandboxFromState(stored.sandbox);
	if (stored?.kind === "local") return localFromPath(stored.path, options.workspacesDir, conversationId);
	if (options.defaultTarget?.kind === "sandbox") {
		return {
			kind: "sandbox",
			provider: options.sandboxDefaults?.provider ?? "e2b",
			...(options.sandboxDefaults?.template === undefined ? {} : { template: options.sandboxDefaults.template }),
			workspaceDir: options.sandboxDefaults?.workspaceDir ?? DEFAULT_SANDBOX_WORKSPACE,
			forwardAgent: options.sandboxDefaults?.forwardAgent ?? true,
		};
	}
	return localFromPath(options.defaultTarget?.path ?? null, options.workspacesDir, conversationId);
}

function localFromPath(
	path: string | null,
	workspacesDir: string | undefined,
	conversationId: ConversationId,
): ResolvedTarget {
	if (path !== null && path !== "") return { kind: "local", path, scratch: false };
	return { kind: "local", path: scratchPath(workspacesDir, conversationId), scratch: true };
}

function sandboxFromState(state: SandboxTargetState): ResolvedTarget {
	return {
		kind: "sandbox",
		provider: state.provider,
		...(state.sandboxId === null ? {} : { sandboxId: state.sandboxId }),
		...(state.name === null ? {} : { name: state.name }),
		...(state.template === null ? {} : { template: state.template }),
		...(state.sourceKind === null
			? {}
			: { source: state.sourceKind === "git" && state.sourceUrl !== null ? { kind: "git", url: state.sourceUrl } : { kind: "empty" } }),
		workspaceDir: state.workspaceDir,
		forwardAgent: state.forwardAgent ?? true,
	};
}

/** A visible transcript entry recording a target change. */
export type TargetChangeData = {
	kind: "local" | "sandbox";
	path: string;
	scratch: boolean;
	provider?: string;
	/** Human-readable provider name, e.g. "E2B". */
	providerName?: string;
	sandboxId?: string;
	name?: string;
	/** Whether the sandbox forwards the host SSH agent. */
	forwardAgent?: boolean;
};

export const TargetChangeEntry = defineEntry<TargetChangeData>("app.target");

/** The system prompt line that tells the model where its tools run. */
export function targetPrompt(target: ResolvedTarget, providerName?: string): string {
	if (target.kind === "sandbox") {
		const name = providerName ?? target.provider;
		const where = target.sandboxId === undefined ? "a new sandbox" : `sandbox ${name}:${target.sandboxId}`;
		const agent = target.forwardAgent ? " The host SSH agent is forwarded, so `git` over SSH works." : "";
		return `Your tools run in the remote ${where} at \`${target.workspaceDir}\`. Saved file paths refer to this target.${agent}`;
	}
	const note = target.scratch ? " (the session's scratch directory)" : "";
	return `Your tools run on the local machine in \`${target.path}\`${note}. Saved file paths refer to this target.`;
}

export type TargetSectionOptions = {
	workspacesDir?: string;
	defaultTarget: () => DefaultTargetConfig | undefined;
	sandboxDefaults: () => { provider: string; template?: string; workspaceDir?: string; forwardAgent?: boolean };
	/** Human-readable provider name for the prompt. */
	providerName?: (provider: string) => string;
};

/** The `execution-target` prompt section: it renders only the current target, never changes it. */
export function createTargetSection(options: TargetSectionOptions) {
	return section("execution-target", async (input, context) => {
		const target = await resolveTarget(input.read, input.conversationId, context, {
			...(options.workspacesDir === undefined ? {} : { workspacesDir: options.workspacesDir }),
			defaultTarget: options.defaultTarget(),
			sandboxDefaults: options.sandboxDefaults(),
		});
		return targetPrompt(target, target.kind === "sandbox" ? options.providerName?.(target.provider) : undefined);
	});
}
