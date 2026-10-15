# Tools run on a user-chosen target, and the harness never falls back

A session's tools run either on the local machine or in a sandbox, and only the user chooses which target; the model cannot change it, and the choice can change between runs. When a target fails or its sandbox is gone, the tool call fails with a clear error — the harness never silently runs the command on another target.

Running model-generated commands on the host must always be an explicit choice. An automatic fallback from a broken sandbox to the local machine would turn a sandbox failure into host execution, which is exactly the outcome sandboxes exist to prevent.
