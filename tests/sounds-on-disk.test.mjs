// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guard (ported from DS Comments test/sounds-on-disk.test.mjs):
// BUNDLED_SOUNDS in src/sound.js MUST exactly mirror the sounds/ directory.
// The list is the only surface the settings dropdown and the playback resolver
// read, so a file shipped without a list entry is dead weight in the package,
// and a list entry without a file 404s on play. This test turns both drifts
// into a CI failure instead of a silent mismatch.

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const soundsDir = path.join(root, 'sounds');

// sound.js → core.js needs the document/SillyTavern shims at module eval.
import './helpers/stub-runtime.mjs';

test('BUNDLED_SOUNDS exactly mirrors the sounds/ directory', async () => {
    const { BUNDLED_SOUNDS } = await import('../src/sound.js');

    const onDisk = readdirSync(soundsDir).sort();
    const listed = BUNDLED_SOUNDS.map(s => s.file).sort();

    assert.deepEqual(listed, onDisk,
        'sounds/ and BUNDLED_SOUNDS drifted — add the file to BUNDLED_SOUNDS (with a label) or drop it from the package');
});

test('every BUNDLED_SOUNDS entry has a non-empty label and a .file', async () => {
    const { BUNDLED_SOUNDS } = await import('../src/sound.js');
    for (const s of BUNDLED_SOUNDS) {
        assert.ok(s.file && typeof s.file === 'string', `entry missing .file: ${JSON.stringify(s)}`);
        assert.ok(s.label && typeof s.label === 'string', `entry missing .label: ${s.file}`);
    }
});
