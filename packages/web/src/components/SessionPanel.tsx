import { useEffect, useState, type ReactNode } from "react";
import type { PromptSectionInfo } from "@harness/protocol";
import { useHarness } from "../lib/store.tsx";
import { fullPromptText, sectionBody, sectionPreview } from "../lib/system-prompt.ts";
import { CheckIcon, ChevronDownIcon, CopyIcon, FileIcon, WrenchIcon, XIcon } from "./icons.tsx";
import { SessionTools } from "./SessionTools.tsx";
/** How long to wait after a committed entry before asking for the prompt again. */
const REFRESH_DEBOUNCE_MS = 300;

/** The two tabs of the session panel. */
type PanelTab = "prompt" | "tools";

/**
 * The session panel: the right-hand column with information about the open session. The Prompt
 * tab shows the system prompt's sections as they were in effect for the model's last request —
 * the committed view, not a preview of the next one. The Tools tab lists the session's tools.
 */
export function SessionPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { activeSessionId, activeSession, systemPrompt } = useHarness();
	const [tab, setTab] = useState<PanelTab>("prompt");
	const [sections, setSections] = useState<PromptSectionInfo[] | undefined>();
	const [loaded, setLoaded] = useState(false);

	// Switching sessions drops whatever the previous one showed.
	useEffect(() => {
		setSections(undefined);
		setLoaded(false);
	}, [activeSessionId]);

	// The prompt changes only when entries are committed, so the entry list is the refetch
	// signal: attach (snapshot) and every later commit both move it. Debounced, and only
	// while the panel is open.
	const entryCount = activeSession?.entries.length ?? 0;
	const lastEntryId = activeSession?.entries[entryCount - 1]?.id;
	useEffect(() => {
		if (!open || activeSessionId === undefined) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void systemPrompt(activeSessionId).then((result) => {
				if (cancelled || result === undefined) return;
				setSections(result.sections);
				setLoaded(true);
			});
		}, REFRESH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [open, activeSessionId, entryCount, lastEntryId, systemPrompt]);

	const hasPrompt = sections !== undefined && sections.length > 0;

	return (
		<aside
			data-session-panel
			className={`fixed inset-y-0 right-0 z-40 flex w-72 shrink-0 flex-col border-l border-line bg-panel transition-[transform,margin-right] duration-200 lg:static lg:z-auto lg:translate-x-0 ${
				open ? "translate-x-0 lg:mr-0" : "translate-x-full lg:-mr-72"
			}`}
		>
			<div role="tablist" aria-label="Session panel" className="flex shrink-0 border-b border-line">
				<PanelTab
					active={tab === "prompt"}
					onClick={() => setTab("prompt")}
					icon={<FileIcon className="h-3.5 w-3.5" />}
					label="Prompt"
				/>
				<PanelTab
					active={tab === "tools"}
					onClick={() => setTab("tools")}
					icon={<WrenchIcon className="h-3.5 w-3.5" />}
					label="Tools"
				/>
			</div>
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-2">
				<span className="text-[11px] text-fg-subtle">
					{tab === "prompt" ? "As sent on the last request" : "What the agent may call"}
				</span>
				<button
					type="button"
					onClick={onClose}
					title="Close session panel"
					className="-mr-1 rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg lg:hidden pointer-coarse:p-2.5"
				>
					<XIcon />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
				{activeSessionId === undefined ? (
					<p className="py-6 text-center text-xs text-fg-subtle">No session selected.</p>
				) : tab === "tools" && open ? (
					<SessionTools />
				) : !loaded ? (
					<p className="py-6 text-center text-xs text-fg-subtle">Loading…</p>
				) : !hasPrompt ? (
					// A session commits its first system entries only when it prepares its first request.
					<p className="py-6 text-center text-xs text-fg-subtle">
						The system prompt appears after the first request.
					</p>
				) : (
					<div className="flex flex-col gap-2">
						<div className="flex justify-end">
							<CopyPromptButton sections={sections ?? []} />
						</div>
						{(sections ?? []).map((section) => (
							<SectionCard key={section.key} section={section} />
						))}
					</div>
				)}
			</div>
		</aside>
	);
}

/** One half-width underline tab in the panel's tab row, like the question form's question tabs. */
function PanelTab({
	active,
	onClick,
	icon,
	label,
}: {
	active: boolean;
	onClick: () => void;
	icon: ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-medium transition-colors ${
				active ? "border-fg text-fg" : "border-transparent text-fg-subtle hover:text-fg"
			}`}
		>
			{icon}
			{label}
		</button>
	);
}

function SectionCard({ section }: { section: PromptSectionInfo }) {
	return (
		<details className="group rounded-md border border-line bg-surface">
			<summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 hover:bg-raised/60">
				<ChevronDownIcon className="h-3 w-3 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
				<span className="shrink-0 text-xs font-medium text-fg">{section.key}</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-fg-subtle">
					{sectionPreview(section)}
				</span>
			</summary>
			<div className="whitespace-pre-wrap border-t border-line px-2.5 py-2 text-xs leading-relaxed text-fg-soft">
				{sectionBody(section)}
			</div>
		</details>
	);
}

function CopyPromptButton({ sections }: { sections: readonly PromptSectionInfo[] }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(fullPromptText(sections));
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_500);
		} catch {
			// Clipboard access can be denied; the click just does nothing then.
		}
	};
	return (
		<button
			type="button"
			onClick={() => void copy()}
			title="Copy the full system prompt"
			className="rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
		>
			{copied ? (
				<CheckIcon className="h-3.5 w-3.5 text-ok" />
			) : (
				<CopyIcon className="h-3.5 w-3.5" />
			)}
		</button>
	);
}
