/** Folders chosen in the folder picker, remembered per browser. */
const STORAGE_KEY = "harness-recent-folders";

/** How many recent folders the picker offers. */
const LIMIT = 5;

/** The recent folders, most recent first; empty when storage is unavailable or holds junk. */
export function recentFolders(): string[] {
	let stored: unknown;
	try {
		stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
	} catch {
		return [];
	}
	if (!Array.isArray(stored)) return [];
	const folders: string[] = [];
	for (const entry of stored) {
		if (typeof entry === "string" && entry !== "" && !folders.includes(entry)) folders.push(entry);
	}
	return folders.slice(0, LIMIT);
}

/** Moves a folder to the front of the recents; a no-op when storage is unavailable. */
export function rememberFolder(path: string): void {
	const clean = path.trim();
	if (clean === "") return;
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(
				[clean, ...recentFolders().filter((folder) => folder !== clean)].slice(0, LIMIT),
			),
		);
	} catch {
		// Storage can be unavailable; the choice is then not remembered.
	}
}
