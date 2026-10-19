import type { HarnessOptions } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/**
 * Builds the execution environment for one conversation's tool calls. The local machine is the
 * only implementation today (`localEnvironment` in `./node.ts`); a remote sandbox implements the
 * same contract (`ExecutionEnv` from `@earendil-works/pi-durable/env`) and replaces this factory.
 */
export type EnvironmentFactory = NonNullable<HarnessOptions["env"]>;

/**
 * An environment that builds the real one on first use. pi-durable asks for an environment before
 * every request, but a session that never touches files should create nothing, so `resolve` runs
 * on the first method call. `id` and `cwd` are known up front.
 */
export function lazyEnvironment(
	id: string,
	cwd: string,
	resolve: () => Promise<ExecutionEnv>,
): ExecutionEnv {
	let pending: Promise<ExecutionEnv> | undefined;
	const environment = () => (pending ??= resolve());
	return new Proxy({ id, cwd } as ExecutionEnv, {
		get(target, property, receiver) {
			if (property === "id" || property === "cwd") return Reflect.get(target, property, receiver);
			// `await` probes for `then`; the proxy must never look thenable.
			if (typeof property !== "string" || property === "then") return undefined;
			return async (...args: unknown[]) => {
				const resolved = await environment();
				const member = (resolved as unknown as Record<string, unknown>)[property];
				if (typeof member !== "function") throw new Error(`ExecutionEnv has no method ${property}`);
				return (member as (...inner: unknown[]) => unknown).apply(resolved, args);
			};
		},
	});
}
