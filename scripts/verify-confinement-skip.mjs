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
 * THE MUTANT'S PROFILE IS READ FROM THE MUTANT, AND A CHILD'S OWN FAILURE IS NOT THIS
 * PIN'S FINDING. Section B asserts the mutant exits 0 with no counted tail against the
 * mutant's OWN output and exit code, and the child pin's red is asserted to be the count's
 * rather than a suite that failed a check of its own. A suite this pin RUNS can fail a
 * check of its own for a reason this pin does not measure (the VM is shared with a sibling
 * distribution), so every suite run below is repeated once when its own summary reports
 * failing checks — runSuiteConclusive, the ruling README.md states for probes.
 *
 * THE TOLERANCE THAT BUYS IS DISCLOSED, NOT HIDDEN: a defect in the suite that failed HALF
 * the time would pass this pin with probability 0.25 (two contaminated runs, both of which
 * must repeat before any row reddens). A defect that fails every time still reddens, with
 * both attempts printed. The suite's OWN probes now carry the documented policy as well
 * (scripts/wsl-probe.mjs), which is where a transient stall belongs; the repeat here only
 * stops ONE hiccup in a run this pin merely READS from becoming this pin's finding.
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
import { probeWithRetry } from './wsl-probe.mjs'

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
/** The label whose FAIL proves the run the child pin read had a failing check of its own. */
const NO_FAILS_LABEL = 'drive-path-free run: NO check FAILS — the missing precondition is not a defect'
/** The row the stalled-probe arm reads: its answer comes from the probe the stub stalls. */
const INSIDE_WRITE_LABEL = 'a write inside the workspace succeeds'
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
 * A finished child's own summary line: the last line it printed.
 * @param {string} out - the child's combined output.
 * @returns {string} the ending, or '' when the run printed nothing.
 */
function endingOf(out) {
  return out.trimEnd().split('\n').slice(-1)[0] ?? ''
}

/**
 * Whether a child's own summary reports FAILING checks — the run is CONTAMINATED.
 *
 * The suite's tail is one of `ALL CHECKS PASSED`, `${n} CHECK(S) FAILED`,
 * `${n} CHECK(S) FAILED, ${m} CHECK(S) SKIPPED`, or the counted-skip line. Only the
 * FAILED forms say that a check this pin does not read failed inside the run it read.
 * @param {string} out - the child's combined output.
 * @returns {boolean} true when the run's own ending reports failures.
 */
function reportsFailedChecks(out) {
  return /\d+ CHECK\(S\) FAILED/.test(endingOf(out))
}

/**
 * Run a suite, repeating the SAME run once when its own summary reports failing checks.
 *
 * This pin measures the SKIP's content and its count — not the suite's other ~80
 * checks. The suite makes ~25 wsl.exe probes with no retry of their own, over a VM this
 * machine shares with a sibling distribution that runs a heavy service, so a stall in any
 * one of them ends a run with `1 CHECK(S) FAILED` while the drive-path SKIP is intact —
 * and every assertion below would then read the wrong subject. MEASURED: one unrelated
 * failing check inside the mutant reddened "and it declares a clean profile" while the
 * mutant's own count behaviour was correct all along. README.md states the ruling for
 * exactly this kind of probe (探针超时 60s + 超时后一次透明重试), and fixtureAnswer and
 * detectRunner already follow it: the run is repeated once, both attempts are disclosed,
 * and the assertions read the conclusive attempt. A run contaminated TWICE is a real
 * failure and reddens — a defect in the suite repeats, a hiccup does not.
 * @param {Record<string, string>} env - overrides applied after the marker removal.
 * @param {string} [suite] - the suite to run; the mutation section points this elsewhere.
 * @param {number} [timeoutMs] - the ceiling; shortened only by the runner rows below.
 * @returns {{code: number, how: string, note: string, out: string}} the conclusive run.
 */
function runSuiteConclusive(env, suite = suitePath, timeoutMs = 300_000) {
  const first = runSuite(env, suite, timeoutMs)
  // Only an EXITED run whose own summary reports failures is repeated: a ceiling kill or
  // a run that never started is the machine's own statement and is reported as it stands.
  if (first.how !== 'exited' || !reportsFailedChecks(first.out)) return first
  // The first attempt's failing checks, each line marked: a bare `  FAIL  ` line printed
  // here would read as a row of THIS pin, and this one is not a row of this pin.
  console.log(`  DISCLOSED  the first run ended with failed checks of its own (${endingOf(first.out)}):`)
  for (const line of failureLinesOf(first.out, /^\s*FAIL\b/).split('\n')) console.log(`  DISCLOSED  first run: ${line.trim()}`)
  const second = runSuite(env, suite, timeoutMs)
  if (second.how === 'exited' && !reportsFailedChecks(second.out)) {
    console.log(`  DISCLOSED  the repeat is clean (${endingOf(second.out)}); that failure is the suite's, not this pin's finding`)
    return second
  }
  console.log(`  DISCLOSED  the repeat ended with failed checks too (${endingOf(second.out)}); both attempts are reported below`)
  return second
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
 * @param {RegExp} [pattern] - which rows to keep; FAIL and SKIP by default, because a run
 *   that skipped a family prints no FAIL of its own. The disclosure below keeps FAIL rows
 *   only: a SKIP line is this pin's NORMAL content, not something a run "failed" on.
 * @returns {string} the matching lines, or a note when there are none.
 */
function failureLinesOf(out, pattern = /^\s*(FAIL|SKIP)\b/) {
  const all = out.split('\n')
  const lines = []
  for (const [index, entry] of all.entries()) {
    if (!pattern.test(entry)) continue
    lines.push(entry)
    for (const next of all.slice(index + 1)) {
      if (!/^ {8}\S/.test(next)) break
      lines.push(next)
    }
  }
  return lines.length === 0 ? '(the suite printed no FAIL or SKIP line of its own)' : lines.join('\n')
}

/**
 * The NAMES of a child's FAIL rows — labels only, without their evidence — so a row that
 * reports "the child reddened" says WHICH rows did. The failure this pin was debugged from
 * carried the child pin's last lines but not its failing rows: only the OUTER pin's detail is
 * printed, so the next occurrence has to be diagnosable from the aggregate alone.
 * @param {string} out - the child's combined output.
 * @returns {string} the labels, joined, or a note when the child printed none.
 */
function failedRowNamesOf(out) {
  const names = out.split('\n').filter((entry) => entry.startsWith('  FAIL  ')).map((entry) => entry.slice(8))
  return names.length === 0 ? '(the child printed no FAIL row)' : names.join(' | ')
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
    // The suite's probes run through scripts/wsl-probe.mjs; a copy without it fails to load.
    ['scripts', 'wsl-probe.mjs'],
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
 * A copy of the suite tree whose `lib/wsl/world.js` STALLS one probe (and, optionally, whose
 * probe policy has the repeat removed), so the suite's own behaviour around a stalled probe can
 * be read without a stalled VM.
 *
 * The stub answers the first call whose command carries `INSIDE-OK` with the shape a stalled
 * `wsl.exe` produces — `timedOut: true` and no output — and delegates everything else to the
 * real module, including the second call for that same command. `export *` skips the name this
 * module exports itself, so the copy's `runWslShell` is the stub and every other export is the
 * original's.
 * @param {boolean} stripRepeat - remove the repeat from the copy's scripts/wsl-probe.mjs.
 * @returns {{suite: string, tree: string}} the copy's suite and its root.
 */
function buildStalledProbeCopy(stripRepeat) {
  const tree = copySuiteTree(stripRepeat ? 'dsh-confinement-skip-norepeat-' : 'dsh-confinement-skip-stall-')
  const world = join(tree, 'lib', 'wsl', 'world.js')
  writeFileSync(join(tree, 'lib', 'wsl', 'world.orig.js'), readFileSync(world, 'utf8'), 'utf8')
  writeFileSync(world, [
    "// PIN STUB: the first call carrying INSIDE-OK is answered with a TIMEOUT (the shape a",
    "// stalled wsl.exe produces); every other call, including the repeat, is delegated.",
    "import * as real from './world.orig.js'",
    "export * from './world.orig.js'",
    "const STALL = 'INSIDE-OK'",
    "let seen = 0",
    "export async function runWslShell(options) {",
    "  const command = String(options?.command ?? '')",
    "  if (command.includes(STALL)) {",
    "    seen += 1",
    "    console.log(`        PROBE STUB: attempt ${seen} of the probe carrying ${STALL} ${seen === 1 ? '-> timedOut' : '-> delegated'}`)",
    "    if (seen === 1) return { exitCode: null, stdout: '', stderr: '', timedOut: true }",
    "  }",
    "  return await real.runWslShell(options)",
    "}",
  ].join('\n'), 'utf8')
  if (stripRepeat) {
    const policy = join(tree, 'scripts', 'wsl-probe.mjs')
    const source = readFileSync(policy, 'utf8')
    const repeat = '  if (first.timedOut !== true) return first'
    if (!source.includes(repeat)) throw new Error('the copy no longer carries the repeat; the stub must be updated')
    writeFileSync(policy, source.replace(repeat, '  return first // PIN STUB: the repeat removed'), 'utf8')
  }
  return { suite: join(tree, 'scripts', 'verify-confinement.mjs'), tree }
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
  check(NO_FAILS_LABEL,
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
  assertDrivePathSkip(runSuiteConclusive({}))
} else {
  console.log('the suite run from a checkout with no /mnt spelling (a UNC helper path in a copy)')
  const uncCopy = buildMutantCopy()
  check('the drive-path mutation applied to the copy (a stale mutation must not pass silently)',
    uncCopy.mutated, `the copy at ${uncCopy.path} does not carry the UNC helper path`)
  assertDrivePathSkip(runSuiteConclusive({}, uncCopy.path))
  rmSync(uncCopy.tree, { recursive: true, force: true })
}

if (!isInnerRun) {
  console.log('\nthe mutation that must redden this pin: the SKIP is printed, the count is zeroed')
  const countCopy = buildMutantCopy(true)
  check('count mutant: the mutation applied to the copy (a stale mutation must not pass silently)',
    countCopy.mutated, `the copy at ${countCopy.path} does not carry both mutations`)
  // THE MUTANT'S OWN RUN, read from the mutant. The claim is about the SUITE — it exits
  // 0 and prints no counted tail — so it is asserted against the suite's own output and
  // exit code. It used to be read out of the child pin's failure detail, where the
  // mutant's ending arrives only as a side effect of another row's evidence; one
  // unrelated check failing inside the suite then reddened a row that names the count
  // (MEASURED: an injected failing check in the mutant produced exactly the captured
  // 1-row failure, with the mutant's own count behaviour correct all along).
  const mutant = runSuiteConclusive({}, countCopy.path)
  check('count mutant: the mutant itself exits 0, prints the SKIP lines, and prints no counted tail',
    mutant.how === 'exited' && mutant.code === 0 && skipLinesOf(mutant.out).length > 0
      && mutant.out.includes('ALL CHECKS PASSED') && mutant.out.includes('CHECK(S) SKIPPED') === false,
    `exit ${mutant.code} (${mutant.how}: ${mutant.note}); the run's FAIL/SKIP lines and its end:\n${failureLinesOf(mutant.out)}\n${tailOf(mutant.out)}`)
  // THIS pin, run against that copy's suite. It must FAIL: the suite still prints every
  // SKIP line, but it exits 0 and declares a clean profile, so the print alone proves
  // nothing — the count is what this pin is pinning.
  const childPin = runSuite({ DSH_CONFINEMENT_SKIP_SUITE: countCopy.path }, pinPath)
  rmSync(countCopy.tree, { recursive: true, force: true })
  check('count mutant: THIS PIN reddens on it (exited 1, not killed on the way)',
    childPin.how === 'exited' && childPin.code === 1,
    `exit ${childPin.code} (${childPin.how}: ${childPin.note}); the child pin's FAIL rows: ${failedRowNamesOf(childPin.out)}\n${failureLinesOf(childPin.out)}\n${tailOf(childPin.out)}`)
  check('count mutant: the row it reddens on is the exit-2 assertion',
    childPin.out.includes(`  FAIL  ${EXIT2_LABEL}`),
    failureLinesOf(childPin.out))
  check('count mutant: the mutant still PRINTS the SKIP lines (the print is not the load-bearing part)',
    mutant.out.includes('  SKIP  the helper parses under bash -n')
      && mutant.out.includes('the shipped helper refuses a SUDO_USER that does not resolve'),
    failureLinesOf(mutant.out))
  // The child pin's red is the COUNT's only if the run IT read was clean: a suite that
  // failed a check of its own exits 1 as well, so the exit-2 row above is satisfied by
  // that run too. Asserted as the absence of the one row that FAILS exactly then —
  // content, not position — rather than assumed: this is the discrimination the
  // captured failure showed was missing.
  check('count mutant: and it reddened on the count, not on a suite that failed a check of its own',
    !childPin.out.includes(`  FAIL  ${NO_FAILS_LABEL}`),
    `the child pin's FAIL rows: ${failedRowNamesOf(childPin.out)}\n${failureLinesOf(childPin.out)}`)
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

if (!isInnerRun) {
  console.log('\nthe probe policy the suite reads its probes through (scripts/wsl-probe.mjs)')
  // Driven through the SEAM, not read from source: each arm hands `probeWithRetry` a stub
  // runner and counts what it was asked for. The policy is README.md's (探针超时 60s +
  // 超时后一次透明重试), and the two arms that matter are the ones a stall and a REFUSAL
  // produce: a probe that TIMED OUT is repeated once and the caller reads the SECOND attempt;
  // a probe that ANSWERED — a refusal included — is asked for exactly once, because a refusal
  // is an immediate answer and never a timeout, so no repeat can turn one into a pass.
  const timedOutAnswer = { exitCode: null, stdout: '', stderr: '', timedOut: true }
  const policyRun = (answers) => {
    const seen = []
    return { seen, run: async (request) => { seen.push(request); return answers[Math.min(seen.length - 1, answers.length - 1)] } }
  }
  const refusal = { exitCode: 2, stdout: '', stderr: 'REFUSED: the helper refuses an empty SUDO_USER', timedOut: false }
  const second = { exitCode: 0, stdout: 'ANSWER-FROM-ATTEMPT-2', stderr: '', timedOut: false }
  const refused = policyRun([refusal])
  const refusedAnswer = await probeWithRetry(refused.run, { distro, command: 'the helper' })
  check('probe policy: a probe that ANSWERED (a refusal is an answer) is asked for exactly once',
    refused.seen.length === 1 && refusedAnswer === refusal,
    `${refused.seen.length} attempt(s); answer=${JSON.stringify(refusedAnswer)}`)
  const retried = policyRun([timedOutAnswer, second])
  const retries = []
  const retriedAnswer = await probeWithRetry(retried.run, { distro, command: 'the stalled probe' }, { onRetry: (request) => retries.push(request) })
  check('probe policy: a probe that TIMED OUT is repeated once, and the caller reads the SECOND attempt',
    retried.seen.length === 2 && retriedAnswer === second && retries.length === 1,
    `${retried.seen.length} attempt(s); answer=${JSON.stringify(retriedAnswer)}; retry hook fired ${retries.length} time(s)`)
  check('probe policy: the repeat asks for the SAME probe (distro, command) and the same ceiling',
    retried.seen.length === 2 && retried.seen[0].command === retried.seen[1].command
      && retried.seen[0].distro === retried.seen[1].distro && retried.seen[0].timeoutMs === 60_000
      && retried.seen[1].timeoutMs === 60_000,
    JSON.stringify(retried.seen))
  const twice = policyRun([timedOutAnswer])
  const twiceAnswer = await probeWithRetry(twice.run, { distro, command: 'the stalled probe' })
  check('probe policy: a probe that timed out TWICE still fails loudly — the second timeout reaches the caller',
    twice.seen.length === 2 && twiceAnswer.timedOut === true,
    `${twice.seen.length} attempt(s); answer=${JSON.stringify(twiceAnswer)}`)
  const heavier = policyRun([refusal])
  await probeWithRetry(heavier.run, { distro, command: 'the 20-file fixture setup', timeoutMs: 120_000 })
  check('probe policy: a request that asks for a LONGER ceiling keeps its own, and a bare one gets the documented 60s',
    heavier.seen.length === 1 && heavier.seen[0].timeoutMs === 120_000,
    `ceiling=${String(heavier.seen[0]?.timeoutMs)} for a request that asked for 120000`)
}
if (!isInnerRun) {
  console.log('\nthe SUITE\'s own probes: a stalled probe is repeated, so one hiccup is not a defect')
  // The seam at the SUITE's level. `buildStalledProbeCopy` writes a tree whose
  // `lib/wsl/world.js` answers the FIRST call carrying `INSIDE-OK` — the workspace-write probe
  // whose answer the row `a write inside the workspace succeeds` reads — with the shape a
  // stalled wsl.exe produces (`timedOut: true`, no output), and delegates every other call to
  // the real module. WITH scripts/wsl-probe.mjs the suite reads the second attempt and that row
  // never reddens; with the repeat REMOVED from the copy's policy the same stall reddens it.
  // The stub prints one line per call, so the run's own output says how many attempts it took.
  const stalledCopy = buildStalledProbeCopy(false)
  const withPolicy = runSuite({}, stalledCopy.suite)
  rmSync(stalledCopy.tree, { recursive: true, force: true })
  const withStub = withPolicy.out.split('\n').filter((entry) => entry.includes('PROBE STUB:')).map((entry) => entry.trim())
  check('suite probes: the stalled probe is repeated by the suite\'s OWN runner, and the row that reads it stays green',
    withStub.length === 2 && withStub[0].includes('-> timedOut') && withStub[1].includes('-> delegated')
      && withPolicy.out.includes('repeating the same request once')
      && !withPolicy.out.includes(`  FAIL  ${INSIDE_WRITE_LABEL}`),
    `exit ${withPolicy.code} (${withPolicy.how}); the stub's calls:\n${withStub.join('\n') || '(none)'}\nthe run's FAIL rows: ${failedRowNamesOf(withPolicy.out)}\n${tailOf(withPolicy.out)}`)
  const strippedCopy = buildStalledProbeCopy(true)
  const withoutPolicy = runSuite({}, strippedCopy.suite)
  rmSync(strippedCopy.tree, { recursive: true, force: true })
  const strippedStub = withoutPolicy.out.split('\n').filter((entry) => entry.includes('PROBE STUB:')).map((entry) => entry.trim())
  check('suite probes: with the repeat removed from the copy, the SAME stall reddens the row that read the probe',
    withoutPolicy.code === 1 && withoutPolicy.out.includes(`  FAIL  ${INSIDE_WRITE_LABEL}`) && strippedStub.length === 1,
    `exit ${withoutPolicy.code} (${withoutPolicy.how}); the stub's calls:\n${strippedStub.join('\n') || '(none)'}\nthe run's FAIL rows: ${failedRowNamesOf(withoutPolicy.out)}\n${tailOf(withoutPolicy.out)}`)
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
