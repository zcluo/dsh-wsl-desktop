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

import { tmpdir } from 'node:os'
import { joinWslUnc } from '../lib/wsl/paths.js'
import { canonicalHostPath, isLexicallyUnderHost, isUnderHost, writableHostRootsFor } from '../lib/wsl/fence.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'

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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${String(detail)}`}`)
  if (!ok) failures += 1
}

console.log(`containment comparison (distro: ${distro})`)

const root = joinWslUnc(distro, `${home}/proj`)
const inside = joinWslUnc(distro, `${home}/proj/src/main.py`)

check('the workspace root itself is contained', isLexicallyUnderHost(root, root))
check('a path below the root is contained', isLexicallyUnderHost(inside, root))
check('comparison is case-insensitive', isLexicallyUnderHost(inside.toUpperCase(), root))
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
check('an existing real root contains its child',
  await isUnderHost(inside, canonicalHostPath(joinWslUnc(distro, '/tmp'))) === (
    inside.startsWith(joinWslUnc(distro, '/tmp'))),
  `${inside} vs the distribution's /tmp`)

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
