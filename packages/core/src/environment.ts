import type { HarnessOptions } from "@earendil-works/pi-durable";

/**
 * Builds the execution environment for one conversation's tool calls. The local machine is the
 * only implementation today (`localEnvironment` in `./node.ts`); a remote sandbox implements the
 * same contract (`ExecutionEnv` from `@earendil-works/pi-durable/env`) and replaces this factory.
 */
export type EnvironmentFactory = NonNullable<HarnessOptions["env"]>;
