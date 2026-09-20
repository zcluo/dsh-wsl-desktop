/**
 * Pure containment mechanics for the WSL filesystem fence.
 *
 * The fence itself lives on `WslFileSystem` (`./fs.js`), but the comparison
 * and allow-list derivation are path algebra with no harness dependency, so
 * they live here where a plain Node process can load and verify them (the same
 * split as `./paths.js` and `./confinement.js`).
 *
 * The rule mirrors the shipped backend (`@deepseek-ai/dsh-fs-sandbox` +
 * `@deepseek-ai/dsh-sandbox/roots`), translated into this world: comparison
 * happens in the HOST namespace, because a targetKey is a Windows spelling and
 * its UNC prefix carries the distribution — same-Linux-path targets of another
 * distro stay outside, and the Windows temp dir (reachable through
 * `/mnt/<drive>`) can still be a granted root.
 * @module dsh-wsl-desktop/wsl/fence
 */

import { stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { joinWslUnc } from './paths.js'

/**
 * Canonicalize a writable root the way the shipped derivation does
 * (`@deepseek-ai/dsh-sandbox/roots`): a root that cannot be resolved stays as
 * spelled, which matches nothing until it exists — the conservative outcome.
 * @param {string} path - the root as configured or platform-reported.
 * @returns {string} the canonical path, or the input when resolution fails.
 */
export function canonicalHostPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Lexical containment with a separator boundary, case-insensitive because
 * targetKeys are Windows spellings (`\\wsl.localhost\…` or a drive path). The
 * boundary is what stops `/proj` matching `/proj-secret`.
 * @param {string} targetKey - the canonical host path of the candidate.
 * @param {string} root - the canonical host path of the writable root.
 * @returns {boolean} true when the target is the root or below it.
 */
export function isLexicallyUnderHost(targetKey, root) {
  const target = targetKey.toLowerCase()
  const prefix = root.toLowerCase()
  if (target === prefix) return true
  const bounded = prefix.endsWith('\\') || prefix.endsWith('/') ? prefix : `${prefix}\\`
  return target.startsWith(bounded)
}

const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Record one stat outcome, distinguishing "absent" from a real I/O fault.
 * @param {string} path - the path to stat.
 * @returns {Promise<object | undefined>} the bigint stats, or undefined when absent.
 */
async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (MISSING_CODES.has(error?.code)) return undefined
    throw error
  }
}

/**
 * Containment for the fs fence: the lexical fast path over canonical
 * spellings, then a filesystem-identity walk that recognizes alias-equivalent
 * roots (casing, short names) without weakening containment to a textual
 * approximation. Mirrors `@deepseek-ai/dsh-fs-sandbox/containment`.
 * @param {string} targetKey - the canonical host path of the candidate.
 * @param {string} root - the canonical host path of the writable root.
 * @returns {Promise<boolean>} true when the target is the root or below it.
 */
export async function isUnderHost(targetKey, root) {
  if (isLexicallyUnderHost(targetKey, root)) return true
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = targetKey
  for (;;) {
    const info = await statIfPresent(ancestor)
    if (info !== undefined && info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true
    const parent = win32.dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

/**
 * The roots one workspace-write mutation may land under, in the host spellings
 * targetKeys use. This mirrors `writableRoots` translated into this world: the
 * workspace root, the *distribution's* temp area on the share (what a Linux
 * `/tmp/…` request resolves to here — the shipped derivation's POSIX `/tmp`
 * entry is meaningless on a Windows host), and the Windows temp dir, reachable
 * through `/mnt/<drive>`.
 *
 * Like the shipped derivation, only `workspace-write` grants roots: an unknown
 * mode yields an empty allow-list, which denies — fail-closed.
 * @param {{ mode?: string, workspaceRoot?: string }} policy - the per-call policy.
 * @param {string} distro - the distribution this backend is pinned to.
 * @returns {string[]} canonical host paths; empty unless workspace-write.
 */
export function writableHostRootsFor(policy, distro) {
  if (policy?.mode !== 'workspace-write') return []
  const roots = [policy.workspaceRoot, joinWslUnc(distro, '/tmp'), tmpdir()]
  return [...new Set(
    roots
      .filter((root) => typeof root === 'string' && root.length > 0)
      .map(canonicalHostPath),
  )]
}
