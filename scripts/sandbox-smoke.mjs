// Real E2B smoke test for the sandbox adapter. Usage:
//   node scripts/sandbox-smoke.mjs
// Reads E2B_API_KEY, or the key pi-remote-sandbox stored. Creates one small sandbox and kills it.
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { resolveHostAgentSocket } from "../packages/core/src/sandboxes/agent.ts";
import { SandboxExecutionEnv } from "../packages/core/src/sandboxes/env.ts";
import { E2BProviderFactory } from "../packages/core/src/sandboxes/e2b/provider.ts";

function storedApiKey() {
	if (process.env.E2B_API_KEY !== undefined && process.env.E2B_API_KEY !== "")
		return process.env.E2B_API_KEY;
	try {
		const auth = JSON.parse(
			readFileSync(
				join(homedir(), ".pi", "agent", "extensions", "remote-sandbox-auth.json"),
				"utf8",
			),
		);
		return auth?.e2b?.apiKey;
	} catch {
		return undefined;
	}
}

const apiKey = storedApiKey();
if (apiKey === undefined || apiKey === "") {
	console.error("No E2B API key: set E2B_API_KEY or store one for pi-remote-sandbox.");
	process.exit(1);
}

const workspaceDir = "/home/user/workspace";
const provider = E2BProviderFactory.create(
	{ stateDir: join(tmpdir(), "harness-sandbox-smoke-state") },
	{ apiKey },
);

const created = Date.now();
const sandbox = await provider.create({
	workspaceDir,
	labels: { harness: "smoke", name: "smoke-test" },
	idleTimeoutMs: 120_000,
	autoPause: true,
});
console.log(`created ${sandbox.id} in ${Date.now() - created}ms`);

try {
	const env = new SandboxExecutionEnv(sandbox);
	await env.writeFile("hello.txt", "hi from the smoke test\n", BACKGROUND_CONTEXT);
	const text = getOrThrow(await env.readTextFile("hello.txt", BACKGROUND_CONTEXT));
	console.log("readTextFile:", JSON.stringify(text));

	const result = getOrThrow(
		await env.exec(
			"pwd && cat hello.txt && printf err >&2",
			{ onOutput: (chunk, _context, info) => process.stdout.write(`[${info.stream}] ${chunk}`) },
			BACKGROUND_CONTEXT,
		),
	);
	console.log("exec exit:", result.exitCode);

	const reader = getOrThrow(await env.openBinaryReader("hello.txt", undefined, BACKGROUND_CONTEXT));
	const scan = getOrThrow(await reader.scanLines({ startLine: 0 }, BACKGROUND_CONTEXT));
	await reader.close(BACKGROUND_CONTEXT);
	console.log("scanLines:", JSON.stringify({ newlines: scan.newlines, bytes: scan.selectedBytes }));

	const listed = getOrThrow(await env.listDir(".", BACKGROUND_CONTEXT));
	console.log("listDir:", listed.map((entry) => `${entry.kind}:${entry.name}`).join(", "));

	const info = getOrThrow(await env.fileInfo("hello.txt", BACKGROUND_CONTEXT));
	console.log("fileInfo:", JSON.stringify({ kind: info.kind, size: info.size }));

	console.log("metrics:", JSON.stringify(await sandbox.metrics()));
	await new Promise((resolve) => setTimeout(resolve, 6_000));
	console.log("metrics after 6s:", JSON.stringify(await sandbox.metrics()));

	// SSH agent forwarding: the host keys never enter the sandbox; only the socket is forwarded.
	const hostSocket = await resolveHostAgentSocket();
	const agentCheck = async (command) => {
		let stdout = "";
		let stderr = "";
		const result = await sandbox.exec(command, {
			timeoutMs: 30_000,
			onStdout: (text) => {
				stdout += text;
			},
			onStderr: (text) => {
				stderr += text;
			},
		});
		return { exitCode: result.exitCode, output: (stdout + stderr).trim() };
	};
	if (hostSocket === undefined) {
		console.log("forwarding: no host SSH agent found, skipped");
	} else {
		const forwarding = await sandbox.forwardAgent(hostSocket);
		const listed = await agentCheck(`SSH_AUTH_SOCK=${forwarding.sandboxSocket} ssh-add -l`);
		console.log("agent inside the sandbox:");
		console.log(listed.output || "(no output)");
		if (listed.exitCode !== 0)
			throw new Error("the forwarded agent did not answer inside the sandbox");
		await forwarding.close();
		const after = await agentCheck(`SSH_AUTH_SOCK=${forwarding.sandboxSocket} ssh-add -l`);
		console.log(`after close: exit ${after.exitCode}`);
		if (after.exitCode === 0) throw new Error("the forwarded agent still answered after close");
		console.log("forwarding closed");
	}

	await sandbox.pause();
	console.log("paused");
	const resumed = await provider.connect(sandbox.id, { workspaceDir });
	const afterResume = getOrThrow(
		await new SandboxExecutionEnv(resumed).readTextFile("hello.txt", BACKGROUND_CONTEXT),
	);
	console.log("after resume:", JSON.stringify(afterResume));

	const sandboxes = await provider.list({ labels: { harness: "smoke" } });
	console.log("list:", sandboxes.map((entry) => `${entry.id}:${entry.state}`).join(", "));
} finally {
	await provider.kill(sandbox.id);
	console.log("killed", sandbox.id);
}
