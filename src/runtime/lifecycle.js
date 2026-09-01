// @ts-check
/**
 * Serialize extension initialization and invalidate suspended work on stop.
 * SillyTavern awaits lifecycle hook promises, but it does not provide a
 * cancellation signal to third-party extensions, so the token is local here.
 */
export function createInitializationController(run) {
    let generation = 0;
    let active = false;
    let currentPromise = null;
    let queued = false;

    function start() {
        const wasActive = active;
        active = true;
        if (currentPromise) {
            if (!wasActive) queued = true;
            return currentPromise;
        }

        const runGeneration = ++generation;
        currentPromise = Promise.resolve()
            .then(() => run(() => !active || runGeneration !== generation))
            .finally(() => {
                currentPromise = null;
                if (queued && active) {
                    queued = false;
                    start();
                }
            });
        return currentPromise;
    }

    function stop() {
        active = false;
        queued = false;
        generation++;
    }

    async function whenIdle() {
        while (currentPromise) await currentPromise;
    }

    return {
        start,
        stop,
        whenIdle,
        isActive: () => active,
    };
}
