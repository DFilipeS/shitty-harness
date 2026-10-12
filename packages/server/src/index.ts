import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessService } from "@harness/core";
import { startServer } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HARNESS_DATA_DIR ?? resolve(here, "../../../data");
const port = Number(process.env.PORT ?? 8787);
const webRoot = process.env.NODE_ENV === "production" ? resolve(here, "../../web/dist") : undefined;

function positiveNumberFromEnv(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const service = await HarnessService.open({
	dataDir,
	progress: {
		partialIntervalMs: positiveNumberFromEnv("HARNESS_PARTIAL_INTERVAL_MS"),
		outputIntervalMs: positiveNumberFromEnv("HARNESS_OUTPUT_INTERVAL_MS"),
	},
});
const server = await startServer({ service, port, webRoot });

console.log(`[server] listening on http://localhost:${server.port} (data: ${dataDir})`);
if (webRoot !== undefined) console.log(`[server] serving web build from ${webRoot}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[server] ${signal} received, shutting down`);
	await server.close();
	await service.close();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
