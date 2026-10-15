import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig } from "./config.ts";
import { lazyEnvironment, type EnvironmentFactory } from "./environment.ts";
import { ProviderManager } from "./providers.ts";
import { HarnessService } from "./service.ts";

export type OpenHarnessServiceOptions = {
	dataDir: string;
	/** Model catalog mirror; defaults to pi.dev. */
	catalogBaseUrl?: string;
	/** Replaces the local execution environment, e.g. with a remote sandbox. */
	environment?: EnvironmentFactory;
};

/** The local machine as the tools' execution environment. */
export function localEnvironment(defaultRoot = process.cwd()): EnvironmentFactory {
	return ({ cwd }) => {
		const root = cwd ?? defaultRoot;
		return lazyEnvironment("node:local", root, async () => {
			await mkdir(root, { recursive: true });
			return new NodeExecutionEnv({ cwd: root });
		});
	};
}

/**
 * Production composition: open SQLite storage, the config-backed provider manager, and the local
 * execution environment, then create the service over them. Node-specific, so it lives behind
 * `@harness/core/node`.
 */
export async function openHarnessService(options: OpenHarnessServiceOptions): Promise<HarnessService> {
	const { dataDir } = options;
	await mkdir(dataDir, { recursive: true });

	const configPath = join(dataDir, "config.json");
	const providers = new ProviderManager(configPath, join(dataDir, "models.json"), await loadConfig(configPath), {
		...(options.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: options.catalogBaseUrl }),
	});
	const storage = await openNodeSqliteStorage(join(dataDir, "sessions.sqlite"));
	const environment = options.environment ?? localEnvironment();

	return HarnessService.create({
		storage,
		providers,
		environment,
		workspacesDir: join(dataDir, "workspaces"),
	});
}
