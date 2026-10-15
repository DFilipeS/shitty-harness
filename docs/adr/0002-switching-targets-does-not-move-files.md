# Switching a session's target does not move files

A target can change between runs, but files live in the target that wrote them. Switching changes where commands run and leaves both file universes untouched; git is the transport between them, and copying a local directory into a sandbox is an explicit action, not part of the switch.

No hidden sync means no ambiguity about which copy is canonical and no silent overwrites. It also matches how remote sandboxes are normally used: clone the repository inside the sandbox, push changes out through git.
