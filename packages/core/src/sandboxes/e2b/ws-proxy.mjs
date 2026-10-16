#!/usr/bin/env node
// Bridges stdin/stdout to a WebSocket. Used as an SSH ProxyCommand.
//
// E2B exposes sandbox ports as WebSocket-over-HTTPS, not raw TCP. websocat
// inside the sandbox bridges the WebSocket to sshd; this script is the host
// side of that bridge, so websocat is not needed on the host.
//
// Usage: node ws-proxy.mjs <wss-url>

if (typeof WebSocket === "undefined") {
	process.stderr.write("ws-proxy: Node.js 22 or newer is required\n");
	process.exit(2);
}

const url = process.argv[2];
if (!url) {
	process.stderr.write("usage: node ws-proxy.mjs <wss-url>\n");
	process.exit(2);
}

const socket = new WebSocket(url);
socket.binaryType = "arraybuffer";

process.stdin.pause();

socket.addEventListener("open", () => {
	process.stdin.resume();
	process.stdin.on("data", (chunk) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(chunk);
	});
	process.stdin.on("end", () => socket.close());
});

socket.addEventListener("message", (event) => {
	const data = event.data;
	if (data instanceof ArrayBuffer) {
		process.stdout.write(Buffer.from(data));
	} else if (typeof data === "string") {
		process.stdout.write(Buffer.from(data, "utf8"));
	}
});

socket.addEventListener("close", () => process.exit(0));

socket.addEventListener("error", () => {
	process.stderr.write("ws-proxy: WebSocket error\n");
	process.exit(1);
});
