import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.env.VERIFY_GRANDCHILD_PID_FILE;
if (!pidFile) {
  process.stderr.write("VERIFY_GRANDCHILD_PID_FILE required\n");
  process.exit(2);
}

const grandchild = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1e9)"],
  { stdio: "ignore", detached: false },
);
writeFileSync(pidFile, String(grandchild.pid));
setInterval(() => {}, 1e9);
