// End-to-end test against a running harness server: create a session, prompt it, print the answer.
// Usage:
//   node scripts/e2e.mjs [ws://localhost:8787/ws] ["your prompt"]
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const prompt = process.argv[3] ?? "Reply with exactly: hello from the harness";
const ws = new WebSocket(url);
let nextId = 0;
const pending = new Map();

const call = (type, payload = {}) =>
	new Promise((resolve, reject) => {
		const id = String(++nextId);
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, type, ...payload }));
	});

function textOfEntry(entry) {
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

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
	console.log("EVENT", event.type);
	if (event.type === "message_end") {
		const text = textOfEntry(event.entry);
		if (text !== undefined && text !== "") console.log("ANSWER:", text);
	}
	if (event.type === "run_end") {
		ws.close();
	}
});

ws.on("open", async () => {
	try {
		const providers = await call("providers.list");
		const configured = providers.providers.filter((provider) => provider.configured);
		console.log("configured providers:", configured.map((provider) => provider.id).join(", ") || "(none)");
		if (configured.length === 0) throw new Error("No configured providers; set an API key env var for this test");

		const { session } = await call("sessions.create");
		console.log("session:", session.id, session.title);
		await call("sessions.attach", { sessionId: session.id });
		console.log("prompt:", prompt);
		await call("sessions.prompt", { sessionId: session.id, text: prompt, requestId: crypto.randomUUID() });
	} catch (error) {
		console.error("E2E FAILED:", error.message);
		process.exitCode = 1;
		ws.close();
	}
});

setTimeout(() => {
	console.error("E2E TIMEOUT");
	process.exitCode = 1;
	ws.close();
}, 120_000).unref();
