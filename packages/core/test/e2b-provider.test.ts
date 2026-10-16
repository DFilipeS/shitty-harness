import { describe, expect, it } from "vitest";
import { mapError } from "../src/sandboxes/e2b/provider.ts";

function namedError(name: string, message: string): Error {
	return Object.assign(new Error(message), { name });
}

describe("E2B error mapping", () => {
	it("reports a paused sandbox as unavailable, not as a command timeout", () => {
		const mapped = mapError(namedError("SandboxNotRunningError", "was not found"));
		expect(mapped.code).toBe("unavailable");
		expect(mapped.message).toContain("paused or stopped");
	});

	it("reports an unreachable sandbox as unavailable", () => {
		const mapped = mapError(namedError("SandboxUnreachableError", "connection lost"));
		expect(mapped.code).toBe("unavailable");
		expect(mapped.message).toContain("unreachable");
	});

	it("keeps a command deadline as a timeout", () => {
		expect(mapError(namedError("TimeoutError", "deadline exceeded")).code).toBe("timeout");
	});
});
