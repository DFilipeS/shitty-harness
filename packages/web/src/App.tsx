import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { ErrorToast } from "./components/ErrorToast.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import {
	KeyboardIcon,
	LayersIcon,
	MenuIcon,
	MoonIcon,
	PlusIcon,
	RefreshIcon,
	SettingsIcon,
	SunIcon,
} from "./components/icons.tsx";
import { CommandPaletteProvider, useRegisterCommands, type Command } from "./lib/commands.tsx";
import { relativeTime } from "./lib/format.ts";
import { useProviderPalette } from "./lib/provider-commands.tsx";
import { HarnessProvider, useHarness } from "./lib/store.tsx";
import { ThemeProvider, useTheme } from "./lib/theme.tsx";

export function App() {
	return (
		<ThemeProvider>
			<HarnessProvider>
				<CommandPaletteProvider>
					<AppShell />
				</CommandPaletteProvider>
			</HarnessProvider>
		</ThemeProvider>
	);
}

function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(false);
	useGlobalCommands(setSidebarOpen);

	// Cmd/Ctrl+B toggles the sessions drawer (it is a drawer below lg).
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "b") {
				event.preventDefault();
				setSidebarOpen((current) => !current);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div className="flex h-full overflow-hidden">
			<Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
			{sidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/60 lg:hidden"
					onClick={() => setSidebarOpen(false)}
					aria-hidden="true"
				/>
			)}
			<ChatPanel onOpenSidebar={() => setSidebarOpen(true)} />
			<ErrorToast />
		</div>
	);
}

/** Commands that make sense anywhere in the app, regardless of the open session. */
function useGlobalCommands(setSidebarOpen: Dispatch<SetStateAction<boolean>>) {
	const { sessions, activeSessionId, createSession, selectSession, refreshProviders } = useHarness();
	const { theme, toggleTheme } = useTheme();
	const providersPalette = useProviderPalette();

	const commands: Command[] = [
		{
			id: "session.new",
			title: "New session",
			group: "Session",
			keywords: ["create", "chat", "conversation"],
			icon: <PlusIcon />,
			run: () => void createSession(),
		},
		{
			id: "session.switch",
			title: "Switch session…",
			group: "Session",
			keywords: ["open", "go to", "conversation", "chat"],
			icon: <LayersIcon />,
			when: () => sessions.length > 0,
			run: ({ pushPage }) =>
				pushPage({
					kind: "commands",
					title: "Switch session",
					placeholder: "Search sessions…",
					commands: sessions.map((session) => ({
						id: `session.open.${session.id}`,
						title: session.title,
						group: "Sessions",
						detail: session.working ? "Working…" : relativeTime(session.updatedAt),
						current: session.id === activeSessionId,
						run: () => selectSession(session.id),
					})),
				}),
		},
		{
			id: "providers.open",
			title: "Configure model providers…",
			group: "App",
			keywords: ["api key", "credentials", "settings", "models", "connect"],
			icon: <SettingsIcon />,
			run: ({ pushPage }) => pushPage(providersPalette.page()),
		},
		{
			id: "providers.refresh",
			title: "Refresh providers and models",
			group: "App",
			keywords: ["reload", "sync", "catalog"],
			icon: <RefreshIcon />,
			run: () => void refreshProviders(),
		},
		{
			id: "theme.toggle",
			title: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
			group: "App",
			keywords: ["theme", "appearance", "dark", "light"],
			icon: theme === "dark" ? <SunIcon /> : <MoonIcon />,
			run: () => toggleTheme(),
		},
		{
			id: "sidebar.toggle",
			title: "Toggle sessions sidebar",
			group: "App",
			keywords: ["panel", "show", "hide", "drawer"],
			icon: <MenuIcon />,
			shortcut: "⌘B",
			run: () => setSidebarOpen((current) => !current),
		},
		{
			id: "help.shortcuts",
			title: "Keyboard shortcuts",
			group: "Help",
			keywords: ["keys", "bindings", "help"],
			icon: <KeyboardIcon />,
			run: ({ pushPage }) => pushPage({ kind: "shortcuts", title: "Keyboard shortcuts" }),
		},
	];

	useRegisterCommands("app", commands);
}
