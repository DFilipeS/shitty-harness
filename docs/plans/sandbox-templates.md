# Plan: sandbox templates

Status: M1 implemented (recipes, storage, build queue, Templates page). M2 (selection, picker, lifecycle) not started.

New sandboxes start from the provider's base image today, so every new sandbox pays the environment
bootstrap again. This plan gives the harness a builder: recipes under `data/templates/` that it
builds into E2B templates, a Templates page to manage them, and a picker so a session's new sandbox
starts prepared. The vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md); the decision is in
[`docs/adr/0004`](../adr/0004-sandbox-templates-built-from-recipes.md).

## Model

- **Sandbox template**: a named environment the harness builds into an E2B template. New sandboxes
  can start from one.
- **Template recipe**: the file that describes how the harness builds a sandbox template: where it
  starts and the commands it runs.
- **Build state**: `draft` (never built), `building`, `ready`, `stale` (the recipe changed since the
  last successful build), `failed`, `missing` (gone from E2B).
- **Selection**: a global default plus a per-session choice. No per-project memory yet.

## Recipe

`data/templates/<name>/recipe.yaml`:

```yaml
description: Node 22 with pnpm
from:
  template: harness-base   # exactly one of template or image; omitted means the E2B base image
  # image: node:22
run:
  - apt-get update && apt-get install -y git build-essential
  - corepack enable
```

- The directory name is the template name. E2B names are lowercased and match `^[a-z0-9-_]+$`.
- `run` commands are single-line strings, executed in order as root.
- `copy`, `env`, and `workdir` are reserved; the harness owns `/home/user/workspace`.
- The recipe file is the source of truth. The palette writes it; hand edits are read back and
  reformatted on the next palette edit.

## Architecture

### Storage

```
data/templates/<name>/
  recipe.yaml   the recipe
  build.json    templateId, buildId, status, startedAt, finishedAt, recipeHash, error
  build.log     the last build's log
```

There is no central registry: the list is a scan of `data/templates/*/` merged with the provider's
state. Staleness compares the recipe's hash with the one recorded by the last successful build.

### Provider

The provider contract gains optional template methods:

```ts
buildTemplate(spec: TemplateBuildSpec, onLog: (line: string) => void): Promise<TemplateBuild>;
listTemplates(): Promise<ProviderTemplate[]>;
deleteTemplate(templateId: string): Promise<void>;
```

E2B implements them with `Template.buildInBackground` plus `Template.getBuildStatus` (log offsets),
`GET /v2/templates` for the list, and `DELETE /templates/{templateID}` with the `X-API-KEY` header —
the SDK has no list or delete. `Template.exists` verifies names.

The server runs one build at a time; other builds wait in a queue. Build resources default to
2 CPU / 2048 MB.

### Service

`TemplateManager` (next to `SandboxManager`) lists templates, creates and updates recipes, queues
builds, streams logs, removes entries, deletes E2B templates, and reports state changes. The starter
recipe for `harness-base` (E2B base plus git, curl, ca-certificates, build-essential, jq, unzip,
procps, and websocat) lives in the source and is written only when the user asks for it.

## Protocol

New commands: `templates.list`, `templates.create`, `templates.update`, `templates.build`,
`templates.remove`, `templates.delete`, `templates.logs`. New event: `templates.changed`, carrying
the template list and the running build's log tail.

## Web UI

- **Templates page** (command palette): the list with states, and per template: Description, Base
  (E2B base / a sandbox template / an image), Commands (add, edit, remove, move up, move down),
  Build/Rebuild, Use as default, Remove from harness, and Delete in E2B (confirmed).
- **New template…**: prompts for a name and a starting point, then writes the recipe.
- **New-sandbox picker**: ready and stale harness templates, provider default, other E2B templates
  from the provider list, and "Use a name…". Draft, building, failed, and missing templates are not
  pickable.
- **Sandbox defaults**: the Template row becomes a picker instead of free text.
- **Notifications**: build started, finished, and failed; deleting the default resets it to provider
  default.

## Milestones

### M1 — recipes, storage, build

- Recipe parse, validate, and write; per-template build state; the starter recipe.
- Provider template methods, the build queue, and log capture.
- Templates page: list, create, edit, and build/rebuild with live logs.
- Tests: recipe validation, staleness, the build queue against a fake provider, service commands.

Done when: `harness-base` builds from the page and a sandbox created with it starts with websocat
installed. The page and the build path are covered by tests; the first build against a real E2B
account is still to be run.

### M2 — selection and lifecycle

- New-sandbox picker, sandbox defaults picker, and the staleness badge.
- Remove from harness, Delete in E2B, and the default reset.
- The "Other E2B templates" section.
- Tests: picker and default resolution, remove and delete behavior.

Done when: a session's new sandbox starts from a chosen template, and removing or deleting a
template behaves as decided.

## Deferred

- Snapshots as another source of sandbox templates.
- Project recipes (`.harness/` in the project) and project layers with `copy`.
- Version tags; rebuilding moves the rolling `default` tag.
- Renaming a template; remove and recreate instead.
- Agent access to templates.
- E2B template visibility (public/private).

## Risks

- E2B builds take minutes and plans limit concurrent builds (429); one queue and clear notifications
  are the mitigation.
- `GET /v2/templates` and `DELETE /templates/{templateID}` are REST-only, so they can change outside
  the SDK's compatibility promises.
- YAML round-tripping through the palette loses comments.
- A name built outside the harness collides with a harness template; the build warns.
