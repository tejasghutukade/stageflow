#!/usr/bin/env node
// Fake docker binary that fails `rm -f` with "No such container" and
// `volume rm` with "no such volume", for stopSandboxContainer's swallow path.
const args = process.argv.slice(2);
if (args[0] === "volume") {
  process.stderr.write("Error response from daemon: no such volume\n");
  process.exit(1);
}
process.stderr.write(
  "Error response from daemon: No such container: definitely-not-a-real-container\n",
);
process.exit(1);
