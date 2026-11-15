/**
 * Build a shareable receipt of one verification run.
 *
 * The problem this solves: this project's gate is a LOCAL matrix, and a
 * prospective third-party user cannot be asked to trust "it passed on the
 * maintainer's machine". A receipt is the smallest artefact that makes the
 * claim checkable — it names every suite, what each one actually established,
 * and (the part a green summary hides) the suites that did NOT run here and the
 * precondition that stopped them.
 *
 * Two rules it must never break:
 *
 *   1. A suite that did not run is NAMED. `verify-all` already refuses an
 *      undeclared skip; the receipt carries that verdict through rather than
 *      compressing it into a count.
 *   2. It carries no machine layout. The same privacy rule `release-check.mjs`
 *      applies to tracked files applies here, because a receipt is meant to be
 *      pasted into an issue.
 *
 * Pure apart from the version stamp: every input arrives as an argument — the
 * outcomes, the declaration table, the timestamp and the platform — so the
 * writer is testable without running the matrix. The one read the module does is
 * `pluginVersion()`, and even that is overridable, because a value a test cannot
 * set is a value a test cannot pin.
 * @module scripts/receipt
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Machine-layout spellings a receipt must not carry.
 *
 * A superset of the shapes `scripts/release-check.mjs` forbids in tracked files —
 * a drive-letter path, a `C:\Users\` style home, an absolute POSIX home — plus the
 * WSL mount spelling below. A receipt is pasted into public issues, so the bar is
 * the tracked-file bar rather than a weaker one; where the two sets differ, this
 * one is stricter, and that is deliberate: a receipt describes a machine, so a
 * shape that merely LOOKS like machine layout still fails here.
 */
export const MACHINE_PATH_PATTERNS = Object.freeze([
  /[A-Za-z]:\\\\/u,
  /[A-Za-z]:\\[A-Za-z]/u,
  /(?<![:\w])\/home\/[\w.-]+/u,
  /(?<![:\w])\/Users\/[\w.-]+/u,
  // WSL mount spelling: `/mnt/c/...` names one machine's drive layout exactly as
  // a `C:\` path does, and this plugin is the one whose subject IS WSL — so it is
  // the likeliest leak here, not the least likely.
  /(?<![:\w])\/mnt\/[A-Za-z]\//u,
])

/**
 * Classify one suite outcome into a receipt row.
 *
 * The aggregate's exit code is NOT the receipt's vocabulary: exit 2 means
 * "skipped" only when the table declares it, and a suite the aggregate stopped
 * established nothing while still failing the run. Those three cases stay
 * distinct here because collapsing them is exactly how a green summary lies.
 * @param {{suite: string, code: number, how: string, note: string}} entry - one aggregate outcome.
 * @param {Map<string, {precondition: string}>} declarations - the DECLARED_SKIPS table.
 * @returns {{suite: string, outcome: string, reason: string, detail: string, precondition: string}} the row.
 */
function rowFor(entry, declarations) {
  const declaration = declarations.get(entry.suite)
  // The aggregate reports THREE abnormal endings, and they are not the same
  // finding. `ceiling` / `signalled` mean it stopped a suite that was running;
  // `unstarted` means the process never came up (EPERM, a missing binary). Both
  // established nothing, so both are failures — but a reader deciding whether to
  // trust this run needs to tell "it ran and was wrong" from "it never ran", and
  // folding `unstarted` into `checks-failed` is the receipt lying in exactly the
  // way it exists to prevent.
  if (entry.how === 'ceiling' || entry.how === 'signalled') {
    return {
      suite: entry.suite,
      outcome: 'failed',
      reason: 'stopped',
      detail: entry.note,
      precondition: '',
    }
  }
  if (entry.how === 'unstarted') {
    return {
      suite: entry.suite,
      outcome: 'failed',
      reason: 'unstarted',
      detail: entry.note,
      precondition: '',
    }
  }
  if (entry.code === 0) {
    return { suite: entry.suite, outcome: 'passed', reason: '', detail: '', precondition: '' }
  }
  if (entry.code === 2) {
    if (declaration === undefined) {
      return {
        suite: entry.suite,
        outcome: 'failed',
        reason: 'undeclared-skip',
        detail: 'exit 2 without a DECLARED_SKIPS entry: the suite did not evaluate every check and nothing said so',
        precondition: '',
      }
    }
    return {
      suite: entry.suite,
      outcome: 'skipped',
      reason: 'declared-skip',
      detail: '',
      precondition: declaration.precondition,
    }
  }
  return {
    suite: entry.suite,
    outcome: 'failed',
    reason: 'checks-failed',
    detail: entry.note === '' ? `exit ${entry.code}` : entry.note,
    precondition: '',
  }
}

/**
 * Read the plugin version the running tree declares.
 * @returns {string} the version, or `unknown` when the manifest is unreadable.
 */
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Build the receipt object for one run.
 * @param {object} input - the recorded run.
 * @param {Array<{suite: string, code: number, how: string, note: string}>} input.outcomes - one per suite.
 * @param {Array<{suite: string, precondition: string}>} input.declared - the declared-skip table.
 * @param {boolean} input.live - whether the live suites were included.
 * @param {string} [input.now] - the timestamp to stamp; omitted uses the wall clock.
 * @param {string} [input.platform] - the platform to stamp; omitted uses this process's.
 * @param {string} [input.version] - the plugin version to stamp; omitted reads the manifest.
 * @returns {object} the receipt.
 */
export function buildReceipt({ outcomes, declared, live, now, platform, version }) {
  const declarations = new Map(declared.map((entry) => [entry.suite, entry]))
  const rows = outcomes.map((entry) => rowFor(entry, declarations))
  const counts = {
    total: rows.length,
    passed: rows.filter((row) => row.outcome === 'passed').length,
    skipped: rows.filter((row) => row.outcome === 'skipped').length,
    failed: rows.filter((row) => row.outcome === 'failed').length,
  }
  return {
    receiptVersion: 1,
    version: version ?? pluginVersion(),
    generatedAt: now ?? new Date().toISOString(),
    platform: platform ?? `${process.platform}-${process.arch}`,
    liveRan: live === true,
    counts,
    rows,
  }
}

/**
 * Render a receipt as the text a person pastes into an issue.
 *
 * JSON, not prose: the counts and verdicts are what a reader's own script would
 * re-derive, and pretty-printing keeps it eyeball-readable at the same time.
 * @param {object} receipt - the object {@link buildReceipt} returned.
 * @returns {string} the rendered receipt text, newline-terminated.
 */
export function receiptText(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`
}

/**
 * Assert that rendered text carries no machine layout.
 * @param {string} text - the rendered receipt.
 * @returns {string[]} the patterns that matched, empty when the text is clean.
 */
export function machinePathMatches(text) {
  return MACHINE_PATH_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern))
}
