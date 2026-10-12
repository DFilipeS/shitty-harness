import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A `ModelsStore` that keeps dynamic provider catalogs in one JSON file, so the model list is
 * available on the next start without waiting for a network refresh. The file is a cache: a
 * missing or unreadable file just starts empty.
 */
export class FileModelsStore implements ModelsStore {
	readonly #path: string;
	#entries: Record<string, ModelsStoreEntry> | undefined;
	#queue: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async #load(): Promise<Record<string, ModelsStoreEntry>> {
		if (this.#entries !== undefined) return this.#entries;
		let entries: Record<string, ModelsStoreEntry> = {};
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (isRecord(parsed)) entries = parsed as Record<string, ModelsStoreEntry>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`[core] ignoring unreadable model cache ${this.#path}:`, error);
			}
		}
		this.#entries = entries;
		return entries;
	}

	#persist(entries: Record<string, ModelsStoreEntry>): Promise<void> {
		const snapshot = { ...entries };
		const run = this.#queue.then(async () => {
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = `${this.#path}.tmp`;
			await writeFile(temporary, `${JSON.stringify(snapshot, null, "\t")}\n`, "utf8");
			await rename(temporary, this.#path);
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async read(providerId: string, _options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		return (await this.#load())[providerId];
	}

	async write(providerId: string, entry: ModelsStoreEntry, _options?: ModelsStoreOperationOptions): Promise<void> {
		const entries = await this.#load();
		entries[providerId] = entry;
		await this.#persist(entries);
	}

	async delete(providerId: string, _options?: ModelsStoreOperationOptions): Promise<void> {
		const entries = await this.#load();
		delete entries[providerId];
		await this.#persist(entries);
	}
}
