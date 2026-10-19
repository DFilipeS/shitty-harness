import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTool, NestedToolView } from "../lib/live-tools.ts";
import { activeBlockIndex, type ToolResultView } from "../lib/messages.ts";
import { useHarness } from "../lib/store.tsx";
import type { LiveMessageState } from "../lib/session-state.ts";
import { AssistantBubble } from "./MessageBubbles.tsx";

/** Reveal rate control: target this much unread text per block while streaming, flush faster once committed. */
const TARGET_LAG_SECONDS = 0.25;
const FINISH_LAG_SECONDS = 0.1;
const MIN_CHARS_PER_SECOND = 60;
const MAX_CHARS_PER_SECOND = 1_500;

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How many characters each block can reveal; blocks without text have length 0. */
function blockLengths(blocks: LiveMessageState["blocks"]): number[] {
	return blocks.map((block) => {
		if (block.type === "text") return block.text.length;
		if (block.type === "thinking") return block.thinking.length;
		return 0;
	});
}

function revealRate(backlog: number, finished: boolean): number {
	const lag = finished ? FINISH_LAG_SECONDS : TARGET_LAG_SECONDS;
	return Math.max(MIN_CHARS_PER_SECOND, Math.min(MAX_CHARS_PER_SECOND, backlog / lag));
}

/** Reveal each text and thinking block up to its own count; other block types pass through whole. */
function truncateBlocks(
	blocks: LiveMessageState["blocks"],
	revealed: readonly number[],
): LiveMessageState["blocks"] {
	return blocks.map((block, index) => {
		const limit = revealed[index] ?? 0;
		if (block.type === "text") return { ...block, text: block.text.slice(0, limit) };
		if (block.type === "thinking") return { ...block, thinking: block.thinking.slice(0, limit) };
		return block;
	});
}

/**
 * Renders the in-flight assistant message with a typing animation. Text arrives from the server in
 * committed batches; this component buffers it and reveals it at a steady pace, so batches of any
 * size look like smooth typing. Each block reveals on its own, so thinking and text type at the
 * same time. When the message is committed, the committed entry stays hidden until the reveal
 * catches up, then `finishLive` drops the live copy.
 */
export function LiveMessage({
	sessionId,
	message,
	onReveal,
	toolResults,
	liveTools,
	nestedTools,
}: {
	sessionId: string;
	message: LiveMessageState;
	onReveal?: () => void;
	toolResults?: ReadonlyMap<string, ToolResultView>;
	liveTools?: Readonly<Record<string, LiveTool>>;
	nestedTools?: Readonly<Record<string, readonly NestedToolView[]>>;
}) {
	const { finishLive } = useHarness();
	const reducedMotion = useMemo(prefersReducedMotion, []);
	const [revealed, setRevealed] = useState<number[]>([]);
	const revealedRef = useRef<number[]>([]);
	const targets = blockLengths(message.blocks);
	const targetsRef = useRef(targets);
	targetsRef.current = targets;
	const onRevealRef = useRef(onReveal);
	onRevealRef.current = onReveal;

	useEffect(() => {
		if (reducedMotion) return;
		let frame = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const elapsed = Math.max(0.001, (now - last) / 1_000);
			last = now;
			const current = revealedRef.current;
			const lengths = targetsRef.current;
			let next: number[] | undefined;
			for (let index = 0; index < lengths.length; index += 1) {
				const target = lengths[index] ?? 0;
				const value = current[index] ?? 0;
				const backlog = target - value;
				if (backlog <= 0) continue;
				const step = Math.max(
					1,
					Math.round(revealRate(backlog, message.finished === true) * elapsed),
				);
				next ??= [...current];
				next[index] = Math.min(target, value + step);
			}
			if (next !== undefined) {
				revealedRef.current = next;
				setRevealed(next);
				onRevealRef.current?.();
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [message.finished, reducedMotion]);

	const targetTotal = targets.reduce((sum, length) => sum + length, 0);
	const revealedTotal = revealed.reduce((sum, length) => sum + length, 0);
	const done = reducedMotion || revealedTotal >= targetTotal;
	useEffect(() => {
		if (message.finished === true && done) finishLive(sessionId);
	}, [message.finished, done, finishLive, sessionId]);

	const blocks = useMemo(
		() => (reducedMotion ? message.blocks : truncateBlocks(message.blocks, revealed)),
		[reducedMotion, message.blocks, revealed],
	);
	return (
		<AssistantBubble
			messageKey={message.key}
			blocks={blocks}
			usage={message.usage}
			activeIndex={activeBlockIndex(message.blocks, message.finished)}
			toolResults={toolResults}
			{...(liveTools === undefined ? {} : { liveTools })}
			{...(nestedTools === undefined ? {} : { nestedTools })}
			streaming={!done}
			error={message.error}
		/>
	);
}
