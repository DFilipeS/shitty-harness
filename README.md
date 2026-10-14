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
| `config.json` | provider API keys and model defaults (mode `0600`) |
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

1. Press `⌘K` and run **Configure model providers…** (or use the palette button in the sidebar).
2. Pick a provider, choose **Set API key…**, paste the key, and press `↵`.
3. Create a session. The model and thinking level live under the message box; click either one to pick from the palette.
4. Optional: run **Model defaults…** in the palette to choose the model and thinking level new
   sessions start with. **First available** and **Model default** clear each choice; sessions that
   already exist keep their own model and level.

Each session has its own URL (`/sessions/<id>`). The address bar follows the session you open, so
reloading the page, bookmarking it, or sending the link to another browser opens that same session.
Back and forward move between the sessions you visited.
4. Chat. Double-click a session title to rename it, or use the trash icon to delete it.

The header keeps a running tally for the open session on the right: cost, tokens, context use,
and cache hit rate. Each percentage gets a small ring that fills to the value; the context ring
turns amber past 80% and red past 95%, and the cache ring turns green once a call hits the cache.
The cache rate stays at 0% until
a call reuses a cached prefix, which needs a repeated prompt of roughly a thousand tokens. Hover
the tally for the input/output, context, and cache read/write breakdown. On a phone only the cost
stays visible.

While a run is in flight, the sidebar shows a spinner and "Working…" under that session — including sessions you switched away from.

On a narrow screen the sidebar becomes a drawer behind the menu button in the header. On wider screens the same button (or `⌘B`) collapses the sidebar to give the conversation the full width; the desktop choice is remembered across reloads.

The sidebar also has a light/dark toggle. The first visit follows your system preference; the choice is saved in the browser.

Messages render Markdown (GFM tables, task lists, strikethrough) with syntax-highlighted code blocks, thinking blocks included. Raw HTML is not enabled, and links open in a new tab. Session titles render inline formatting (bold, italic, code) while staying single-line.

Deleting a session removes it from the app index, so it disappears from the sidebar and cannot be resumed. Durable storage is append-only and has no public delete API, so the underlying records stay in `sessions.sqlite`.

### Model catalogs

The provider list and model picker come from pi-ai's bundled catalog plus pi.dev's public catalog
(`https://pi.dev/api/models/providers/<id>`, the same source the pi CLI uses). Refreshing pulls
the remote catalog, so newly released models show up without waiting for a pi-ai update. The
result is cached in `data/models.json` with its `ETag` and `Last-Modified`, restored on the next
start, and revalidated with `If-None-Match`. Startup refresh uses the cache while it is fresh
(under four hours); **Refresh providers and models** in the command palette forces a fetch and
reports what each provider did in a toast. Set `HARNESS_CATALOG_BASE_URL` to point at a mirror.

OpenRouter goes one step further: the catalog is then restricted to the chat models your key may
use, with your account's context limits and prices (`GET /models/user`). A model the account
cannot use disappears from the picker instead of falling back to its bundled entry.

pi-ai still decides how a model is called: remote entries only add models or replace same-id
ones, and entries older than the bundled model data are ignored.

## Keyboard

The app is keyboard-first. Press `⌘K` (or `Ctrl+K`) anywhere to open the command palette:
type to filter, `↑`/`↓` to move, `↵` to run. Commands come from the page you are on, so the
chat page also offers session commands (change model, rename, delete, …). Some commands open
a nested list (`Change model…`, `Switch session…`) or ask for a value
(`Rename current session…`); `⌫` on an empty search goes back one level.

On Windows and Linux, use `Ctrl` instead of `⌘`.

| Shortcut | Action |
| --- | --- |
| `⌘K` | Open the command palette |
| `⌘B` | Toggle the sessions sidebar |
| `?` | Show the shortcut list |
| `↵` | Send the message |
| `⇧↵` | New line in the message |
| `esc` | Close the palette or a dialog |

Provider credentials can also come from environment variables (for example `OPENAI_API_KEY`); pi-ai resolves those the same way it does in Pi. The provider list shows `authSource` when a credential comes from the environment.

## How a message flows

1. The client sends `sessions.prompt` over `/ws`.
2. `core` durably admits the submission (`conversation.submit`) and returns its ID.
3. The durable generation task calls the model, streams progress, and commits entries.
4. Tool calls run in the conversation's environment and their results are committed too.
5. The server forwards `watchEvents` batches as `session.event` messages.
6. The client renders committed entries plus the in-flight assistant message.

Sessions are durable conversations. The sidebar order and titles come from a session-scoped `app.session-index` document, which is updated in the same commits that create conversations and place prompts.

## Tools

Agents get pi-durable's default coding tools: `read`, `write`, `edit`, and `bash`. They come from
the `CodingTools` extension, which `packages/core/src/service.ts` installs in the registry; every
conversation selects it by default.

Tools touch files and processes only through an `ExecutionEnv`. Today the only implementation is
the local machine (`NodeExecutionEnv`), which starts in the server's working directory. Set
`HARNESS_WORKSPACE=/some/dir` to change it. **Commands run as the server user with no sandbox**, so
only point this at a machine where that is fine.

The environment is the seam for remote execution: `openHarnessService` takes an `environment`
factory, and anything implementing pi-durable's `ExecutionEnv` works — for example a container per
conversation, looked up by `conversationId`. Only the local implementation exists today.

## Current scope

- Local tools only: the coding tools run on the machine that runs the server; a remote sandbox
  environment is not implemented yet.
- API keys only: no OAuth login flows.
- Built-in providers only: no custom OpenAI/Anthropic-compatible endpoints.
- Single user, local-first: the server trusts every client on localhost.

The protocol is versionless and experimental, like pi-durable itself.
