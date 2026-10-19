import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { HarnessService, SandboxError, ServiceError } from "@harness/core";
import {
	ATTACHMENT_LIMITS,
	type AgentEvent,
	type ClientCommand,
	type CommandResult,
	type ModelRef,
	type PromptAttachment,
	type QuestionReply,
	type SandboxChoice,
	type SandboxSourceChoice,
	type ServerError,
	type ServerMessage,
	type TargetChoice,
	type TemplateRecipeInput,
	type TemplateSourceChoice,
} from "@harness/protocol";
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
	"sessions.answer",
	"sessions.configure",
	"sessions.setTarget",
	"sessions.skills",
	"sessions.systemPrompt",
	"sessions.tools",
	"sessions.queue",
	"sessions.withdraw",
	"workspaces.browse",
	"workspaces.createFolder",
	"sandboxes.list",
	"sandboxes.create",
	"sandboxes.pause",
	"sandboxes.resume",
	"sandboxes.kill",
	"sandboxes.metrics",
	"sandboxes.configure",
	"sandboxes.settings",
	"templates.list",
	"templates.create",
	"templates.createStarter",
	"templates.update",
	"templates.build",
	"templates.logs",
	"templates.remove",
	"templates.delete",
	"templates.deleteProvider",
	"providers.list",
	"providers.configure",
	"providers.refresh",
	"defaults.set",
]);

const THINKING_LEVELS = new Set<string>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

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
	return (
		typeof value.id === "string" && typeof value.type === "string" && COMMAND_TYPES.has(value.type)
	);
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new ServiceError("invalid", `${name} must be a string`);
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ServiceError("invalid", `${name} must be a number`);
	}
	return value;
}

function requireBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new ServiceError("invalid", `${name} must be a boolean`);
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

function optionalToolChange(value: unknown): { remove: string[] } | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!isRecord(value) || !Array.isArray(value.remove)) {
		throw new ServiceError("invalid", "tools must be { remove: string[] } or null");
	}
	return { remove: value.remove.map((name) => requireString(name, "tools.remove")) };
}

function optionalTargetChoice(value: unknown): TargetChoice | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ServiceError("invalid", "target must be a local or sandbox target");
	}
	if (value.kind === "sandbox") return { kind: "sandbox", ...optionalSandboxChoice(value) };
	if (value.kind !== "local")
		throw new ServiceError("invalid", "target.kind must be local or sandbox");
	if (value.path === undefined) return { kind: "local" };
	if (typeof value.path !== "string")
		throw new ServiceError("invalid", "target.path must be a string");
	return { kind: "local", path: value.path };
}

function optionalSandboxSource(value: unknown): SandboxSourceChoice | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ServiceError("invalid", "sandbox.source must be an object");
	}
	if (value.kind === "empty") return { kind: "empty" };
	if (value.kind === "git")
		return { kind: "git", url: requireString(value.url, "sandbox.source.url") };
	throw new ServiceError("invalid", "sandbox.source.kind must be empty or git");
}

function optionalSandboxChoice(value: unknown): SandboxChoice {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new ServiceError("invalid", "sandbox must be an object");
	const choice: SandboxChoice = {};
	if (value.provider !== undefined)
		choice.provider = requireString(value.provider, "sandbox.provider");
	if (value.sandboxId !== undefined)
		choice.sandboxId = requireString(value.sandboxId, "sandbox.sandboxId");
	if (value.name !== undefined) choice.name = requireString(value.name, "sandbox.name");
	if (value.template !== undefined) {
		choice.template =
			value.template === null ? null : requireString(value.template, "sandbox.template");
	}
	if (value.workspaceDir !== undefined)
		choice.workspaceDir = requireString(value.workspaceDir, "sandbox.workspaceDir");
	if (value.forwardAgent !== undefined)
		choice.forwardAgent = requireBoolean(value.forwardAgent, "sandbox.forwardAgent");
	const source = optionalSandboxSource(value.source);
	if (source !== undefined) choice.source = source;
	return choice;
}

function requiredTargetChoice(value: unknown): TargetChoice {
	const target = optionalTargetChoice(value);
	if (target === undefined || target === null) {
		throw new ServiceError("invalid", "target must be a local target");
	}
	return target;
}

function optionalAttachments(value: unknown): PromptAttachment[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ServiceError("invalid", "attachments must be an array");
	if (value.length > ATTACHMENT_LIMITS.maxPerMessage) {
		throw new ServiceError(
			"invalid",
			`attachments must contain at most ${ATTACHMENT_LIMITS.maxPerMessage} files`,
		);
	}
	return value.map((item, index) => {
		if (!isRecord(item))
			throw new ServiceError("invalid", `attachments[${index}] must be an object`);
		return {
			name: requireString(item.name, `attachments[${index}].name`),
			mimeType: requireString(item.mimeType, `attachments[${index}].mimeType`),
			data: requireString(item.data, `attachments[${index}].data`),
		};
	});
}

function requireQuestionReply(value: unknown): QuestionReply {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ServiceError("invalid", "reply must be an object with a kind");
	}
	if (value.kind === "skipped") return { kind: "skipped" };
	if (value.kind !== "answered")
		throw new ServiceError("invalid", "reply.kind must be answered or skipped");
	if (!Array.isArray(value.answers))
		throw new ServiceError("invalid", "reply.answers must be an array");
	return {
		kind: "answered",
		answers: value.answers.map((answer, index) => {
			if (!isRecord(answer) || !Array.isArray(answer.selected)) {
				throw new ServiceError("invalid", `reply.answers[${index}] must have a selected array`);
			}
			const selected = answer.selected.map((label, labelIndex) =>
				requireString(label, `reply.answers[${index}].selected[${labelIndex}]`),
			);
			if (answer.skipped === true) return { selected: [], skipped: true as const };
			return answer.other === undefined
				? { selected }
				: { selected, other: requireString(answer.other, `reply.answers[${index}].other`) };
		}),
	};
}

function optionalTemplateRecipe(value: unknown): TemplateRecipeInput {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new ServiceError("invalid", "recipe must be an object");
	const recipe: TemplateRecipeInput = {};
	if (value.description !== undefined)
		recipe.description = requireString(value.description, "recipe.description");
	if (value.source !== undefined) recipe.source = optionalTemplateSource(value.source);
	if (value.run !== undefined) {
		if (!Array.isArray(value.run))
			throw new ServiceError("invalid", "recipe.run must be an array of commands");
		recipe.run = value.run.map((command, index) => requireString(command, `recipe.run[${index}]`));
	}
	return recipe;
}

function optionalTemplateSource(value: unknown): TemplateSourceChoice {
	if (!isRecord(value) || typeof value.kind !== "string") {
		throw new ServiceError("invalid", "recipe.source must be an object with a kind");
	}
	if (value.kind === "default") return { kind: "default" };
	if (value.kind === "template") {
		return { kind: "template", name: requireString(value.name, "recipe.source.name") };
	}
	if (value.kind === "image") {
		return { kind: "image", image: requireString(value.image, "recipe.source.image") };
	}
	throw new ServiceError("invalid", "recipe.source.kind must be default, template, or image");
}

function toServerError(error: unknown): ServerError {
	if (error instanceof ServiceError) return { code: error.code, message: error.message };
	if (error instanceof SandboxError) return { code: error.code, message: error.message };
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

async function serveStatic(
	root: string,
	requestUrl: string,
	response: ServerResponse,
): Promise<void> {
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
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ ok: true }));
				return;
			}
			if (webRoot !== undefined) {
				await serveStatic(webRoot, request.url ?? "/", response);
				return;
			}
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
		})().catch((error: unknown) => {
			console.error("[server] request failed:", error);
			if (!response.headersSent)
				response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
			response.end("Internal server error");
		});
	});

	const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

	function send(connection: Connection, message: ServerMessage): void {
		if (connection.socket.readyState !== WebSocket.OPEN) return;
		connection.socket.send(JSON.stringify(message));
	}

	function sendEvents(
		connection: Connection,
		sessionId: string,
		events: readonly AgentEvent[],
	): void {
		for (const event of events) send(connection, { type: "session.event", sessionId, event });
	}

	async function executeCommand(
		connection: Connection,
		command: ClientCommand,
	): Promise<CommandOutcome> {
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
				const attachments = optionalAttachments(command.attachments);
				return { data: await service.prompt(sessionId, text, requestId, attachments) };
			}
			case "sessions.abort": {
				const sessionId = requireString(command.sessionId, "sessionId");
				await service.abort(sessionId);
				return { data: {} };
			}
			case "sessions.answer": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const callId = requireString(command.callId, "callId");
				await service.answer(sessionId, callId, requireQuestionReply(command.reply));
				return { data: {} };
			}
			case "sessions.configure": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const agent = await service.configureSession(sessionId, {
					model: optionalModelRef(command.model),
					thinkingLevel: optionalThinkingLevel(command.thinkingLevel),
					tools: optionalToolChange(command.tools),
				});
				return { data: { agent } };
			}
			case "sessions.setTarget": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const target = requiredTargetChoice(command.target);
				return { data: { session: await service.setTarget(sessionId, target) } };
			}
			case "sessions.skills": {
				const sessionId = requireString(command.sessionId, "sessionId");
				return { data: await service.listSkills(sessionId) };
			}
			case "sessions.systemPrompt": {
				const sessionId = requireString(command.sessionId, "sessionId");
				return { data: await service.systemPrompt(sessionId) };
			}
			case "sessions.tools": {
				const sessionId = requireString(command.sessionId, "sessionId");
				return { data: await service.listTools(sessionId) };
			}
			case "sessions.queue": {
				const sessionId = requireString(command.sessionId, "sessionId");
				return { data: await service.queue(sessionId) };
			}
			case "sessions.withdraw": {
				const sessionId = requireString(command.sessionId, "sessionId");
				const submissionId = requireString(command.submissionId, "submissionId");
				return { data: await service.withdraw(sessionId, submissionId) };
			}
			case "workspaces.browse": {
				const path = command.path === undefined ? undefined : requireString(command.path, "path");
				return { data: await service.browseWorkspaces(path) };
			}
			case "workspaces.createFolder": {
				const parent = requireString(command.parent, "parent");
				const name = requireString(command.name, "name");
				return { data: await service.createWorkspaceFolder(parent, name) };
			}
			case "sandboxes.list": {
				return { data: await service.listSandboxes() };
			}
			case "sandboxes.create": {
				return { data: await service.createSandbox(optionalSandboxChoice(command.choice)) };
			}
			case "sandboxes.pause": {
				return {
					data: await service.pauseSandbox(
						requireString(command.provider, "provider"),
						requireString(command.sandboxId, "sandboxId"),
					),
				};
			}
			case "sandboxes.resume": {
				return {
					data: await service.resumeSandbox(
						requireString(command.provider, "provider"),
						requireString(command.sandboxId, "sandboxId"),
					),
				};
			}
			case "sandboxes.kill": {
				return {
					data: await service.killSandbox(
						requireString(command.provider, "provider"),
						requireString(command.sandboxId, "sandboxId"),
					),
				};
			}
			case "sandboxes.metrics": {
				return {
					data: {
						metrics: await service.sandboxMetrics(
							requireString(command.provider, "provider"),
							requireString(command.sandboxId, "sandboxId"),
						),
					},
				};
			}
			case "sandboxes.configure": {
				const provider = requireString(command.provider, "provider");
				const apiKey = command.apiKey === null ? null : requireString(command.apiKey, "apiKey");
				return { data: await service.configureSandboxProvider(provider, apiKey) };
			}
			case "sandboxes.settings": {
				return {
					data: await service.setSandboxSettings({
						...(command.provider === undefined
							? {}
							: { provider: requireString(command.provider, "provider") }),
						...(command.template === undefined
							? {}
							: {
									template:
										command.template === null ? null : requireString(command.template, "template"),
								}),
						...(command.idleTimeoutMs === undefined
							? {}
							: {
									idleTimeoutMs:
										command.idleTimeoutMs === null
											? null
											: requireNumber(command.idleTimeoutMs, "idleTimeoutMs"),
								}),
						...(command.autoPause === undefined
							? {}
							: {
									autoPause:
										command.autoPause === null
											? null
											: requireBoolean(command.autoPause, "autoPause"),
								}),
						...(command.sshAgentSocket === undefined
							? {}
							: {
									sshAgentSocket:
										command.sshAgentSocket === null
											? null
											: requireString(command.sshAgentSocket, "sshAgentSocket"),
								}),
						...(command.forwardAgent === undefined
							? {}
							: {
									forwardAgent:
										command.forwardAgent === null
											? null
											: requireBoolean(command.forwardAgent, "forwardAgent"),
								}),
					}),
				};
			}
			case "providers.list": {
				return { data: await service.listProviders() };
			}
			case "templates.list": {
				return { data: await service.listTemplates() };
			}
			case "templates.create": {
				const name = requireString(command.name, "name");
				const recipe =
					command.recipe === undefined ? undefined : optionalTemplateRecipe(command.recipe);
				return { data: await service.createTemplate(name, recipe) };
			}
			case "templates.createStarter": {
				return { data: await service.createStarterTemplate() };
			}
			case "templates.update": {
				const name = requireString(command.name, "name");
				const recipe = optionalTemplateRecipe(command.recipe);
				return { data: await service.updateTemplate(name, recipe) };
			}
			case "templates.build": {
				const name = requireString(command.name, "name");
				return { data: await service.buildTemplate(name) };
			}
			case "templates.logs": {
				const name = requireString(command.name, "name");
				return { data: await service.templateLogs(name) };
			}
			case "templates.remove": {
				const name = requireString(command.name, "name");
				return { data: await service.removeTemplate(name) };
			}
			case "templates.delete": {
				const name = requireString(command.name, "name");
				return { data: await service.deleteTemplate(name) };
			}
			case "templates.deleteProvider": {
				const templateId = requireString(command.templateId, "templateId");
				return { data: await service.deleteProviderTemplate(templateId) };
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
					imageModel: optionalModelRef(command.imageModel),
					target: optionalTargetChoice(command.target),
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
		let message: ServerMessage;
		if (event.type === "sessions") message = { type: "sessions.changed", sessions: event.sessions };
		else if (event.type === "sandboxes") {
			message = {
				type: "sandboxes.changed",
				provider: event.provider,
				settings: event.settings,
				sandboxes: event.sandboxes,
			};
		} else if (event.type === "target") message = { type: "session.target", status: event.status };
		else if (event.type === "templates") {
			message = {
				type: "templates.changed",
				provider: event.provider,
				providerName: event.providerName,
				configured: event.configured,
				templates: event.templates,
				other: event.other,
			};
		} else {
			message = {
				type: "providers.changed",
				providers: event.providers,
				models: event.models,
				imageModels: event.imageModels,
				defaults: event.defaults,
			};
		}
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
