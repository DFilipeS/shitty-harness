import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadConfig } from "./config.ts";
import { ProviderManager } from "./providers.ts";
import { HarnessService } from "./service.ts";

export type OpenHarnessServiceOptions = {
	dataDir: string;
	/** Model catalog mirror; defaults to pi.dev. */
	catalogBaseUrl?: string;
};

/**
 * Production composition: open SQLite storage and the config-backed provider manager, then create
 * the service over them. Node-specific, so it lives behind `@harness/core/node`.
 */
export async function openHarnessService(options: OpenHarnessServiceOptions): Promise<HarnessService> {
	const { dataDir } = options;
	await mkdir(dataDir, { recursive: true });

	const configPath = join(dataDir, "config.json");
	const providers = new ProviderManager(configPath, join(dataDir, "models.json"), await loadConfig(configPath), {
		...(options.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: options.catalogBaseUrl }),
	});
	const storage = await openNodeSqliteStorage(join(dataDir, "sessions.sqlite"));

	return HarnessService.create({ storage, providers });
}
