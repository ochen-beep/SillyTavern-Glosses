// @ts-check
// Portable Node test runner for Glosses.
//
// Ported from DS Comments/scripts/run-tests.mjs. Recursively discovers all
// tests/**/*.test.mjs files, runs them under `node --test`, and injects
// NODE_TEST=1 so production code can expose test-only (_test-prefixed) exports.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, 'tests');

/** Recursively collect *.test.mjs under testDir, sorted for stable order. */
function collectTestFiles(dir, acc = []) {
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            collectTestFiles(full, acc);
        } else if (name.endsWith('.test.mjs')) {
            acc.push(full);
        }
    }
    return acc;
}

const testFiles = collectTestFiles(testDir).sort();
if (!testFiles.length) {
    console.error('[run-tests] No *.test.mjs files found under', testDir);
    process.exitCode = 1;
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    env: { ...process.env, NODE_TEST: '1' },
    stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
