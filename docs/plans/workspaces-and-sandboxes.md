# Plan: workspaces and remote sandboxes

Status: M1 (local targets and scratch workspaces), M2 (sandbox seam and E2B), M3 (SSH agent forwarding), and M4 (concurrency warning, key validation, docs) implemented. The sandbox template build now has its own plan: [sandbox templates](./sandbox-templates.md).

The harness keeps running on the user's machine. Tools run either on the local machine or in a
remote sandbox, chosen by the user per session. This plan turns that into code. The vocabulary is
in [`GLOSSARY.md`](../../GLOSSARY.md); the decisions are in
[`docs/adr/0001`](../adr/0001-user-chosen-targets-no-fallback.md),
[`0002`](../adr/0002-switching-targets-does-not-move-files.md), and
[`0003`](../adr/0003-sandboxes-outlive-sessions.md).

## Model

- **Target**: where a session's tools run — the local machine or a sandbox. The user chooses it; the
  model cannot change it; it can change between runs.
- **Workspace**: the directory the tools operate in, inside the target. Local: a scratch directory
  at `data/workspaces/<session-id>`, or a picked folder. Sandbox: `/home/user/workspace`, recorded
  in the sandbox metadata.
- **Sandbox**: a first-class, long-lived resource with a provider, id, name, state, workspace
  directory, and source. Any session can connect to it. It dies only when explicitly killed.
- **No project entity**: local directories are plain paths. The session stores its target and root.

## Architecture

### Target model and storage

A conversation-scoped document holds the session's target:

```ts
// packages/core/src/targets.ts
type SandboxSource = { kind: "empty" } | { kind: "git"; url: string };

type SessionTarget =
  | { kind: "local"; path: string }
  | {
      kind: "sandbox";
      provider: string;
      sandboxId?: string; // absent until first use
      name?: string;
      template?: string;
      source?: SandboxSource;
      workspaceDir?: string;
      forwardAgent?: boolean;
    };

type SessionTargetState = { kind: "unset" } | SessionTarget;

export const SessionTargetDoc = defineDoc<SessionTargetState>({
  kind: "app.session-target",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ kind: "unset" }),
});
```

- New sessions write the current default target in `createSession`.
- A missing target (old test sessions) resolves to the current default at use time.
- `sessions.setTarget` writes the document; a change is appended to the transcript and rendered in
  the system prompt (see below).

Settings in `data/config.json`:

```json
{
  "defaults": {
    "target": { "kind": "local" }
  },
  "sandboxes": {
    "provider": "e2b",
    "template": "base",
    "idleTimeoutMs": 300000,
    "autoPause": true,
    "ssh": { "agentSocket": null, "forwardAgent": true },
    "e2b": { "apiKey": "..." }
  }
}
```

`defaults.target` may be `{ "kind": "local" }` (scratch), `{ "kind": "local", "path": "…" }`, or
`{ "kind": "sandbox" }` (using the `sandboxes` defaults). `HARNESS_WORKSPACE` is removed.

### Environment factory

pi-durable calls `HarnessOptions.env` on every generation and every tool call, so the factory must
be cheap and cache sandbox connections. `HarnessService` composes it:

```ts
env: async (target, context) => {
  const resolved = await resolveTarget(target.read, target.conversationId, context, deps);
  if (resolved.kind === "local") return deps.localEnvironment({ ...target, cwd: resolved.path }, context);
  return deps.sandboxes.environment(resolved, target.conversationId, context);
}
```

- `localEnvironment` is today's `NodeExecutionEnv` factory from `@harness/core/node`.
- `SandboxManager.environment` returns a cached `SandboxExecutionEnv` per conversation, creating or
  connecting the sandbox on first use and persisting `sandboxId` back into the target document.
- pi-durable reports a factory error and continues with no environment; the service surfaces the
  failure as a target error so the UI can show it instead of a bare "tool failed".

### Sandbox modules

```
packages/core/src/sandboxes/
  provider.ts        contract, errors, capabilities (no provider SDK imports)
  registry.ts        provider factories by name
  manager.ts         SandboxManager: per-conversation env cache, lifecycle, status
  env.ts             SandboxExecutionEnv: pi-durable ExecutionEnv over a Sandbox
  e2b/provider.ts    E2B adapter (dynamic import of "e2b")
  e2b/ws-proxy.mjs   host-side WebSocket proxy for SSH
  e2b/index.ts       registers the E2B factory
```

Provider contract (ported from `pi-remote-sandbox`, trimmed):

```ts
interface SandboxProvider {
  readonly name: string;
  readonly capabilities: {
    pauseResume: boolean;
    agentForwarding: boolean;
    metrics: boolean;
  };
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  connect(id: string): Promise<SandboxHandle>;
  list(filter?: { labels?: Record<string, string> }): Promise<SandboxInfo[]>;
  kill(id: string): Promise<void>;
}

interface SandboxHandle {
  readonly id: string;
  readonly workspaceDir: string;
  exec(command: string, options?: ExecOptions): Promise<{ exitCode: number | null }>;
  readFile / writeFile / listDir / stat / makeDir;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
  kill(): Promise<void>;
  metrics?(): Promise<SandboxMetrics | undefined>;
  forwardAgent?(hostSocket: string): Promise<AgentForwarding>;
}
```

`SandboxExecutionEnv` implements pi-durable's `ExecutionEnv` over a `SandboxHandle`:

- Filesystem maps to the provider's file API. `openBinaryReader`, `openTextLineReader`, and
  `scanLines` read the file and serve ranges from memory in v1; `listFiles` and `watch` stay
  unimplemented (both are optional).
- Shell maps to `exec` with streaming output, environment variables, abort, and a spill file in the
  sandbox for large output.
- `cleanup` kills running commands, never the sandbox.

The conformance suite from `@earendil-works/pi-durable/testing/env-conformance` runs against a fake
provider; a smoke script runs the same cases against a real E2B sandbox when `E2B_API_KEY` is set.

### E2B adapter

- `create`: template from the spec (default from settings), metadata `{ harness: "1", name,
  workspaceDir, source }`, `lifecycle: { onTimeout: "pause", autoResume: true }`, workspace
  directory, optional git clone, git identity copied from the host.
- `connect`: `Sandbox.connect`, which resumes a paused sandbox.
- `list`: `Sandbox.list` filtered by the `harness` label, paginated.
- `pause`, `resume`, `kill`, `metrics` map directly.
- `forwardAgent`: hop key in `data/sandboxes/`, websocat bootstrap, WebSocket bridge, `ssh -N -R`
  tunnel using `process.execPath` for the proxy, restart with backoff, stop on pause and kill.

### Status and events

- `SandboxManager` emits state changes: `starting`, `ready`, `paused`, `gone`.
- The service forwards `sandboxes.changed` (the list) and per-session `session.target` events with
  the phase, so the composer shows "creating sandbox…", "installing tools…", "cloning…".
- Metrics are polled while the sandboxes page is open and while a run is active.

### System prompt and transcript

- A prompt section renders the current target, for example:
  `Your tools run in sandbox e2b:1234abcd at /home/user/workspace. Saved file paths refer to this target.`
- Switching appends a visible transcript entry with the old and new target.
- The model cannot change the target.

## Protocol

New types: `TargetChoice`, `TargetInfo`, `SandboxSummary`, `SandboxState`.

New commands:

| Command | Purpose |
| --- | --- |
| `sessions.setTarget` | Choose local, a new sandbox, or an existing sandbox |
| `sessions.create` (extended) | Optional target, so the sandboxes page can open a session bound to one |
| `workspaces.browse` | List directories for the local folder picker |
| `workspaces.createFolder` | Create a directory from the picker |
| `sandboxes.list` | Sandboxes known to the provider, merged with local last-used data |
| `sandboxes.create` | Standalone sandbox, before any session connects |
| `sandboxes.pause` / `sandboxes.resume` | Lifecycle |
| `sandboxes.kill` | Explicit removal |
| `sandboxes.rename` | Update the name in provider metadata |
| `sandboxes.metrics` | CPU, memory, disk samples |

New events: `sandboxes.changed`, `session.target`.

`SessionSummary` gains the current target so the sidebar and header can show it.

## Web UI

- Target control in the composer row, next to model and thinking level. It shows `Local`,
  `e2b:1234abcd`, `paused`, or `gone`, and opens the picker: Local machine (scratch or folder), New
  sandbox, Existing sandbox.
- New-sandbox dialog: name (optional), template (advanced, default from settings), source (empty or
  git URL), forward SSH agent (default on).
- Sandboxes page: list with state and name, create, connect to the open session, open a new session
  with it, pause, resume, kill, rename, metrics.
- Command palette: "Switch target…", "New sandbox…", "Manage sandboxes…", "Configure E2B…".
- Errors: a gone or failing sandbox shows a clear message in the session and the sandboxes page.
- Without an E2B key, sandbox options hide behind "Configure E2B…".

## Milestones

### M1 — Targets and local workspaces

- Target document, defaults, resolution, scratch directories, folder browser.
- `sessions.setTarget`, `workspaces.browse`, `workspaces.createFolder`; target in the session
  snapshot; system prompt section; transcript entry.
- Composer control and local folder picker.
- Tests: target resolution, scratch paths, service commands.

Done when: a session can run tools in a picked folder or a scratch directory, switching works
between runs, and a chat-only session creates nothing.

### M2 — Sandbox seam and E2B basics

- Provider contract, registry, E2B adapter (`create`, `connect`, `list`, `kill`, `pause`, `resume`,
  `metrics`), `SandboxExecutionEnv`, conformance tests, `SandboxManager` with lazy creation.
- Settings: E2B key and sandbox defaults; palette "Configure E2B…".
- Picker: new sandbox (empty or public git clone), existing sandbox; sandboxes page.
- Tests: env conformance against a fake provider; manager lifecycle; a smoke script against E2B.

Done when: a sandbox session runs `read`, `write`, `edit`, and `bash` in E2B; pause, resume, kill,
and list work; a server restart reconnects to a paused sandbox.

### M3 — SSH agent forwarding

- `ws-proxy.mjs`, hop key, websocat bootstrap, tunnel lifecycle, git identity, `SSH_AUTH_SOCK`
  injection, per-sandbox toggle, active indicator, docs recommending a destination-constrained
  agent.

Done when: a private repository clones and pushes through the forwarded agent, no key material
enters the sandbox, and the tunnel stops on pause and kill.

### M4 — Polish

- Metrics display, concurrency warning, error surfaces, README and docs. (Rename and a template
  build command were dropped; see Deferred.)

## Deferred

- Copying a local workspace into a sandbox (git is the transport in v1).
- Snapshots and forks.
- A prebuilt `harness-base` template with websocat, so sandboxes skip the first-use download: covered by [sandbox templates](./sandbox-templates.md). Until then, the E2B adapter installs websocat at runtime.
- Renaming a sandbox: E2B metadata is set at creation and cannot be updated, so the harness would
  need its own alias store.
- Docker and other providers.
- Model-requested sandboxes; the user owns the target.

## Risks

- `ExecutionEnv` conformance is the biggest unknown; start M2 by running the conformance suite
  against a fake provider.
- E2B file API latency may make whole-file reads slow for large files; measure and add streaming
  reads if needed.
- The websocat bootstrap adds a GitHub download per new sandbox until a template exists.
