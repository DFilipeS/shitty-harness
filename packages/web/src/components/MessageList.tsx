import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EntryRecord, ModelInfo } from "@harness/protocol";
import { nestedToolsByParent, type LiveTool, type NestedToolView } from "../lib/live-tools.ts";
import {
	assistantError,
	assistantMessageOf,
	codemodeCalls,
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
import { ASK_USER_TOOL, questionReplyOf } from "../lib/questions.ts";
import type { SessionState } from "../lib/session-state.ts";
import { useHarness } from "../lib/store.tsx";
import {
	clampHead,
	initialHead,
	PRELOAD_PX,
	prependHead,
	trimHeadAtBottom,
} from "../lib/windowing.ts";
import { LiveMessage } from "./LiveMessage.tsx";
import {
	AssistantBubble,
	Divider,
	HiddenOutputNotice,
	QueuedMessage,
	ToolResultBubble,
	UserBubble,
} from "./MessageBubbles.tsx";

/** How close to the bottom (px) the list counts as following the newest message. */
const STICK_TO_BOTTOM_PX = 120;

export function MessageList({ session, active }: { session: SessionState; active: boolean }) {
	const { models, withdrawQueued } = useHarness();
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	// The committed entry stays hidden while the live reveal is still catching up to it.
	const entries = session.entries;
	const live = session.live;
	const visibleEntries =
		live?.entryId === undefined ? entries : entries.filter((entry) => entry.id !== live.entryId);
	const total = visibleEntries.length;
	const queue = session.queue;

	// Only the window's tail renders; the reader grows it upward as they scroll (see lib/windowing).
	const [head, setHead] = useState(() => initialHead(total));
	const effectiveHead = clampHead(head, total);
	const windowEntries = useMemo(
		() => visibleEntries.slice(effectiveHead),
		[visibleEntries, effectiveHead],
	);

	// The scroll handler runs in a rAF callback, so it reads the latest values through these refs.
	const scrollTick = useRef(0);
	const headRef = useRef(effectiveHead);
	headRef.current = effectiveHead;
	const totalRef = useRef(total);
	totalRef.current = total;
	// A prepend restores the reader's position: content was added above, so the same offset from
	// the bottom means the same message stays in view.
	const prependAnchor = useRef<{ height: number; top: number } | null>(null);

	const onScroll = useCallback(() => {
		if (scrollTick.current !== 0) return;
		scrollTick.current = requestAnimationFrame(() => {
			scrollTick.current = 0;
			const element = scrollRef.current;
			if (element === null) return;
			stickToBottom.current =
				element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX;
			const currentHead = clampHead(headRef.current, totalRef.current);
			if (element.scrollTop < PRELOAD_PX && currentHead > 0) {
				prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
				setHead(prependHead(currentHead));
			} else if (stickToBottom.current) {
				const trimmed = trimHeadAtBottom(currentHead, totalRef.current);
				if (trimmed !== currentHead) setHead(trimmed);
			}
		});
	}, []);

	useEffect(() => {
		const element = scrollRef.current;
		if (element === null) return;
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			if (scrollTick.current !== 0) cancelAnimationFrame(scrollTick.current);
			scrollTick.current = 0;
		};
	}, [onScroll]);

	// Restore the reader's position after a prepend, or follow the newest message while it streams,
	// while entries land, and when this list becomes the visible one again.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (element === null) return;
		if (prependAnchor.current !== null) {
			element.scrollTop =
				element.scrollHeight - prependAnchor.current.height + prependAnchor.current.top;
			prependAnchor.current = null;
		} else if (active && stickToBottom.current) {
			element.scrollTop = element.scrollHeight;
		}
	}, [effectiveHead, total, live, queue.length, active]);

	// Tool results render inside the call block they belong to, so pair them by tool call id and
	// remember which calls are on screen; a result without a call stays on its own. Both come from
	// the rendered window: a result whose call sits above it shows as its own bubble.
	const nestedTools = useMemo(
		() => nestedToolsByParent(session.nestedTools),
		[session.nestedTools],
	);
	const { toolResults, toolCallIds } = useMemo(() => {
		const results = new Map<string, ToolResultView>();
		const calls = new Set<string>();
		for (const entry of windowEntries) {
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
					questionReply:
						result.toolName === ASK_USER_TOOL ? questionReplyOf(result.details) : undefined,
					nestedCalls: codemodeCalls(result),
				});
			}
		}
		for (const block of live?.blocks ?? []) if (block.type === "toolCall") calls.add(block.id);
		return { toolResults: results, toolCallIds: calls };
	}, [windowEntries, live]);

	const handleReveal = useCallback(() => {
		const element = scrollRef.current;
		if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, []);

	// `overflow-anchor: none`: the list restores the scroll position itself after a prepend; with
	// the browser's own anchoring on top, the position would be adjusted twice.
	return (
		<div
			ref={scrollRef}
			data-message-scroll
			className="flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
		>
			<div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 pt-4 pb-[calc(var(--composer-height,6rem)+1.5rem)] sm:px-4 sm:pt-6">
				{head > 0 && (
					<p className="py-2 text-center text-[11px] text-fg-faint">
						Scroll up for earlier messages.
					</p>
				)}
				{windowEntries.map((entry) => (
					<EntryView
						key={entry.id}
						entry={entry}
						toolResults={toolResults}
						toolCallIds={toolCallIds}
						liveTools={session.liveTools}
						nestedTools={nestedTools}
						models={models}
					/>
				))}
				{live !== undefined && (
					<LiveMessage
						key={live.key}
						sessionId={session.id}
						message={live}
						onReveal={handleReveal}
						toolResults={toolResults}
						liveTools={session.liveTools}
						nestedTools={nestedTools}
					/>
				)}
				{queue.map((message) => (
					<QueuedMessage
						key={message.id}
						message={message}
						onRemove={() => void withdrawQueued(message.id)}
					/>
				))}
				{total === 0 && live === undefined && queue.length === 0 && (
					<p className="py-10 text-center text-sm text-fg-subtle">
						{session.attached ? "Send a message to start the conversation." : "Loading messages…"}
					</p>
				)}
			</div>
		</div>
	);
}

function EntryView({
	entry,
	toolResults,
	toolCallIds,
	liveTools,
	nestedTools,
	models,
}: {
	entry: EntryRecord;
	toolResults: ReadonlyMap<string, ToolResultView>;
	toolCallIds: ReadonlySet<string>;
	liveTools: Readonly<Record<string, LiveTool>>;
	nestedTools: Readonly<Record<string, readonly NestedToolView[]>>;
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
					liveTools={liveTools}
					nestedTools={nestedTools}
					error={assistantError(assistant)}
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
		const data = entry.data as
			| {
					kind?: unknown;
					path?: unknown;
					scratch?: unknown;
					provider?: unknown;
					providerName?: unknown;
					sandboxId?: unknown;
			  }
			| undefined;
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
						sandboxId === undefined
							? "Target: new sandbox"
							: `Target: ${provider}:${sandboxId.slice(0, 8)}`
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
