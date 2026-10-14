import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { HarnessService, ServiceError } from "@harness/core";
import type { AgentEvent, ClientCommand, CommandResult, ModelRef, ServerError, ServerMessage } from "@harness/protocol";
import { WebSocket, WebSocketServer } from "ws";

type Connection = {
	socket: WebSocket;
	subscriptions: Map<string, () => void>;
	alive: boolean;
};

type CommandOutcome = {
	data: CommandResult[ClientCommand["type"]];
	afterSend?: () => void;
};

export type HarnessServerOptions = {
	service: HarnessService;
	port: number;
	webRoot?: string;
};

export type HarnessServer = {
	port: number;
	close(): Promise<void>;
};

const COMMAND_TYPES = new Set<string>([
	"sessions.list",
	"sessions.create",
	"sessions.rename",
	"sessions.delete",
	"sessions.attach",
	"sessions.detach",
	"sessions.prompt",
	"sessions.abort",
	"sessions.configure",
	"providers.list",
	"providers.configure",
	"providers.refresh",
	"defaults.set",
]);

const THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClientCommand(value: unknown): value is ClientCommand {
	if (!isRecord(value)) return false;
	return typeof value.id === "string" && typeof value.type === "string" && COMMAND_TYPES.has(value.type);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new ServiceError("invalid", `${name} must be a string`);
	return value;
}

function optionalModelRef(value: unknown): ModelRef | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!isRecord(value)) throw new ServiceError("invalid", "model must be an object or null");
	const provider = requireString(value.provider, "model.provider");
	const modelId = requireString(value.modelId, "model.modelId");
	return { provider, modelId };
}

function optionalThinkingLevel(value: unknown): ModelThinkingLevel | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
		throw new ServiceError("invalid", "thinkingLevel is not a known thinking level");
	}
	return value as ModelThinkingLevel;
}

function toServerError(error: unknown): ServerError {
	if (error instanceof ServiceError) return { code: error.code, message: error.message };
	if (error instanceof Error) return { code: "internal", message: error.message };
	return { code: "internal", message: String(error) };
}

async function statSafe(path: string) {
	try {
		return await stat(path);
	} catch {
		return undefined;
	}
}

async function serveStatic(root: string, requestUrl: string, response: ServerResponse): Promise<void> {
	const url = new URL(requestUrl, "http://localhost");
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		response.writeHead(400).end("Bad request");
		return;
	}
	const relative = normalize(pathname).replace(/^[/\\]+/, "");
	let filePath = resolve(root, relative);
	if (filePath !== root && !filePath.startsWith(root + sep)) {
		response.writeHead(403).end("Forbidden");
		return;
	}
	let info = await statSafe(filePath);
	if (info?.isDirectory()) {
		filePath = join(filePath, "index.html");
		info = await statSafe(filePath);
	}
	if (info === undefined && extname(filePath) === "") {
		filePath = join(root, "index.html");
		info = await statSafe(filePath);
	}
	if (info === undefined || !info.isFile()) {
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
		return;
	}
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
		"content-length": info.size,
		"cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
	});
	createReadStream(filePath).pipe(response);
}

export function startServer(options: HarnessServerOptions): Promise<HarnessServer> {
	const { service, webRoot } = options;
	const connections = new Set<Connection>();

	const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.pathname === "/health") {
				response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
				return;
			}
			if (webRoot !== undefined) {
				await serveStatic(webRoot, request.url ?? "/", response);
				return;
			}
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
		})().catch((error: unknown) => {
			console.error("[server] request failed:", error);
			if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			response.end("Internal server error");
		});
	});

	const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

	function send(connection: Connection, message: ServerMessage): void {
		if (connection.socket.readyState !== WebSocket.OPEN) return;
		connection.socket.send(JSON.stringify(message));
	}

	function sendEvents(connection: Connection, sessionId: string, events: readonly AgentEvent[]): void {
		for (const event of events) send(connection, { type: "session.event", sessionId, event });
	}

	async function executeCommand(connection: Connection, command: ClientCommand): Promise<CommandOutcome> {
		switch (command.type) {
			case "sessions.list": {
				return { data: { sessions: await service.listSessions() } };
			}
			case "sessions.create": {
				return { data: { session: await service.createSession() } };
			}
			case "sessions.rename": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const title = requireString(command.title, "title");
				return { data: { session: await service.renameSession(sessionId, title) } };
			}
			case "sessions.delete": {
				const sessionId = requireString(command.sessionId, "sessionId");
				await service.deleteSession(sessionId);
				connection.subscriptions.get(sessionId)?.();
				connection.subscriptions.delete(sessionId);
				return { data: {} };
			}
			case "sessions.attach": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const buffer: AgentEvent[] = [];
				let ready = false;
				const { snapshot, unsubscribe } = await service.subscribeSession(sessionId, (events) => {
					if (!ready) {
						buffer.push(...events);
						return;
					}
					sendEvents(connection, sessionId, events);
				});
				connection.subscriptions.get(sessionId)?.();
				connection.subscriptions.set(sessionId, unsubscribe);
				return {
					data: { snapshot },
					afterSend: () => {
						ready = true;
						sendEvents(connection, sessionId, buffer);
						buffer.length = 0;
					},
				};
			}
			case "sessions.detach": {
				const sessionId = requireString(command.sessionId, "sessionId");
				connection.subscriptions.get(sessionId)?.();
				connection.subscriptions.delete(sessionId);
				return { data: {} };
			}
			case "sessions.prompt": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const text = requireString(command.text, "text");
				const requestId = requireString(command.requestId, "requestId");
				return { data: await service.prompt(sessionId, text, requestId) };
			}
			case "sessions.abort": {
				const sessionId = requireString(command.sessionId, "sessionId");
				await service.abort(sessionId);
				return { data: {} };
			}
			case "sessions.configure": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const agent = await service.configureSession(sessionId, {
					model: optionalModelRef(command.model),
					thinkingLevel: optionalThinkingLevel(command.thinkingLevel),
				});
				return { data: { agent } };
			}
			case "providers.list": {
				return { data: await service.listProviders() };
			}
			case "providers.configure": {
				const providerId = requireString(command.providerId, "providerId");
				const apiKey = command.apiKey === null ? null : requireString(command.apiKey, "apiKey");
				await service.configureProvider(providerId, apiKey);
				return { data: await service.listProviders() };
			}
			case "providers.refresh": {
				const refresh = await service.refreshProviders();
				return { data: { ...(await service.listProviders()), refresh } };
			}
			case "defaults.set": {
				const defaults = await service.setDefaults({
					model: optionalModelRef(command.model),
					thinkingLevel: optionalThinkingLevel(command.thinkingLevel),
				});
				return { data: { defaults } };
			}
		}
	}

	async function handleMessage(connection: Connection, raw: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			send(connection, {
				id: "0",
				type: "response",
				ok: false,
				error: { code: "invalid_json", message: "Message is not valid JSON" },
			});
			return;
		}
		if (!isClientCommand(parsed)) {
			send(connection, {
				id: isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : "0",
				type: "response",
				ok: false,
				error: { code: "invalid_command", message: "Unknown command" },
			});
			return;
		}
		let outcome: CommandOutcome;
		try {
			outcome = await executeCommand(connection, parsed);
		} catch (error) {
			send(connection, { id: parsed.id, type: "response", ok: false, error: toServerError(error) });
			return;
		}
		send(connection, { id: parsed.id, type: "response", ok: true, data: outcome.data });
		outcome.afterSend?.();
	}

	wss.on("connection", (socket: WebSocket) => {
		const connection: Connection = { socket, subscriptions: new Map(), alive: true };
		connections.add(connection);
		socket.on("message", (data) => {
			void handleMessage(connection, data.toString()).catch((error: unknown) => {
				console.error("[server] handling message failed:", error);
			});
		});
		socket.on("pong", () => {
			connection.alive = true;
		});
		socket.on("error", (error) => {
			console.warn("[server] websocket error:", error);
		});
		socket.on("close", () => {
			for (const unsubscribe of connection.subscriptions.values()) unsubscribe();
			connection.subscriptions.clear();
			connections.delete(connection);
		});
	});

	const unsubscribeService = service.on((event) => {
		const message: ServerMessage =
			event.type === "sessions"
				? { type: "sessions.changed", sessions: event.sessions }
				: {
						type: "providers.changed",
						providers: event.providers,
						models: event.models,
						defaults: event.defaults,
					};
		for (const connection of connections) send(connection, message);
	});

	const heartbeat = setInterval(() => {
		for (const connection of connections) {
			if (!connection.alive) {
				connection.socket.terminate();
				continue;
			}
			connection.alive = false;
			connection.socket.ping();
		}
	}, 30_000);
	heartbeat.unref();

	return new Promise<HarnessServer>((resolveListen, rejectListen) => {
		httpServer.once("error", rejectListen);
		httpServer.listen(options.port, () => {
			httpServer.off("error", rejectListen);
			const address = httpServer.address();
			const port = typeof address === "object" && address !== null ? address.port : options.port;
			resolveListen({
				port,
				async close() {
					clearInterval(heartbeat);
					unsubscribeService();
					for (const socket of wss.clients) socket.terminate();
					await new Promise<void>((done) => wss.close(() => done()));
					await new Promise<void>((done, failed) =>
						httpServer.close((error) => (error === undefined ? done() : failed(error))),
					);
				},
			});
		});
	});
}
