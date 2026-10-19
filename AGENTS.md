# Shitty Harness

A local-first coding agent harness: a durable core, a WebSocket server, and a web UI, in `packages/{protocol,core,server,web}`. The README maps the packages and how a message flows; `GLOSSARY.md` defines the product's terms, and `docs/adr/` records the decisions.

## Wrapping up a task

Before calling work done (and before committing), run these three and fix what they report:

```bash
npm run format        # prettier; the codebase is fully formatted, keep it that way
npm run typecheck
npm test
```

## pi-durable

The agent loop is `@earendil-works/pi-durable`; this repo builds the product around it. When you need its APIs, read its README first — it documents everything and links the normative spec:

- `node_modules/@earendil-works/pi-durable/README.md`
- Spec: <https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md>

The parts this product touches most: messages sent while a run is busy queue in the conversation's `pi.inbox` document (steer or follow-up modes); `Harness.abortSubmission()` withdraws a queued one; `watchEvents()` streams what a client renders, including `inbox_update`; submission statuses run `queued → placed → done/unanswered`. Type definitions live in `node_modules/@earendil-works/pi-durable/dist/`.
