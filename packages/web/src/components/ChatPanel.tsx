import { useLayoutEffect, useRef } from "react";
import { useRegisterCommands, type Command } from "../lib/commands.tsx";
import { useHarness } from "../lib/store.tsx";
import { Composer } from "./Composer.tsx";
import { MarkdownInline } from "./Markdown.tsx";
import { MessageList } from "./MessageList.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import {
	BrainIcon,
	ChevronDownIcon,
	MenuIcon,
	MessageIcon,
	PencilIcon,
	PlusIcon,
	SparklesIcon,
	StopIcon,
	TrashIcon,
} from "./icons.tsx";

export function ChatPanel({ onOpenSidebar }: { onOpenSidebar: () => void }) {
	const { activeSessionId, activeSession, sessionsLoaded, createSession } = useHarness();
	const mainRef = useRef<HTMLElement>(null);
	const composerRef = useRef<HTMLDivElement>(null);

	useChatCommands();

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

function focusComposer() {
	document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
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
		configureModel,
		configureThinkingLevel,
		abortSession,
	} = useHarness();

	const modelRef = activeSession?.agent.model;
	const currentModel = models.find((model) => model.provider === modelRef?.provider && model.id === modelRef.modelId);
	const thinkingLevels = currentModel?.thinkingLevels ?? [];
	const hasSession = () => activeSessionId !== undefined;

	const commands: Command[] = [
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
			run: ({ pushPage }) => {
				pushPage({
					kind: "commands",
					title: "Change model",
					placeholder: "Search models…",
					commands: models.map((model) => ({
						id: `model.${model.provider}.${model.id}`,
						title: model.name,
						group: model.providerName,
						detail: `${Math.round(model.contextWindow / 1000)}k context`,
						keywords: [model.provider, model.providerName, model.id, ...(model.reasoning ? ["reasoning"] : [])],
						current: modelRef?.provider === model.provider && modelRef.modelId === model.id,
						run: () => void configureModel({ provider: model.provider, modelId: model.id }),
					})),
				});
			},
		},
		{
			id: "thinking.change",
			title: "Change thinking level…",
			group: "Session",
			keywords: ["reasoning", "effort"],
			icon: <BrainIcon />,
			when: () => hasSession() && thinkingLevels.length > 1,
			run: ({ pushPage }) => {
				const current = activeSession?.agent.thinkingLevel;
				pushPage({
					kind: "commands",
					title: "Change thinking level",
					placeholder: "Search levels…",
					commands: thinkingLevels.map((level) => ({
						id: `thinking.${level}`,
						title: level,
						group: "Thinking level",
						current: level === current,
						run: () => void configureThinkingLevel(level),
					})),
				});
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
			group: "Chat",
			keywords: ["type", "write", "compose"],
			icon: <MessageIcon />,
			when: hasSession,
			run: () => focusComposer(),
		},
		{
			id: "chat.bottom",
			title: "Scroll to the latest message",
			group: "Chat",
			keywords: ["end", "down", "bottom"],
			icon: <ChevronDownIcon />,
			when: hasSession,
			run: () => scrollToLatest(),
		},
	];

	useRegisterCommands("chat", commands, 1);
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
