import { useEffect, useState } from "react";
import type { ToolInfo } from "@harness/protocol";
import { useHarness } from "../lib/store.tsx";

/** How long to wait after a committed entry before asking for the tools again. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * The session panel's Tools tab: every installed tool with an on/off toggle, grouped by the
 * extension that brings it. Pinned tools stay on; a toggle applies to the session's next request.
 */
export function SessionTools() {
	const { activeSessionId, activeSession, sessionTools, configureTools } = useHarness();
	const [tools, setTools] = useState<ToolInfo[]>();
	const [loaded, setLoaded] = useState(false);

	// Switching sessions drops whatever the previous one showed.
	useEffect(() => {
		setTools(undefined);
		setLoaded(false);
	}, [activeSessionId]);

	// The offered tools change only when entries are committed (a tool change writes a system
	// entry), so the entry list is the refetch signal. Debounced.
	const entryCount = activeSession?.entries.length ?? 0;
	const lastEntryId = activeSession?.entries[entryCount - 1]?.id;
	useEffect(() => {
		if (activeSessionId === undefined) return;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void sessionTools(activeSessionId).then((result) => {
				if (cancelled || result === undefined) return;
				setTools(result.tools);
				setLoaded(true);
			});
		}, REFRESH_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [activeSessionId, entryCount, lastEntryId, sessionTools]);

	const toggle = (tool: ToolInfo, enabled: boolean) => {
		if (tool.pinned || tools === undefined) return;
		const next = tools.map((t) => (t.name === tool.name ? { ...t, enabled } : t));
		setTools(next); // Optimistic; the change commits a system entry, which refetches the truth.
		const remove = next.filter((t) => !t.enabled && !t.pinned).map((t) => t.name);
		void configureTools(remove.length === 0 ? null : remove);
	};

	if (activeSessionId === undefined || !loaded) {
		return <p className="py-6 text-center text-xs text-fg-subtle">Loading…</p>;
	}
	if (tools === undefined || tools.length === 0) {
		return <p className="py-6 text-center text-xs text-fg-subtle">No tools installed.</p>;
	}

	// The server lists tools in install order, so groups keep that order too.
	const groups = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const group = groups.get(tool.extension);
		if (group === undefined) groups.set(tool.extension, [tool]);
		else group.push(tool);
	}

	return (
		<div className="flex flex-col gap-3">
			{[...groups].map(([extension, groupTools]) => (
				<section key={extension} className="flex flex-col gap-1.5">
					<h3 className="text-[11px] font-semibold text-fg-muted">{extension}</h3>
					{groupTools.map((tool) => (
						<ToolRow key={tool.name} tool={tool} onToggle={(enabled) => toggle(tool, enabled)} />
					))}
				</section>
			))}
			<p className="text-[11px] text-fg-subtle">Changes apply from the next request.</p>
		</div>
	);
}

function ToolRow({ tool, onToggle }: { tool: ToolInfo; onToggle: (enabled: boolean) => void }) {
	return (
		<div className="flex items-start justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-2">
			<div className="min-w-0">
				<div className="flex items-baseline gap-1.5">
					<span className="text-xs font-medium text-fg">{tool.name}</span>
					{tool.pinned && <span className="text-[10px] text-fg-subtle">pinned</span>}
				</div>
				<p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-subtle">
					{tool.description}
				</p>
			</div>
			<ToolSwitch checked={tool.enabled} disabled={tool.pinned} onChange={onToggle} />
		</div>
	);
}

function ToolSwitch({
	checked,
	disabled,
	onChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label="Toggle tool"
			disabled={disabled}
			onClick={() => onChange(!checked)}
			title={checked ? "Turn off for the next request" : "Turn on for the next request"}
			className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition-colors ${
				checked ? "bg-ok" : "bg-line-strong"
			} ${disabled ? "cursor-default opacity-50" : "cursor-pointer hover:brightness-110"}`}
		>
			<span
				className={`absolute top-0.5 h-3 w-3 rounded-full transition-[left] ${
					checked ? "left-3.5 bg-panel" : "left-0.5 bg-fg-subtle"
				}`}
			/>
		</button>
	);
}
