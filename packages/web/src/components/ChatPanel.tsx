import { useHarness } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { MenuIcon, PlusIcon } from "./icons.tsx";

export function ChatPanel({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { activeSessionId, activeSession, sessionsLoaded, createSession } = useHarness();

	if (activeSessionId === undefined || activeSession === undefined) {
		return (
			<main className="flex flex-1 flex-col">
				<div className="flex px-3 pt-2.5 sm:px-4 lg:hidden">
					<SidebarToggle onOpenSidebar={onOpenSidebar} />
				</div>
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
					<p className="text-sm text-zinc-400">{sessionsLoaded ? "No session selected." : "Loading…"}</p>
					<button
						type="button"
						onClick={() => void createSession()}
						className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white"
					>
						<PlusIcon />
						New session
					</button>
				</div>
			</main>
		);
	}

	return (
		<main className="flex min-w-0 flex-1 flex-col">
			<ChatHeader onOpenSidebar={onOpenSidebar} />
			<MessageList />
			<Composer />
		</main>
	);
}

function SidebarToggle({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpenSidebar}
			title="Sessions"
			className="-ml-1 rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 pointer-coarse:p-2.5 lg:hidden"
		>
			<MenuIcon />
		</button>
	);
}

function ChatHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { sessions, activeSessionId } = useHarness();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	return (
		<header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-3 py-2.5 sm:px-4">
			<SidebarToggle onOpenSidebar={onOpenSidebar} />
			<h1 className="min-w-0 flex-1 truncate text-sm font-medium">{session?.title ?? "Session"}</h1>
			<div className="w-full min-w-0 lg:w-auto">
				<ModelPicker />
			</div>
		</header>
	);
}
