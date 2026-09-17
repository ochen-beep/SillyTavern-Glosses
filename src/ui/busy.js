// @ts-check
/**
 * Glosses — UI busy indicator (single refcounted owner of .gls_generating)
 *
 * Every generation entry point (per-message generateFootnotes, targeted
 * runs, future ones) overlaps freely, but they all drive the SAME visual
 * state: the launcher controls (QR-bar button + floating FAB) pulse and the
 * floating panel sweeps its top progress bar while ANY generation runs.
 *
 * That class used to have two independent mutators (generator.js's refcount
 * for regular runs, window.js's direct add/remove for targeted runs), which
 * broke the "who added — removes" invariant: a chat switch bumped the
 * targeted requestId so its finally skipped the remove (class stuck on
 * forever), and an overlapping run of the other kind toggled the class off
 * while one was still in flight.
 *
 * Rule: acquire in the run's setup, release in its finally — ALWAYS, with no
 * staleness/epoch/requestId guards. Those guards protect STATE writes (they
 * decide whether a superseded run may touch _targetedState), but resource
 * release must be unconditional: the begin was unconditional, so a guarded
 * finally leaks the class on every early-bail path.
 */

/** Elements that carry .gls_generating while any generation is in flight. */
const BUSY_TARGET_IDS = ['gls_launcher', 'gls_fab', 'gls-panel'];

let _busyRuns = 0;

/** Acquire one busy reference (idempotent per extra concurrent run). */
export function uiBusyBegin() {
    if (_busyRuns++ === 0) {
        for (const id of BUSY_TARGET_IDS) {
            document.getElementById(id)?.classList.add('gls_generating');
        }
    }
}

/** Release one busy reference; the last release clears the visual state. */
export function uiBusyEnd() {
    if (_busyRuns === 0) return; // underflow guard — never toggle on stale ends
    if (--_busyRuns === 0) {
        for (const id of BUSY_TARGET_IDS) {
            document.getElementById(id)?.classList.remove('gls_generating');
        }
    }
}
