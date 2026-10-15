/** App-level failure with a stable code the client can react to. */
export class ServiceError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ServiceError";
		this.code = code;
	}
}
