/**
 * Run every verification suite and report one summary.
 *
 * The suites are independent Node programs, so this only sequences them and
 * aggregates exit codes: it never swallows a failure, and a suite that crashes
 * is reported with its own exit code rather than as a pass.
 *
 * Suites that need the running Desktop host are opt-in (`--live`), because they
 * mutate host state (they create and remove a workspace, and one of them creates
 * sessions) and are meaningless without the plugin installed.
 *
 * Run: node scripts/verify-all.mjs [--live]
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const live = process.argv.includes('--live')

/** Suites that run against the distribution and the source tree alone. */
const STANDALONE = [
  'verify-modules.mjs',
  'verify-world.mjs',
  'verify-preset.mjs',
  'verify-9p.mjs',
  'verify-confinement.mjs',
  'verify-terminal.mjs',
  'verify-pty-handle.mjs',
  'verify-client-ui.mjs',
  'verify-client-dom.mjs',
]

/** Suites that require the installed plugin behind a running Desktop host. */
const LIVE = ['verify-route.mjs', 'inspect-live-client.mjs', 'verify-post-restart.mjs']

const suites = live ? [...STANDALONE, ...LIVE] : STANDALONE
const results = []

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const run = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' })
  results.push({ suite, code: run.status ?? 1 })
}

console.log('\n=== summary ===')
for (const { suite, code } of results) {
  console.log(`  ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}  ${suite}`)
}
const failed = results.filter((entry) => entry.code !== 0)
console.log(`\n${results.length - failed.length}/${results.length} suites passed`
  + `${live ? '' : ' (live suites skipped; add --live to include them)'}`)
process.exit(failed.length === 0 ? 0 : 1)
