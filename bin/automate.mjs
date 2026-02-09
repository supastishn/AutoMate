#!/usr/bin/env node

// Thin wrapper that runs src/index.ts via tsx so no build step is needed.
// Works from any directory — all data lives in ~/.automate/

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const entry = join(projectRoot, 'src', 'index.ts');
const tsxPath = join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');

try {
  execFileSync(
    process.execPath,
    ['--import', tsxPath, entry, ...process.argv.slice(2)],
    { stdio: 'inherit', cwd: process.cwd() },
  );
} catch (err) {
  process.exit(err.status || 1);
}
