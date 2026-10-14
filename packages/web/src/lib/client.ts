import type { ClientCommand, CommandResult, ServerEvent, ServerMessage } from "@harness/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** A command the server rejected; `code` is the stable server-side reason. */
export class ServerCommandError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ServerCommandError";
		this.code = code;
	}
}

type WithoutId<C> = C extends { id: string } ? Omit<C, "id"> : never;

/** A client command without its correlation ID. */
export type CommandInput = WithoutId<ClientCommand>;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

const RECONNECT_DELAY_MS = 1_000;

/**
 * One WebSocket to the harness server. Commands resolve by correlation ID; server pushes go to
 * event listeners. Reconnects on its own after a dropped connection.
 */
export class HarnessClient {
	readonly #url: string;
	#socket: WebSocket | undefined;
	#status: ConnectionStatus = "disconnected";
	#nextId = 0;
	#pending = new Map<string, PendingRequest>();
	#eventListeners = new Set<(event: ServerEvent) => void>();
	#statusListeners = new Set<(status: ConnectionStatus) => void>();
	#reconnectTimer: number | undefined;
	#disposed = false;

	constructor(url: string) {
		this.#url = url;
	}

	get status(): ConnectionStatus {
		return this.#status;
	}

	connect(): void {
		if (this.#disposed || this.#socket !== undefined || this.#reconnectTimer !== undefined) return;
		this.#open();
	}

	#open(): void {
		this.#setStatus("connecting");
		const socket = new WebSocket(this.#url);
		this.#socket = socket;

		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			this.#setStatus("connected");
		});

		socket.addEventListener("message", (message) => {
			let parsed: ServerMessage;
			try {
				parsed = JSON.parse(String(message.data)) as ServerMessage;
			} catch {
				console.warn("[client] ignoring malformed server message");
				return;
			}
			if (parsed.type === "response") {
				const pending = this.#pending.get(parsed.id);
				this.#pending.delete(parsed.id);
				if (pending === undefined) return;
				if (parsed.ok) pending.resolve(parsed.data);
				else pending.reject(new ServerCommandError(parsed.error.code, parsed.error.message));
				return;
			}
			for (const listener of [...this.#eventListeners]) listener(parsed);
		});

		socket.addEventListener("close", () => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			for (const pending of this.#pending.values()) pending.reject(new Error("Connection closed"));
			this.#pending.clear();
			this.#setStatus("disconnected");
			if (!this.#disposed) {
				this.#reconnectTimer = window.setTimeout(() => {
					this.#reconnectTimer = undefined;
					this.#open();
				}, RECONNECT_DELAY_MS);
			}
		});

		socket.addEventListener("error", () => {
			// The close event follows and handles the reconnect.
		});
	}

	send<T extends ClientCommand["type"]>(command: Extract<CommandInput, { type: T }>): Promise<CommandResult[T]> {
		const socket = this.#socket;
		if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Not connected to the server"));
		}
		const id = String(++this.#nextId);
		return new Promise<CommandResult[T]>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			socket.send(JSON.stringify({ ...command, id }));
		});
	}

	onEvent(listener: (event: ServerEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	onStatus(listener: (status: ConnectionStatus) => void): () => void {
		this.#statusListeners.add(listener);
		return () => {
			this.#statusListeners.delete(listener);
		};
	}

	#setStatus(status: ConnectionStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		for (const listener of [...this.#statusListeners]) listener(status);
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#reconnectTimer !== undefined) window.clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#socket?.close();
		this.#socket = undefined;
	}
}
