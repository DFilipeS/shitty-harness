# Harness

A personal AI agent harness: a durable chat server plus a web client. The server owns the agent loop and commits every change to storage before it is shown; the client is one way to drive it.

## Language

### The harness

**Harness**:
The durable agent loop. It owns conversations, runs their tasks, and commits every change before it is shown.
_Avoid_: server, engine

**Agent**:
A conversation's resolved model, thinking level, and tools, used for its next request.
_Avoid_: bot, assistant

**System prompt**:
The instruction text a model receives with each request, composed of ordered, named prompt sections.
_Avoid_: instructions, persona, prompt (unqualified)

**Prompt section**:
One named piece of the system prompt, rendered before each request.
_Avoid_: block, fragment

**Agent guidance**:
The prompt section that tells the agent who it is and how to behave: identity, tool rules, output style, and question policy.
_Avoid_: preamble, persona, general prompt

### Sessions

**Session**:
A titled, durable chat that the sessions sidebar lists and the user can open, rename, or delete. A session is backed by a conversation.
_Avoid_: chat, thread, conversation

**Conversation**:
The durable record of a transcript, agent settings, and live work. A session presents a conversation to the user.
_Avoid_: session (when you mean the record)

**Session index**:
The ordered list of sessions the app knows about. Deleting a session removes it from the index; the conversation's records stay in storage.
_Avoid_: session list

**Working**:
A session that has live work and no open question, shown with a spinner in the sessions sidebar.
_Avoid_: busy, running

**Needs input**:
A session whose run is paused on an open question. The sessions sidebar shows it apart from working sessions.
_Avoid_: waiting, blocked

**Session panel**:
The right-hand panel with information about the open session.
_Avoid_: inspector, info sidebar, details panel

### Transcript

**Entry**:
One committed record in a conversation's transcript. Every message is an entry; so are tool results, compaction summaries, and other harness records.
_Avoid_: record, item

**Message**:
A user message or an assistant response. Other transcript records, such as tool results, are entries but not messages.
_Avoid_: entry (for a message)

**Live message**:
The assistant response being generated right now, shown before it is committed as an entry.
_Avoid_: partial, streaming message

**Snapshot**:
The point-in-time view of a conversation, including its entries and current work, sent when a client attaches.
_Avoid_: state dump

### Work and runs

**Run**:
The processing of one or more queued inputs for a session, from start to end.
_Avoid_: turn, job

**Turn**:
One model request and its response within a run.
_Avoid_: round, step

**Submission**:
A piece of user input or an entry write that the harness has durably admitted, whether or not it has been processed yet.
_Avoid_: request, prompt

**Queue**:
The messages of a session that wait behind its active run. A queued message can be taken back out until the run picks it up.
_Avoid_: backlog, buffer, inbox

**Attachment**:
A file sent with a message. Images travel as image content to models that accept them; text files are inlined into the message text. Every attachment is also saved in the workspace, and the message lists the paths.
_Avoid_: upload, file

**Task**:
A durable unit of work for a conversation, such as generation, a tool call, or compaction.
_Avoid_: job

**Question**:
A tool call in which the agent asks the user to choose from options or answer in their own words, and waits for the reply. The reply is the call's result.
_Avoid_: prompt, form, elicitation

**Nested tool call**:
A tool call made by a running tool call, such as a script's, rather than by the agent's message. It belongs to its caller, which reports it, instead of the transcript.
_Avoid_: sub-call, inner call

**Compaction**:
Replacing older entries with a summary so a conversation fits its model's context window.
_Avoid_: truncation, summarization

### Execution

**Sandbox**:
A remote execution environment created and managed by a sandbox provider. Its files and processes can be paused, resumed, and attached to a session again later.
_Avoid_: container, VM, remote machine

**Sandbox provider**:
A vendor that creates and manages sandboxes, such as E2B.
_Avoid_: provider (unqualified), backend

**Sandbox template**:
A named environment the harness builds into an E2B template. New sandboxes can start from one.
_Avoid_: image, base

**Template recipe**:
The file that describes how the harness builds a sandbox template: where it starts and the commands it runs.
_Avoid_: definition, spec

**Target**:
Where a session's tools run: the local machine or a sandbox. A session can change its target between runs.
_Avoid_: environment, host, runner

**Workspace**:
The directory a session's tools operate in, inside its target.
_Avoid_: project, working directory

**Connect**:
To bind a session to an existing sandbox, so its tools run there.
_Avoid_: attach (a client attaches to a session)

### Models and providers

**Provider**:
A vendor that serves models, such as OpenAI or Anthropic. A provider is either configured with a credential or not.
_Avoid_: model, vendor

**Model**:
One selectable model offered by a provider.
_Avoid_: provider

**Credential**:
The secret, currently an API key, that authenticates the harness to a provider.
_Avoid_: token (for an API key)

**Model catalog**:
The set of models known for each provider, from the bundled pi-ai data plus an overlay from the remote pi.dev catalog.
_Avoid_: model list

**Defaults**:
The model, thinking level, and target a new session starts with. Unset means the harness picks the first available model and the local machine.
_Avoid_: settings

**Thinking level**:
How much reasoning effort a model spends on a response.
_Avoid_: reasoning (unqualified)

**Usage**:
A session's recorded token and cost totals, kept in separate model and tool buckets.
_Avoid_: stats, metrics

### Extensions

**Registry**:
The collection of extensions installed in the harness. Tools are not installed yet.
_Avoid_: plugin list

**Extension**:
A named bundle of tools, prompt sections, hooks, and tasks that a conversation can select.
_Avoid_: plugin, module

**Tool**:
A callable capability offered to a model, such as reading a file or running a shell command.
_Avoid_: function, action

**Code Mode**:
The capability that lets the agent write one script whose code calls tools, instead of one tool call at a time.
_Avoid_: code execution, REPL

**Script**:
The JavaScript the agent writes in a Code Mode call. Only the script's output and the calls it made become part of the conversation.
_Avoid_: program, macro

### Skills

**Skill**:
A directory of instructions, and optionally scripts and other files, that an agent can load for a specific task. It follows the Agent Skills format.
_Avoid_: prompt, recipe, plugin

**Skill catalog**:
The names and descriptions of the skills available to a conversation, shown to the agent before any skill is loaded.
_Avoid_: skill list

**Project instructions**:
The context files a workspace carries — AGENTS.md and its kin — loaded from the workspace's ancestors and the target's global slot, and given to the agent as prompt content.
_Avoid_: context files, project context, AGENTS file

**Activate**:
To load a skill's instructions into a conversation, by the model or by the user.
_Avoid_: load, run, trigger

**Invoke**:
To activate a skill directly from the message box.
_Avoid_: slash command, call
