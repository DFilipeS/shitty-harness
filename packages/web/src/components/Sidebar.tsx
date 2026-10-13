import { useState } from "react";
import type { SessionSummary } from "@harness/protocol";
import { relativeTime } from "../lib/format.ts";
import { useHarness } from "../lib/store.tsx";
import { PencilIcon, PlusIcon, SettingsIcon, TrashIcon } from "./icons.tsx";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
	const {
		sessions,
		sessionsLoaded,
		activeSessionId,
		status,
		createSession,
		selectSession,
		renameSession,
		deleteSession,
		openProviderDialog,
	} = useHarness();
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
			className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/95 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:bg-zinc-900/40 ${
				open ? "translate-x-0" : "-translate-x-full"
			}`}
		>
			<div className="flex items-center justify-between px-3 py-3">
				<div>
					<div className="text-sm font-semibold">Shitty Harness</div>
					<div className="text-[11px] text-zinc-500">pi-durable agent</div>
				</div>
				<button
					type="button"
					onClick={openProviderDialog}
					title="Model providers"
					className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 pointer-coarse:p-2.5"
				>
					<SettingsIcon />
				</button>
			</div>

			<div className="px-3 pb-2">
				<button
					type="button"
					onClick={() => {
						void createSession();
						onClose();
					}}
					className="flex w-full items-center justify-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white pointer-coarse:py-2.5"
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
							<div key={session.id} className="rounded-md bg-red-950/30 px-2 py-1.5">
								<p className="truncate text-xs text-red-300">Delete “{session.title}”?</p>
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
										className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-500 pointer-coarse:py-1.5"
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
								active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
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
									className="w-full rounded border border-zinc-600 bg-zinc-900 px-1 py-0.5 text-base outline-none sm:text-sm"
								/>
							) : (
								<>
									<button
										type="button"
										onClick={() => {
											selectSession(session.id);
											onClose();
										}}
										onDoubleClick={() => startRename(session)}
										className="min-w-0 flex-1 text-left"
									>
										<div className="truncate text-sm">{session.title}</div>
										{session.working ? (
											<div className="flex items-center gap-1.5 text-[11px] text-amber-400/90">
												<span
													aria-hidden="true"
													className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-zinc-700 border-t-amber-400 motion-safe:animate-spin"
												/>
												Working…
											</div>
										) : (
											<div className="text-[11px] text-zinc-500">{relativeTime(session.updatedAt)}</div>
										)}
									</button>
									<button
										type="button"
										onClick={() => startRename(session)}
										title="Rename session"
										className="hidden rounded p-1 text-zinc-500 hover:text-zinc-200 group-hover:block pointer-coarse:block pointer-coarse:p-2"
									>
										<PencilIcon className="h-3.5 w-3.5" />
									</button>
									<button
										type="button"
										onClick={() => setDeletingId(session.id)}
										title="Delete session"
										className="hidden rounded p-1 text-zinc-500 hover:text-red-400 group-hover:block pointer-coarse:block pointer-coarse:p-2"
									>
										<TrashIcon className="h-3.5 w-3.5" />
									</button>
								</>
							)}
						</div>
					);
				})}
				{sessionsLoaded && sessions.length === 0 && (
					<p className="px-2 py-6 text-center text-xs text-zinc-500">No sessions yet.</p>
				)}
			</nav>

			<div className="border-t border-zinc-800 px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-[11px] text-zinc-500 lg:pb-2">
				<span
					className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
						status === "connected" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500"
					}`}
				/>
				{status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected"}
			</div>
		</aside>
	);
}
