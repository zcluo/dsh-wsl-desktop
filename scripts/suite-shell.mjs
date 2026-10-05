/**
 * The assertion shell the client suites share: argument flags, the harness
 * checkout default, and the check() counter.
 *
 * ONE owner, because verify-client-dom.mjs and verify-client-ui.mjs were carrying
 * byte-identical copies of all three, and a fix to one (the detail rendering, the
 * flag parsing) had to be repeated by hand in the other.
 * @module dsh-wsl-desktop/scripts/suite-shell
 */

import { join } from 'node:path'
import { detailText } from './detail.mjs'

/**
 * Read one `--name=value` argument, falling back when absent.
 * @param {string} name - the flag name, without the leading dashes.
 * @param {string} fallback - the value when the flag is absent.
 * @returns {string} the flag's value or the fallback.
 */
export function argvFlag(name, fallback) {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

/**
 * The harness checkout this suite reads shared client sources from.
 *
 * The harness checkout is this repo's sibling in a normal development layout;
 * DSH_CHECKOUT / --checkout override it anywhere else.
 * @param {string} pluginRoot - the plugin's own root.
 * @returns {string} the harness checkout root.
 */
export function checkoutDefault(pluginRoot) {
  return process.env.DSH_CHECKOUT ?? join(pluginRoot, '..', 'deepseek-harness')
}

/**
 * The check counter both client suites drive.
 * @returns {{ check: (label: string, ok: boolean, detail?: unknown) => void,
 *   skip: (count?: number) => void,
 *   readonly failures: number, readonly checks: number, readonly skipped: number }}
 *   the check function and live counters (read the getters, do not destructure
 *   them — a destructured number is a snapshot, and the tails read the live count).
 */
export function makeChecker() {
  let failures = 0
  let checks = 0
  let skipped = 0
  return {
    /**
     * Record one assertion.
     * @param {string} label - what was asserted.
     * @param {boolean} ok - the outcome.
     * @param {unknown} [detail] - context shown on failure.
     */
    check(label, ok, detail) {
      checks += 1
      console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
      if (!ok && detail !== undefined) console.log(`        ${detailText(detail)}`)
      if (!ok) failures += 1
    },
    /**
     * Count assertions a named precondition did not let run.
     * @param {number} [count] - how many did not run.
     */
    skip(count = 1) {
      skipped += count
    },
    get failures() { return failures },
    get checks() { return checks },
    get skipped() { return skipped },
  }
}
