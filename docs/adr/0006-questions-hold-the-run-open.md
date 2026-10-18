# Questions hold the run open

A question keeps its tool call open until the user answers, skips, or stops the run. The reply becomes that call's result, and there is no timeout: an open question survives server restarts. While it is open, the composer is replaced by the question form, so the only ways forward are answering, skipping, or Stop.

The alternative was to end the run when the question is shown (`terminate: true`) and let the reply arrive as the next user message. That is durable for free and never leaves a session stuck, but the model would get its answer as a new input rather than as the result of its call, and it could not ask in the middle of a plan and carry on. We chose to match Claude Code's behaviour and pay for it in the tool: it must be replay-safe and find a stored reply when it reruns after a restart.
