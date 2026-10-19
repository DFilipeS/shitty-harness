// Smoke test for the server protocol. Usage:
//   node scripts/smoke.mjs [ws://localhost:8787/ws]   run against a running server
//   node scripts/smoke.mjs --serve                    spawn a throwaway server and run against it
// `npm run smoke` does the latter: no setup, no cleanup, nothing persistent is touched.
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));

/** A TCP port the kernel confirms is free right now. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
		probe.on("error", reject);
	});
}

/**
 * A server of this repo on a throwaway port and data directory. The user's data directory is only
 * read to copy `config.json`, so a configured provider is used when one exists; nothing is written
 * there. Returns the WebSocket URL plus a `stop()` that is safe to call twice.
 */
async function startThrowawayServer() {
	const port = await freePort();
	const dataDir = await mkdtemp(join(tmpdir(), "harness-smoke-"));
	await copyFile(join(here, "../data/config.json"), join(dataDir, "config.json")).catch(() => {});
	const child = spawn(process.execPath, [join(here, "../packages/server/src/index.ts")], {
		env: { ...process.env, PORT: String(port), HARNESS_DATA_DIR: dataDir },
		stdio: "ignore",
	});
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		child.kill();
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	};
	process.on("exit", stop);
	console.log(`spawned server on port ${port} (data dir ${dataDir})`);
	return { url: `ws://127.0.0.1:${port}/ws`, stop };
}

/** Resolve once the URL accepts a WebSocket, or throw after `timeoutMs`. */
async function waitForServer(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() > deadline) throw new Error(`server did not accept connections at ${url}`);
		const ready = await new Promise((resolve) => {
			const probe = new WebSocket(url);
			probe.on("open", () => {
				probe.close();
				resolve(true);
			});
			probe.on("error", () => resolve(false));
		});
		if (ready) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** The smoke checks, run over one WebSocket connection. */
async function runSmoke(url) {
	const ws = new WebSocket(url);
	let nextId = 0;
	const pending = new Map();

	const call = (type, payload = {}) =>
		new Promise((resolve, reject) => {
			const id = String(++nextId);
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, type, ...payload }));
		});

	async function waitFor(predicate, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (await predicate()) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	ws.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.type === "response") {
			const entry = pending.get(message.id);
			pending.delete(message.id);
			if (message.ok) entry.resolve(message.data);
			else entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
		} else {
			console.log("PUSH", message.type, JSON.stringify(message).slice(0, 240));
		}
	});

	await new Promise((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});

	try {
		const providers = await call("providers.list");
		console.log(
			"providers:",
			providers.providers.length,
			"configured:",
			providers.providers.filter((p) => p.configured).map((p) => p.id),
		);
		console.log("models:", providers.models.length);
		console.log("sessions:", await call("sessions.list"));
		const { session } = await call("sessions.create");
		console.log("created:", session);
		console.log("sessions:", await call("sessions.list"));
		let prompted = false;
		try {
			await call("sessions.prompt", {
				sessionId: session.id,
				text: "Hello there, this is a test",
				requestId: "r1",
			});
			prompted = true;
			console.log("prompt: accepted");
		} catch (error) {
			console.log("prompt error:", error.message);
		}
		const attach = await call("sessions.attach", { sessionId: session.id });
		console.log("attach snapshot keys:", Object.keys(attach.snapshot).join(","));
		if (prompted) {
			const isWorking = async () =>
				(await call("sessions.list")).sessions.find((candidate) => candidate.id === session.id)
					?.working === true;
			const working = await waitFor(isWorking, 5_000);
			console.log("working while running:", working);
			if (working) {
				// A prompt while busy queues; the queue lists it and withdraw takes it back out.
				await call("sessions.prompt", {
					sessionId: session.id,
					text: "Follow-up",
					requestId: "r2",
				});
				const queued = await call("sessions.queue", { sessionId: session.id });
				console.log("queued while running:", JSON.stringify(queued.items));
				if (queued.items.length > 0) {
					const withdrawn = await call("sessions.withdraw", {
						sessionId: session.id,
						submissionId: queued.items[0].id,
					});
					console.log("withdraw outcome:", withdrawn.outcome);
				}
			}
			await call("sessions.abort", { sessionId: session.id });
			const idle = await waitFor(async () => !(await isWorking()), 10_000);
			console.log("working cleared after abort:", idle);
		}
		await call("sessions.rename", { sessionId: session.id, title: "Renamed session" });
		console.log(
			"titles:",
			(await call("sessions.list")).sessions.map((s) => s.title),
		);
		await call("sessions.delete", { sessionId: session.id });
		console.log(
			"titles after delete:",
			(await call("sessions.list")).sessions.map((s) => s.title),
		);
		try {
			await call("sessions.attach", { sessionId: session.id });
			console.log("attach after delete: unexpectedly succeeded");
		} catch (error) {
			console.log("attach after delete rejected:", error.message);
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	} catch (error) {
		console.error("SMOKE FAILED:", error);
		process.exitCode = 1;
	} finally {
		ws.close();
	}
}

const serve = process.argv.includes("--serve");
const url = serve ? undefined : (process.argv[2] ?? "ws://localhost:8787/ws");

if (serve) {
	const server = await startThrowawayServer();
	try {
		await waitForServer(server.url, 15_000);
		await runSmoke(server.url);
	} catch (error) {
		console.error("SMOKE FAILED:", error);
		process.exitCode = 1;
	} finally {
		await server.stop();
	}
} else {
	await runSmoke(url);
}
