import type { TargetInfo } from "@harness/protocol";
import { CheckIcon, FilePlusIcon, FolderIcon, KeyIcon, LayersIcon, TerminalIcon } from "../components/icons.tsx";
import { useCommandPalette, type Command, type CommandPage } from "./commands.tsx";
import { useHarness } from "./store.tsx";

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
	return `${target.provider}:${target.sandboxId.slice(0, 8)}`;
}

/** The folder browser: use the current folder, walk into a child, go up, or create a new folder. */
export function buildFolderPage(
	listing: FolderListing,
	browse: (path: string) => CommandPage,
	choose: (path: string) => void,
	createFolder: (parent: string, name: string) => Promise<{ path: string } | undefined>,
): CommandPage {
	const commands: Command[] = [
		{
			id: "folder.choose",
			title: "Use this folder",
			group: "Folder",
			detail: listing.path,
			icon: <CheckIcon />,
			run: () => choose(listing.path),
		},
	];
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
						if (created !== undefined) choose(created.path);
					});
				},
			}),
	});
	return { kind: "commands", title: "Choose a folder", placeholder: "Search folders…", commands };
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
	} = useHarness();
	const { openPage } = useCommandPalette();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	const current = session?.target;
	const configured = sandboxSettings?.configured === true;

	const browse = (path?: string): CommandPage =>
		folderPage(async () =>
			buildFolderPage(
				await browseWorkspaces(path),
				browse,
				(folder) => void setTarget({ kind: "local", path: folder }),
				createWorkspaceFolder,
			),
		);

	const newSandbox = (): CommandPage => ({
		kind: "commands",
		title: "New sandbox",
		placeholder: "Choose the starting point…",
		commands: [
			{
				id: "sandbox.new.empty",
				title: "Empty workspace",
				group: "New sandbox",
				detail: "Start with an empty directory",
				icon: <TerminalIcon />,
				run: () => void setTarget({ kind: "sandbox", source: { kind: "empty" } }),
			},
			{
				id: "sandbox.new.git",
				title: "Clone a Git repository…",
				group: "New sandbox",
				detail: "Public HTTPS or SSH with a forwarded agent",
				icon: <FolderIcon />,
				run: ({ prompt }) =>
					prompt({
						title: "Git repository URL",
						placeholder: "https://github.com/owner/repo.git",
						onSubmit: (value) => {
							const url = value.trim();
							if (url === "") return false;
							void setTarget({ kind: "sandbox", source: { kind: "git", url } });
						},
					}),
			},
		],
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
						detail: `${sandbox.state} · ${sandbox.workspaceDir}`,
						current: current?.kind === "sandbox" && current.sandboxId === sandbox.id,
						run: () =>
							void setTarget({
								kind: "sandbox",
								provider: sandbox.provider,
								sandboxId: sandbox.id,
								workspaceDir: sandbox.workspaceDir,
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
					title: `Configure ${sandboxProvider}…`,
					group: "Sandbox",
					detail: "Add an API key to use sandboxes",
					icon: <KeyIcon />,
					run: ({ prompt }) =>
						prompt({
							title: `${sandboxProvider} API key`,
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
	const { defaults, setDefaults, browseWorkspaces, createWorkspaceFolder, sandboxSettings } = useHarness();
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
