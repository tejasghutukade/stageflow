import { stdin as input, stderr as output } from "node:process";

export function readApiKeyFromEnv(
  env: NodeJS.ProcessEnv,
  varName: string,
): string {
  if (typeof varName !== "string" || varName.length === 0) {
    throw new Error("Missing value for --api-key-env");
  }
  const value = env[varName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Environment variable ${varName} is not set`);
  }
  return value;
}

export function promptSecret(message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(`${message}: `);
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      let buf = "";
      const onData = (chunk: Buffer | string) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (buf.includes("\n") || buf.includes("\r")) {
          cleanup();
          resolve(buf.replace(/\r?\n$/, ""));
        }
      };
      const onEnd = () => {
        cleanup();
        resolve(buf);
      };
      const cleanup = () => {
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.pause();
      };
      input.resume();
      input.on("data", onData);
      input.once("end", onEnd);
      return;
    }

    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        cleanup();
        output.write("\n");
        resolve(buf);
      } else if (ch === "\u0003") {
        cleanup();
        output.write("\n");
        reject(new Error("Cancelled"));
      } else if (ch === "\u007f" || ch === "\b") {
        buf = buf.slice(0, -1);
      } else if (ch >= " ") {
        buf += ch;
      }
    };
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
    };
    input.on("data", onData);
  });
}
