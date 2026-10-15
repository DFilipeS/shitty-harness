# Sandboxes outlive their sessions

A sandbox is a first-class resource independent of any session: any session may connect to it, and it is killed only explicitly. Deleting a session never kills a sandbox.

Sessions are cheap and disposable, while a sandbox holds files and installed dependencies. Tying a sandbox's death to a session risks silent data loss and prevents reusing a prepared environment across sessions. Paused sandboxes cost no compute, so leaving them alive is cheap.
