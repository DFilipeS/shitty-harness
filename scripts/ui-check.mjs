// Headless Chrome check for the web UI. Loads the app, optionally selects a session and sends a prompt,
// then prints the rendered text twice (during and after the run).
// Usage: node scripts/ui-check.mjs [http://localhost:8792/] [session-title-substring] [prompt]
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import WebSocket from "ws";

const url = process.argv[2] ?? "http://localhost:8792/";
const clickText = process.argv[3];
const prompt = process.argv[4];
const port = 9223;
const profile = "/tmp/harness-ui-check-profile";
await rm(profile, { recursive: true, force: true });

const chrome = spawn(
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path) {
	const response = await fetch(`http://localhost:${port}${path}`);
	return response.json();
}

try {
	let version;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			version = await getJson("/json/version");
			break;
		} catch {
			await sleep(200);
		}
	}
	if (version === undefined) throw new Error("Chrome DevTools did not start");

	const targets = await getJson("/json/list");
	const page = targets.find((target) => target.type === "page");
	if (page === undefined) throw new Error("No page target");

	const socket = new WebSocket(page.webSocketDebuggerUrl);
	let nextId = 0;
	const pending = new Map();
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});

	socket.on("message", (data) => {
		const message = JSON.parse(data.toString());
		if (message.id === undefined || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(message.error.message));
		else resolve(message.result);
	});

	const bodyText = async () => {
		const result = await send("Runtime.evaluate", {
			expression: "document.body.innerText",
			returnByValue: true,
		});
		return result.result.value;
	};

	await new Promise((resolve) => socket.on("open", resolve));
	await send("Page.enable");
	await send("Page.navigate", { url });
	await sleep(4_000);

	const target = clickText ?? (prompt === undefined ? undefined : "New session");
	if (target !== undefined) {
		await send("Runtime.evaluate", {
			expression: `[...document.querySelectorAll("button")].find((button) => button.textContent.includes(${JSON.stringify(target)}))?.click()`,
		});
		await sleep(1_500);
	}

	if (prompt !== undefined) {
		await send("Runtime.evaluate", { expression: `document.querySelector("textarea")?.focus()` });
		await send("Input.insertText", { text: prompt });
		await sleep(200);
		await send("Input.dispatchKeyEvent", {
			type: "rawKeyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		await send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
		});
		// Sample the rendered length of the last text block while the answer streams.
		const samples = [];
		for (let tick = 0; tick < 70; tick += 1) {
			await sleep(100);
			const result = await send("Runtime.evaluate", {
				expression: `(() => { const nodes = [...document.querySelectorAll(".whitespace-pre-wrap")]; return nodes.length === 0 ? 0 : nodes[nodes.length - 1].textContent.length; })()`,
				returnByValue: true,
			});
			samples.push(result.result.value);
		}
		console.log("rendered text length every 100ms:");
		console.log(samples.join(" "));
		const increments = samples.map((value, index) =>
			index === 0 ? value : value - samples[index - 1],
		);
		console.log("increments:", increments.join(" "));
		console.log("--- after run ---");
	}

	console.log(await bodyText());
	socket.close();
} finally {
	chrome.kill();
	await sleep(300);
}
