import { useState } from "react";
import { PRODUCT_NAME, type SessionSummary } from "@harness/protocol";
import { relativeTime } from "../lib/format.ts";
import { useProviderPalette } from "../lib/provider-commands.tsx";
import { useHarness } from "../lib/store.tsx";
import { useTheme } from "../lib/theme.tsx";
import { formatKeys, useCommandPalette } from "../lib/commands.tsx";
import { SHORTCUTS } from "../lib/shortcuts.ts";
import {
	CommandIcon,
	MoonIcon,
	PencilIcon,
	PlusIcon,
	QuestionIcon,
	SunIcon,
	TrashIcon,
} from "./icons.tsx";
import { MarkdownInline } from "./Markdown.tsx";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
	const {
		sessions,
		sessionsLoaded,
		activeSessionId,
		status,
		createSession,
		selectSession,
		renameSession,
		deleteSession,
	} = useHarness();
	const { theme, toggleTheme } = useTheme();
	const providersPalette = useProviderPalette();
	const { open: openPalette } = useCommandPalette();
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	const startRename = (session: SessionSummary) => {
		setRenamingId(session.id);
		setDraft(session.title);
	};

	const commitRename = async () => {
		if (renamingId === null) return;
		const id = renamingId;
		const title = draft.trim();
		setRenamingId(null);
		if (title !== "") await renameSession(id, title);
	};

	return (
		<aside
			className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-line bg-panel transition-[transform,margin-left] duration-200 lg:static lg:z-auto lg:translate-x-0 ${
				open ? "translate-x-0 lg:ml-0" : "-translate-x-full lg:-ml-72"
			}`}
		>
			<div className="flex items-center justify-between px-3 py-3">
				<div>
					<div className="text-sm font-semibold">{PRODUCT_NAME}</div>
					<div className="text-[11px] text-fg-subtle">pi-durable agent</div>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={toggleTheme}
						title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
						className="rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
					>
						{theme === "dark" ? <SunIcon /> : <MoonIcon />}
					</button>
					<button
						type="button"
						onClick={openPalette}
						title={`Command palette (${formatKeys(SHORTCUTS.palette)})`}
						className="rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
					>
						<CommandIcon />
					</button>
				</div>
			</div>

			<div className="px-3 pb-2">
				<button
					type="button"
					onClick={() => {
						void createSession();
						onNavigate();
					}}
					className="flex w-full items-center justify-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-canvas hover:bg-fg/90 pointer-coarse:py-2.5"
				>
					<PlusIcon />
					New session
				</button>
			</div>

			<nav className="flex-1 overflow-y-auto px-2 pb-2">
				{sessions.map((session) => {
					const active = session.id === activeSessionId;
					if (deletingId === session.id) {
						return (
							<div key={session.id} className="rounded-md bg-red-500/10 px-2 py-1.5">
								<p className="truncate text-xs text-red-700 dark:text-red-300">
									Delete “{session.title}”?
								</p>
								<div className="mt-1.5 flex gap-1.5">
									<button
										type="button"
										onClick={() => {
											setDeletingId(null);
											void deleteSession(session.id);
										}}
										className="rounded bg-red-500/90 px-2 py-0.5 text-xs text-white hover:bg-red-500 pointer-coarse:py-1.5"
									>
										Delete
									</button>
									<button
										type="button"
										onClick={() => setDeletingId(null)}
										className="rounded border border-line-strong px-2 py-0.5 text-xs text-fg-soft hover:border-fg-subtle pointer-coarse:py-1.5"
									>
										Cancel
									</button>
								</div>
							</div>
						);
					}
					return (
						<div
							key={session.id}
							className={`group flex items-center gap-1 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 ${
								active ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised/60 hover:text-fg"
							}`}
						>
							{renamingId === session.id ? (
								<input
									autoFocus
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									onBlur={() => void commitRename()}
									onKeyDown={(event) => {
										if (event.key === "Enter") void commitRename();
										if (event.key === "Escape") setRenamingId(null);
									}}
									className="w-full rounded border border-line-strong bg-panel px-1 py-0.5 text-base outline-none sm:text-sm"
								/>
							) : (
								<>
									<button
										type="button"
										onClick={() => {
											selectSession(session.id);
											onNavigate();
										}}
										onDoubleClick={() => startRename(session)}
										className="min-w-0 flex-1 text-left"
									>
										<div className="truncate text-sm">
											<MarkdownInline text={session.title} />
										</div>
										{session.working ? (
											<div className="flex items-center gap-1.5 text-[11px] text-warn">
												<span
													aria-hidden="true"
													className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-warn motion-safe:animate-spin"
												/>
												Working…
											</div>
										) : session.needsInput ? (
											<div className="flex items-center gap-1.5 text-[11px] text-link">
												<QuestionIcon className="h-2.5 w-2.5 shrink-0" />
												Needs input
											</div>
										) : (
											<div className="text-[11px] text-fg-subtle">
												{relativeTime(session.updatedAt)}
											</div>
										)}
									</button>
									<button
										type="button"
										onClick={() => startRename(session)}
										title="Rename session"
										className="hidden rounded p-1 text-fg-subtle hover:text-fg group-hover:block pointer-coarse:block pointer-coarse:p-2"
									>
										<PencilIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										onClick={() => setDeletingId(session.id)}
										title="Delete session"
										className="hidden rounded p-1 text-fg-subtle hover:text-red-500 group-hover:block pointer-coarse:block pointer-coarse:p-2"
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</>
							)}
						</div>
					);
				})}
				{sessionsLoaded && sessions.length === 0 && (
					<p className="px-2 py-6 text-center text-xs text-fg-subtle">No sessions yet.</p>
				)}
			</nav>

			<div className="border-t border-line px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-[11px] text-fg-subtle lg:pb-2">
				<span
					className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
						status === "connected" ? "bg-ok" : status === "connecting" ? "bg-warn" : "bg-red-500"
					}`}
				/>
				{status === "connected"
					? "Connected"
					: status === "connecting"
						? "Connecting…"
						: "Disconnected"}
			</div>
		</aside>
	);
}
