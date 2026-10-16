import type { Context } from "@earendil-works/chord";
import { SandboxExecutionEnv } from "./env.ts";
import {
	SandboxError,
	type SandboxHandle,
	type SandboxInfo,
	type SandboxMetrics,
	type SandboxProvider,
	type SandboxSource,
} from "./provider.ts";
import { createSandboxProvider, sandboxProviderFactory } from "./registry.ts";
import type { SandboxSettings, SandboxSettingsChange, SandboxSettingsStore } from "./settings.ts";

/** A session target that names a sandbox, before or after the sandbox exists. */
export type ResolvedSandboxTarget = {
	kind: "sandbox";
	provider: string;
	sandboxId?: string;
	name?: string;
	template?: string;
	source?: SandboxSource;
	workspaceDir: string;
};

/** One sandbox as the UI lists it. */
export type SandboxSummary = {
	provider: string;
	id: string;
	name?: string;
	state: "running" | "paused" | "stopped";
	workspaceDir: string;
	template?: string;
	createdAt?: number;
	lastUsedAt?: number;
};

/** Progress of a sandbox a session is lazily opening, pushed to the UI. */
export type SandboxStatus = {
	conversationId: string;
	phase: "starting" | "ready" | "gone" | "error";
	sandboxId?: string;
	message?: string;
};

export type SandboxManagerOptions = {
	store: SandboxSettingsStore;
	/** Directory for provider state, e.g. SSH keys; unused until agent forwarding lands. */
	stateDir?: string;
};

/** The labels that mark a sandbox as this harness's, so the list never shows foreign sandboxes. */
export const SANDBOX_LABELS: Record<string, string> = { harness: "1" };

type EnvironmentEntry = {
	promise: Promise<SandboxExecutionEnv>;
	sandboxId: string;
};

/**
 * Owns the sandbox providers and the per-session environments. Sessions talk to sandboxes only
 * through here; the manager keeps the connection cache and never kills a sandbox on its own.
 */
export class SandboxManager {
	/** Progress of lazily opened sandboxes; the service forwards it to clients. */
	onStatus?: (status: SandboxStatus) => void;
	/** Persists the sandbox id the first time a session creates one, before `ready` is reported. */
	rememberSandboxId?: (conversationId: string, sandboxId: string) => Promise<void>;
	readonly #options: SandboxManagerOptions;
	readonly #providers = new Map<string, SandboxProvider>();
	readonly #handles = new Map<string, SandboxHandle>();
	readonly #environments = new Map<string, EnvironmentEntry>();

	constructor(options: SandboxManagerOptions) {
		this.#options = options;
	}

	get settings(): SandboxSettings {
		return this.#options.store.getSandboxSettings();
	}

	async setSettings(change: SandboxSettingsChange): Promise<SandboxSettings> {
		const settings = await this.#options.store.setSandboxSettings(change);
		this.invalidate();
		return settings;
	}

	/** Drop provider instances and cached environments, e.g. after credentials change. */
	invalidate(): void {
		this.#providers.clear();
		this.#handles.clear();
		this.#environments.clear();
	}

	/** Forget one session's environment, e.g. after its target changes. */
	forget(conversationId: string): void {
		this.#environments.delete(conversationId);
	}

	/** The environment of one session, creating or connecting its sandbox on first use. */
	async environment(
		target: ResolvedSandboxTarget,
		conversationId: string,
		context: Context,
	): Promise<SandboxExecutionEnv> {
		const cached = this.#environments.get(conversationId);
		if (cached !== undefined) return cached.promise;
		const entry: EnvironmentEntry = { promise: undefined as never, sandboxId: target.sandboxId ?? "" };
		entry.promise = this.#open(target, conversationId, context).then((env) => {
			entry.sandboxId = env.sandboxId;
			this.#handles.set(env.sandboxId, env.handle);
			return env;
		});
		this.#environments.set(conversationId, entry);
		try {
			return await entry.promise;
		} catch (error) {
			if (this.#environments.get(conversationId) === entry) this.#environments.delete(conversationId);
			throw error;
		}
	}

	async #open(
		target: ResolvedSandboxTarget,
		conversationId: string,
		_context: Context,
	): Promise<SandboxExecutionEnv> {
		const provider = this.#provider(target.provider);
		let handle: SandboxHandle;
		if (target.sandboxId !== undefined) {
			try {
				handle = await provider.connect(target.sandboxId, { workspaceDir: target.workspaceDir });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.onStatus?.({ conversationId, phase: "gone", sandboxId: target.sandboxId, message });
				throw error;
			}
			this.onStatus?.({ conversationId, phase: "ready", sandboxId: handle.id });
		} else {
			this.onStatus?.({ conversationId, phase: "starting" });
			try {
				handle = await provider.create({
					...(target.template === undefined ? {} : { template: target.template }),
					workspaceDir: target.workspaceDir,
					...(target.source === undefined ? {} : { source: target.source }),
					labels: { ...SANDBOX_LABELS, ...(target.name === undefined ? {} : { name: target.name }) },
					idleTimeoutMs: this.settings.idleTimeoutMs,
					autoPause: this.settings.autoPause,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.onStatus?.({ conversationId, phase: "error", message });
				throw error;
			}
			await this.rememberSandboxId?.(conversationId, handle.id);
			this.onStatus?.({ conversationId, phase: "ready", sandboxId: handle.id });
		}
		return new SandboxExecutionEnv(handle);
	}

	/** Whether the configured provider has a usable credential. */
	configured(): boolean {
		const settings = this.settings;
		const factory = sandboxProviderFactory(settings.provider);
		if (factory.needsApiKey === false) return true;
		const apiKey =
			settings.providers[settings.provider]?.apiKey ??
			(factory.envVar === undefined ? undefined : process.env[factory.envVar]);
		return apiKey !== undefined && apiKey !== "";
	}

	/** Sandboxes the harness created, newest first. */
	async list(): Promise<SandboxSummary[]> {
		const settings = this.settings;
		const provider = this.#provider(settings.provider);
		const infos = await provider.list({ labels: SANDBOX_LABELS });
		return infos
			.map((info) => summaryOf(info))
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	async create(choice: {
		name?: string;
		template?: string;
		source?: SandboxSource;
		workspaceDir: string;
	}): Promise<SandboxSummary> {
		const settings = this.settings;
		const provider = this.#provider(settings.provider);
		const template = choice.template ?? settings.template;
		const handle = await provider.create({
			...(template === undefined ? {} : { template }),
			workspaceDir: choice.workspaceDir,
			...(choice.source === undefined ? {} : { source: choice.source }),
			labels: { ...SANDBOX_LABELS, ...(choice.name === undefined ? {} : { name: choice.name }) },
			idleTimeoutMs: settings.idleTimeoutMs,
			autoPause: settings.autoPause,
		});
		this.#handles.set(handle.id, handle);
		return {
			provider: handle.provider,
			id: handle.id,
			...(choice.name === undefined ? {} : { name: choice.name }),
			state: "running",
			workspaceDir: handle.workspaceDir,
			...(template === undefined ? {} : { template }),
		};
	}

	async pause(providerName: string, sandboxId: string): Promise<void> {
		const handle = await this.#handle(providerName, sandboxId);
		if (handle.pause === undefined) {
			throw new SandboxError("invalid", `Provider ${providerName} cannot pause sandboxes`);
		}
		await handle.pause();
	}

	async resume(providerName: string, sandboxId: string): Promise<void> {
		// Connecting resumes a paused sandbox; the cached handle keeps working afterwards.
		const provider = this.#provider(providerName);
		const handle = await provider.connect(sandboxId);
		this.#handles.set(handle.id, handle);
	}

	async kill(providerName: string, sandboxId: string): Promise<void> {
		const provider = this.#provider(providerName);
		await provider.kill(sandboxId);
		this.#handles.delete(sandboxId);
		for (const [conversationId, entry] of [...this.#environments]) {
			if (entry.sandboxId === sandboxId) this.#environments.delete(conversationId);
		}
	}

	async metrics(providerName: string, sandboxId: string): Promise<SandboxMetrics | undefined> {
		const handle = await this.#handle(providerName, sandboxId);
		return handle.metrics?.();
	}

	#provider(name: string): SandboxProvider {
		const existing = this.#providers.get(name);
		if (existing !== undefined) return existing;
		const settings = this.settings;
		const factory = sandboxProviderFactory(name);
		const apiKey =
			settings.providers[name]?.apiKey ??
			(factory.envVar === undefined ? undefined : process.env[factory.envVar]);
		const provider = createSandboxProvider(
			name,
			{ ...(settings.template === undefined ? {} : { template: settings.template }), ...(this.#options.stateDir === undefined ? {} : { stateDir: this.#options.stateDir }) },
			{ ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }) },
		);
		this.#providers.set(name, provider);
		return provider;
	}

	async #handle(providerName: string, sandboxId: string): Promise<SandboxHandle> {
		const cached = this.#handles.get(sandboxId);
		if (cached !== undefined) return cached;
		const handle = await this.#provider(providerName).connect(sandboxId);
		this.#handles.set(sandboxId, handle);
		return handle;
	}
}

function summaryOf(info: SandboxInfo): SandboxSummary {
	return {
		provider: info.provider,
		id: info.id,
		...(info.name === undefined ? {} : { name: info.name }),
		state: info.state,
		workspaceDir: info.workspaceDir,
		...(info.template === undefined ? {} : { template: info.template }),
		...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
		...(info.lastUsedAt === undefined ? {} : { lastUsedAt: info.lastUsedAt }),
	};
}
