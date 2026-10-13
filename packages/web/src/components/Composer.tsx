import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { useHarness } from "../lib/store.tsx";
import { SendIcon, StopIcon } from "./icons.tsx";

/** The textarea grows with its content up to this height, then scrolls. Matches `max-h-40`. */
const MAX_TEXTAREA_HEIGHT = 160;

/** Floating message composer. ChatPanel positions it and reserves its height in the message list. */
export function Composer({ ref }: { ref?: Ref<HTMLDivElement> }) {
	const { activeSession, sendPrompt, abortSession, status } = useHarness();
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const model = activeSession?.agent.model;
	const runActive = activeSession?.runActive ?? false;
	const canSend = text.trim() !== "" && model !== undefined && status === "connected";

	useLayoutEffect(() => {
		const element = textareaRef.current;
		if (element === null) return;
		const resize = () => {
			element.style.height = "auto";
			element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
			element.style.overflowY = element.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
		};
		resize();
		// The line height changes between the mobile and desktop font sizes, so remeasure on resize.
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, [text]);

	const submit = async () => {
		if (!canSend) return;
		const value = text;
		setText("");
		await sendPrompt(value);
		textareaRef.current?.focus();
	};

	return (
		<div
			ref={ref}
			className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-4"
		>
			<div className="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-1.5">
				{model === undefined && (
					<p className="w-fit rounded-lg border border-line bg-panel/95 px-3 py-1.5 text-xs text-warn shadow-sm">
						Choose a model above (or add a provider in settings) before sending a message.
					</p>
				)}
				{runActive && (
					<p className="w-fit rounded-lg border border-line bg-panel/95 px-3 py-1.5 text-[11px] text-fg-subtle shadow-sm">
						The agent is working. Sending another message queues it as a follow-up.
					</p>
				)}
				<div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 shadow-lg shadow-black/5 focus-within:border-line-strong dark:shadow-black/40">
					<textarea
						ref={textareaRef}
						data-composer-input
						value={text}
						rows={1}
						placeholder="Send a message…"
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void submit();
							}
						}}
						className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-fg-faint sm:text-sm"
					/>
					{runActive ? (
						<button
							type="button"
							onClick={() => void abortSession()}
							title="Stop"
							className="mb-0.5 rounded-lg bg-red-500/90 p-2 text-white hover:bg-red-500 pointer-coarse:p-2.5"
						>
							<StopIcon />
						</button>
					) : (
						<button
							type="button"
							onClick={() => void submit()}
							disabled={!canSend}
							title="Send"
							className="mb-0.5 rounded-lg bg-fg p-2 text-canvas hover:bg-fg/90 disabled:opacity-30 disabled:hover:bg-fg pointer-coarse:p-2.5"
						>
							<SendIcon />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
