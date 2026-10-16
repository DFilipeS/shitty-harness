import type { Context } from "@earendil-works/chord";
import { resolveHostAgentSocket } from "./agent.ts";
import { SandboxExecutionEnv } from "./env.ts";
import { applyGitIdentity, cloneIntoWorkspace, hostGitIdentity } from "./git.ts";
import {
	SandboxError,
	type AgentForwarding,
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
	/** Whether this sandbox forwards the host SSH agent. */
	forwardAgent: boolean;
};

/** One sandbox as the UI lists it. */
export type SandboxSummary = {
	provider: string;
	providerName: string;
	id: string;
	name?: string;
	state: "running" | "paused" | "stopped";
	workspaceDir: string;
	template?: string;
	createdAt?: number;
	lastUsedAt?: number;
	/** True while this process holds a live SSH agent forward into the sandbox. */
	forwarding: boolean;
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
	/** Overrides host agent discovery; tests use this to stay deterministic. */
	resolveHostAgentSocket?: () => Promise<string | undefined>;
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
	readonly #forwardings = new Map<string, AgentForwarding>();
	/** Sandboxes whose targets asked for forwarding, so a resume can start it again. */
	readonly #forwardEnabled = new Set<string>();

	constructor(options: SandboxManagerOptions) {
		this.#options = options;
	}

	get settings(): SandboxSettings {
		return this.#options.store.getSandboxSettings();
	}

	async setSettings(change: SandboxSettingsChange): Promise<SandboxSettings> {
		const settings = await this.#options.store.setSandboxSettings(change);
		// Only a credential or provider change drops providers, environments, and live forwards.
		// The other settings apply to the sandboxes created after them, so cached ones stay usable.
		if (change.apiKey !== undefined || change.provider !== undefined) await this.invalidate();
		return settings;
	}

	/** Drop provider instances, cached environments, and forwards, e.g. after credentials change. */
	async invalidate(): Promise<void> {
		await this.close();
		this.#providers.clear();
		this.#handles.clear();
		this.#environments.clear();
	}

	/** Stop every forwarded agent. The sandboxes themselves keep running. */
	async close(): Promise<void> {
		for (const id of [...this.#forwardings.keys()]) await this.#stopForwarding(id);
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
		let created = false;
		if (target.sandboxId !== undefined) {
			try {
				handle = await provider.connect(target.sandboxId, {
					workspaceDir: target.workspaceDir,
					idleTimeoutMs: this.settings.idleTimeoutMs,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.onStatus?.({ conversationId, phase: "gone", sandboxId: target.sandboxId, message });
				throw error;
			}
		} else {
			this.onStatus?.({ conversationId, phase: "starting" });
			try {
				handle = await provider.create({
					...(target.template === undefined ? {} : { template: target.template }),
					workspaceDir: target.workspaceDir,
					labels: { ...SANDBOX_LABELS, ...(target.name === undefined ? {} : { name: target.name }) },
					idleTimeoutMs: this.settings.idleTimeoutMs,
					autoPause: this.settings.autoPause,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.onStatus?.({ conversationId, phase: "error", message });
				throw error;
			}
			created = true;
		}

		if (target.forwardAgent) this.onStatus?.({ conversationId, phase: "starting", message: "Forwarding the SSH agent" });
		const agentSocket = await this.#startForwarding(handle, target.forwardAgent);

		if (created) {
			try {
				if (target.source !== undefined && target.source.kind === "git") {
					await cloneIntoWorkspace(handle, target.source.url, agentSocket === undefined ? {} : { env: { SSH_AUTH_SOCK: agentSocket } });
				}
				const identity = await hostGitIdentity();
				await applyGitIdentity(handle, identity).catch((error: unknown) => {
					console.warn("[sandbox] could not copy the host Git identity:", error);
				});
			} catch (error) {
				await this.#stopForwarding(handle.id);
				await handle.kill().catch(() => undefined);
				const message = error instanceof Error ? error.message : String(error);
				this.onStatus?.({ conversationId, phase: "error", message });
				throw error;
			}
			await this.rememberSandboxId?.(conversationId, handle.id);
		}

		this.onStatus?.({ conversationId, phase: "ready", sandboxId: handle.id });
		return new SandboxExecutionEnv(handle, agentSocket === undefined ? {} : { agentSocket });
	}

	/** Start forwarding when asked, resolving the host socket first. Failures are not fatal. */
	async #startForwarding(handle: SandboxHandle, forward: boolean): Promise<string | undefined> {
		if (!forward || handle.forwardAgent === undefined) return undefined;
		const existing = this.#forwardings.get(handle.id);
		if (existing !== undefined) return existing.sandboxSocket;
		const hostSocket = await (this.#options.resolveHostAgentSocket?.() ??
			resolveHostAgentSocket(this.settings.ssh.agentSocket));
		if (hostSocket === undefined) {
			console.warn("[sandbox] no host SSH agent found; forwarding is off");
			return undefined;
		}
		try {
			const forwarding = await handle.forwardAgent(hostSocket);
			this.#forwardings.set(handle.id, forwarding);
			this.#forwardEnabled.add(handle.id);
			return forwarding.sandboxSocket;
		} catch (error) {
			console.warn("[sandbox] SSH agent forwarding failed:", error);
			return undefined;
		}
	}

	async #stopForwarding(sandboxId: string): Promise<void> {
		const forwarding = this.#forwardings.get(sandboxId);
		this.#forwardings.delete(sandboxId);
		await forwarding?.close().catch(() => undefined);
	}

	/** Human-readable provider name for user-facing text. */
	displayName(providerId: string): string {
		return sandboxProviderFactory(providerId).displayName;
	}

	/** The configured provider, with its credentials; shared with the template manager. */
	provider(): SandboxProvider {
		return this.#provider(this.settings.provider);
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
			.map((info) => summaryOf(info, provider.displayName, this.#forwardings.has(info.id)))
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	async create(choice: {
		name?: string;
		template?: string;
		source?: SandboxSource;
		workspaceDir: string;
		forwardAgent?: boolean;
	}): Promise<SandboxSummary> {
		const settings = this.settings;
		const provider = this.#provider(settings.provider);
		const template = choice.template ?? settings.template;
		const handle = await provider.create({
			...(template === undefined ? {} : { template }),
			workspaceDir: choice.workspaceDir,
			labels: { ...SANDBOX_LABELS, ...(choice.name === undefined ? {} : { name: choice.name }) },
			idleTimeoutMs: settings.idleTimeoutMs,
			autoPause: settings.autoPause,
		});
		this.#handles.set(handle.id, handle);
		const agentSocket = await this.#startForwarding(handle, choice.forwardAgent ?? settings.ssh.forwardAgent);
		if (choice.source !== undefined && choice.source.kind === "git") {
			await cloneIntoWorkspace(handle, choice.source.url, agentSocket === undefined ? {} : { env: { SSH_AUTH_SOCK: agentSocket } });
		}
		const identity = await hostGitIdentity();
		await applyGitIdentity(handle, identity).catch((error: unknown) => {
			console.warn("[sandbox] could not copy the host Git identity:", error);
		});
		return {
			provider: handle.provider,
			providerName: provider.displayName,
			id: handle.id,
			...(choice.name === undefined ? {} : { name: choice.name }),
			state: "running",
			workspaceDir: handle.workspaceDir,
			...(template === undefined ? {} : { template }),
			forwarding: this.#forwardings.has(handle.id),
		};
	}

	async pause(providerName: string, sandboxId: string): Promise<void> {
		const handle = await this.#handle(providerName, sandboxId);
		if (handle.pause === undefined) {
			throw new SandboxError("invalid", `Provider ${providerName} cannot pause sandboxes`);
		}
		await this.#stopForwarding(sandboxId);
		await handle.pause();
	}

	async resume(providerName: string, sandboxId: string): Promise<void> {
		// Connecting resumes a paused sandbox; the cached handle keeps working afterwards.
		const provider = this.#provider(providerName);
		const handle = await provider.connect(sandboxId, { idleTimeoutMs: this.settings.idleTimeoutMs });
		this.#handles.set(handle.id, handle);
		if (this.#forwardEnabled.has(sandboxId)) await this.#startForwarding(handle, true);
	}

	async kill(providerName: string, sandboxId: string): Promise<void> {
		await this.#stopForwarding(sandboxId);
		this.#forwardEnabled.delete(sandboxId);
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
			{
				...(settings.template === undefined ? {} : { template: settings.template }),
				...(this.#options.stateDir === undefined ? {} : { stateDir: this.#options.stateDir }),
			},
			{ ...(apiKey === undefined || apiKey === "" ? {} : { apiKey }) },
		);
		this.#providers.set(name, provider);
		return provider;
	}

	async #handle(providerName: string, sandboxId: string): Promise<SandboxHandle> {
		const cached = this.#handles.get(sandboxId);
		if (cached !== undefined) return cached;
		const handle = await this.#provider(providerName).connect(sandboxId, { idleTimeoutMs: this.settings.idleTimeoutMs });
		this.#handles.set(sandboxId, handle);
		return handle;
	}
}

function summaryOf(info: SandboxInfo, providerName: string, forwarding: boolean): SandboxSummary {
	return {
		provider: info.provider,
		providerName,
		id: info.id,
		...(info.name === undefined ? {} : { name: info.name }),
		state: info.state,
		workspaceDir: info.workspaceDir,
		...(info.template === undefined ? {} : { template: info.template }),
		...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
		...(info.lastUsedAt === undefined ? {} : { lastUsedAt: info.lastUsedAt }),
		forwarding,
	};
}
