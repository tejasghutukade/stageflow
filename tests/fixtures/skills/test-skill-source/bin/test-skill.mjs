#!/usr/bin/env node

const subcommand = process.argv[2];
if (subcommand === "doctor") {
  if (process.env.SF_TEST_SKILL_DOCTOR_FAIL === "1") {
    process.exit(1);
  }
  process.exit(0);
}

console.error(`unknown subcommand: ${subcommand ?? "(none)"}`);
process.exit(1);
