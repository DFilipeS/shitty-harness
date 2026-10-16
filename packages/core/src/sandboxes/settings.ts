/** Where a new sandbox puts the project when the provider has no better answer. */
export const DEFAULT_SANDBOX_WORKSPACE = "/home/user/workspace";

/** Defaults for new sandboxes; the stored settings override them. */
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
	provider: "e2b",
	idleTimeoutMs: 5 * 60 * 1000,
	autoPause: true,
	providers: {},
};

export type SandboxSettings = {
	provider: string;
	template?: string;
	idleTimeoutMs: number;
	autoPause: boolean;
	/** Stored API keys per provider; environment variables remain a fallback. */
	providers: Record<string, { apiKey?: string }>;
};

export type SandboxSettingsChange = {
	provider?: string;
	template?: string | null;
	idleTimeoutMs?: number | null;
	autoPause?: boolean | null;
	apiKey?: { provider: string; key: string | null };
};

/** The settings the sandbox manager reads and writes; `ProviderManager` implements it in production. */
export interface SandboxSettingsStore {
	getSandboxSettings(): SandboxSettings;
	setSandboxSettings(change: SandboxSettingsChange): Promise<SandboxSettings>;
}
