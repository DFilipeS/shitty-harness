import { useLayoutEffect, useRef, useState, type Ref } from "react";
import { useProviderPalette } from "../lib/provider-commands.tsx";
import { useModelPalette, useThinkingPalette } from "../lib/session-commands.tsx";
import { useHarness } from "../lib/store.tsx";
import { BrainIcon, CpuIcon, SendIcon, StopIcon } from "./icons.tsx";

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

				<div className="flex flex-wrap items-end gap-2 rounded-2xl border border-line bg-panel p-2 shadow-lg shadow-black/5 focus-within:border-line-strong dark:shadow-black/40">
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
					<div className="flex w-full flex-wrap items-center gap-1 px-1">
						<ModelChip />
						<ThinkingChip />
						{runActive && (
							<span className="ml-auto flex flex-wrap items-center justify-end gap-x-1.5 text-[11px] text-fg-faint">
								<span className="flex items-center gap-1.5">
									<span
										aria-hidden="true"
										className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-warn motion-safe:animate-spin"
									/>
									<span className="text-warn">Working</span>
								</span>
								<span>Sending another message queues it as a follow-up.</span>
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/** Opens the model page, or the provider page when no provider is configured yet. */
function ModelChip() {
	const { models, activeSession } = useHarness();
	const modelPalette = useModelPalette();
	const providersPalette = useProviderPalette();
	const current = activeSession?.agent.model;
	const info = models.find((model) => model.provider === current?.provider && model.id === current.modelId);
	const configured = models.length > 0;
	return (
		<button
			type="button"
			data-model-chip
			onClick={() => (configured ? modelPalette.open() : providersPalette.open())}
			title={info === undefined ? "Choose a model" : `Model: ${info.providerName} · ${info.name}`}
			className={`flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] hover:bg-raised ${
				info === undefined ? "text-warn" : "text-fg-subtle hover:text-fg"
			}`}
		>
			<CpuIcon className="h-3.5 w-3.5 shrink-0" />
			<span className="max-w-44 truncate">{info?.name ?? current?.modelId ?? "Choose a model"}</span>
		</button>
	);
}

/** Only shown when the current model has more than one thinking level. */
function ThinkingChip() {
	const { activeSession } = useHarness();
	const thinkingPalette = useThinkingPalette();
	if (thinkingPalette.levels.length <= 1) return null;
	return (
		<button
			type="button"
			data-thinking-chip
			onClick={thinkingPalette.open}
			title="Change thinking level"
			className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-fg-subtle hover:bg-raised hover:text-fg"
		>
			<BrainIcon className="h-3.5 w-3.5 shrink-0" />
			<span>{activeSession?.agent.thinkingLevel ?? "off"}</span>
		</button>
	);
}
