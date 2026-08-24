#!/usr/bin/env node
/**
 * Print live login-capable providers from embedded Pi ModelRuntime.
 * Use to fill docs/manual-tests/pi-provider-login-parity-matrix.md rows.
 *
 * Usage:
 *   npm run providers:list-login-capable
 *   npx tsx scripts/list-login-capable-providers.ts [authPath]
 *
 * authPath defaults to a temp SF-owned-style path under the OS tmpdir
 * (does not read or write real credentials unless you pass a path).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  isLoginCapable,
  listLoginCapableProviders,
} from "../src/agent/providerAuth.js";

async function main(): Promise<void> {
  const argPath = process.argv[2];
  let tempRoot: string | undefined;
  let authPath = argPath;
  if (!authPath) {
    tempRoot = await mkdtemp(path.join(tmpdir(), "sf-login-capable-"));
    authPath = path.join(tempRoot, "auth.json");
  }

  try {
    const runtime = await ModelRuntime.create({
      authPath,
      refreshOnCreate: false,
    });
    const all = runtime.getProviders();
    const capable = listLoginCapableProviders(runtime);
    const excluded = all
      .filter((p) => !isLoginCapable(p))
      .map((p) => p.id);

    console.log(
      JSON.stringify(
        {
          authPath,
          embeddedNote:
            "Login-capable = oauth present OR apiKey.login present (KTD1). Env-only excluded.",
          loginCapable: capable,
          excludedEnvOnlyIds: excluded,
        },
        null,
        2,
      ),
    );
  } finally {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
