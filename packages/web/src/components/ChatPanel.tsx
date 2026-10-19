import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	focusComposer,
	formatKeys,
	useRegisterCommands,
	type RootCommand,
} from "../lib/commands.tsx";
import { useModelPalette, useThinkingPalette } from "../lib/session-commands.tsx";
import { useSkillsPalette } from "../lib/skill-commands.tsx";
import { useTargetPalette } from "../lib/target-commands.tsx";
import { findQuestions } from "../lib/questions.ts";
import { SHORTCUTS } from "../lib/shortcuts.ts";
import { useHarness } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { MarkdownInline } from "./Markdown.tsx";
import { MessageList } from "./MessageList.tsx";
import { QuestionForm } from "./QuestionForm.tsx";
import { SessionStats } from "./SessionStats.tsx";
import {
	BookIcon,
	BrainIcon,
	ChevronDownIcon,
	FolderIcon,
	InfoIcon,
	MenuIcon,
	MessageIcon,
	PencilIcon,
	PlusIcon,
	SparklesIcon,
	StopIcon,
	TrashIcon,
} from "./icons.tsx";

/**
 * Recently visited sessions whose message lists stay mounted, most recent first. Switching back
 * to one reuses its rendered transcript instead of re-rendering it; beyond this many, the least
 * recently viewed list unmounts and frees its DOM.
 */
const MOUNTED_SESSIONS = 5;

export function ChatPanel({
	onToggleSidebar,
	onToggleSessionPanel,
}: {
	onToggleSidebar: () => void;
	onToggleSessionPanel: () => void;
}) {
	const { activeSessionId, activeSession, sessionStates, sessions, sessionsLoaded, createSession } =
		useHarness();
	const [visited, setVisited] = useState<readonly string[]>([]);
	// Track the visited list during render, so the first click shows its list in the same paint
	// instead of an empty panel that fills in one frame later.
	const [seenActiveId, setSeenActiveId] = useState(activeSessionId);
	if (activeSessionId !== seenActiveId) {
		setSeenActiveId(activeSessionId);
		const id = activeSessionId;
		if (id !== undefined)
			setVisited((previous) =>
				[id, ...previous.filter((candidate) => candidate !== id)].slice(0, MOUNTED_SESSIONS),
			);
	}
	const questionCallId = sessions.find((session) => session.id === activeSessionId)?.questionCallId;
	const questions = useMemo(
		() =>
			questionCallId === undefined || activeSession === undefined
				? undefined
				: findQuestions(activeSession.entries, activeSession.live?.blocks, questionCallId),
		[questionCallId, activeSession],
	);
	const mainRef = useRef<HTMLElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);

	useChatCommands();

	// The composer, or the question form in its place, floats over the list, so publish its height for
	// the list's bottom padding.
	useLayoutEffect(() => {
		const main = mainRef.current;
		const composer = composerRef.current;
		if (main === null || composer === null) return;
		const update = () => main.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(composer);
		return () => observer.disconnect();
	}, [activeSessionId, questionCallId]);

	if (activeSessionId === undefined || activeSession === undefined) {
		return (
			<main className="flex flex-1 flex-col">
				<div className="flex px-3 pt-2.5 sm:px-4">
					<SidebarToggle onToggleSidebar={onToggleSidebar} />
				</div>
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
					<p className="text-sm text-fg-muted">
						{sessionsLoaded ? "No session selected." : "Loading…"}
					</p>
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
			<ChatHeader onToggleSidebar={onToggleSidebar} onToggleSessionPanel={onToggleSessionPanel} />
			{/* One mounted list per recently visited session: the active one fills the panel, the rest
			    stay mounted but hidden, so switching back shows them without re-rendering them. */}
			{visited.map((id) => {
				const session = sessionStates[id];
				if (session === undefined) return null;
				const isActive = id === activeSessionId;
				return (
					<div
						key={id}
						// `min-h-0` matters: without it the wrapper's automatic minimum height grows to the
						// transcript's full height, and the scroller inside never overflows (no scrolling).
						className={isActive ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" : "hidden"}
					>
						<MessageList session={session} active={isActive} />
					</div>
				);
			})}
			{/* The composer stays mounted under an open question, so a draft survives it. */}
			<Composer
				hidden={questionCallId !== undefined}
				{...(questionCallId === undefined ? { ref: composerRef } : {})}
			/>
			{questionCallId !== undefined && (
				<QuestionForm
					key={questionCallId}
					ref={composerRef}
					callId={questionCallId}
					questions={questions}
				/>
			)}
		</main>
	);
}

function scrollToLatest() {
	const scroller = document.querySelector<HTMLElement>("[data-message-scroll]");
	if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
}

/** Commands that act on the open conversation. They are hidden while no session is selected. */
function useChatCommands() {
	const {
		sessions,
		models,
		activeSessionId,
		activeSession,
		renameSession,
		deleteSession,
		abortSession,
	} = useHarness();
	const modelPalette = useModelPalette();
	const thinkingPalette = useThinkingPalette();
	const targetPalette = useTargetPalette();
	const skillsPalette = useSkillsPalette();
	const hasSession = () => activeSessionId !== undefined;

	const commands: RootCommand[] = [
		{
			id: "session.rename",
			title: "Rename current session…",
			group: "Session",
			keywords: ["title", "name"],
			icon: <PencilIcon />,
			when: hasSession,
			run: ({ prompt }) => {
				const id = activeSessionId;
				if (id === undefined) return;
				const session = sessions.find((candidate) => candidate.id === id);
				prompt({
					title: "Rename session",
					placeholder: "Session name",
					initialValue: session?.title ?? "",
					onSubmit: (value) => {
						const title = value.trim();
						if (title === "") return false;
						void renameSession(id, title);
					},
				});
			},
		},
		{
			id: "session.delete",
			title: "Delete current session…",
			group: "Session",
			keywords: ["remove", "trash"],
			icon: <TrashIcon />,
			when: hasSession,
			run: ({ pushPage }) => {
				const id = activeSessionId;
				if (id === undefined) return;
				const title = sessions.find((candidate) => candidate.id === id)?.title ?? "this session";
				pushPage({
					kind: "commands",
					title: "Delete session",
					placeholder: "Delete…",
					commands: [
						{
							id: "session.delete.confirm",
							title: `Delete “${title}”`,
							group: "Confirm",
							detail: "Cannot be undone",
							icon: <TrashIcon />,
							run: () => void deleteSession(id),
						},
						{ id: "session.delete.cancel", title: "Cancel", group: "Confirm", run: () => {} },
					],
				});
			},
		},
		{
			id: "model.change",
			title: "Change model…",
			group: "Session",
			keywords: ["provider", "llm", "switch"],
			icon: <SparklesIcon />,
			when: () => hasSession() && models.length > 0,
			run: ({ pushPage }) => pushPage(modelPalette.page()),
		},
		{
			id: "thinking.change",
			title: "Change thinking level…",
			group: "Session",
			keywords: ["reasoning", "effort"],
			icon: <BrainIcon />,
			when: () => hasSession() && thinkingPalette.levels.length > 1,
			run: ({ pushPage }) => pushPage(thinkingPalette.page()),
		},
		{
			id: "target.change",
			title: "Change target…",
			group: "Session",
			keywords: ["folder", "directory", "workspace", "scratch", "where"],
			icon: <FolderIcon />,
			when: () => hasSession() && activeSession?.runActive !== true,
			run: ({ pushPage }) => pushPage(targetPalette.page()),
		},
		{
			id: "skills.list",
			title: "Skills…",
			group: "Session",
			keywords: ["skill", "agent skills", "SKILL.md", "instructions"],
			icon: <BookIcon />,
			when: hasSession,
			run: ({ pushPage }) => {
				const page = skillsPalette.page();
				if (page !== undefined) pushPage(page);
			},
		},
		{
			id: "run.stop",
			title: "Stop the agent",
			group: "Session",
			keywords: ["abort", "cancel", "halt"],
			icon: <StopIcon />,
			when: () => activeSession?.runActive === true,
			run: () => void abortSession(),
		},
		{
			id: "chat.focus",
			title: "Focus the message input",
			group: "App",
			keywords: ["type", "write", "compose"],
			icon: <MessageIcon />,
			when: hasSession,
			run: () => focusComposer(),
		},
		{
			id: "chat.bottom",
			title: "Scroll to the latest message",
			group: "App",
			keywords: ["end", "down", "bottom"],
			icon: <ChevronDownIcon />,
			when: hasSession,
			run: () => scrollToLatest(),
		},
	];

	useRegisterCommands("chat", commands, 1);
}

function SidebarToggle({ onToggleSidebar }: { onToggleSidebar: () => void }) {
	return (
		<button
			type="button"
			onClick={onToggleSidebar}
			title="Toggle sessions sidebar"
			className="-ml-1 rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
		>
			<MenuIcon />
		</button>
	);
}

function ChatHeader({
	onToggleSidebar,
	onToggleSessionPanel,
}: {
	onToggleSidebar: () => void;
	onToggleSessionPanel: () => void;
}) {
	const { sessions, activeSessionId } = useHarness();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	return (
		<header className="flex items-center gap-3 border-b border-line px-3 py-2.5 sm:px-4">
			<SidebarToggle onToggleSidebar={onToggleSidebar} />
			<h1 className="min-w-0 flex-1 truncate text-sm font-medium">
				{session === undefined ? "Session" : <MarkdownInline text={session.title} />}
			</h1>
			<SessionStats />
			<button
				type="button"
				onClick={onToggleSessionPanel}
				title={`Toggle session panel (${formatKeys(SHORTCUTS.sessionPanel)})`}
				className="-mr-1 rounded-md p-1.5 text-fg-muted hover:bg-raised hover:text-fg pointer-coarse:p-2.5"
			>
				<InfoIcon />
			</button>
		</header>
	);
}
