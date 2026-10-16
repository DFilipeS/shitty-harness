import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Per-provider credentials. Only API keys for now. */
export type ProviderConfig = {
	apiKey?: string;
};

/** Where new sessions run. Local, or a fresh sandbox with the configured defaults. */
export type DefaultTargetConfig = { kind: "local"; path?: string } | { kind: "sandbox" };

/** Sandbox defaults and stored provider credentials. */
export type SandboxConfig = {
	provider?: string;
	template?: string;
	idleTimeoutMs?: number;
	autoPause?: boolean;
	providers?: Record<string, { apiKey?: string }>;
};

/** Model and thinking level applied to new sessions, plus the model `generate_image` uses. */
export type DefaultsConfig = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: ModelThinkingLevel;
	imageModel?: { provider: string; modelId: string };
	target?: DefaultTargetConfig;
};

/** Everything stored in `data/config.json`. */
export type AppConfig = {
	providers: Record<string, ProviderConfig>;
	defaults?: DefaultsConfig;
	sandboxes?: SandboxConfig;
};

export function emptyConfig(): AppConfig {
	return { providers: {} };
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function parseModelRef(value: unknown): { provider: string; modelId: string } | undefined {
	return isRecord(value) && typeof value.provider === "string" && typeof value.modelId === "string"
		? { provider: value.provider, modelId: value.modelId }
		: undefined;
}

function parseDefaults(value: unknown): DefaultsConfig | undefined {
	if (!isRecord(value)) return undefined;
	const defaults: DefaultsConfig = {};
	const model = parseModelRef(value.model);
	if (model !== undefined) defaults.model = model;
	const imageModel = parseModelRef(value.imageModel);
	if (imageModel !== undefined) defaults.imageModel = imageModel;
	const level = value.thinkingLevel;
	if (typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level)) {
		defaults.thinkingLevel = level as ModelThinkingLevel;
	}
	const target = parseDefaultTarget(value.target);
	if (target !== undefined) defaults.target = target;
	return Object.keys(defaults).length === 0 ? undefined : defaults;
}

/** A default target is valid only when it names a local folder or a fresh sandbox. */
function parseDefaultTarget(value: unknown): DefaultTargetConfig | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "sandbox") return { kind: "sandbox" };
	if (value.kind !== "local") return undefined;
	if (value.path === undefined) return { kind: "local" };
	return typeof value.path === "string" && value.path !== "" ? { kind: "local", path: value.path } : undefined;
}

function parseSandboxConfig(value: unknown): SandboxConfig | undefined {
	if (!isRecord(value)) return undefined;
	const config: SandboxConfig = {};
	if (typeof value.provider === "string" && value.provider !== "") config.provider = value.provider;
	if (typeof value.template === "string" && value.template !== "") config.template = value.template;
	if (typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs) && value.idleTimeoutMs >= 0) {
		config.idleTimeoutMs = value.idleTimeoutMs;
	}
	if (typeof value.autoPause === "boolean") config.autoPause = value.autoPause;
	if (isRecord(value.providers)) {
		const providers: Record<string, { apiKey?: string }> = {};
		for (const [id, entry] of Object.entries(value.providers)) {
			if (!isRecord(entry)) continue;
			if (typeof entry.apiKey === "string" && entry.apiKey !== "") providers[id] = { apiKey: entry.apiKey };
		}
		if (Object.keys(providers).length > 0) config.providers = providers;
	}
	return Object.keys(config).length === 0 ? undefined : config;
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
	const sandboxes = parseSandboxConfig(parsed.sandboxes);
	return {
		providers,
		...(defaults === undefined ? {} : { defaults }),
		...(sandboxes === undefined ? {} : { sandboxes }),
	};
}

export async function saveConfig(path: string, config: AppConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}
