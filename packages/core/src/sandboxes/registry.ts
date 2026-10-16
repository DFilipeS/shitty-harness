import { SandboxError, type SandboxProvider, type SandboxProviderFactory } from "./provider.ts";

const factories = new Map<string, SandboxProviderFactory>();

/** Make a provider factory available by name; a later registration replaces the earlier one. */
export function registerSandboxProvider(factory: SandboxProviderFactory): void {
	factories.set(factory.name, factory);
}

export function sandboxProviderFactory(name: string): SandboxProviderFactory {
	const factory = factories.get(name);
	if (factory === undefined) throw new SandboxError("invalid", `Unknown sandbox provider: ${name}`);
	return factory;
}

export function sandboxProviderNames(): string[] {
	return [...factories.keys()];
}

export function createSandboxProvider(
	name: string,
	config: { template?: string; stateDir?: string },
	credentials: { apiKey?: string },
): SandboxProvider {
	return sandboxProviderFactory(name).create(config, credentials);
}
