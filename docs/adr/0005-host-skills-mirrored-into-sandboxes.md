# Host skills are mirrored into sandboxes

User-level skills live on the host (`~/.agents/skills`, `~/.claude/skills`), but a sandbox session's tools run in the sandbox, where a skill's scripts and reference files would not exist. At the start of each run on a sandbox target, the harness mirrors the host's user skills into the sandbox's `~/.agents/skills`, uploading only what changed. From then on every skill is discovered, activated, and used through the target, the same way on local and sandbox targets, and other agents running inside the sandbox see the same skills.

The harness keeps a manifest (`~/.agents/skills/.harness-mirror.json`) of the folders it wrote and only ever updates or deletes those. A skill folder already in the sandbox that the manifest does not list, such as one a template installed, is left alone and wins over a host skill of the same name.

## Considered Options

- **Copy a skill's folder only when it is activated.** Fewer uploads, but the instructions would come from the host and the files from the sandbox, two read paths for one skill.
- **Route `read` of host-skill paths to the host.** Covers reference files, not scripts: `bash` still runs in the sandbox.
- **Mirror into a harness-owned folder (`~/.harness/skills`).** Never collides with the sandbox's own skills, but needs a sandbox-only user scope and hides the skills from other agents in the sandbox.
