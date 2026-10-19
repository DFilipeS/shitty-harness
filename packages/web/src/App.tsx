import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { SessionPanel } from "./components/SessionPanel.tsx";
import { Toast } from "./components/Toast.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import {
	InfoIcon,
	KeyboardIcon,
	LayersIcon,
	MenuIcon,
	MoonIcon,
	PlusIcon,
	RefreshIcon,
	SettingsIcon,
	SlidersIcon,
	SunIcon,
	TerminalIcon,
	WandIcon,
} from "./components/icons.tsx";
import { CommandPaletteProvider, useRegisterCommands, type RootCommand } from "./lib/commands.tsx";
import { relativeTime } from "./lib/format.ts";
import { useProviderPalette } from "./lib/provider-commands.tsx";
import { useSandboxesPalette } from "./lib/sandbox-commands.tsx";
import { useDefaultsPalette } from "./lib/session-commands.tsx";
import { useTemplatesPalette } from "./lib/template-commands.tsx";
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
const SESSION_PANEL_STORAGE_KEY = "harness-session-panel";

/** The sidebar starts open on desktop and closed on phones; desktop remembers the choice. */
function initialSidebarOpen(): boolean {
	if (!isDesktop()) return false;
	try {
		return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "closed";
	} catch {
		return true;
	}
}

/** The session panel starts closed everywhere; desktop remembers the choice once toggled. */
function desktopPanelOpen(): boolean {
	try {
		return localStorage.getItem(SESSION_PANEL_STORAGE_KEY) === "open";
	} catch {
		return false;
	}
}

function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
	const [panelOpen, setPanelOpen] = useState(() => (isDesktop() ? desktopPanelOpen() : false));

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

	const togglePanel = useCallback(() => {
		setPanelOpen((current) => {
			const next = !current;
			if (isDesktop()) {
				try {
					localStorage.setItem(SESSION_PANEL_STORAGE_KEY, next ? "open" : "closed");
				} catch {
					// Storage can be unavailable; the choice then lasts for this page only.
				}
			}
			return next;
		});
	}, []);

	useGlobalCommands(toggleSidebar, togglePanel);

	// Crossing the breakpoint resets both columns: drawers on phones, open columns on desktop.
	useEffect(() => {
		const query = window.matchMedia(DESKTOP_QUERY);
		const onChange = (event: MediaQueryListEvent) => {
			setSidebarOpen(event.matches);
			// The panel keeps its remembered choice on desktop and closes on phones.
			setPanelOpen(event.matches ? desktopPanelOpen() : false);
		};
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return (
		<div className="flex h-full overflow-hidden">
			{/* Selecting a session only closes the drawers on phones; on desktop the columns stay. */}
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
			<ChatPanel onToggleSidebar={toggleSidebar} onToggleSessionPanel={togglePanel} />
			{panelOpen && (
				<div
					className="fixed inset-0 z-30 bg-black/60 lg:hidden"
					onClick={() => setPanelOpen(false)}
					aria-hidden="true"
				/>
			)}
			<SessionPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
			<Toast />
		</div>
	);
}

/** Commands that make sense anywhere in the app, regardless of the open session. */
function useGlobalCommands(toggleSidebar: () => void, togglePanel: () => void) {
	const { sessions, activeSessionId, createSession, selectSession, refreshProviders } =
		useHarness();
	const { theme, toggleTheme } = useTheme();
	const providersPalette = useProviderPalette();
	const defaultsPalette = useDefaultsPalette();
	const sandboxesPalette = useSandboxesPalette();
	const templatesPalette = useTemplatesPalette();

	const commands: RootCommand[] = [
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
			id: "sandboxes.open",
			title: "Manage sandboxes…",
			group: "App",
			keywords: ["sandbox", "e2b", "remote", "kill", "pause"],
			icon: <TerminalIcon />,
			run: ({ pushPage }) => pushPage(sandboxesPalette.page()),
		},
		{
			id: "templates.open",
			title: "Sandbox templates…",
			group: "App",
			keywords: ["template", "recipe", "build", "e2b", "environment", "image"],
			icon: <WandIcon />,
			run: ({ pushPage }) => pushPage(templatesPalette.page()),
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
			id: "session.panel.toggle",
			title: "Toggle session panel",
			group: "App",
			keywords: ["panel", "show", "hide", "drawer", "system prompt", "info"],
			icon: <InfoIcon />,
			keys: SHORTCUTS.sessionPanel,
			run: () => togglePanel(),
		},
		{
			id: "help.shortcuts",
			title: "Keyboard shortcuts",
			group: "App",
			keywords: ["keys", "bindings", "help"],
			icon: <KeyboardIcon />,
			run: ({ pushPage }) => pushPage({ kind: "shortcuts", title: "Keyboard shortcuts" }),
		},
	];

	useRegisterCommands("app", commands);
}
