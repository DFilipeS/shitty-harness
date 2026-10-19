import { useState } from "react";
import type {
	ProviderTemplateInfo,
	SandboxSourceChoice,
	TargetInfo,
	TemplateInfo,
} from "@harness/protocol";
import {
	CheckIcon,
	ClockIcon,
	FilePlusIcon,
	FolderIcon,
	KeyIcon,
	LayersIcon,
	TerminalIcon,
} from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { recentFolders, rememberFolder } from "./recent-folders.ts";
import { useHarness } from "./store.tsx";
import { buildTemplatePickerPage } from "./template-commands.tsx";

type FolderListing = {
	path: string;
	parent?: string;
	directories: { name: string; path: string }[];
};

/** A loading page that fetches one folder listing and turns it into a command page. */
function folderPage(load: () => Promise<CommandPage>): CommandPage {
	return { kind: "loading", title: "Choose a folder", load };
}

/** A short label for the target, used as the composer chip and the palette's current marker. */
export function targetLabel(target: TargetInfo | undefined): string {
	if (target === undefined) return "Scratch";
	if (target.kind === "local") return target.scratch ? "Scratch" : target.path;
	if (target.sandboxId === undefined) return "New sandbox";
	return `${target.providerName}:${target.sandboxId.slice(0, 8)}`;
}

/** The last segment of a folder path, e.g. "project" for "/Users/me/project". */
function folderName(path: string): string {
	const segments = path.split(/[/\\]/).filter((segment) => segment !== "");
	return segments[segments.length - 1] ?? path;
}

/** The folder browser: pick a recent, use the current folder, walk into a child, go up, or create one. */
export function buildFolderPage(
	listing: FolderListing,
	browse: (path: string) => CommandPage,
	choose: (path: string) => void,
	createFolder: (parent: string, name: string) => Promise<{ path: string } | undefined>,
): CommandPage {
	const chooseFolder = (path: string): void => {
		rememberFolder(path);
		choose(path);
	};
	const commands: Command[] = [];
	for (const folder of recentFolders()) {
		if (folder === listing.path) continue;
		commands.push({
			id: `folder.recent.${folder}`,
			title: folderName(folder),
			group: "Recent",
			detail: folder,
			keywords: [folder],
			icon: <ClockIcon />,
			run: () => chooseFolder(folder),
		});
	}
	commands.push({
		id: "folder.choose",
		title: "Use this folder",
		group: "Folder",
		detail: listing.path,
		icon: <CheckIcon />,
		run: () => chooseFolder(listing.path),
	});
	if (listing.parent !== undefined) {
		const parent = listing.parent;
		commands.push({
			id: "folder.up",
			title: "Go up",
			group: "Folder",
			detail: parent,
			icon: <FolderIcon />,
			run: ({ pushPage }) => pushPage(browse(parent)),
		});
	}
	for (const directory of listing.directories) {
		commands.push({
			id: `folder.${directory.path}`,
			title: directory.name,
			group: "Folders",
			icon: <FolderIcon />,
			run: ({ pushPage }) => pushPage(browse(directory.path)),
		});
	}
	commands.push({
		id: "folder.new",
		title: "New folder…",
		group: "Folder",
		icon: <FilePlusIcon />,
		run: ({ prompt }) =>
			prompt({
				title: `New folder in ${listing.path}`,
				placeholder: "Folder name",
				onSubmit: (value) => {
					const name = value.trim();
					if (name === "") return false;
					void createFolder(listing.path, name).then((created) => {
						if (created !== undefined) chooseFolder(created.path);
					});
				},
			}),
	});
	return { kind: "commands", title: "Choose a folder", placeholder: "Search folders…", commands };
}

/** What the new-sandbox dialog hands to `create`. */
export type NewSandboxChoice = {
	source: SandboxSourceChoice;
	forwardAgent: boolean;
	/** The template a new sandbox starts from; `null` is the provider's own default. */
	template: string | null;
};

/**
 * The new-sandbox dialog: the template a sandbox starts from, its workspace source, and whether the
 * host SSH agent is forwarded. It creates nothing itself; `create` does.
 */
export function buildNewSandboxPage(options: {
	forwardAgent: boolean;
	/** The template that applies now; undefined is the provider default. */
	template?: string;
	templates: TemplateInfo[];
	other: ProviderTemplateInfo[];
	chooseTemplate(template: string | null): void;
	toggleForwardAgent(): void;
	create(choice: NewSandboxChoice): void;
}): CommandPage {
	const template = options.template;
	const choice = (source: SandboxSourceChoice): NewSandboxChoice => ({
		source,
		forwardAgent: options.forwardAgent,
		template: template ?? null,
	});
	return {
		kind: "commands",
		title: "New sandbox",
		placeholder: "Choose the starting point…",
		commands: [
			{
				id: "sandbox.new.template",
				title: "Template",
				group: "New sandbox",
				detail: template ?? "provider default",
				icon: <LayersIcon />,
				run: ({ pushPage }) =>
					pushPage(
						buildTemplatePickerPage({
							idPrefix: "sandbox.new.template",
							title: "Sandbox template",
							templates: options.templates,
							other: options.other,
							...(template === undefined ? {} : { current: template }),
							select: options.chooseTemplate,
						}),
					),
			},
			{
				id: "sandbox.new.empty",
				title: "Empty workspace",
				group: "New sandbox",
				detail: "Start with an empty directory",
				icon: <TerminalIcon />,
				run: () => options.create(choice({ kind: "empty" })),
			},
			{
				id: "sandbox.new.git",
				title: "Clone a Git repository…",
				group: "New sandbox",
				detail: "Clone a repository into the new sandbox",
				icon: <FolderIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "Git repository URL",
						placeholder: "https://github.com/owner/repo.git",
						onSubmit: (value) => {
							const url = value.trim();
							if (url === "") return false;
							options.create(choice({ kind: "git", url }));
						},
					}),
			},
			{
				id: "sandbox.new.forward",
				title: options.forwardAgent ? "Forward SSH agent: on" : "Forward SSH agent: off",
				group: "New sandbox",
				detail: options.forwardAgent
					? "Private repositories and git push work"
					: "The host keys stay out of the sandbox",
				icon: <KeyIcon />,
				current: options.forwardAgent,
				keepOpen: true,
				run: ({ replacePage }) => {
					options.toggleForwardAgent();
					replacePage(buildNewSandboxPage({ ...options, forwardAgent: !options.forwardAgent }));
				},
			},
		],
	};
}

/** The target picker: the session's scratch directory, a folder, or a sandbox. */
export function useTargetPalette(): { page(): CommandPage; open(): void } {
	const {
		activeSessionId,
		sessions,
		setTarget,
		browseWorkspaces,
		createWorkspaceFolder,
		sandboxes,
		sandboxProvider,
		sandboxSettings,
		configureSandbox,
		templates,
		templatesOther,
	} = useHarness();
	const { openPage } = useCommandPalette();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	const current = session?.target;
	const configured = sandboxSettings?.configured === true;
	// The new-sandbox toggle; undefined follows the stored default.
	const [forwardOverride, setForwardOverride] = useState<boolean | undefined>(undefined);
	const forwardAgent = forwardOverride ?? sandboxSettings?.forwardAgent ?? true;
	// The new-sandbox template; undefined follows the stored default, null means provider default.
	const [templateOverride, setTemplateOverride] = useState<string | null | undefined>(undefined);
	const selectedTemplate =
		templateOverride === undefined ? sandboxSettings?.template : (templateOverride ?? undefined);

	const browse = (path?: string): CommandPage =>
		folderPage(async () =>
			buildFolderPage(
				await browseWorkspaces(path),
				browse,
				(folder) => void setTarget({ kind: "local", path: folder }),
				createWorkspaceFolder,
			),
		);

	const newSandbox = (): CommandPage =>
		buildNewSandboxPage({
			forwardAgent,
			...(selectedTemplate === undefined ? {} : { template: selectedTemplate }),
			templates,
			other: templatesOther,
			chooseTemplate: (template) => setTemplateOverride(template),
			toggleForwardAgent: () => setForwardOverride(!forwardAgent),
			create: (choice) =>
				void setTarget({
					kind: "sandbox",
					source: choice.source,
					forwardAgent: choice.forwardAgent,
					template: choice.template,
				}),
		});

	const existingSandbox = (): CommandPage => ({
		kind: "commands",
		title: "Existing sandboxes",
		placeholder: "Search sandboxes…",
		commands:
			sandboxes.length === 0
				? [
						{
							id: "sandbox.existing.none",
							title: "No sandboxes yet",
							group: "Sandboxes",
							detail: "Create one from New sandbox…",
							run: () => {},
						},
					]
				: sandboxes.map((sandbox) => ({
						id: `sandbox.existing.${sandbox.id}`,
						title: sandbox.name ?? sandbox.id.slice(0, 12),
						group: "Sandboxes",
						detail: `${sandbox.state}${sandbox.working ? " · working" : ""} · ${sandbox.workspaceDir}`,
						current: current?.kind === "sandbox" && current.sandboxId === sandbox.id,
						run: () =>
							void setTarget({
								kind: "sandbox",
								provider: sandbox.provider,
								sandboxId: sandbox.id,
								workspaceDir: sandbox.workspaceDir,
								forwardAgent,
							}),
					})),
	});

	const sandboxCommands: Command[] = configured
		? [
				{
					id: "target.sandbox.new",
					title: "New sandbox…",
					group: "Sandbox",
					detail: "Create a fresh sandbox for this session",
					icon: <TerminalIcon />,
					current: current?.kind === "sandbox" && current.sandboxId === undefined,
					run: ({ pushPage }) => pushPage(newSandbox()),
				},
				{
					id: "target.sandbox.existing",
					title: "Existing sandbox…",
					group: "Sandbox",
					detail: sandboxes.length === 0 ? "None yet" : `${sandboxes.length} available`,
					icon: <LayersIcon />,
					current: current?.kind === "sandbox" && current.sandboxId !== undefined,
					run: ({ pushPage }) => pushPage(existingSandbox()),
				},
			]
		: [
				{
					id: "target.sandbox.configure",
					title: `Configure ${sandboxSettings?.providerName ?? sandboxProvider}…`,
					group: "Sandbox",
					detail: "Add an API key to use sandboxes",
					icon: <KeyIcon />,
					run: ({ prompt }) =>
						prompt({
							title: `${sandboxSettings?.providerName ?? sandboxProvider} API key`,
							secret: true,
							onSubmit: (value) => {
								const key = value.trim();
								if (key === "") return false;
								void configureSandbox(sandboxProvider, key);
							},
						}),
				},
			];

	const page = (): CommandPage => ({
		kind: "commands",
		title: "Change target",
		placeholder: "Search targets…",
		commands: [
			{
				id: "target.scratch",
				title: "Scratch directory",
				group: "Target",
				detail: "A private folder for this session",
				icon: <TerminalIcon />,
				current: current?.kind === "local" && current.scratch === true,
				run: () => void setTarget({ kind: "local" }),
			},
			{
				id: "target.folder",
				title: "Choose a folder…",
				group: "Target",
				detail: current?.kind === "local" && !current.scratch ? current.path : undefined,
				icon: <FolderIcon />,
				current: current?.kind === "local" && !current.scratch,
				run: ({ pushPage }) => pushPage(browse()),
			},
			...sandboxCommands,
		],
	});

	return { page, open: () => openPage(page()) };
}

/** The default target new sessions start with. */
export function useDefaultTargetPalette(): { page(): CommandPage; open(): void } {
	const { defaults, setDefaults, browseWorkspaces, createWorkspaceFolder, sandboxSettings } =
		useHarness();
	const { openPage } = useCommandPalette();
	const current = defaults.target;
	const isFolder = current?.kind === "local" && current.path !== undefined && current.path !== "";
	const configured = sandboxSettings?.configured === true;

	const browse = (path?: string): CommandPage =>
		folderPage(async () =>
			buildFolderPage(
				await browseWorkspaces(path),
				browse,
				(folder) => void setDefaults({ target: { kind: "local", path: folder } }),
				createWorkspaceFolder,
			),
		);

	const sandboxCommands: Command[] = configured
		? [
				{
					id: "default.target.sandbox",
					title: "New sandbox",
					group: "Defaults",
					detail: "Each session creates its own sandbox",
					icon: <TerminalIcon />,
					current: current?.kind === "sandbox",
					run: () => void setDefaults({ target: { kind: "sandbox" } }),
				},
			]
		: [];

	const page = (): CommandPage => ({
		kind: "commands",
		title: "Default target",
		placeholder: "Search targets…",
		commands: [
			{
				id: "default.target.scratch",
				title: "Scratch directory",
				group: "Defaults",
				detail: "Each session gets its own folder",
				icon: <TerminalIcon />,
				current: current === undefined || current.kind === "local",
				run: () => void setDefaults({ target: null }),
			},
			{
				id: "default.target.folder",
				title: "Choose a folder…",
				group: "Defaults",
				detail: isFolder ? current.path : undefined,
				icon: <FolderIcon />,
				current: isFolder,
				run: ({ pushPage }) => pushPage(browse()),
			},
			...sandboxCommands,
		],
	});

	return { page, open: () => openPage(page()) };
}
