import type { TargetInfo } from "@harness/protocol";
import { CheckIcon, FilePlusIcon, FolderIcon, TerminalIcon } from "../components/icons.tsx";
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
	if (target === undefined || target.scratch) return "Scratch";
	return target.path;
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

/** The target picker: the session's scratch directory, or a folder from the browser. */
export function useTargetPalette(): { page(): CommandPage; open(): void } {
	const { activeSessionId, sessions, setTarget, browseWorkspaces, createWorkspaceFolder } = useHarness();
	const { openPage } = useCommandPalette();
	const session = sessions.find((candidate) => candidate.id === activeSessionId);
	const current = session?.target;

	const browse = (path?: string): CommandPage =>
		folderPage(async () =>
			buildFolderPage(
				await browseWorkspaces(path),
				browse,
				(folder) => void setTarget({ kind: "local", path: folder }),
				createWorkspaceFolder,
			),
		);

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
				current: current?.scratch === true,
				run: () => void setTarget({ kind: "local" }),
			},
			{
				id: "target.folder",
				title: "Choose a folder…",
				group: "Target",
				detail: current !== undefined && !current.scratch ? current.path : undefined,
				icon: <FolderIcon />,
				current: current !== undefined && !current.scratch,
				run: ({ pushPage }) => pushPage(browse()),
			},
		],
	});

	return { page, open: () => openPage(page()) };
}

/** The default target new sessions start with. */
export function useDefaultTargetPalette(): { page(): CommandPage; open(): void } {
	const { defaults, setDefaults, browseWorkspaces, createWorkspaceFolder } = useHarness();
	const { openPage } = useCommandPalette();
	const current = defaults.target;
	const isFolder = current?.path !== undefined && current.path !== "";

	const browse = (path?: string): CommandPage =>
		folderPage(async () =>
			buildFolderPage(
				await browseWorkspaces(path),
				browse,
				(folder) => void setDefaults({ target: { kind: "local", path: folder } }),
				createWorkspaceFolder,
			),
		);

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
				current: !isFolder,
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
		],
	});

	return { page, open: () => openPage(page()) };
}
