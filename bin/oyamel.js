#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "src", "cli.ts");

// Resolve tsx dynamically so it works when npm hoists it
const require = createRequire(import.meta.url);
const tsxDir = dirname(require.resolve("tsx/package.json"));
const tsxCli = join(tsxDir, "dist", "cli.mjs");

const result = spawnSync(
  process.execPath,
  [tsxCli, cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
