// Quick smoke test for the server protocol. Usage:
//   node scripts/smoke.mjs [ws://localhost:8787/ws]
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
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

ws.on("open", async () => {
	try {
		const providers = await call("providers.list");
		console.log("providers:", providers.providers.length, "configured:", providers.providers.filter((p) => p.configured).map((p) => p.id));
		console.log("models:", providers.models.length);
		console.log("sessions:", await call("sessions.list"));
		const { session } = await call("sessions.create");
		console.log("created:", session);
		console.log("sessions:", await call("sessions.list"));
		let prompted = false;
		try {
			await call("sessions.prompt", { sessionId: session.id, text: "Hello there, this is a test", requestId: "r1" });
			prompted = true;
			console.log("prompt: accepted");
		} catch (error) {
			console.log("prompt error:", error.message);
		}
		const attach = await call("sessions.attach", { sessionId: session.id });
		console.log("attach snapshot keys:", Object.keys(attach.snapshot).join(","));
		if (prompted) {
			const isWorking = async () =>
				(await call("sessions.list")).sessions.find((candidate) => candidate.id === session.id)?.working === true;
			const working = await waitFor(isWorking, 5_000);
			console.log("working while running:", working);
			await call("sessions.abort", { sessionId: session.id });
			const idle = await waitFor(async () => !(await isWorking()), 10_000);
			console.log("working cleared after abort:", idle);
		}
		await call("sessions.rename", { sessionId: session.id, title: "Renamed session" });
		console.log("titles:", (await call("sessions.list")).sessions.map((s) => s.title));
		await call("sessions.delete", { sessionId: session.id });
		console.log("titles after delete:", (await call("sessions.list")).sessions.map((s) => s.title));
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
});
