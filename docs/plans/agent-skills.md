# Plan: agent skills

Status: implemented.

Agents gain [Agent Skills](https://agentskills.io/specification): directories with a `SKILL.md`
that hold instructions, and optionally scripts and other files, for a specific task. The model sees
a catalog of names and descriptions and activates a skill when one fits; the user can invoke one
directly from the message box. The vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md); the
mirroring decision is in [`docs/adr/0005`](../adr/0005-host-skills-mirrored-into-sandboxes.md).

## Model

- **Skill**: a directory with a `SKILL.md` (YAML frontmatter plus a Markdown body).
- **Skill catalog**: the names and descriptions a conversation's agent sees before loading any skill.
- **Activate**: load a skill's instructions into a conversation, by the model or by the user.
- **Invoke**: activate a skill from the message box with `/skill:name`.

## Discovery

Two scopes, both read through the session's target:

| Scope | Directories | On a sandbox target |
| --- | --- | --- |
| Project | `<workspace>/.agents/skills`, `<workspace>/.claude/skills` | travel with the repo |
| User | `~/.agents/skills`, `~/.claude/skills` | the sandbox's own home, plus the host mirror |

- A skill is `<dir>/<name>/SKILL.md`; there is no nested search, and a scope lists at most 500.
- Precedence: project over user, `.agents` over `.claude`. A shadowed skill is recorded with a
  warning. Two entries that resolve to the same real directory (symlinks) count once, silently.
- Parsing follows the spec leniently: a name that does not match its directory or is too long warns
  and loads; a missing description or unparseable YAML skips the skill with a reason. A failed parse
  is retried once with unquoted `key: value: more` values quoted.
- `allowed-tools` is kept but not enforced. `disable-model-invocation: true` (Claude Code) leaves a
  skill out of the catalog and the tool, but it can still be invoked.
- No trust gate: a workspace's skills always load.

### Host mirror

On a sandbox target, the host's user skills (`~/.agents/skills` and `~/.claude/skills` on this
machine, `.agents` first) are mirrored into the sandbox's `~/.agents/skills` before the scan:

- `~/.agents/skills/.harness-mirror.json` lists the folders the harness wrote and their content
  hashes. Only those are ever updated or deleted; a skill the host no longer has is removed.
- A folder of the same name that the manifest does not list belongs to the sandbox; it is left alone
  and the host skill is skipped with a warning.
- `.git`, `node_modules`, and dotfiles are skipped. A skill over 10 MB, or past 50 MB in total, is
  not mirrored, with a warning.

## When it runs

- Each run rescans: `sessions.prompt` marks the conversation's catalog stale, and the next request
  rescans (and mirrors) through the request's environment, which already holds the sandbox open.
  The catalog is then cached, so later requests of the run keep the prompt cache warm.
- Autocomplete (`sessions.skills`) scans the host and, for a local target, the workspace. On a
  sandbox target it never opens the sandbox: it returns the host skills merged with the last scan.

## Model side

An extension, `skills`, brings:

- **`skills` section**: short instructions and the catalog (`name`, `description`), omitted when no
  skill is offered to the model.
- **`skill` tool** (`{ name }`): returns the body wrapped as `<skill name="…" source="…">` with the
  skill directory and up to 50 files of it, without reading them. A name that is not in the catalog
  is an error listing the valid names. If the skill is already active, it returns a short note.
  The tool is always offered (a conversation's tools are fixed per extension); with no skills, the
  section is absent and nothing points the model at it.
- **Active skills**: every activation (tool or invocation) is recorded in the conversation's
  `app.skills` document with its content. A `beforeRequest` hook re-adds the content of active skills
  that no longer appear in the request's messages, which is what happens after a compaction.

## Invocation

- `/skill:name rest…` as the first token of a message. The server parses it, so every client gets
  it; an unknown skill is rejected with an error.
- The skill is read at submit time and placed in front of the user's text as the same
  `<skill …>` block the tool returns, so the transcript keeps the content as it was. A user
  invocation always re-adds the skill.
- A new session's title comes from the rest of the message, or the skill name when there is none.

## Protocol

- `sessions.skills { sessionId }` → `{ skills: SkillInfo[], issues: SkillIssue[] }`, where a skill
  carries `name`, `description`, `scope`, `path`, `modelInvocable`, and `warnings`, and an issue is a
  skipped or shadowed skill with its `path` and `reason`.

## Web

- Composer: typing `/` as the first character opens a card above the input with matching skills.
  Matching ignores the `skill:` prefix: name prefix first, then name substring, then description.
  `↑`/`↓` move, `Tab` or `↵` inserts `/skill:name `, `esc` closes. An unknown `/skill:` name blocks
  Send.
- Transcript: one collapsed skill card, with its own icon, for an invocation and for a `skill` tool
  call.
- Palette: **Skills…** lists the session's skills with scope, path, and warnings, and the skipped
  ones with reasons. Read-only.
