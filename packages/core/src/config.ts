import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Per-provider credentials. Only API keys for now. */
export type ProviderConfig = {
	apiKey?: string;
};

/** Model and thinking level applied to new sessions. */
export type DefaultsConfig = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: ModelThinkingLevel;
};

/** Everything stored in `data/config.json`. */
export type AppConfig = {
	providers: Record<string, ProviderConfig>;
	defaults?: DefaultsConfig;
};

export function emptyConfig(): AppConfig {
	return { providers: {} };
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseDefaults(value: unknown): DefaultsConfig | undefined {
	if (!isRecord(value)) return undefined;
	const defaults: DefaultsConfig = {};
	const model = value.model;
	if (isRecord(model) && typeof model.provider === "string" && typeof model.modelId === "string") {
		defaults.model = { provider: model.provider, modelId: model.modelId };
	}
	const level = value.thinkingLevel;
	if (typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level)) {
		defaults.thinkingLevel = level as ModelThinkingLevel;
	}
	return Object.keys(defaults).length === 0 ? undefined : defaults;
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

	const defaults = parseDefaults(parsed.defaults);
	return { providers, ...(defaults === undefined ? {} : { defaults }) };
}

export async function saveConfig(path: string, config: AppConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}
