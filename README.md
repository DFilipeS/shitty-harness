# Shitty Harness

A personal AI agent harness built on [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable), with a web client.

The durable package owns the agent loop: conversations, model turns, tool calls, and state are committed to SQLite before anything is shown. If the server dies mid-turn, reopening the database picks the work up where it stopped. This repo adds the product around it: provider configuration, a session index, a WebSocket protocol, and a web UI.

## Architecture

```
packages/
  protocol/   shared command/event types (the contract between server and client)
  core/       the harness: pi-durable, providers, credentials, sessions, event streams
  server/     HTTP + WebSocket transport and static file serving
  web/        React + Vite + Tailwind UI
```

- `core` has no HTTP knowledge. A different client (TUI, CLI, mobile) can reuse it as is. It takes its storage and providers as dependencies; `@harness/core/node` wires the SQLite and config-file adapters for production.
- `server` translates protocol messages into `core` calls and forwards push events.
- `web` is one client. It only knows the protocol.

Data lives in `data/` (git-ignored):

| File | Contents |
| --- | --- |
| `sessions.sqlite` | durable conversations, tasks, entries, documents |
| `config.json` | provider API keys (mode `0600`) |
| `models.json` | cached dynamic provider catalogs |

## Requirements

- [mise](https://mise.jdx.dev/) (pins Node 26 in `.mise.toml`)
- An API key for at least one built-in pi-ai provider (OpenAI, Anthropic, Fireworks, OpenRouter, …)

## Run it

```bash
mise install
npm install

# development: server on :8787, Vite dev server on :5173 (proxies /ws)
npm run dev
# open http://localhost:5173
```

Production build:

```bash
npm run build     # builds the web app
npm start         # serves web + /ws from http://localhost:8787
```

Other scripts:

```bash
npm run typecheck                    # all four packages
npm test                             # core unit tests (Vitest, in-process)
node scripts/smoke.mjs               # protocol smoke test against a running server
node scripts/e2e.mjs                 # create a session, prompt a real model, print the answer
node scripts/ui-check.mjs http://localhost:8787/   # headless Chrome check of the rendered UI
node scripts/measure-stream.mjs      # per-batch stream timing
```

### Streaming

pi-durable commits streamed text and tool output every 100 ms (its default), and one event batch is emitted per commit, so raw batches arrive chunky. The web client hides that: it buffers whatever arrives and reveals it with a typing animation (`packages/web/src/components/LiveMessage.tsx`). Each text and thinking block reveals on its own; the rate follows that block's backlog with a small target lag (~0.25 s), so batches of any size appear as smooth typing, and the committed entry stays hidden until the reveal catches up. `prefers-reduced-motion` skips the animation.

`scripts/measure-stream.mjs` prints the actual gap and batch size while a model streams.

## Using it

1. Open the app and click the gear icon.
2. Find a provider, click **Connect**, paste an API key, and save.
3. Create a session, pick a provider, model, and thinking level in the header.
4. Chat. Double-click a session title to rename it, or use the trash icon to delete it.

While a run is in flight, the sidebar shows a spinner and "Working…" under that session — including sessions you switched away from.

On a narrow screen the sidebar becomes a drawer behind the menu button in the header.

Messages render Markdown (GFM tables, task lists, strikethrough) with syntax-highlighted code blocks. Raw HTML is not enabled, and links open in a new tab.

Deleting a session removes it from the app index, so it disappears from the sidebar and cannot be resumed. Durable storage is append-only and has no public delete API, so the underlying records stay in `sessions.sqlite`.

Provider credentials can also come from environment variables (for example `OPENAI_API_KEY`); pi-ai resolves those the same way it does in Pi. The settings UI shows `authSource` when a credential comes from the environment.

## How a message flows

1. The client sends `sessions.prompt` over `/ws`.
2. `core` durably admits the submission (`conversation.submit`) and returns its ID.
3. The durable generation task calls the model, streams progress, and commits entries.
4. The server forwards `watchEvents` batches as `session.event` messages.
5. The client renders committed entries plus the in-flight assistant message.

Sessions are durable conversations. The sidebar order and titles come from a session-scoped `app.session-index` document, which is updated in the same commits that create conversations and place prompts.

## Current scope

- Chat only: no tools are installed in the registry yet.
- API keys only: no OAuth login flows.
- Built-in providers only: no custom OpenAI/Anthropic-compatible endpoints.
- Single user, local-first: the server trusts every client on localhost.

The `registry` in `packages/core/src/service.ts` is where tools and prompt sections will be installed. The protocol is versionless and experimental, like pi-durable itself.
