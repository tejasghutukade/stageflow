import * as readline from "node:readline";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
} from "@earendil-works/pi-ai";
import { promptSecret } from "./terminalSecret.js";

export type TerminalAuthInteractionOptions = {
  signal?: AbortSignal;
  write?: (line: string) => void;
  promptLine?: (message: string) => Promise<string>;
  promptSecretLine?: (message: string) => Promise<string>;
};

function defaultPromptLine(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve, reject) => {
    rl.question(`${message}: `, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      // no-op; question callback handles resolve
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new Error("Login cancelled"));
    });
  });
}

export function createTerminalAuthInteraction(
  options: TerminalAuthInteractionOptions = {},
): AuthInteraction {
  const write = options.write ?? ((line: string) => {
    process.stderr.write(`${line}\n`);
  });
  const promptLine = options.promptLine ?? defaultPromptLine;
  const promptSecretLine = options.promptSecretLine ?? promptSecret;

  return {
    signal: options.signal,
    notify(event: AuthEvent): void {
      if (event.type === "info" || event.type === "progress") {
        write(event.message);
        return;
      }
      if (event.type === "auth_url") {
        if (event.instructions) write(event.instructions);
        write(`Open: ${event.url}`);
        return;
      }
      if (event.type === "device_code") {
        write(`Visit: ${event.verificationUri}`);
        write(`Code: ${event.userCode}`);
      }
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (options.signal?.aborted || prompt.signal?.aborted) {
        throw new Error("Login cancelled");
      }
      if (prompt.type === "secret") {
        return promptSecretLine(prompt.message);
      }
      if (prompt.type === "select") {
        write(prompt.message);
        for (const opt of prompt.options) {
          const desc =
            opt.description !== undefined ? ` — ${opt.description}` : "";
          write(`  [${opt.id}] ${opt.label}${desc}`);
        }
        return promptLine("Select option id");
      }
      const suffix =
        prompt.placeholder !== undefined ? ` (${prompt.placeholder})` : "";
      return promptLine(`${prompt.message}${suffix}`);
    },
  };
}
