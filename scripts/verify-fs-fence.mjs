/**
 * Offline verification for the WSL filesystem fence's pure mechanics
 * (`lib/wsl/fence.js`).
 *
 * The fence's class wiring (sandboxMode, checkedTarget on the two mutation
 * entry points) is pinned structurally by `verify-modules.mjs`; its real
 * behavior needs a live session. What CAN be verified offline is the part
 * that has to be right for the fence to mean anything: the writable-root
 * derivation and the containment comparison — including the two ways a naive
 * implementation goes wrong (a missing separator boundary, and comparing in
 * the Linux namespace where two distributions share every path spelling).
 *
 * Its fixtures are BUILT, not assumed: the containment root is a scratch
 * directory the suite creates inside the distribution's /tmp and removes again
 * on every exit path, and the second distribution is resolved from the machine.
 * A root nothing creates makes `isUnderHost` return at its missing-root check
 * BEFORE the identity walk, so an assertion written against one passes without
 * comparing a single ancestor — the vacuous pass this file was fixed for (the
 * audit's D2: a pin whose subject is never created is not a pin).
 *
 * Run: node scripts/verify-fs-fence.mjs
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { joinWslUnc } from '../lib/wsl/paths.js'
import { canonicalHostPath, isLexicallyUnderHost, isUnderHost, writableHostRootsFor } from '../lib/wsl/fence.js'
import { resolveDistro, resolveLinuxUser, resolveOtherDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro()
// Fixture paths derive from the environment, never from a hardcoded identity
// (the same rule every other suite follows). The fixture ROOT is derived from
// the distribution rather than from the Linux home: a fixture under the home
// would have to create — and later delete — a directory that may already be the
// user's, and its answer would then depend on what that machine happens to hold.

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

// The user probe is on the critical path of EVERY suite that touches a
// distribution, and wsl.exe is the call a cold VM start can hang. An unhandled
// ETIMEDOUT threw out of module evaluation and killed a whole suite with a stack
// trace before a single check printed — observed once in about eight full-suite
// runs, and the reason this suite appeared flaky. It now retries, and a real
// failure names the distribution and the way out.
{
  let message = ''
  try {
    resolveLinuxUser('dsh-wsl-no-such-distro')
  } catch (error) {
    message = String(error.message)
  }
  check('a failed user probe names the distribution instead of dumping a stack trace',
    message.includes('cannot resolve the Linux user') && message.includes('dsh-wsl-no-such-distro') && !message.includes('spawnSync'),
    message || 'no error was thrown for a distribution that does not exist')
}

console.log(`containment comparison (distro: ${distro})`)

// The audit's D2: this suite passed <home>/proj — a path nothing ever created —
// so `isUnderHost` returned at its missing-root check before the identity walk,
// and the cross-distribution pin below passed without comparing a single
// ancestor. The subject is therefore CREATED, in the distribution's /tmp:
// a scratch name unique to this run, and one that exists on THIS share only —
// which is what the cross-distribution answer needs. (README, "Measured fence
// facts": F3 measured the two shares reporting the SAME (dev,ino) for /tmp and
// /, so a root that exists on one share only is the fixture whose foreign
// denial is a real denial rather than a collision.) It never touches a real
// workspace.
const fixtureParentLinux = '/tmp'
const fixtureLinux = `${fixtureParentLinux}/dsh-fence-fixture-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
const root = joinWslUnc(distro, fixtureLinux)
const inside = joinWslUnc(distro, `${fixtureLinux}/src/main.py`)
let fixtureProblem = ''
try {
  mkdirSync(root)
} catch (error) {
  fixtureProblem = `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`
}
/**
 * Remove the scratch root, and never throw while doing it.
 *
 * This runs from an exit handler and from a signal handler, where a throw would
 * replace the suite's verdict — or the signal's exit code — with an unrelated
 * error. A leftover must not be silent either, so a failed removal is reported
 * on stderr.
 */
function removeFixtureRoot() {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch (error) {
    console.error(`verify-fs-fence: the scratch root could not be removed: ${root} (${error?.code ?? error?.message ?? String(error)})`)
  }
}
// Removed on EVERY path that can still run code: a normal exit, `process.exit`,
// an uncaught throw, a failed assertion. Signals need handlers of their own —
// Node does not emit 'exit' when it dies from a signal, so Ctrl-C would
// otherwise strand the scratch directory in the user's distribution. (An
// unconditional kill — SIGKILL, or Stop-Process on Windows — runs no code at
// all; the dsh-fence-fixture- prefix is then how the leftover is found.)
process.on('exit', removeFixtureRoot)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    removeFixtureRoot()
    // This handler replaces Node's default termination, so the conventional
    // status (128 + the signal number) is set explicitly.
    process.exit(code)
  })
}
const rootExists = fixtureProblem === '' && existsSync(root)
check('the containment fixture root exists, so the identity walk actually runs',
  rootExists === true,
  `${fixtureProblem || 'the scratch directory was not created'} (${root}) — the containment assertions below are NOT evaluated without it, because a missing root makes isUnderHost return before the identity walk`)

if (!rootExists) {
  // Report and STOP rather than carry on. The assertions below are spelled from
  // this root, and the ones that decide whether the fence works are answered by
  // the identity walk — which returns before comparing anything when the root is
  // missing. That is exactly the vacuous pass this suite was fixed for (D2): the
  // old fixture root was absent, so the cross-distribution pin passed while
  // comparing nothing. A quiet pass is worse than a red run.
  console.error('verify-fs-fence: the containment fixture root could not be created:'
    + `\n  ${root}\n  ${fixtureProblem || 'the scratch directory was not created'}`
    + `\n  A scratch directory under the distribution's /tmp needs that distribution`
    + ` reachable and writable. Wake it ("wsl.exe -d ${distro} -- true"), or point`
    + ' DSH_WSL_DISTRO at one that is.')
  console.log(`\n${failures} CHECK(S) FAILED`)
  process.exit(1)
}

check('the workspace root itself is contained', isLexicallyUnderHost(root, root))
check('a path below the root is contained', isLexicallyUnderHost(inside, root))
// The pin that used to sit here ("comparison is case-insensitive") asserted the
// fold was INTENDED for the whole string. Half of it is: the UNC host and the
// distribution segment are Windows spellings, and Windows folds them. The Linux
// portion is not - the share resolves it with Linux semantics (README, "Measured
// fence facts": /TMP -> ENOENT, so PROJ and proj are different directories) - and
// folding it authorized a sibling of the workspace root, which the inherited
// publication then CREATED with mkdir({recursive:true}) after the check passed.
// The DEFAULT is unchanged, so the old pin's assertion is still true for callers
// that do not ask for case sensitivity; it is kept, relabelled to say which half
// it is about, and the case-sensitive half is pinned beside it.
check('the default comparison is case-insensitive (the old pin, still true by default)',
  isLexicallyUnderHost(inside.toUpperCase(), root) === true)
check('the default keeps the Windows behaviour for existing callers',
  isLexicallyUnderHost(joinWslUnc(distro, `${fixtureLinux.toUpperCase()}/x`), root) === true)
check('a case-variant sibling of the root is NOT contained (case-sensitive share)',
  isLexicallyUnderHost(joinWslUnc(distro, `${fixtureLinux.toUpperCase()}/x`), root, { caseSensitive: true }) === false)
check('an upper-cased Linux portion of a contained path is NOT contained',
  isLexicallyUnderHost(inside.toUpperCase(), root, { caseSensitive: true }) === false)
check('the distro segment stays case-insensitive even when the path is not',
  isLexicallyUnderHost(joinWslUnc(distro.toUpperCase(), `${fixtureLinux}/src`), root, { caseSensitive: true }) === true)
// parseWslUnc synthesizes the Linux path "/" for a share root, and no character of
// `\\wsl.localhost\<distro>` spells it: subtracting that length from the string
// eats the last character of the DISTRIBUTION name instead of the absent Linux
// portion, so the share root itself stops being recognized as contained.
check('a share root folds whole (the synthesized Linux path "/" is not in the string)',
  isLexicallyUnderHost(joinWslUnc(distro.toUpperCase(), '/'), joinWslUnc(distro, '/'), { caseSensitive: true }) === true)
check('a Windows drive path folds whole (parseWslUnc returns null; the host is case-insensitive)',
  isLexicallyUnderHost('C:\\Users\\X\\PROJ\\a', 'C:\\users\\x\\proj', { caseSensitive: true }) === true)
// The WIRING, not just the pure function: isUnderHost must ask for the
// case-sensitive comparison. This check needs a root whose case-variant spelling
// the SHARE itself can answer for, so it uses the distribution's /tmp — the one
// path here that exists in both spellings on every run (the fixture root's own
// case-variant sibling does not exist, and a missing root short-circuits before
// the walk).
// The expected answer is the SHARE's own answer: a case-variant sibling is
// contained exactly when the share folds the two spellings onto one object (F1).
// On a folding share the identity walk answers, which is the fallback working.
const foldsCase = (() => {
  try {
    const upper = statSync(joinWslUnc(distro, '/TMP'), { bigint: true })
    const lower = statSync(joinWslUnc(distro, '/tmp'), { bigint: true })
    return upper.dev === lower.dev && upper.ino === lower.ino
  } catch {
    return false
  }
})()
check('the full check answers a case-variant sibling the way the share does',
  await isUnderHost(joinWslUnc(distro, '/TMP/dsh-fence-probe.txt'), canonicalHostPath(joinWslUnc(distro, '/tmp'))) === foldsCase,
  `share folds /TMP onto /tmp: ${foldsCase}`)
check('a sibling prefix is NOT contained (separator boundary)',
  isLexicallyUnderHost(joinWslUnc(distro, `${fixtureLinux}-secret/x`), root) === false)
check('a path above the root is NOT contained',
  isLexicallyUnderHost(joinWslUnc(distro, fixtureParentLinux), root) === false)

// The reason containment runs in the HOST namespace: in the Linux namespace
// this target's path is <fixture>/src/main.py — identical spelling, different
// distribution. Only the UNC prefix tells them apart.
//
// The second distribution is resolved from the MACHINE, never named here. A
// hardcoded name makes this pin depend on the machine that happens to have that
// name and compare nothing at all anywhere else — and a pin whose subject does
// not exist asserts nothing, so an absent second share is reported as a missing
// precondition instead of being skipped or passed.
let otherDistro = ''
let otherProblem = ''
try {
  const resolved = resolveOtherDistro(distro)
  if (resolved === undefined) otherProblem = `no distribution other than "${distro}" is installed`
  else if (resolved.toLowerCase() === distro.toLowerCase()) otherProblem = `the resolved second distribution is "${distro}" itself, so there is nothing to compare against`
  else otherDistro = resolved
} catch (error) {
  otherProblem = String(error?.message ?? error)
}
const otherShare = otherDistro === '' ? '' : joinWslUnc(otherDistro, fixtureParentLinux)
const otherReachable = otherShare !== '' && existsSync(otherShare)
check("a second distribution's share answers, so the cross-distribution pin compares a foreign inode",
  otherReachable === true,
  otherProblem || `${otherShare} does not exist — install a second distribution, or set DSH_WSL_OTHER_DISTRO`)

if (otherReachable) {
  const crossDistro = joinWslUnc(otherDistro, `${fixtureLinux}/src/main.py`)
  check('a same-spelled path of ANOTHER distribution is lexically outside',
    isLexicallyUnderHost(crossDistro, root) === false,
    `${crossDistro} vs ${root}`)
  // The walk RUNS here, and this is what makes the denial mean something: the
  // root exists (the precondition above), and this target's ancestors on the
  // other share — /tmp and the share root — are real directories, so the
  // comparison is against real foreign inodes rather than against nothing.
  // Deleting the inode half of the walk (comparing `dev` alone, which is 0 on
  // every 9P share) turns this check RED.
  check('the cross-distribution target is denied by the full check too',
    await isUnderHost(crossDistro, root) === false,
    `${crossDistro} vs ${root}`)
} else {
  console.log('  SKIP  the two cross-distribution assertions (no second share to compare against; see the FAIL above)')
}

console.log('\nidentity fallback and missing roots')
check('a missing root contains nothing', await isUnderHost(inside, joinWslUnc(distro, '/no/such/root')) === false)
// A real NEGATIVE: an existing root that genuinely does not contain the target.
// (The previous expectation compared the result against the same lexical test it
// already implied, so it asserted false === false and could never fail.) The
// target must be unrelated to that root — `inside` lives under the
// distribution's /tmp now, so it would be contained by the lexical fast path
// alone and the assertion would fail for a fixture reason.
const unrelated = canonicalHostPath(joinWslUnc(distro, '/usr'))
check('an existing real root does not contain an unrelated path',
  await isUnderHost(unrelated, canonicalHostPath(joinWslUnc(distro, '/tmp'))) === false,
  `${unrelated} vs the distribution's /tmp`)

// POSITIVE coverage for the stat-identity fallback. Every other expectation in
// this file is satisfied by the lexical fast path alone, so deleting the walk
// entirely left the whole suite green. The `wsl$` spelling is a different STRING
// for the same object (verify-9p pins that (dev,ino) is stable across the two
// spellings), so it is NOT lexically under the root and can only be contained by
// the identity walk.
const aliasTmp = `\\\\wsl$\\${distro}\\tmp`
const realTmp = canonicalHostPath(joinWslUnc(distro, '/tmp'))
check('the identity walk contains the same object under its wsl$ alias',
  isLexicallyUnderHost(aliasTmp, realTmp) === false && await isUnderHost(aliasTmp, realTmp) === true,
  `${aliasTmp} vs ${realTmp}`)

console.log('\nwritable-root derivation')
// The workspace root is the fixture root, and it EXISTS: an uncreated spelling
// makes canonicalHostPath return it unchanged, so the containment pins below
// (including the drive-root one) would pass without the walk running.
const workspaceRoot = root
const roots = writableHostRootsFor({ mode: 'workspace-write', workspaceRoot }, distro)
check('workspace-write grants exactly the workspace root, the distribution tmp, and the Windows temp', roots.length === 3, roots)
check('the workspace root is canonical and present', roots.some((entry) => entry.toLowerCase() === canonicalHostPath(workspaceRoot).toLowerCase()), roots)
check('the distribution tmp is granted', roots.includes(canonicalHostPath(joinWslUnc(distro, '/tmp'))), roots)
check('the Windows temp dir is granted', roots.includes(canonicalHostPath(tmpdir())), roots)
check('a write into the Windows temp is contained (the /mnt/<drive> direction)',
  await isUnderHost(canonicalHostPath(tmpdir()) + '\\dsh-fence-probe.txt', canonicalHostPath(tmpdir())) === true)
check('deduplication: an identical workspace root collapses', writableHostRootsFor({ mode: 'workspace-write', workspaceRoot: joinWslUnc(distro, '/tmp') }, distro).length === 2,
  writableHostRootsFor({ mode: 'workspace-write', workspaceRoot: joinWslUnc(distro, '/tmp') }, distro))
check('read-only grants nothing', writableHostRootsFor({ mode: 'read-only', workspaceRoot }, distro).length === 0)
check('danger-full-access grants nothing through this derivation', writableHostRootsFor({ mode: 'danger-full-access', workspaceRoot }, distro).length === 0)
check('an unknown mode grants nothing (fail-closed)', writableHostRootsFor({ mode: 'something-else', workspaceRoot }, distro).length === 0)
check('a missing workspaceRoot is tolerated, not fatal', writableHostRootsFor({ mode: 'workspace-write' }, distro).length === 2,
  writableHostRootsFor({ mode: 'workspace-write' }, distro))

// And the direction the fence exists for: a write that reaches /mnt/c from a
// WSL session whose workspace is inside the distribution must be outside. The
// root exists (the fixture above), so the walk runs and compares the drive
// root's real identity before denying — with a missing root this pin passed
// without comparing anything either.
console.log('\nthe hole the fence closes')
const mntC = 'C:\\'
check('a drive root is not contained by a WSL workspace', await isUnderHost(mntC, canonicalHostPath(workspaceRoot)) === false)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
