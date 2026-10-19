import type {
	ProviderTemplateInfo,
	SandboxInfo,
	SandboxesState,
	SandboxSettingsInfo,
	TemplateInfo,
} from "@harness/protocol";
import {
	CheckIcon,
	KeyIcon,
	RefreshIcon,
	SlidersIcon,
	TerminalIcon,
	TrashIcon,
} from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { formatBytes } from "./format.ts";
import { useHarness } from "./store.tsx";
import { buildTemplatePickerPage } from "./template-commands.tsx";

type SandboxSettingsChange = {
	provider?: string;
	template?: string | null;
	idleTimeoutMs?: number | null;
	autoPause?: boolean | null;
	sshAgentSocket?: string | null;
	forwardAgent?: boolean | null;
};

type SettingsPatch = {
	template?: string | undefined;
	sshAgentSocket?: string | undefined;
	idleTimeoutMs?: number;
	autoPause?: boolean;
	forwardAgent?: boolean;
};

/** Applies a change to the settings the page shows, so a row updates before the server answers. */
function withChange(
	settings: SandboxSettingsInfo | undefined,
	change: SettingsPatch,
): SandboxSettingsInfo | undefined {
	return settings === undefined ? undefined : { ...settings, ...change };
}

/**
 * The sandbox defaults page. A row shows its new value right away, then the page is rebuilt from
 * the settings the server returns, so the palette stays open and ends up quoting the server.
 */
export function buildSandboxSettingsPage(
	settings: SandboxSettingsInfo | undefined,
	setSettings: (change: SandboxSettingsChange) => Promise<SandboxesState | undefined>,
	templates: { list: TemplateInfo[]; other: ProviderTemplateInfo[] } = { list: [], other: [] },
): CommandPage {
	const page = (current: SandboxSettingsInfo | undefined): CommandPage => ({
		kind: "commands",
		title: "Sandbox defaults",
		placeholder: "Settings…",
		commands: [
			{
				id: "sandbox.settings.template",
				title: "Template",
				group: "Defaults",
				detail: current?.template ?? "provider default",
				icon: <SlidersIcon />,
				run: ({ pushPage }) =>
					pushPage(
						buildTemplatePickerPage({
							idPrefix: "sandbox.settings.template",
							title: "Sandbox template",
							templates: templates.list,
							other: templates.other,
							...(current?.template === undefined ? {} : { current: current.template }),
							select: (template) => void setSettings({ template: template ?? null }),
						}),
					),
			},
			{
				id: "sandbox.settings.idle",
				title: "Idle timeout",
				group: "Defaults",
				detail: `${Math.round((current?.idleTimeoutMs ?? 0) / 60_000)} min`,
				icon: <SlidersIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "Idle timeout in minutes",
						initialValue: String(Math.round((current?.idleTimeoutMs ?? 0) / 60_000)),
						returnToPage: true,
						onSubmit: async (value) => {
							const minutes = Number(value.trim());
							if (!Number.isFinite(minutes) || minutes < 0) return false;
							const idleTimeoutMs = Math.round(minutes * 60_000);
							replacePage(page(withChange(current, { idleTimeoutMs })));
							const state = await setSettings({ idleTimeoutMs });
							if (state !== undefined) replacePage(page(state.settings));
						},
					}),
			},
			{
				id: "sandbox.settings.autopause",
				title: current?.autoPause === true ? "Auto-pause: on" : "Auto-pause: off",
				group: "Defaults",
				detail: "Pause when idle instead of killing",
				icon: <SlidersIcon />,
				keepOpen: true,
				run: async ({ replacePage }) => {
					const autoPause = current?.autoPause !== true;
					replacePage(page(withChange(current, { autoPause })));
					const state = await setSettings({ autoPause });
					if (state !== undefined) replacePage(page(state.settings));
				},
			},
			{
				id: "sandbox.settings.forward",
				title: current?.forwardAgent === true ? "Forward SSH agent: on" : "Forward SSH agent: off",
				group: "Defaults",
				detail: "Default for new sandboxes",
				icon: <KeyIcon />,
				keepOpen: true,
				run: async ({ replacePage }) => {
					const forwardAgent = current?.forwardAgent !== true;
					replacePage(page(withChange(current, { forwardAgent })));
					const state = await setSettings({ forwardAgent });
					if (state !== undefined) replacePage(page(state.settings));
				},
			},
			{
				id: "sandbox.settings.agent-socket",
				title: "SSH agent socket",
				group: "Defaults",
				detail: current?.sshAgentSocket ?? "Detected automatically",
				icon: <KeyIcon />,
				run: ({ prompt, replacePage }) =>
					prompt({
						title: "SSH agent socket",
						initialValue: current?.sshAgentSocket ?? "",
						placeholder: "$SSH_AUTH_SOCK",
						returnToPage: true,
						onSubmit: async (value) => {
							const socket = value.trim();
							replacePage(
								page(withChange(current, { sshAgentSocket: socket === "" ? undefined : socket })),
							);
							const state = await setSettings({ sshAgentSocket: socket === "" ? null : socket });
							if (state !== undefined) replacePage(page(state.settings));
						},
					}),
			},
		],
	});
	return page(settings);
}

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
		templates,
		templatesOther,
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

	const settingsPage = (): CommandPage =>
		buildSandboxSettingsPage(sandboxSettings, setSandboxSettings, {
			list: templates,
			other: templatesOther,
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
						keepOpen: true,
						run: async ({ replacePage }) => {
							const state = await pauseSandbox(sandbox.provider, sandbox.id);
							const fresh = state?.sandboxes.find((candidate) => candidate.id === sandbox.id);
							if (fresh !== undefined) replacePage(sandboxPage(fresh));
						},
					}
				: {
						id: "sandbox.resume",
						title: "Resume",
						group: "Actions",
						keepOpen: true,
						run: async ({ replacePage }) => {
							const state = await resumeSandbox(sandbox.provider, sandbox.id);
							const fresh = state?.sandboxes.find((candidate) => candidate.id === sandbox.id);
							if (fresh !== undefined) replacePage(sandboxPage(fresh));
						},
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
				keepOpen: true,
				run: async ({ replacePage }) => {
					const state = await refreshSandboxes();
					if (state !== undefined) replacePage(page());
				},
			},
		],
	});

	return { page, open: () => openPage(page()) };
}
