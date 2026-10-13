import { useLayoutEffect, useRef } from "react";
import { useHarness } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { MarkdownInline } from "./Markdown.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { MenuIcon, PlusIcon } from "./icons.tsx";

export function ChatPanel({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { activeSessionId, activeSession, sessionsLoaded, createSession } = useHarness();
	const mainRef = useRef<HTMLElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);

	// The composer floats over the list, so publish its height for the list's bottom padding.
	useLayoutEffect(() => {
		const main = mainRef.current;
		const composer = composerRef.current;
		if (main === null || composer === null) return;
		const update = () => main.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(composer);
		return () => observer.disconnect();
	}, [activeSessionId]);

	if (activeSessionId === undefined || activeSession === undefined) {
		return (
			<main className="flex flex-1 flex-col">
				<div className="flex px-3 pt-2.5 sm:px-4 lg:hidden">
					<SidebarToggle onOpenSidebar={onOpenSidebar} />
				</div>
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
					<p className="text-sm text-fg-muted">{sessionsLoaded ? "No session selected." : "Loading…"}</p>
					<button
						type="button"
						onClick={() => void createSession()}
						className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-sm font-medium text-canvas hover:bg-fg/90"
					>
						<PlusIcon />
						New session
					</button>
				</div>
			</main>
		);
	}

	return (
		<main ref={mainRef} className="relative flex min-w-0 flex-1 flex-col">
			<ChatHeader onOpenSidebar={onOpenSidebar} />
			<MessageList />
			<Composer ref={composerRef} />
		</main>
	);
}

function SidebarToggle({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpenSidebar}
			title="Sessions"
			className="-ml-1 rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5 lg:hidden"
		>
			<MenuIcon />
		</button>
	);
}

function ChatHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { sessions, activeSessionId } = useHarness();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	return (
		<header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
			<SidebarToggle onOpenSidebar={onOpenSidebar} />
			<h1 className="min-w-0 flex-1 truncate text-sm font-medium">
				{session === undefined ? "Session" : <MarkdownInline text={session.title} />}
			</h1>
			<div className="w-full min-w-0 lg:w-auto">
				<ModelPicker />
			</div>
		</header>
	);
}
