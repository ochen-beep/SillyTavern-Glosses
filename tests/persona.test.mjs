import { test } from 'node:test';
import assert from 'node:assert/strict';

// §4.4 spec test: getPersonaDescription contract.
// The function bodies below mirror src/generator.js's `getPersonaDescription`
// 1:1 with a stubbed dynamic-import of personas.js (substituted by a plain
// `user_avatar` constant). The real implementation lives in generator.js and
// is referenced by buildContextBlocks; under Node generator.js pulls core.js
// which pulls jQuery/DOM, so we test the CONTRACT independently the same way
// the §5.3 test does. Plan §Task5 explicitly documents this as acceptable.

async function makeGetPersonaDescription({ ctx, userAvatar }) {
    // Replace the dynamic import('../../../../personas.js') with a memoized
    // resolved module — the function body below uses `_mod` instead.
    const personasMod = userAvatar === null ? null : { user_avatar: userAvatar };
    return async function getPersonaDescription() {
        if (typeof ctx.getPersonaDescription === 'function') {
            try { return ctx.getPersonaDescription() || ''; } catch { /* fall through */ }
        }
        try {
            const mod = personasMod;
            const user_avatar = mod?.user_avatar;
            const pu = ctx.powerUserSettings;
            if (user_avatar && pu?.persona_descriptions) {
                const desc = pu.persona_descriptions?.[user_avatar]?.description;
                if (typeof desc === 'string') return desc;
            }
        } catch { /* non-critical */ }
        return '';
    };
}

test('getPersonaDescription prefers ctx.getPersonaDescription when present', async () => {
    const ctx = {
        getPersonaDescription: () => 'from-ctx',
        powerUserSettings: { persona_descriptions: { x: { description: 'from-PU' } } },
    };
    const gpd = await makeGetPersonaDescription({ ctx, userAvatar: 'x' });
    assert.equal(await gpd(), 'from-ctx');
});

test('getPersonaDescription falls back to powerUserSettings + user_avatar', async () => {
    const ctx = {
        powerUserSettings: {
            persona_descriptions: { avatar1: { description: 'fallback-text' } },
        },
    };
    const gpd = await makeGetPersonaDescription({ ctx, userAvatar: 'avatar1' });
    assert.equal(await gpd(), 'fallback-text');
});

test('getPersonaDescription returns empty string when nothing available', async () => {
    const ctx = { powerUserSettings: { persona_descriptions: {} } };
    const gpd = await makeGetPersonaDescription({ ctx, userAvatar: '' });
    assert.equal(await gpd(), '');
});

test('getPersonaDescription returns empty when personas.js import fails', async () => {
    const ctx = {
        powerUserSettings: { persona_descriptions: { a1: { description: 'desc' } } },
    };
    // userAvatar=null emulates a failed dynamic import (mod === null).
    const gpd = await makeGetPersonaDescription({ ctx, userAvatar: null });
    assert.equal(await gpd(), '');
});

test('getPersonaDescription swallows ctx.getPersonaDescription throw and falls back', async () => {
    const ctx = {
        getPersonaDescription: () => { throw new Error('boom'); },
        powerUserSettings: { persona_descriptions: { a1: { description: 'fallback' } } },
    };
    const gpd = await makeGetPersonaDescription({ ctx, userAvatar: 'a1' });
    assert.equal(await gpd(), 'fallback');
});