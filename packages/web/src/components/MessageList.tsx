import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EntryRecord, ModelInfo } from "@harness/protocol";
import {
	assistantMessageOf,
	generatedImageInfo,
	hasHiddenOutput,
	toolResultImages,
	toolResultOf,
	toolResultText,
	toLiveBlock,
	userMessageOf,
	userParts,
	type ToolResultView,
} from "../lib/messages.ts";
import { useHarness } from "../lib/store.tsx";
import { LiveMessage } from "./LiveMessage.tsx";
import {
	AssistantBubble,
	Divider,
	HiddenOutputNotice,
	ToolResultBubble,
	UserBubble,
} from "./MessageBubbles.tsx";

export function MessageList() {
	const { activeSession, models } = useHarness();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null) return;
		const onScroll = () => {
			stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
		};
		element.addEventListener("scroll", onScroll);
		return () => element.removeEventListener("scroll", onScroll);
	}, []);

	const live = activeSession?.live;
	const entries = activeSession?.entries ?? [];
	// The committed entry stays hidden while the live reveal is still catching up to it.
	const visibleEntries = live?.entryId === undefined ? entries : entries.filter((entry) => entry.id !== live.entryId);

	// Tool results render inside the call block they belong to, so pair them by tool call id and
	// remember which calls are on screen; a result without a call stays on its own.
	const { toolResults, toolCallIds } = useMemo(() => {
		const results = new Map<string, ToolResultView>();
		const calls = new Set<string>();
		for (const entry of entries) {
			const assistant = assistantMessageOf(entry);
			if (assistant !== undefined) {
				for (const block of assistant.content) if (block.type === "toolCall") calls.add(block.id);
			}
			const result = toolResultOf(entry);
			if (result !== undefined) {
				results.set(result.toolCallId, {
					text: toolResultText(result),
					images: toolResultImages(result),
					isError: result.isError === true,
					imageModel: generatedImageInfo(result),
				});
			}
		}
		for (const block of live?.blocks ?? []) if (block.type === "toolCall") calls.add(block.id);
		return { toolResults: results, toolCallIds: calls };
	}, [entries, live]);

	useEffect(() => {
		const element = scrollRef.current;
		if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, [entries.length, live]);

	const handleReveal = useCallback(() => {
		const element = scrollRef.current;
		if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, []);

	return (
		<div ref={scrollRef} data-message-scroll className="flex-1 overflow-y-auto overscroll-contain">
			<div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 pt-4 pb-[calc(var(--composer-height,6rem)+1.5rem)] sm:px-4 sm:pt-6">
				{visibleEntries.map((entry) => (
					<EntryView
						key={entry.id}
						entry={entry}
						toolResults={toolResults}
						toolCallIds={toolCallIds}
						models={models}
					/>
				))}
				{live !== undefined && activeSession !== undefined && (
					<LiveMessage
						key={live.key}
						sessionId={activeSession.id}
						message={live}
						onReveal={handleReveal}
						toolResults={toolResults}
					/>
				)}
				{entries.length === 0 && live === undefined && (
					<p className="py-10 text-center text-sm text-fg-subtle">Send a message to start the conversation.</p>
				)}
			</div>
		</div>
	);
}

function EntryView({
	entry,
	toolResults,
	toolCallIds,
	models,
}: {
	entry: EntryRecord;
	toolResults: ReadonlyMap<string, ToolResultView>;
	toolCallIds: ReadonlySet<string>;
	models: readonly ModelInfo[];
}) {
	const user = userMessageOf(entry);
	if (user !== undefined) return <UserBubble parts={userParts(user)} />;

	const assistant = assistantMessageOf(entry);
	if (assistant !== undefined) {
		return (
			<>
				<AssistantBubble
					messageKey={String(assistant.timestamp)}
					blocks={assistant.content.map(toLiveBlock)}
					usage={assistant.usage}
					toolResults={toolResults}
				/>
				{hasHiddenOutput(assistant, models) && <HiddenOutputNotice />}
			</>
		);
	}

	const toolResult = toolResultOf(entry);
	if (toolResult !== undefined) {
		// A result with a call on screen lives inside that call's block.
		if (toolCallIds.has(toolResult.toolCallId)) return null;
		return (
			<ToolResultBubble
				text={toolResultText(toolResult)}
				images={toolResultImages(toolResult)}
				isError={toolResult.isError === true}
			/>
		);
	}

	if (entry.kind === "app.target") {
		const data = entry.data as {
			kind?: unknown;
			path?: unknown;
			scratch?: unknown;
			provider?: unknown;
			providerName?: unknown;
			sandboxId?: unknown;
		} | undefined;
		if (data?.kind === "sandbox") {
			const provider =
				typeof data.providerName === "string"
					? data.providerName
					: typeof data.provider === "string"
						? data.provider
						: "sandbox";
			const sandboxId = typeof data.sandboxId === "string" ? data.sandboxId : undefined;
			return (
				<Divider
					label={
						sandboxId === undefined ? "Target: new sandbox" : `Target: ${provider}:${sandboxId.slice(0, 8)}`
					}
				/>
			);
		}
		const scratch = data?.scratch === true;
		const path = typeof data?.path === "string" ? data.path : "";
		return <Divider label={`Target: ${scratch ? "scratch directory" : path}`} />;
	}
	if (entry.kind === "pi.compaction") return <Divider label="Context compacted" />;
	if (entry.kind === "pi.reset") return <Divider label="Context reset" />;
	return null;
}
