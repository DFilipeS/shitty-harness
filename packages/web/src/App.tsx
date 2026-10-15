import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { Toast } from "./components/Toast.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import {
	KeyboardIcon,
	LayersIcon,
	MenuIcon,
	MoonIcon,
	PlusIcon,
	RefreshIcon,
	SettingsIcon,
	SlidersIcon,
	SunIcon,
} from "./components/icons.tsx";
import { CommandPaletteProvider, useRegisterCommands, type Command } from "./lib/commands.tsx";
import { relativeTime } from "./lib/format.ts";
import { useProviderPalette } from "./lib/provider-commands.tsx";
import { useDefaultsPalette } from "./lib/session-commands.tsx";
import { SHORTCUTS } from "./lib/shortcuts.ts";
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

/** Matches Tailwind's `lg` breakpoint, where the sidebar stops being a drawer. */
const DESKTOP_QUERY = "(min-width: 64rem)";

function isDesktop(): boolean {
	return window.matchMedia(DESKTOP_QUERY).matches;
}

const SIDEBAR_STORAGE_KEY = "harness-sidebar";

/** The sidebar starts open on desktop and closed on phones; desktop remembers the choice. */
function initialSidebarOpen(): boolean {
	if (!isDesktop()) return false;
	try {
		return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "closed";
	} catch {
		return true;
	}
}

function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);

	const toggleSidebar = useCallback(() => {
		setSidebarOpen((current) => {
			const next = !current;
			if (isDesktop()) {
				try {
					localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? "open" : "closed");
				} catch {
					// Storage can be unavailable; the choice then lasts for this page only.
				}
			}
			return next;
		});
	}, []);

	useGlobalCommands(toggleSidebar);

	// Crossing the breakpoint resets the sidebar: a drawer on phones, an open column on desktop.
	useEffect(() => {
		const query = window.matchMedia(DESKTOP_QUERY);
		const onChange = (event: MediaQueryListEvent) => setSidebarOpen(event.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return (
		<div className="flex h-full overflow-hidden">
			{/* Selecting a session only closes the drawer on phones; on desktop the column stays. */}
			<Sidebar
				open={sidebarOpen}
				onNavigate={() => {
					if (!isDesktop()) setSidebarOpen(false);
				}}
			/>
			{sidebarOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/60 lg:hidden"
					onClick={() => setSidebarOpen(false)}
					aria-hidden="true"
				/>
			)}
			<ChatPanel onToggleSidebar={toggleSidebar} />
			<Toast />
		</div>
	);
}

/** Commands that make sense anywhere in the app, regardless of the open session. */
function useGlobalCommands(toggleSidebar: () => void) {
	const { sessions, activeSessionId, createSession, selectSession, refreshProviders } = useHarness();
	const { theme, toggleTheme } = useTheme();
	const providersPalette = useProviderPalette();
	const defaultsPalette = useDefaultsPalette();

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
			id: "defaults.open",
			title: "Defaults…",
			group: "App",
			keywords: ["default", "model", "thinking", "reasoning", "target", "folder", "new session"],
			icon: <SlidersIcon />,
			run: ({ pushPage }) => pushPage(defaultsPalette.page()),
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
			keys: SHORTCUTS.sidebar,
			run: () => toggleSidebar(),
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
