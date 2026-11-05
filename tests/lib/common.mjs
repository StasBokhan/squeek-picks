// Shared by the bot tests: where the repo is, a local chain, and a scratch folder for each run.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
export const TESTS = ROOT + "/tests";
export const OUT = process.env.TEST_OUT || TESTS + "/out";

// A fresh folder under tests/out for one run of one test (config files, bot state).
export function scratch(name) {
  mkdirSync(OUT, { recursive: true });
  return mkdtempSync(OUT + "/" + name + "-");
}

// A local chain on `port` (hardhat's, chain id 31337). It runs in its own process group,
// so a test stops it with process.kill(-node.pid, "SIGKILL").
export function startChain(port, config = "hardhat.config.cjs") {
  return spawn(process.execPath, [TESTS + "/node_modules/hardhat/internal/cli/bootstrap.js", "--config", TESTS + "/" + config, "node", "--port", String(port)],
    { cwd: TESTS, stdio: "ignore", detached: true });
}
