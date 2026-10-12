import { useHarness } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { PlusIcon } from "./icons.tsx";

export function ChatPanel() {
	const { activeSessionId, activeSession, sessionsLoaded, createSession } = useHarness();

	if (activeSessionId === undefined || activeSession === undefined) {
		return (
			<main className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
				<p className="text-sm text-zinc-400">{sessionsLoaded ? "No session selected." : "Loading…"}</p>
				<button
					type="button"
					onClick={() => void createSession()}
					className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white"
				>
					<PlusIcon />
					New session
				</button>
			</main>
		);
	}

	return (
		<main className="flex min-w-0 flex-1 flex-col">
			<ChatHeader />
			<MessageList />
			<Composer />
		</main>
	);
}

function ChatHeader() {
	const { sessions, activeSessionId } = useHarness();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	return (
		<header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-2.5">
			<h1 className="min-w-0 truncate text-sm font-medium">{session?.title ?? "Session"}</h1>
			<ModelPicker />
		</header>
	);
}
