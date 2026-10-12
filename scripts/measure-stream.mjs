// Measures how streamed text arrives: one line per message_update batch with time since the
// previous batch and how many characters it carried.
// Usage: node scripts/measure-stream.mjs [ws://localhost:8787/ws] ["prompt"]
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const prompt = process.argv[3] ?? "Write a 150 word story about a compiler that dreams.";
const ws = new WebSocket(url);
let nextId = 0;
const pending = new Map();

const call = (type, payload = {}) =>
	new Promise((resolve, reject) => {
		const id = String(++nextId);
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, type, ...payload }));
	});

let previous = 0;
let batches = 0;
let chars = 0;
let first = 0;

ws.on("message", (data) => {
	const message = JSON.parse(data.toString());
	if (message.type === "response") {
		const entry = pending.get(message.id);
		pending.delete(message.id);
		if (message.ok) entry.resolve(message.data);
		else entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
		return;
	}
	if (message.type !== "session.event") return;
	const event = message.event;
	if (event.type === "message_update") {
		const now = Date.now();
		const delta = event.changes
			.filter((change) => change.type === "text_delta")
			.reduce((sum, change) => sum + change.delta.length, 0);
		if (delta === 0) return;
		if (first === 0) first = now;
		batches += 1;
		chars += delta;
		const gap = previous === 0 ? 0 : now - previous;
		previous = now;
		console.log(`${String(gap).padStart(4)}ms  ${String(delta).padStart(4)} chars`);
	}
	if (event.type === "run_end") {
		const seconds = (Date.now() - first) / 1000;
		console.log(`\n${batches} batches, ${chars} chars, ${(chars / batches).toFixed(1)} chars/batch, ${(batches / seconds).toFixed(1)} batches/s`);
		ws.close();
	}
});

ws.on("open", async () => {
	try {
		const { session } = await call("sessions.create");
		await call("sessions.attach", { sessionId: session.id });
		await call("sessions.prompt", { sessionId: session.id, text: prompt, requestId: crypto.randomUUID() });
	} catch (error) {
		console.error("FAILED:", error.message);
		process.exitCode = 1;
		ws.close();
	}
});

setTimeout(() => {
	console.error("TIMEOUT");
	process.exitCode = 1;
	ws.close();
}, 180_000).unref();
