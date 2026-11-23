import { test } from 'node:test';
import assert from 'node:assert/strict';

// §4.4 spec test: getPersonaDescription contract, tested against the REAL
// context-blocks.js implementation via the NODE_TEST-gated _test export.
// (The previous version of this file rebuilt the function body inside the
// test and passed for the wrong reason once the real implementation drifted.)
//
// Node cannot resolve the real dynamic import('../../../../personas.js') —
// it points into ST's public/scripts — so the fallback tests pre-seed the
// memoized module promise through _test._setUserAvatarImport.

import './helpers/stub-runtime.mjs';
import { resetCtx } from './helpers/stub-runtime.mjs';
import { _test } from '../src/context-blocks.js';

const { getPersonaDescription, _setUserAvatarImport } = _test;

test('getPersonaDescription prefers ctx.getPersonaDescription when present', async () => {
    resetCtx({
        getPersonaDescription: () => 'from-ctx',
        // A resolvable fallback would give different text — must NOT be consulted.
        powerUserSettings: { persona_descriptions: { avatar1: { description: 'from-PU' } } },
    });
    _setUserAvatarImport(Promise.resolve({ user_avatar: 'avatar1' }));
    assert.equal(await getPersonaDescription(), 'from-ctx');
});

test('an empty preferred description is final — no fallback for ""', async () => {
    // The || '' short-circuit returns immediately: an empty description from
    // the ctx surface is not treated as an error and does not fall through.
    resetCtx({
        getPersonaDescription: () => '',
        powerUserSettings: { persona_descriptions: { avatar1: { description: 'from-PU' } } },
    });
    _setUserAvatarImport(Promise.resolve({ user_avatar: 'avatar1' }));
    assert.equal(await getPersonaDescription(), '');
});

test('getPersonaDescription falls back to powerUserSettings + user_avatar', async () => {
    // Newer ST stopped exposing ctx.getPersonaDescription — the manual read
    // via personas.js's user_avatar named export is the live path there.
    resetCtx({
        powerUserSettings: { persona_descriptions: { avatar1: { description: 'fallback-text' } } },
    });
    _setUserAvatarImport(Promise.resolve({ user_avatar: 'avatar1' }));
    assert.equal(await getPersonaDescription(), 'fallback-text');
});

test('a non-string persona description degrades to ""', async () => {
    resetCtx({
        powerUserSettings: { persona_descriptions: { avatar1: { description: 42 } } },
    });
    _setUserAvatarImport(Promise.resolve({ user_avatar: 'avatar1' }));
    assert.equal(await getPersonaDescription(), '');
});

test('a throwing ctx.getPersonaDescription falls through to the fallback', async () => {
    resetCtx({
        getPersonaDescription: () => { throw new Error('boom'); },
        powerUserSettings: { persona_descriptions: { avatar1: { description: 'fallback-text' } } },
    });
    _setUserAvatarImport(Promise.resolve({ user_avatar: 'avatar1' }));
    assert.equal(await getPersonaDescription(), 'fallback-text');
});

test('an unavailable personas module degrades to "" and never throws', async () => {
    // What the real .catch(() => null) memoizes when personas.js cannot load.
    resetCtx({
        powerUserSettings: { persona_descriptions: { avatar1: { description: 'from-PU' } } },
    });
    _setUserAvatarImport(Promise.resolve(null));
    assert.equal(await getPersonaDescription(), '');
});
