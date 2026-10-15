// @ts-check
/**
 * Glosses — Generation coordinator (plan stage 6)
 *
 * Scoped ownership for footnote generation. Replaces the implicit contract
 * where every run snapshot the single global generationEpoch and checked
 * isEpochCurrent() at guard points. That worked for chat switches but made a
 * swipe of message A invalidate an unrelated in-flight generation of message B
 * (events.onMsgSwiped bumped the global epoch).
 *
 * Identity model:
 *   - chatEpoch      — the existing state.generationEpoch; bumped ONLY on
 *                      chat change / disable (invalidateAll).
 *   - messageRevision — a per-message counter; bumped by swipe / edit / delete
 *                      of THAT message (bumpMessageRevision). Unrelated
 *                      messages keep running.
 *   - runToken        — a per-run unique id; a new run for the same message
 *                      supersedes the previous one (its controller is aborted
 *                      and the abortControllers slot is replaced).
 *
 * A run is CURRENT when all three hold: it is still the owner of the message's
 * abortControllers slot (token + controller identity), its messageRevision
 * hasn't been bumped, and its chatEpoch snapshot is still active. The commit
 * guard in generator.js requires isCurrent(run) so a stale run whose transport
 * ignored AbortSignal can never write over a newer run.
 *
 * The coordinator keeps writing state.abortControllers / state.isGenerating so
 * existing consumers (events.onChatChanged abort-all, index.cleanup) keep
 * working unchanged.
 */

import {
    state, bumpGenerationEpoch, beginGenerationEpoch, isEpochCurrent,
} from '../core.js';

export function createGenerationCoordinator() {
    /** @type {Record<string, number>} per-message revision counters */
    const revisions = {};
    /** Ids whose CURRENT in-flight run was started by the auto-generate path. */
    const autoRuns = new Set();
    let tokenSeq = 0;

    function revisionOf(messageId) {
        return revisions[messageId] ?? 0;
    }

    /**
     * Invalidate a SINGLE message's in-flight generation(s): bump its revision
     * and abort its current run. Unrelated messages are untouched. Call from
     * onMsgSwiped / onMsgEdited (and regenerate) instead of bumpGenerationEpoch.
     *
     * @param {number|string} messageId
     */
    function bumpMessageRevision(messageId) {
        const id = String(messageId);
        revisions[id] = revisionOf(id) + 1;
        state.abortControllers[id]?.abort();
    }

    /**
     * Invalidate everything: bump the global chatEpoch AND abort every in-flight
     * run. Call from onChatChanged / disable. After this, every run's
     * isCurrent() returns false (chatEpoch mismatch).
     */
    function invalidateAll() {
        bumpGenerationEpoch();
        for (const ctrl of Object.values(state.abortControllers)) ctrl.abort();
        autoRuns.clear();
    }

    /**
     * Start a run for a message. Supersedes any previous run of the same
     * message (its controller is aborted, the slot is replaced). Registers the
     * controller + isGenerating flag on state for host-visible progress.
     *
     * @param {number|string} messageId
     * @param {{ auto?: boolean }} [opts] auto: run started by the auto-generate
     *   path (autoGenerateIfConfigured), abortable via abortAutoRuns().
     * @returns {{ id: string, token: number, ctrl: AbortController, messageRevision: number, chatEpoch: number }}
     */
    function beginRun(messageId, { auto = false } = {}) {
        const id = String(messageId);
        state.abortControllers[id]?.abort();
        const ctrl = new AbortController();
        state.abortControllers[id] = ctrl;
        state.isGenerating[id] = true;
        // The slot now belongs to THIS run, so its kind wins — a manual run
        // superseding an auto one must clear the message's auto mark.
        if (auto) autoRuns.add(id); else autoRuns.delete(id);
        return {
            id,
            token: ++tokenSeq,
            ctrl,
            messageRevision: revisionOf(id),
            chatEpoch: beginGenerationEpoch(),
        };
    }

    /**
     * Abort every in-flight AUTO run (autoGenerateIfConfigured-started); manual
     * runs (regen button, panel CTAs, /glosses_regen) keep going. Called when
     * the autoGenerate toggle flips off: without it a run started seconds
     * earlier would still commit its footnotes, reading as "generation fired
     * while disabled". bumpMessageRevision aborts AND bumps the revision, so
     * even a transport that ignores AbortSignal fails the commit guard.
     */
    function abortAutoRuns() {
        for (const id of [...autoRuns]) bumpMessageRevision(id);
        autoRuns.clear();
    }

    /**
     * Is this run still the active owner? The single staleness predicate the
     * generator uses after every await and right before commit.
     *
     * @param {{ id: string, ctrl: AbortController, messageRevision: number, chatEpoch: number } | null | undefined} run
     * @returns {boolean}
     */
    function isCurrent(run) {
        if (!run) return false;
        return state.abortControllers[run.id] === run.ctrl
            && revisionOf(run.id) === run.messageRevision
            && isEpochCurrent(run.chatEpoch);
    }

    /**
     * Clean up a run's state — but only if this run is still the owner. A
     * superseded run's finally must not touch the slot of the run that replaced
     * it. Returns true when this run was the owner (state was cleaned).
     *
     * @param {{ id: string, ctrl: AbortController }} run
     * @returns {boolean}
     */
    function endRun(run) {
        if (!run) return false;
        if (state.abortControllers[run.id] !== run.ctrl) return false;
        delete state.abortControllers[run.id];
        delete state.isGenerating[run.id];
        autoRuns.delete(run.id);
        return true;
    }

    return {
        beginRun,
        isCurrent,
        endRun,
        bumpMessageRevision,
        invalidateAll,
        abortAutoRuns,
        revisionOf,
    };
}

/** App-wide singleton. Stateless except for per-message counters; safe to share. */
export const generationCoordinator = createGenerationCoordinator();
