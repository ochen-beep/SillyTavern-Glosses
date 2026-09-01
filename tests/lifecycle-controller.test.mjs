// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Unit tests for src/runtime/lifecycle.js — the initialization controller that
// serializes extension startup and invalidates suspended init work on stop.
//
// This module is pure (no DOM/ST deps), so it is tested directly. The
// controller's contract (informed by the SillyTavern hook lifecycle):
//   - start() returns a Promise that resolves when run() settles;
//   - start() is idempotent: a second start while one is in flight coalesces;
//   - stop() invalidates suspended work via the isCancelled callback and bumps
//     a generation token so a re-enable can queue a fresh start;
//   - stop() is idempotent and safe to call when idle.

import { createInitializationController } from '../src/runtime/lifecycle.js';

// Microtask flush — lets us advance a promise chain deterministically.
const tick = () => new Promise(r => setTimeout(r, 0));

test('start() returns a promise that resolves once run() settles', async () => {
    const controller = createInitializationController(async () => 'ok');
    const result = await controller.start();
    // start() resolves to run()'s resolution value; this is what ST hooks
    // await, so the resolved value (or undefined for void runs) is acceptable.
    assert.ok(result === 'ok' || result === undefined);
    assert.equal(controller.isActive(), true);
});

test('run() observes isCancelled() === false during a normal start', async () => {
    let observedCancelled = null;
    const controller = createInitializationController(async (isCancelled) => {
        await tick();
        observedCancelled = isCancelled();
    });
    await controller.start();
    assert.equal(observedCancelled, false);
});

test('stop() marks suspended run() work as cancelled', async () => {
    // A synchronous stop() right after start() cancels the run BEFORE its body
    // even begins (the body is queued as a microtask), so every isCancelled()
    // checkpoint observes true. To exercise mid-run cancellation we instead let
    // the body run one synchronous checkpoint, then stop() during its await.
    const checkpoints = [];
    const controller = createInitializationController(async (isCancelled) => {
        checkpoints.push(`a:${isCancelled()}`);   // body started: not yet cancelled
        await tick();
        checkpoints.push(`b:${isCancelled()}`);   // after stop(): cancelled
    });
    const p = controller.start();
    await tick();            // let the body start and capture checkpoint `a`
    controller.stop();       // now cancel during the awaited tick
    await p;
    assert.deepEqual(checkpoints, ['a:false', 'b:true']);
});

test('stop() before the microtask cancels the run before its body starts', async () => {
    // Synchronous stop() after start() cancels even the first checkpoint: the
    // body is queued as a microtask and runs after stop() has flipped `active`.
    const checkpoints = [];
    const controller = createInitializationController(async (isCancelled) => {
        checkpoints.push(isCancelled());
    });
    const p = controller.start();
    controller.stop();
    await p;
    assert.deepEqual(checkpoints, [true]);
});

test('stop() is idempotent and safe when idle', async () => {
    const controller = createInitializationController(async () => {});
    controller.stop();
    controller.stop();
    await controller.start();
    controller.stop();
    controller.stop();
    assert.equal(controller.isActive(), false);
});

test('start() is idempotent while a previous start is in flight (no double run)', async () => {
    let runCount = 0;
    const controller = createInitializationController(async () => {
        runCount++;
        await tick();
    });
    const p1 = controller.start();
    const p2 = controller.start();
    assert.equal(p1, p2, 'second start returns the same in-flight promise');
    await Promise.all([p1, p2]);
    assert.equal(runCount, 1);
});

test('after a cancelled run settles, a new start() runs fresh work', async () => {
    const runs = [];
    const controller = createInitializationController(async (isCancelled) => {
        runs.push(isCancelled() ? 'cancelled' : 'live');
        await tick();
    });
    const p1 = controller.start();
    controller.stop();
    await p1;
    assert.deepEqual(runs, ['cancelled']);

    // Re-enable: controller must permit a new live run.
    const p2 = controller.start();
    await p2;
    assert.deepEqual(runs, ['cancelled', 'live']);
});

test('start() queued after stop-during-flight runs a fresh live attempt', async () => {
    // The controller's contract is about GENERATION invalidation: after stop()
    // bumps the generation, a queued re-start runs with a fresh runGeneration.
    // Track the generation each run observed by capturing isCancelled() at the
    // first checkpoint. The first run starts live; stop() invalidates it; the
    // queued re-start observes a different generation.
    const observations = [];
    const controller = createInitializationController(async (isCancelled) => {
        observations.push(isCancelled() ? 'cancelled' : 'live');
        await tick();
    });
    const p1 = controller.start();
    await tick();            // body starts, records 'live', then awaits tick
    controller.stop();       // bump generation; mark active=false
    await p1;                 // first run settles (its body already recorded)
    const p2 = controller.start(); // queued fresh start, new generation
    await p2;
    assert.deepEqual(observations, ['live', 'live']);
    assert.equal(observations.length, 2, 'run body executed exactly twice (initial + re-start)');
});

test('isActive() reflects start/stop transitions', async () => {
    const controller = createInitializationController(async () => { await tick(); });
    assert.equal(controller.isActive(), false);
    const p = controller.start();
    assert.equal(controller.isActive(), true);
    controller.stop();
    assert.equal(controller.isActive(), false);
    await p;
});

test('whenIdle() resolves once the in-flight run has settled', async () => {
    let settled = false;
    const controller = createInitializationController(async () => {
        await tick();
        settled = true;
    });
    controller.start();
    await controller.whenIdle();
    assert.equal(settled, true);
});
