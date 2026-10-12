import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Per-provider credentials. Only API keys for now. */
export type ProviderConfig = {
	apiKey?: string;
};

/** Everything stored in `data/config.json`. */
export type AppConfig = {
	providers: Record<string, ProviderConfig>;
};

export function emptyConfig(): AppConfig {
	return { providers: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadConfig(path: string): Promise<AppConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
	}
	if (!isRecord(parsed)) return emptyConfig();

	const providers: Record<string, ProviderConfig> = {};
	if (isRecord(parsed.providers)) {
		for (const [id, value] of Object.entries(parsed.providers)) {
			if (!isRecord(value)) continue;
			const apiKey = value.apiKey;
			if (typeof apiKey === "string" && apiKey !== "") providers[id] = { apiKey };
		}
	}

	return { providers };
}

export async function saveConfig(path: string, config: AppConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}
