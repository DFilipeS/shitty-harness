import { useCallback, useEffect, useRef } from "react";
import type { EntryRecord } from "@harness/protocol";
import {
	assistantMessageOf,
	toolResultOf,
	toolResultText,
	toLiveBlock,
	userMessageOf,
	userText,
} from "../lib/messages.ts";
import { useHarness } from "../lib/store.tsx";
import { LiveMessage } from "./LiveMessage.tsx";
import { AssistantBubble, Divider, ToolResultBubble, UserBubble } from "./MessageBubbles.tsx";

export function MessageList() {
	const { activeSession } = useHarness();
	const scrollRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
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

	useEffect(() => {
		if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
	}, [entries.length, live]);

	const handleReveal = useCallback(() => {
		const element = scrollRef.current;
		if (element !== null && stickToBottom.current) element.scrollTop = element.scrollHeight;
	}, []);

	return (
		<div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
			<div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-4 sm:px-4 sm:py-6">
				{visibleEntries.map((entry) => (
					<EntryView key={entry.id} entry={entry} />
				))}
				{live !== undefined && activeSession !== undefined && (
					<LiveMessage key={live.key} sessionId={activeSession.id} message={live} onReveal={handleReveal} />
				)}
				{entries.length === 0 && live === undefined && (
					<p className="py-10 text-center text-sm text-fg-subtle">Send a message to start the conversation.</p>
				)}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}

function EntryView({ entry }: { entry: EntryRecord }) {
	const user = userMessageOf(entry);
	if (user !== undefined) return <UserBubble text={userText(user)} />;

	const assistant = assistantMessageOf(entry);
	if (assistant !== undefined) {
		return (
			<AssistantBubble
				messageKey={String(assistant.timestamp)}
				blocks={assistant.content.map(toLiveBlock)}
				usage={assistant.usage}
			/>
		);
	}

	const toolResult = toolResultOf(entry);
	if (toolResult !== undefined) {
		return <ToolResultBubble text={toolResultText(toolResult)} isError={toolResult.isError === true} />;
	}

	if (entry.kind === "pi.compaction") return <Divider label="Context compacted" />;
	if (entry.kind === "pi.reset") return <Divider label="Context reset" />;
	return null;
}
