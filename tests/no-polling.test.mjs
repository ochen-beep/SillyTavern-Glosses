// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Static guard (ported from DS Comments test/no-polling.test.mjs):
// no setInterval() polling for lazy-mounted ST core UI. #send_form is
// guaranteed present by APP_READY — attachment must go through
// whenSendFormReady (event-driven), never through a timer probe. This guard
// prevents a regression that reintroduces polling.

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const FILES = [
    path.join(root, 'index.js'),
    path.join(root, 'src', 'ui', 'launcher.js'),
    path.join(root, 'src', 'ui', 'window.js'),
];

test('index.js, launcher.js and window.js contain no setInterval() calls', () => {
    for (const file of FILES) {
        const src = readFileSync(file, 'utf8');
        assert.ok(
            !/setInterval\s*\(/.test(src),
            `${path.relative(root, file)} still contains setInterval() - lazy-mount attachment must use whenSendFormReady (APP_READY), not polling`,
        );
    }
});
