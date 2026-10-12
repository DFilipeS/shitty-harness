import { useRef, useState } from "react";
import { useHarness } from "../lib/store.tsx";
import { SendIcon, StopIcon } from "./icons.tsx";

export function Composer() {
	const { activeSession, sendPrompt, abortSession, status } = useHarness();
	const [text, setText] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const model = activeSession?.agent.model;
	const runActive = activeSession?.runActive ?? false;
	const canSend = text.trim() !== "" && model !== undefined && status === "connected";

	const submit = async () => {
		if (!canSend) return;
		const value = text;
		setText("");
		await sendPrompt(value);
		textareaRef.current?.focus();
	};

	return (
		<div className="border-t border-zinc-800 px-4 py-3">
			<div className="mx-auto flex max-w-3xl flex-col gap-2">
				{model === undefined && (
					<p className="text-xs text-amber-400">
						Choose a model above (or add a provider in settings) before sending a message.
					</p>
				)}
				<div className="flex items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2 focus-within:border-zinc-600">
					<textarea
						ref={textareaRef}
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
						className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-zinc-600"
					/>
					{runActive ? (
						<button
							type="button"
							onClick={() => void abortSession()}
							title="Stop"
							className="rounded-lg bg-red-500/90 p-2 text-white hover:bg-red-500"
						>
							<StopIcon />
						</button>
					) : (
						<button
							type="button"
							onClick={() => void submit()}
							disabled={!canSend}
							title="Send"
							className="rounded-lg bg-zinc-100 p-2 text-zinc-900 hover:bg-white disabled:opacity-30 disabled:hover:bg-zinc-100"
						>
							<SendIcon />
						</button>
					)}
				</div>
				{runActive && (
					<p className="text-[11px] text-zinc-500">
						The agent is working. Sending another message queues it as a follow-up.
					</p>
				)}
			</div>
		</div>
	);
}
