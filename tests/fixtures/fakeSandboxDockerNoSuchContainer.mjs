#!/usr/bin/env node
// Fake docker binary that always fails `rm -f` with a real docker-style
// "No such container" message, for testing stopSandboxContainer's
// best-effort swallow behavior.
process.stderr.write(
  "Error response from daemon: No such container: definitely-not-a-real-container\n",
);
process.exit(1);
