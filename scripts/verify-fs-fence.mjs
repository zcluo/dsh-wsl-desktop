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
 * Run: node scripts/verify-fs-fence.mjs
 */

import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { joinWslUnc } from '../lib/wsl/paths.js'
import { canonicalHostPath, isLexicallyUnderHost, isUnderHost, writableHostRootsFor } from '../lib/wsl/fence.js'
import { resolveDistro, resolveLinuxHome, resolveLinuxUser } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro()
// Fixture paths derive from the environment, never from a hardcoded identity
// (the same rule every other suite follows).
const home = resolveLinuxHome()

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

const root = joinWslUnc(distro, `${home}/proj`)
const inside = joinWslUnc(distro, `${home}/proj/src/main.py`)

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
  isLexicallyUnderHost(joinWslUnc(distro, `${home}/PROJ/x`), joinWslUnc(distro, `${home}/proj`)) === true)
check('a case-variant sibling of the root is NOT contained (case-sensitive share)',
  isLexicallyUnderHost(joinWslUnc(distro, `${home}/PROJ/x`), joinWslUnc(distro, `${home}/proj`), { caseSensitive: true }) === false)
check('an upper-cased Linux portion of a contained path is NOT contained',
  isLexicallyUnderHost(inside.toUpperCase(), root, { caseSensitive: true }) === false)
check('the distro segment stays case-insensitive even when the path is not',
  isLexicallyUnderHost(joinWslUnc(distro.toUpperCase(), `${home}/proj/src`), joinWslUnc(distro, `${home}/proj`), { caseSensitive: true }) === true)
// parseWslUnc synthesizes the Linux path "/" for a share root, and no character of
// `\\wsl.localhost\<distro>` spells it: subtracting that length from the string
// eats the last character of the DISTRIBUTION name instead of the absent Linux
// portion, so the share root itself stops being recognized as contained.
check('a share root folds whole (the synthesized Linux path "/" is not in the string)',
  isLexicallyUnderHost(joinWslUnc(distro.toUpperCase(), '/'), joinWslUnc(distro, '/'), { caseSensitive: true }) === true)
check('a Windows drive path folds whole (parseWslUnc returns null; the host is case-insensitive)',
  isLexicallyUnderHost('C:\\Users\\X\\PROJ\\a', 'C:\\users\\x\\proj', { caseSensitive: true }) === true)
// The WIRING, not just the pure function: isUnderHost must ask for the
// case-sensitive comparison. The fixture root above does not exist on this
// machine (README F4), and a missing root short-circuits to false for ANY
// implementation - so this check uses the distribution's /tmp, which exists.
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
  isLexicallyUnderHost(joinWslUnc(distro, `${home}/proj-secret/x`), root) === false)
check('a path above the root is NOT contained',
  isLexicallyUnderHost(joinWslUnc(distro, home), root) === false)

// The reason containment runs in the HOST namespace: in the Linux namespace
// this target's path is <home>/proj/src/main.py — identical spelling,
// different distribution. Only the UNC prefix tells them apart.
const otherDistro = distro === 'debian' ? 'debian-dev' : 'debian'
const crossDistro = joinWslUnc(otherDistro, `${home}/proj/src/main.py`)
check('a same-spelled path of ANOTHER distribution is lexically outside',
  isLexicallyUnderHost(crossDistro, root) === false,
  `${crossDistro} vs ${root}`)
check('the cross-distribution target is denied by the full check too',
  await isUnderHost(crossDistro, root) === false)

console.log('\nidentity fallback and missing roots')
check('a missing root contains nothing', await isUnderHost(inside, joinWslUnc(distro, '/no/such/root')) === false)
// A real NEGATIVE: an existing root that genuinely does not contain the target.
// (The previous expectation compared the result against the same lexical test it
// already implied, so it asserted false === false and could never fail.)
check('an existing real root does not contain an unrelated path',
  await isUnderHost(inside, canonicalHostPath(joinWslUnc(distro, '/tmp'))) === false,
  `${inside} vs the distribution's /tmp`)

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
const workspaceRoot = joinWslUnc(distro, `${home}/proj`)
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
// WSL session whose workspace is inside the distribution must be outside.
console.log('\nthe hole the fence closes')
const mntC = 'C:\\'
check('a drive root is not contained by a WSL workspace', await isUnderHost(mntC, canonicalHostPath(workspaceRoot)) === false)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
