/**
 * Checks on the CI subset selector itself.
 *
 * The subset decides what a green CI run means, so it gets its own assertions:
 * a typo in a suite name would otherwise turn into a silently narrower run.
 *
 * Run: node scripts/verify-ci-subset.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeChecker } from './suite-shell.mjs'
import { CI_EXCLUDED, CI_SUITES } from './ci-suites.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

check('the subset is not empty', CI_SUITES.length > 0, CI_SUITES)
check('every named suite exists as a file',
  CI_SUITES.every((suite) => existsSync(join(here, suite))),
  CI_SUITES.filter((suite) => !existsSync(join(here, suite))))
check('the subset never includes a live suite',
  !CI_SUITES.some((suite) => /^verify-(route|live-env|post-restart)\.mjs$|^inspect-live-client\.mjs$/u.test(suite)),
  CI_SUITES)
check('the subset never includes the platform-bound suites',
  !CI_SUITES.some((suite) => /^verify-(9p|confinement|fs-fence|terminal|pty-handle|sync)/u.test(suite)),
  CI_SUITES)
check('every excluded suite carries a reason',
  CI_EXCLUDED.every((entry) => typeof entry.why === 'string' && entry.why.length > 10),
  CI_EXCLUDED.filter((entry) => !(typeof entry.why === 'string' && entry.why.length > 10)))
check('included and excluded do not overlap',
  CI_SUITES.every((suite) => !CI_EXCLUDED.some((entry) => entry.suite === suite)),
  CI_SUITES.filter((suite) => CI_EXCLUDED.some((entry) => entry.suite === suite)))

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
