/**
 * Checks on the shareable receipt writer (`--receipt`).
 *
 * A receipt is what a third party reads to decide whether this plugin's claims
 * hold on THEIR machine, so the two ways it can lie are the two things asserted
 * here: it must say which suites did not run, and it must carry no machine
 * layout (the privacy rule `release-check.mjs` already enforces for tracked
 * files).
 *
 * The suite is pure: it feeds recorded outcomes through the same builder the
 * aggregate calls, rather than re-running the matrix.
 *
 * Run: node scripts/verify-receipt.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeChecker } from './suite-shell.mjs'
import { buildReceipt, MACHINE_PATH_PATTERNS, machinePathMatches, receiptText } from './receipt.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

/** One outcome, in the shape `verify-all`'s `outcomeOf` produces. */
const outcome = (suite, code, how = 'exited', note = '') => ({ suite, code, how, note })

/** A declaration in the shape `DECLARED_SKIPS` holds. */
const declared = (suite, precondition) => ({ suite, precondition })

const MIXED = [
  outcome('verify-protocol.mjs', 0),
  outcome('verify-docs.mjs', 0),
  outcome('verify-9p.mjs', 2),
  outcome('verify-terminal.mjs', 2),
  outcome('verify-world.mjs', 1),
]

const DECLARED = [
  declared('verify-9p.mjs', 'wsl.exe cannot be spawned here'),
  declared('verify-terminal.mjs', 'wsl.exe cannot be spawned here'),
]

// --- the counts must add up -------------------------------------------------
{
  const receipt = buildReceipt({ outcomes: MIXED, declared: DECLARED, live: false })
  check('passed counts only exit 0', receipt.counts.passed === 2, receipt.counts)
  check('skipped counts only DECLARED exit 2', receipt.counts.skipped === 2, receipt.counts)
  check('failed counts a non-zero, non-skip suite', receipt.counts.failed === 1, receipt.counts)
  check('the counts sum to the suites that ran',
    receipt.counts.passed + receipt.counts.skipped + receipt.counts.failed === receipt.counts.total,
    receipt.counts)
}

// --- an undeclared skip is a FAILURE, never a skip --------------------------
{
  const receipt = buildReceipt({
    outcomes: [outcome('verify-protocol.mjs', 0), outcome('verify-wat.mjs', 2)],
    declared: [],
    live: false,
  })
  check('an undeclared exit 2 is counted as failed, not skipped', receipt.counts.failed === 1, receipt.counts)
  check('and the failing row says so by name',
    receipt.rows.some((row) => row.suite === 'verify-wat.mjs' && row.outcome === 'failed'), receipt.rows)
  check('with the undeclared verdict spelled out',
    receipt.rows.find((row) => row.suite === 'verify-wat.mjs')?.reason === 'undeclared-skip',
    receipt.rows.find((row) => row.suite === 'verify-wat.mjs'))
}

// --- what did NOT run is named, not omitted ---------------------------------
{
  const receipt = buildReceipt({ outcomes: MIXED, declared: DECLARED, live: false })
  check('every skipped suite carries the precondition that justified it',
    receipt.rows.filter((row) => row.outcome === 'skipped').every((row) => row.precondition.length > 10),
    receipt.rows)
  check('the receipt states the live suites did not run',
    receipt.liveRan === false, receipt.liveRan)
  check('the receipt states the platform it ran on',
    typeof receipt.platform === 'string' && receipt.platform.length > 0, receipt.platform)
  check('the receipt names the plugin version it describes',
    typeof receipt.version === 'string' && receipt.version.length > 0, receipt.version)
  check('and the version is injectable, so a test can pin it',
    buildReceipt({ outcomes: [], declared: [], live: false, version: '9.9.9' }).version === '9.9.9',
    buildReceipt({ outcomes: [], declared: [], live: false, version: '9.9.9' }).version)
}

// --- a stopped suite is a failure, and says it was not a check failure ------
{
  const receipt = buildReceipt({
    outcomes: [outcome('verify-fs-fence.mjs', 1, 'ceiling', 'killed at the ceiling after 300.0s')],
    declared: [],
    live: false,
  })
  const row = receipt.rows[0]
  check('a stopped suite is failed, not skipped', row?.outcome === 'failed', row)
  check('and its reason distinguishes it from a defect', row?.reason === 'stopped', row)
  check('carrying the aggregate note', row?.detail.includes('ceiling') === true, row?.detail)
}

// --- a suite that never STARTED is named as such ---------------------------
// `outcomeOf` reports three abnormal endings, and only two of them are the
// aggregate's own doing. A suite that could not be spawned (EPERM, a missing
// binary) established nothing, but it did not FAIL its checks either — and the
// receipt's whole reason to exist is that a reader can tell "did not run" from
// "ran and was wrong". Reporting it as `checks-failed` is the receipt telling
// exactly the lie it was written to prevent.
{
  const receipt = buildReceipt({
    outcomes: [outcome('verify-world.mjs', 1, 'unstarted', 'could not be started: EPERM')],
    declared: [],
    live: false,
  })
  const row = receipt.rows[0]
  check('a suite that could not be started is failed, not passed', row?.outcome === 'failed', row)
  check('and its reason is its own, not checks-failed', row?.reason === 'unstarted', row)
  check('carrying the aggregate note', row?.detail.includes('EPERM') === true, row?.detail)
  check('the three abnormal endings stay distinguishable',
    ['stopped', 'unstarted', 'checks-failed'].every((reason) => {
      const ending = reason === 'stopped' ? 'ceiling' : reason === 'unstarted' ? 'unstarted' : 'exited'
      const built = buildReceipt({
        outcomes: [outcome('s.mjs', 1, ending, 'note')],
        declared: [],
        live: false,
      })
      return built.rows[0].reason === reason
    }),
    null)
}

// --- no machine layout ------------------------------------------------------
{
  const receipt = buildReceipt({ outcomes: MIXED, declared: DECLARED, live: false })
  const text = receiptText(receipt)
  // The STRICT patterns are the rule; the loose spelling below them is what a
  // reader would eyeball. Asserting the strict set alone is what makes this row
  // able to fail: an `||` against a looser regex passes whenever the loose one
  // matches and the strict ones do not, which is the case it was meant to catch.
  check('the rendered receipt matches no machine-layout pattern',
    MACHINE_PATH_PATTERNS.every((pattern) => !pattern.test(text)),
    MACHINE_PATH_PATTERNS.filter((pattern) => pattern.test(text)).map(String))
  check('and no drive-letter spelling survives in it',
    !/[A-Za-z]:\\\\|(?<![:\w/])[A-Za-z]:(?![\\/])/u.test(text), text.slice(0, 200))
  check('the strict pattern set is not empty, so the row above is not vacuous',
    MACHINE_PATH_PATTERNS.length > 0, MACHINE_PATH_PATTERNS.length)
  check('the rendered receipt carries no absolute POSIX home path',
    !/(?<![:\w])\/home\/[\w.-]+/u.test(text), text.slice(0, 200))
  // The WSL mount spelling is the likeliest leak in THIS plugin, so the detector
  // is proven against a positive sample rather than assumed to work.
  check('the detector catches a WSL mount path when one is present',
    machinePathMatches('{"p":"/mnt/c/Users/someone/project"}').length > 0,
    machinePathMatches('{"p":"/mnt/c/Users/someone/project"}'))
  check('and does not fire on prose that merely mentions mnt',
    machinePathMatches('{"p":"the /mnt/<drive>/ spelling"}').length === 0,
    machinePathMatches('{"p":"the /mnt/<drive>/ spelling"}'))
  check('the rendered receipt is valid JSON', (() => {
    try { JSON.parse(receiptText(receipt)); return true } catch { return false }
  })(), null)
}

// --- the deterministic part is reproducible --------------------------------
{
  const a = buildReceipt({ outcomes: MIXED, declared: DECLARED, live: false, now: '2026-01-01T00:00:00.000Z' })
  const b = buildReceipt({ outcomes: MIXED, declared: DECLARED, live: false, now: '2026-01-01T00:00:00.000Z' })
  check('two builds of the same outcomes are byte-identical',
    receiptText(a) === receiptText(b), null)
  check('the timestamp is the one supplied, not the wall clock',
    a.generatedAt === '2026-01-01T00:00:00.000Z', a.generatedAt)
}

// --- the aggregate actually wires it ---------------------------------------
{
  const source = readFileSync(join(here, 'verify-all.mjs'), 'utf8')
  check('verify-all imports the receipt builder', /from '\.\/receipt\.mjs'/u.test(source), null)
  check('verify-all accepts --receipt', /--receipt/u.test(source), null)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
