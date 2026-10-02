/**
 * Publication primitive for the WSL 9P share.
 *
 * `fs-local` publishes an overwrite with a bare `rename` (`fsio.ts`
 * `writeFileAtomic`, `replaceFile`), which this provider supplies because
 * `ReplaceFileW` is a local-volume Win32 API with no meaning on a network share.
 * The share REFUSES that replace transiently: measured on debian, 321 refusals
 * across 6900 replace invocations (4-5% of back-to-back publications, 6-9% at the
 * probe's own dose), every one cleared on a retry in 8-49 ms — one 82 ms outlier —
 * within at most 3 attempts, with the destination's inode unchanged afterwards. It
 * is the share's answer rather than a capability answer: .NET is refused the same
 * way (ERROR_ACCESS_DENIED, 8.9-10.7%) while the distribution's own rename never is
 * (0/3000), and a destination that does not exist is never refused (0/1000).
 *
 * A single unretried rename therefore turns a bounded race into a user-visible
 * write failure at that rate. Measured through the provider's own `writeText` on
 * this share (the `write` and `edit` tools' publication path): 2 of 200
 * publications failed with `EPERM`, the destination still holding the previous
 * generation — and the probe's own dose lost 13, 21 of 200 the same way.
 *
 * This module is the ONE owner of waiting that refusal out:
 * `lib/wsl/fs.js`'s `replaceFile` publishes through it, and
 * `scripts/verify-9p.mjs` drives this same function against the real share at a
 * dose — so the code that waits is the code that is measured.
 * @module dsh-wsl-desktop/wsl/publish
 */

import { rename } from 'node:fs/promises'

/**
 * How long a refused publication is waited out before it is reported as a failure.
 *
 * This is the WHOLE bound, and it is deliberately above the tail it was chosen for:
 * every clearing measured on this share took 8-49 ms, with one 82 ms outlier across
 * 321 refusals, so 500 ms keeps 6x the worst clearing ever observed. It also caps
 * what a publication failing for a REAL reason adds to a user-visible write at half
 * a second; the probe's former 2 s ceiling was a measurement budget, and a caller
 * waiting on a failed write is measuring nothing.
 */
export const PUBLICATION_CEILING_MS = 500

/**
 * How long to wait between attempts.
 *
 * Never zero: the refusal is the share's answer to a COMPLETED operation, so
 * re-issuing it back to back is a spin that would spend the whole ceiling in
 * hundreds of attempts against the redirector while the state it races settles.
 * 5 ms matches the dose's poll and still allows ~10 attempts inside the median
 * clearing time.
 */
export const PUBLICATION_POLL_MS = 5

/**
 * Publish a staged replacement over an existing destination, waiting out the
 * share's transient refusal of the replace.
 *
 * The condition waited on is the operation's OWN outcome — the rename is
 * re-attempted, never merely re-read — because the refusal is a REFUSED rename
 * (measured: the destination's inode is unchanged afterwards, so the replace did
 * not land) and because waiting BEFORE the rename does not help (measured: 25/400 = 6.25%
 * still refused after a 50 ms pause before it; the 0/400 that this record once contrasted it
 * with is WITHDRAWN as confounded by density — see the dose's note in scripts/verify-9p.mjs).
 * A read-back would prove nothing about a rename that never ran.
 *
 * EVERY throw is retried, not only the measured ERROR_ACCESS_DENIED: a whitelist
 * re-opens this defect the day the share refuses with a code this module has not
 * seen, and the price of having none is that a DETERMINISTIC failure also pays the
 * ceiling before it is reported — a failure either way, half a second later. What
 * must never happen is the other trade, a wait that reports a real error as a
 * success: the error is rethrown UNCHANGED, by identity, code and message, because
 * `fs-local`'s publication inspects `error.code` (`fsio.ts:645` treats an ENOENT
 * from `replaceFile` as "the target disappeared while staging" and falls back to a
 * plain rename) and a wrapper of this module's own would break that.
 * @param {string} replaced - the destination the replacement must land on.
 * @param {string} replacement - the staged file to publish.
 * @param {{ rename?: (from: string, to: string) => Promise<void>, ceilingMs?: number, pollMs?: number }} [options] - the primitive and the bound; the defaults are the production ones, and the seams exist so a refusal that cannot be produced on demand is still measurable.
 * @returns {Promise<{attempts: number, refusals: number, waitedMs: number}>} what the publication cost, so the share's own behaviour stays on the record.
 * @throws the last refusal, unchanged, once the ceiling is exhausted.
 */
export async function publishReplace(replaced, replacement, options = {}) {
  const renameFn = options.rename ?? rename
  const ceilingMs = options.ceilingMs ?? PUBLICATION_CEILING_MS
  const pollMs = options.pollMs ?? PUBLICATION_POLL_MS
  const started = Date.now()
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      await renameFn(replacement, replaced)
      // Every attempt before this one was refused, or this would have returned.
      return { attempts, refusals: attempts - 1, waitedMs: Date.now() - started }
    } catch (error) {
      // Checked AFTER the attempt, so an attempt is never abandoned mid-flight and
      // the refusal reported is the last one the share actually gave.
      if (Date.now() - started >= ceilingMs) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export default publishReplace
