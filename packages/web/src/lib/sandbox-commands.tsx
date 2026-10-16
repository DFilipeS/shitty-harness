import type { SandboxInfo } from "@harness/protocol";
import { CheckIcon, KeyIcon, RefreshIcon, SlidersIcon, TerminalIcon, TrashIcon } from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { formatBytes } from "./format.ts";
import { useHarness } from "./store.tsx";

/** The sandboxes page: list, connect, pause, resume, kill, metrics, and provider settings. */
export function useSandboxesPalette(): { page(): CommandPage; open(): void } {
	const {
		sandboxes,
		sandboxProvider,
		sandboxSettings,
		activeSessionId,
		setTarget,
		refreshSandboxes,
		createSandbox,
		pauseSandbox,
		resumeSandbox,
		killSandbox,
		sandboxMetrics,
		configureSandbox,
		setSandboxSettings,
	} = useHarness();
	const { openPage } = useCommandPalette();
	const configured = sandboxSettings?.configured === true;
	const providerLabel = sandboxSettings?.providerName ?? sandboxProvider;

	const configurePage = (): CommandPage => ({
		kind: "commands",
		title: `Configure ${providerLabel}`,
		placeholder: "Settings…",
		commands: [
			{
				id: "sandbox.configure.key",
				title: sandboxSettings?.configured === true ? "Replace API key…" : "Set API key…",
				group: "Credentials",
				icon: <KeyIcon />,
				run: ({ prompt }) =>
					prompt({
						title: `${providerLabel} API key`,
						secret: true,
						onSubmit: (value) => {
							const key = value.trim();
							if (key === "") return false;
							void configureSandbox(sandboxProvider, key);
						},
					}),
			},
			{
				id: "sandbox.configure.clear",
				title: "Remove API key",
				group: "Credentials",
				detail: "Sandbox options disappear until a key is set again",
				when: () => sandboxSettings?.configured === true,
				run: () => void configureSandbox(sandboxProvider, null),
			},
		],
	});

	const settingsPage = (): CommandPage => ({
		kind: "commands",
		title: "Sandbox defaults",
		placeholder: "Settings…",
		commands: [
			{
				id: "sandbox.settings.template",
				title: "Template",
				group: "Defaults",
				detail: sandboxSettings?.template ?? "provider default",
				icon: <SlidersIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "Sandbox template",
						initialValue: sandboxSettings?.template ?? "",
						placeholder: "base",
						onSubmit: (value) => {
							const template = value.trim();
							void setSandboxSettings({ template: template === "" ? null : template });
						},
					}),
			},
			{
				id: "sandbox.settings.idle",
				title: "Idle timeout",
				group: "Defaults",
				detail: `${Math.round((sandboxSettings?.idleTimeoutMs ?? 0) / 60_000)} min`,
				icon: <SlidersIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "Idle timeout in minutes",
						initialValue: String(Math.round((sandboxSettings?.idleTimeoutMs ?? 0) / 60_000)),
						onSubmit: (value) => {
							const minutes = Number(value.trim());
							if (!Number.isFinite(minutes) || minutes < 0) return false;
							void setSandboxSettings({ idleTimeoutMs: Math.round(minutes * 60_000) });
						},
					}),
			},
			{
				id: "sandbox.settings.autopause",
				title: sandboxSettings?.autoPause === true ? "Auto-pause: on" : "Auto-pause: off",
				group: "Defaults",
				detail: "Pause when idle instead of killing",
				icon: <SlidersIcon />,
				run: () => void setSandboxSettings({ autoPause: sandboxSettings?.autoPause !== true }),
			},
			{
				id: "sandbox.settings.forward",
				title: sandboxSettings?.forwardAgent === true ? "Forward SSH agent: on" : "Forward SSH agent: off",
				group: "Defaults",
				detail: "Default for new sandboxes",
				icon: <KeyIcon />,
				run: () => void setSandboxSettings({ forwardAgent: sandboxSettings?.forwardAgent !== true }),
			},
			{
				id: "sandbox.settings.agent-socket",
				title: "SSH agent socket",
				group: "Defaults",
				detail: sandboxSettings?.sshAgentSocket ?? "Detected automatically",
				icon: <KeyIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "SSH agent socket",
						initialValue: sandboxSettings?.sshAgentSocket ?? "",
						placeholder: "$SSH_AUTH_SOCK",
						onSubmit: (value) => {
							const socket = value.trim();
							void setSandboxSettings({ sshAgentSocket: socket === "" ? null : socket });
						},
					}),
			},
		],
	});

	const metricsPage = (sandbox: SandboxInfo): CommandPage => ({
		kind: "loading",
		title: "Sandbox metrics",
		load: async () => {
			const metrics = await sandboxMetrics(sandbox.provider, sandbox.id);
			const commands: Command[] =
				metrics === undefined
					? [{ id: "metrics.none", title: "No metrics yet", group: "Metrics", run: () => {} }]
					: [
							{
								id: "metrics.cpu",
								title: `CPU: ${metrics.cpuUsedPct === undefined ? "?" : `${metrics.cpuUsedPct.toFixed(0)}%`} of ${metrics.cpuCount ?? "?"} cores`,
								group: "Metrics",
								run: () => {},
							},
							{
								id: "metrics.memory",
								title: `Memory: ${metrics.memoryUsedBytes === undefined ? "?" : formatBytes(metrics.memoryUsedBytes)} of ${metrics.memoryTotalBytes === undefined ? "?" : formatBytes(metrics.memoryTotalBytes)}`,
								group: "Metrics",
								run: () => {},
							},
							{
								id: "metrics.disk",
								title: `Disk: ${metrics.diskUsedBytes === undefined ? "?" : formatBytes(metrics.diskUsedBytes)} of ${metrics.diskTotalBytes === undefined ? "?" : formatBytes(metrics.diskTotalBytes)}`,
								group: "Metrics",
								run: () => {},
							},
						];
			return { kind: "commands", title: "Sandbox metrics", placeholder: "Metrics…", commands };
		},
	});

	const sandboxPage = (sandbox: SandboxInfo): CommandPage => ({
		kind: "commands",
		title: sandbox.name ?? sandbox.id,
		placeholder: "Actions…",
		commands: [
			{
				id: "sandbox.use",
				title: "Use in this session",
				group: "Actions",
				detail: sandbox.workspaceDir,
				icon: <CheckIcon />,
				when: () => activeSessionId !== undefined,
				run: () =>
					void setTarget({
						kind: "sandbox",
						provider: sandbox.provider,
						sandboxId: sandbox.id,
						workspaceDir: sandbox.workspaceDir,
					}),
			},
			sandbox.state === "running"
				? {
						id: "sandbox.pause",
						title: "Pause",
						group: "Actions",
						detail: "Keeps the files and stops the compute",
						run: () => void pauseSandbox(sandbox.provider, sandbox.id),
					}
				: {
						id: "sandbox.resume",
						title: "Resume",
						group: "Actions",
						run: () => void resumeSandbox(sandbox.provider, sandbox.id),
					},
			{
				id: "sandbox.metrics",
				title: "Show metrics…",
				group: "Actions",
				run: ({ pushPage }) => pushPage(metricsPage(sandbox)),
			},
			{
				id: "sandbox.kill",
				title: "Kill sandbox…",
				group: "Danger",
				detail: "The files are lost",
				icon: <TrashIcon />,
				run: ({ pushPage }) =>
					pushPage({
						kind: "commands",
						title: "Kill sandbox",
						placeholder: "Confirm…",
						commands: [
							{
								id: "sandbox.kill.confirm",
								title: `Kill ${sandbox.name ?? sandbox.id}`,
								group: "Confirm",
								detail: "Cannot be undone",
								icon: <TrashIcon />,
								run: () => void killSandbox(sandbox.provider, sandbox.id),
							},
							{ id: "sandbox.kill.cancel", title: "Cancel", group: "Confirm", run: () => {} },
						],
					}),
			},
		],
	});

	const sandboxCommands: Command[] = configured
		? sandboxes.map((sandbox): Command => ({
				id: `sandbox.manage.${sandbox.id}`,
				title: sandbox.name ?? sandbox.id.slice(0, 12),
				group: "Sandboxes",
				detail: `${sandbox.state}${sandbox.working ? " · working" : ""}${sandbox.forwarding ? " · SSH agent" : ""}${sandbox.sessions.length > 0 ? ` · ${sandbox.sessions.length} session${sandbox.sessions.length === 1 ? "" : "s"}` : ""}`,
				run: ({ pushPage }) => pushPage(sandboxPage(sandbox)),
			}))
		: [
				{
					id: "sandbox.configure",
					title: `Configure ${providerLabel}…`,
					group: "Sandboxes",
					detail: "Add an API key to use sandboxes",
					icon: <KeyIcon />,
					run: ({ pushPage }) => pushPage(configurePage()),
				},
			];
	const emptyCommands: Command[] =
		sandboxes.length === 0 && configured
			? [
					{
						id: "sandbox.none",
						title: "No sandboxes yet",
						group: "Sandboxes",
						detail: "Create one from a session's target picker",
						run: () => {},
					},
				]
			: [];

	const page = (): CommandPage => ({
		kind: "commands",
		title: "Sandboxes",
		placeholder: "Search sandboxes…",
		commands: [
			...sandboxCommands,
			...emptyCommands,
			{
				id: "sandbox.create",
				title: "New sandbox…",
				group: "Sandboxes",
				detail: "Create one now and connect a session later",
				icon: <TerminalIcon />,
				when: () => configured,
				run: () => void createSandbox({ source: { kind: "empty" } }),
			},
			{
				id: "sandbox.settings",
				title: "Sandbox defaults…",
				group: "Settings",
				icon: <SlidersIcon />,
				run: ({ pushPage }) => pushPage(settingsPage()),
			},
			{
				id: "sandbox.refresh",
				title: "Refresh sandboxes",
				group: "Settings",
				icon: <RefreshIcon />,
				run: () => void refreshSandboxes(),
			},
		],
	});

	return { page, open: () => openPage(page()) };
}
