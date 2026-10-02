/**
 * Pin the SKIP `verify-confinement.mjs` reports when the checkout has no /mnt
 * spelling — and the COUNT that makes it a skip instead of a green pass.
 *
 * THE FAMILY — the drive-path assertions. Six checks RUN the shipped helper inside
 * the distribution through its /mnt spelling, which only a Windows drive path has
 * (plus a seventh, the installed-helper drift check, when the detected runner is the
 * helper). On a checkout that has no such spelling — the suite run from inside a
 * distribution — they cannot run at all, and the suite must say so LOUDLY: a SKIP
 * naming every unevaluated assertion by its own label, the precondition and the
 * remedy, and exit 2, which `verify-all.mjs` reports as SKIP rather than as a pass.
 * Before that convention the same machine exited 1 at the precondition (a missing
 * precondition read as a defect) or printed the SKIP and exited 0, which let a green
 * aggregate stand for coverage that was never established.
 *
 * WHY THIS IS ITS OWN SUITE. The precondition cannot be produced by a real run on a
 * machine whose checkout IS on a drive path, and a check written inside
 * verify-confinement.mjs for it would be a check that never runs here — the
 * unreachable-check class this plan removes. Every assertion below reads a real
 * child's stdout and exit code, so it runs on every machine. It is a CONTENT pin:
 * "the child skipped" would be unfalsifiable here, because this suite is what forces
 * the skip. The shape is `verify-fs-fence-skip.mjs`'s and `verify-9p-skip.mjs`'s.
 *
 * THE COUNT IS LOAD-BEARING, AND THE PRINT IS NOT. Section A asserts the exit code,
 * the labels, the per-line counts and the counted tail. Section B then RUNS the
 * mutation the previous round measured — `skipped += 0`, which leaves every SKIP line
 * printed while the suite exits 0 and declares a clean profile — and requires THIS PIN
 * to redden on it. A pin that only read the print would stay green through that
 * mutation, which is exactly the defect the counted skips were added to remove.
 *
 * Every mutation is applied to a COPY in a throwaway tree that carries the suite's
 * imports too, so the real scripts are never touched and nothing scratch is written
 * inside the repository.
 *
 * Run: node scripts/verify-confinement-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { windowsToMntPath } from '../lib/wsl/paths.js'
import { resolveDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const distro = resolveDistro()
/** This pin's own path, so the mutation section can re-run it as a child. */
const pinPath = fileURLToPath(import.meta.url)
/** The suite under test; the mutation section points this at a copy that carries it. */
const givenSuite = process.env.DSH_CONFINEMENT_SKIP_SUITE
const suitePath = givenSuite ?? join(here, 'verify-confinement.mjs')
/** True when THIS process is the inner run the mutation section starts. */
const isInnerRun = givenSuite !== undefined

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

/**
 * The six assertions the drive-path family evaluates, under the labels the suite
 * prints — the same six the SKIP must name.
 *
 * They are duplicated HERE on purpose: the pin holds the expected content
 * independently, so a reworded label in the suite reddens this file instead of
 * following the suite wherever it goes. (`verify-fs-fence-skip.mjs` does the same
 * with its four cross-distribution labels.) The suite keeps its own list as the
 * single source of truth for the labels it PRINTS and the checks it RUNS, so its
 * prose cannot drift from what did not run.
 */
const DRIVE_PATH_LABELS = [
  'the shipped helper refuses an empty SUDO_USER before any privileged work',
  'the shipped helper refuses an unset SUDO_USER before any privileged work',
  'the shipped helper refuses a SUDO_USER that does not resolve',
  'the shipped helper refuses an empty SUDO_USER under user-namespace root',
  'the helper parses under bash -n',
  'the shipped helper exits 2 on a control character in --workspace',
]
/**
 * The seventh drive-path label. It is printed only when the suite detected the
 * helper runner: on the direct sudo-unshare path there is no installed copy whose
 * drift could matter, so the suite records no skip for it — and the pin asserts
 * that biconditional rather than accepting either shape.
 */
const INSTALLED_HELPER_LABEL = 'the installed helper is the helper this package ships'
/** The label section A's flagship assertion carries, and section B requires it to print as FAIL. */
const EXIT2_LABEL = 'drive-path-free run: exit 2, so verify-all reports the suite as SKIP instead of as a pass'
/** The token the drive-path precondition names, and the remedy it must offer. */
const PRECONDITION_TOKEN = 'no /mnt spelling'
const REMEDY_TOKEN = 'run the suite from a checkout on a Windows drive'

/**
 * What one child run WAS, rather than the single number spawnSync reports.
 *
 * spawnSync funnels several endings through one `status`, and `?? 1` reads every one of
 * them as "the suite exited 1" — the conflation verify-all.mjs fixed for itself (its
 * outcomeOf), and it matters here because this pin asserts a CHILD's exit code: a child
 * pin killed at this helper's own ceiling would satisfy a row claiming the pin REDDENED.
 * Measured endings on this platform (Windows, Node 24), the same table the aggregate
 * carries: a ceiling kill is status null + signal SIGKILL + error ETIMEDOUT, a spawn that
 * never happened is null/null/ENOENT, and a normal exit is the status alone. A child killed
 * by a signal from elsewhere is reported exactly like one that exited 1, so this identifies
 * the endings THIS helper produces itself and claims nothing about the others.
 * @param {import('node:child_process').SpawnSyncReturns<string>} run - the finished run.
 * @param {number} elapsedMs - how long the helper waited.
 * @param {number} ceilingMs - the ceiling it waited under.
 * @returns {{code: number, how: 'exited'|'ceiling'|'signalled'|'unstarted', note: string}} the outcome.
 */
function outcomeOf(run, elapsedMs, ceilingMs) {
  const { status, signal } = run
  const error = run.error ?? null
  const seconds = (elapsedMs / 1000).toFixed(1)
  const outOfTime = error?.code === 'ETIMEDOUT' || (status === null && signal !== null && elapsedMs >= ceilingMs)
  if (outOfTime) return { code: 1, how: 'ceiling', note: `killed at this pin's ${(ceilingMs / 1000).toFixed(1)}s ceiling after ${seconds}s — it did not finish` }
  if (status === null && signal !== null) return { code: 1, how: 'signalled', note: `killed by ${signal} after ${seconds}s — it did not finish` }
  if (status === null) return { code: 1, how: 'unstarted', note: `could not be started${error === null ? ' (no exit status and no error)' : `: ${error.code ?? error.message}`}` }
  return { code: status, how: 'exited', note: '' }
}

/**
 * Run one suite in a child process with an explicit environment.
 *
 * `DSH_CONFINEMENT_SKIP_SUITE` is removed from the inherited environment first:
 * it is this pin's own inner-run marker, and letting it leak into the suite (or
 * into an unrelated child) would make a later run think it is the mutant.
 * @param {Record<string, string>} env - overrides applied after the removal.
 * @param {string} [suite] - the suite to run; the mutation section points this elsewhere.
 * @param {number} [timeoutMs] - the ceiling; shortened only by the runner rows below.
 * @returns {{code: number, how: string, note: string, out: string}} the child's ending and combined output.
 */
function runSuite(env, suite = suitePath, timeoutMs = 300_000) {
  const childEnv = { ...process.env }
  delete childEnv.DSH_CONFINEMENT_SKIP_SUITE
  Object.assign(childEnv, env)
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [suite], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: childEnv,
  })
  // The ending, not merely the number: a killed run has no status at all, and reporting
  // that as "exit 1" is what let a kill satisfy an assertion about a reddened pin.
  return { ...outcomeOf(run, Date.now() - startedAt, timeoutMs), out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * The `  SKIP  ` lines of a run: one per family the suite could not evaluate.
 * @param {string} out - the child's combined output.
 * @returns {string[]} the SKIP lines.
 */
function skipLinesOf(out) {
  return out.split('\n').filter((entry) => entry.startsWith('  SKIP  '))
}

/**
 * What one SKIP line CLAIMS: the labels it names and the count it prints for them.
 * The suite prints `SKIP  <labels joined by '; '> — N check(s) not evaluated, ...`.
 * The labels carry no em dash of their own, so the first one delimits them.
 * @param {string} line - one SKIP line.
 * @returns {{labels: string[], count: number}} the claim; count is -1 when unparsable.
 */
function claimOf(line) {
  const body = line.slice('  SKIP  '.length)
  const labels = (body.split(' — ')[0] ?? '').split('; ').filter((label) => label.trim() !== '')
  const match = /(\d+) check\(s\) not evaluated/.exec(line)
  return { labels, count: match === null ? -1 : Number(match[1]) }
}

/**
 * The child's own FAIL lines, with the evidence indented under them — so a failure
 * detail says WHICH check inside the suite answered wrongly instead of only how it
 * ended. SKIP lines are included: a run that skipped the family prints no FAIL of its
 * own, and the evidence section B reads (the mutant's own output) lives here.
 * @param {string} out - the child's combined output.
 * @returns {string} the matching lines, or a note when there are none.
 */
function failureLinesOf(out) {
  const all = out.split('\n')
  const lines = []
  for (const [index, entry] of all.entries()) {
    if (!/^\s*(FAIL|SKIP)\b/.test(entry)) continue
    lines.push(entry)
    for (const next of all.slice(index + 1)) {
      if (!/^ {8}\S/.test(next)) break
      lines.push(next)
    }
  }
  return lines.length === 0 ? '(the suite printed no FAIL or SKIP line of its own)' : lines.join('\n')
}

/**
 * The last few lines of a child's output, for a failure detail that stays readable.
 * @param {string} out - the child's combined output.
 * @param {number} [count] - how many trailing lines to keep.
 * @returns {string} the trailing lines.
 */
function tailOf(out, count = 3) {
  return out.trimEnd().split('\n').slice(-count).join('\n')
}

/**
 * A copy of the tree the SUITE runs from: the suite, its imports and the helper.
 * @param {string} prefix - the mkdtemp prefix, so a leaked tree names its section.
 * @returns {string} the copy's root.
 */
function copySuiteTree(prefix) {
  const tree = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'lib', 'wsl'), { recursive: true })
  for (const [dir, name] of [
    ['scripts', 'verify-confinement.mjs'],
    ['scripts', 'env.mjs'],
    ['scripts', 'detail.mjs'],
    ['scripts', 'source-text.mjs'],
    ['lib/wsl', 'world.js'],
    ['lib/wsl', 'confinement.js'],
    ['lib/wsl', 'paths.js'],
    // The finding-1 source pin reads shell.js as TEXT, so a copy without it crashes
    // the suite before the first SKIP line is printed.
    ['lib/wsl', 'shell.js'],
    ['lib/wsl', 'dsh-wsl-confine.sh'],
  ]) copyFileSync(join(pluginRoot, dir, name), join(tree, dir, name))
  return tree
}

/**
 * The line that defines the helper's Windows path — the one value the drive-path
 * family's precondition is read from.
 */
const HELPER_PATH_LINE = "const helperPathFile = fileURLToPath(new URL('../lib/wsl/dsh-wsl-confine.sh', import.meta.url))"
/**
 * The line `skip()` counts with. `skipped += 0` is the mutation section B runs: it
 * leaves the SKIP print untouched and makes the suite exit 0.
 */
const SKIP_COUNT_LINE = '  skipped += labels.length'

/**
 * A copy of the suite whose helper path is a UNC spelling, so `windowsToMntPath`
 * returns null and every drive-path check takes its skip branch — the machine class
 * the family exists for, produced on a machine that is not in it.
 *
 * The helper's BYTES are still read from the copy: only the value handed to
 * `windowsToMntPath` changes, which is the gate itself.
 * @param {boolean} [zeroCount] - also apply the `skipped += 0` mutation.
 * @returns {{path: string, tree: string, mutated: boolean}} the copy, and whether both mutations applied.
 */
function buildMutantCopy(zeroCount = false) {
  const tree = copySuiteTree(zeroCount ? 'dsh-confinement-skip-count-' : 'dsh-confinement-skip-unc-')
  const suite = join(tree, 'scripts', 'verify-confinement.mjs')
  const source = readFileSync(suite, 'utf8')
  const uncSpelling = [
    '// PIN MUTANT: the helper is addressed by a UNC spelling, which has no /mnt form —',
    '// the machine class the drive-path checks skip on.',
    String.raw`const helperMntFile = '\\\\wsl.localhost\\' + distro + '\\home\\pin\\lib\\wsl\\dsh-wsl-confine.sh'`,
  ].join('\n')
  let mutated = source.includes(HELPER_PATH_LINE) && source.includes('windowsToMntPath(helperPathFile)')
  let next = source
    .replace(HELPER_PATH_LINE, HELPER_PATH_LINE + '\n' + uncSpelling)
    .split('windowsToMntPath(helperPathFile)').join('windowsToMntPath(helperMntFile)')
    .split('drivePathPrecondition(helperPathFile)').join('drivePathPrecondition(helperMntFile)')
  if (zeroCount) {
    mutated = mutated && next.includes(SKIP_COUNT_LINE)
    next = next.replace(SKIP_COUNT_LINE, '  skipped += 0 // PIN MUTANT: the count is zeroed, the SKIP print is untouched')
  }
  writeFileSync(suite, next, 'utf8')
  return { path: suite, tree, mutated }
}

/**
 * Assert everything the drive-path SKIP must carry, whatever forced it.
 * @param {{code: number, out: string}} run - the child's result.
 */
function assertDrivePathSkip(run) {
  const skipLines = skipLinesOf(run.out)
  const skipText = skipLines.join('\n')
  const claims = skipLines.map(claimOf)
  const counted = claims.reduce((total, claim) => total + claim.count, 0)
  const failLines = run.out.split('\n').filter((entry) => entry.startsWith('  FAIL'))
  const runnerMatch = /^ {8}runner=(\S+)$/m.exec(run.out)
  const detectedHelper = runnerMatch !== null && runnerMatch[1] === 'helper'
  check(EXIT2_LABEL,
    run.how === 'exited' && run.code === 2,
    `exit ${run.code}; the run's FAIL/SKIP lines and its end:\n${failureLinesOf(run.out)}\n${tailOf(run.out)}`)
  check('drive-path-free run: NO check FAILS — the missing precondition is not a defect',
    failLines.length === 0,
    failLines.join('\n') || `exit ${run.code}; the run ends:\n${tailOf(run.out)}`)
  check('drive-path-free run: the SKIP names every drive-path assertion that did not run',
    DRIVE_PATH_LABELS.every((label) => skipText.includes(label)),
    `the SKIP lines:\n${skipText || '(none)'}\n`
      + DRIVE_PATH_LABELS.map((label) => `${label}: ${skipText.includes(label)}`).join('; '))
  check('drive-path-free run: the SKIP names the installed-helper drift check exactly when the helper runner was detected',
    skipText.includes(INSTALLED_HELPER_LABEL) === detectedHelper,
    `runner=${runnerMatch === null ? '(not reported)' : runnerMatch[1]} driftLabelNamed=${skipText.includes(INSTALLED_HELPER_LABEL)}`)
  check('drive-path-free run: the SKIP names the precondition and the remedy',
    skipLines.length > 0 && skipLines.every((line) => line.includes(PRECONDITION_TOKEN) && line.includes(REMEDY_TOKEN)),
    skipText || `(no "  SKIP  " line); the run ends:\n${tailOf(run.out)}`)
  check('drive-path-free run: every SKIP line counts exactly the labels it names',
    claims.length > 0 && claims.every((claim) => claim.count === claim.labels.length && claim.labels.length > 0),
    claims.map((claim) => `${claim.count} vs ${claim.labels.length} label(s)`).join('; '))
  // The aggregate rule: the tail is a SUM of the per-line counts, so it cannot be
  // satisfied by a number that drifted from the lines above it. `skipped += 0` removes
  // the tail entirely; a count that is short by one per line leaves the tail disagreeing
  // with the lines it counts.
  const tail = run.out.split('\n').find((entry) => entry.includes('CHECK(S) SKIPPED')) ?? ''
  check(`drive-path-free run: the tail counts the ${counted} skipped checks the SKIP lines claim, and says exit 2`,
    new RegExp(`(^| )EVERY CHECK THAT COULD RUN PASSED, ${counted} CHECK\\(S\\) SKIPPED — exit 2,`).test(tail),
    tail || `(no counted tail); the run ends:\n${tailOf(run.out)}`)
  // The skip is NOT an early exit: the checks that need no /mnt spelling still ran.
  const passLines = run.out.split('\n').filter((entry) => entry.startsWith('  PASS  '))
  check('drive-path-free run: the assertions that need no drive path still ran (no early skip)',
    passLines.some((entry) => entry.includes('the helper pins PATH to the standard system directories'))
      && passLines.some((entry) => entry.includes('the /tmp refusal is classifiable as a setup failure'))
      && passLines.some((entry) => entry.includes('a write inside the workspace succeeds')),
    `${passLines.length} PASS line(s); the run ends:\n${tailOf(run.out)}`)
  // The fixture table's precondition is the HOST TEMP DIRECTORY, not the checkout, so
  // its rows must still have run — a stronger no-early-skip statement than any offline
  // row. Where the temp directory has no /mnt spelling either, they skip with their own
  // counted line and that is disclosed instead of asserted.
  if (hostTempMountable) {
    check('drive-path-free run: the fixture-table rows still ran (their precondition is the temp directory, not the checkout)',
      passLines.some((entry) => entry.includes('the ownership gate refuses a session-user-owned copy under /tmp')),
      `${passLines.length} PASS line(s); the run ends:\n${tailOf(run.out)}`)
  } else {
    console.log('  DISCLOSED  the host temp directory has no /mnt spelling here, so the fixture-table rows skip too; their own counted SKIP line is part of the parity assertion above.')
  }
}

/**
 * Whether the host temp directory has a /mnt spelling — the fixture table's own
 * precondition, measured here so the assertion above is only made where it holds.
 */
const hostTempMountable = windowsToMntPath(join(tmpdir(), 'dsh-confinement-skip-probe')) !== null

if (isInnerRun) {
  // The inner run: the suite given on the command line IS the mutant, so it is run
  // directly (rebuilding the drive-path mutation here would test the real file and
  // make the outer assertion vacuous), and the mutation section is not entered again.
  console.log('the suite under test, given by DSH_CONFINEMENT_SKIP_SUITE (the inner run of the mutation section)')
  assertDrivePathSkip(runSuite({}))
} else {
  console.log('the suite run from a checkout with no /mnt spelling (a UNC helper path in a copy)')
  const uncCopy = buildMutantCopy()
  check('the drive-path mutation applied to the copy (a stale mutation must not pass silently)',
    uncCopy.mutated, `the copy at ${uncCopy.path} does not carry the UNC helper path`)
  assertDrivePathSkip(runSuite({}, uncCopy.path))
  rmSync(uncCopy.tree, { recursive: true, force: true })
}

if (!isInnerRun) {
  console.log('\nthe mutation that must redden this pin: the SKIP is printed, the count is zeroed')
  const countCopy = buildMutantCopy(true)
  check('count mutant: the mutation applied to the copy (a stale mutation must not pass silently)',
    countCopy.mutated, `the copy at ${countCopy.path} does not carry both mutations`)
  // THIS pin, run against that copy's suite. It must FAIL: the suite still prints every
  // SKIP line, but it exits 0 and declares a clean profile, so the print alone proves
  // nothing — the count is what this pin is pinning.
  const childPin = runSuite({ DSH_CONFINEMENT_SKIP_SUITE: countCopy.path }, pinPath)
  rmSync(countCopy.tree, { recursive: true, force: true })
  check('count mutant: THIS PIN reddens on it (exited 1, not killed on the way)',
    childPin.how === 'exited' && childPin.code === 1,
    `exit ${childPin.code} (${childPin.how}: ${childPin.note}); the child pin's FAIL lines and its end:\n${failureLinesOf(childPin.out)}\n${tailOf(childPin.out)}`)
  check('count mutant: the row it reddens on is the exit-2 assertion',
    childPin.out.includes(`  FAIL  ${EXIT2_LABEL}`),
    failureLinesOf(childPin.out))
  check('count mutant: the mutant still PRINTS the SKIP lines (the print is not the load-bearing part)',
    childPin.out.includes('  SKIP  the helper parses under bash -n')
      && childPin.out.includes('the shipped helper refuses a SUDO_USER that does not resolve'),
    failureLinesOf(childPin.out))
  // The mutant's own end is read from the child pin's evidence, which carries the run's
  // last lines. Asserted as the ABSENCE of the counted tail rather than as a phrase from
  // this file's failure detail: a detail that is reworded must not redden the pin.
  check('count mutant: and it declares a clean profile while doing so (exit 0, no counted tail)',
    childPin.out.includes('ALL CHECKS PASSED') && childPin.out.includes('CHECK(S) SKIPPED') === false,
    tailOf(childPin.out, 8))
}

if (!isInnerRun) {
  console.log('\nthe runner distinguishes what it stopped (the aggregate learned this; so does this helper)')
  // spawnSync funnels several endings through one `status`, and `?? 1` reports every one of
  // them as "exited 1" — so a child pin KILLED at this helper's own ceiling satisfied the
  // row above, which claims the pin REDDENED. One ending is PRODUCED (a suite that never
  // finishes); the other three are read through the reporter's own decision table, whose
  // shapes are the aggregate's measured ones.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-confinement-skip-runner-'))
  const hangPath = join(scratch, 'hang.mjs')
  writeFileSync(hangPath, 'setTimeout(() => {}, 60_000)\n')
  const killed = runSuite({}, hangPath, 900)
  check('a child killed at the runner\'s ceiling is reported as a kill, not as an exit 1',
    killed.how === 'ceiling' && killed.code === 1 && /did not finish/.test(killed.note),
    { how: killed.how, code: killed.code, note: killed.note })
  // The other endings are pinned through the reporter's own decision table, because the
  // helper always spawns process.execPath — which EXISTS, so a missing suite is node
  // exiting 1 with "cannot find module" (measured), not a spawn that never happened. The
  // shapes are the aggregate's measured ones; the backstop is why the signalled case runs
  // inside the ceiling (a null status with a signal AT the ceiling is the ceiling).
  const endings = [
    [{ status: null, signal: 'SIGKILL', error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 900, 'ceiling'],
    [{ status: null, signal: 'SIGTERM', error: null }, 400, 'signalled'],
    [{ status: null, signal: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 10, 'unstarted'],
    [{ status: 2, signal: null, error: null }, 40, 'exited'],
  ]
  for (const [run, elapsed, want] of endings) {
    const got = outcomeOf(run, elapsed, 900)
    check(`the reporter reads the ${want} ending as ${want}`, got.how === want, { how: got.how, note: got.note })
  }
  check('a run that never started names the reason rather than only the ending',
    /ENOENT/.test(outcomeOf({ status: null, signal: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 10, 900).note),
    outcomeOf({ status: null, signal: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 10, 900).note)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
