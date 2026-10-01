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

import { lstat, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { DISTRO_NAME, joinWslUnc, parseWslUnc } from './paths.js'

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
 * Lexical containment with a separator boundary. The boundary is what stops
 * `/proj` matching `/proj-secret`.
 *
 * Only the WINDOWS spellings fold. The UNC host and the distribution segment are
 * Windows spellings and compare case-insensitively; the Linux portion does not,
 * because the share resolves it with Linux semantics (README, "Measured fence
 * facts": `/TMP` is ENOENT where `/tmp` exists, so `PROJ` and `proj` are
 * different directories). Folding it judged a target under a case-variant
 * sibling of the writable root to be contained — and that escape needed no
 * pre-existing directory, because the publication running after this check
 * creates it with `mkdir(..., { recursive: true })`. The class already disagreed
 * with itself: `contains()` compares Linux spellings case-sensitively.
 *
 * This is the parameter upstream carries
 * (`@deepseek-ai/dsh-fs-sandbox/containment` takes `caseSensitive`, defaulting
 * to the host convention); the WSL copy had dropped it and folded
 * unconditionally. The default here stays case-insensitive so every existing
 * caller keeps its behaviour; callers comparing Linux paths pass
 * `{ caseSensitive: true }`.
 * @param {string} targetKey - the canonical host path of the candidate.
 * @param {string} root - the canonical host path of the writable root.
 * @param {{ caseSensitive?: boolean }} [options] - fold only the Windows prefix.
 * @returns {boolean} true when the target is the root or below it.
 */
export function isLexicallyUnderHost(targetKey, root, options = {}) {
  const fold = (value) => {
    if (options.caseSensitive !== true) return value.toLowerCase()
    const parsed = parseWslUnc(value)
    if (parsed === null) return value.toLowerCase()
    // The Linux portion is the TAIL of the value, preserved in the spelling it
    // was given — comparing it case-sensitively is the whole point. parseWslUnc
    // reports `/` for the share root, which no character of the value spells:
    // that is the one case where subtracting the length would eat the last
    // character of the distribution name instead, so the share root folds whole.
    if (parsed.linuxPath === '/') return value.toLowerCase()
    const split = value.length - parsed.linuxPath.length
    return value.slice(0, split).toLowerCase() + value.slice(split)
  }
  const target = fold(targetKey)
  const prefix = fold(root)
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
 * What the canonicalizer can say about ONE path component.
 *
 * `realpathSync.native` is the fence's canonicalizer (`canonicalHostPath`) and
 * the one the harness resolves targets with (`resolveLocalTarget`,
 * fs-local/src/fsio.ts:161-210), and on the 9P share it is BLIND to a Linux
 * symlink: measured, it answers ENOENT for the link entry, and so does `stat`
 * (which follows). `lstat` is the call that can still tell the entry apart —
 * it answers EISDIR — and `readdir` lists it, so a component the canonicalizer
 * could not resolve is not automatically a component that is absent. That
 * difference is the whole rule below: the share's write primitives DO resolve
 * such a spelling, so containment for it is lexical only, while the publication
 * that follows the check creates the missing level at the link's target
 * (`mkdir(directory, {recursive:true})`, fs-local/src/fsio.ts:598) — outside
 * the writable root.
 *
 * Only ENOENT/ENOTDIR prove absence; every other outcome — a successful `lstat`
 * with a failed `realpath`, the share's EISDIR for a link entry, or any other
 * fault — means the entry is there and cannot be resolved, which is the
 * fail-closed reading.
 * @param {string} path - the component to canonicalize.
 * @returns {Promise<'resolved' | 'absent' | 'unresolvable'>} the outcome.
 */
async function canonicalizationOf(path) {
  try {
    realpathSync.native(path)
    return 'resolved'
  } catch {
    // Blind to the component — or it does not exist. Only the existence probe
    // below can tell those apart.
  }
  try {
    await lstat(path)
  } catch (error) {
    if (MISSING_CODES.has(error?.code)) return 'absent'
    return 'unresolvable'
  }
  return 'unresolvable'
}

/**
 * Whether every component strictly between `root` and the target's own name
 * either does not exist or canonicalizes.
 *
 * The prefixes are sliced out of `targetKey` itself, so the walk is separator-
 * and case-agnostic and cannot be fooled by a spelling the root comparison
 * folded: the prefix ending at each separator below the root is exactly one
 * ancestor, and the LAST one is the target's parent. The target's own name is
 * never tested, deliberately: a final-component link is measured safe — the
 * publication's rename replaces the link entry inside the root and the link's
 * target is untouched — and it works today, so refusing it would refuse a
 * working legitimate write.
 * @param {string} targetKey - the candidate, already known to be lexically under `root`.
 * @param {string} root - the canonical host path of the writable root.
 * @returns {Promise<boolean>} false when an existing component cannot be resolved.
 */
async function componentsCanonicalize(targetKey, root) {
  for (let index = root.length; index < targetKey.length; index += 1) {
    const character = targetKey[index]
    if (character !== '\\' && character !== '/') continue
    // The separator that ends the ROOT is not a component below it (and a root
    // that ends with one has no separator of its own to skip).
    if (index <= root.length) continue
    const outcome = await canonicalizationOf(targetKey.slice(0, index))
    if (outcome === 'unresolvable') return false
    // The walk goes downward and stops at the first component that does not
    // exist: nothing below an absent component can exist, so the rest of the
    // spelling cannot traverse anything the share resolves.
    if (outcome === 'absent') return true
  }
  return true
}

/**
 * Containment for the fs fence: the lexical fast path over canonical
 * spellings, then a filesystem-identity walk that recognizes alias-equivalent
 * roots (casing, short names) without weakening containment to a textual
 * approximation. Mirrors `@deepseek-ai/dsh-fs-sandbox/containment`.
 *
 * The verdict also carries the rule the share's blindness requires: a path is
 * authorized only when every component strictly between the root and the
 * target's own name either does not exist or canonicalizes (`canonicalizationOf`).
 * A spelling that traverses a component which EXISTS and does not resolve is a
 * spelling the SHARE can resolve elsewhere, so the lexical comparison is not
 * containment — it is a guess — and the write that follows the check would
 * create the missing level at the link's target, outside the root.
 * @param {string} targetKey - the canonical host path of the candidate.
 * @param {string} root - the canonical host path of the writable root.
 * @returns {Promise<boolean>} true when the target is the root or below it.
 */
export async function isUnderHost(targetKey, root) {
  // The lexical fast path compares Linux paths, so it asks for the
  // case-sensitive comparison; the identity walk below still recognizes
  // alias-equivalent spellings — the `wsl$` host, 8.3 names, and a share
  // whose filesystem does fold case — without weakening containment to a
  // textual approximation.
  if (isLexicallyUnderHost(targetKey, root, { caseSensitive: true })) {
    return await componentsCanonicalize(targetKey, root)
  }
  // The lexical fast path is the ONLY comparison that carries the distribution: it
  // compares the UNC prefixes, so a target in another distribution fails it. Once it
  // has failed we are in the fallback, and the walk below re-stats each ancestor
  // THROUGH THE TARGET'S OWN SHARE — so a foreign target's ancestors are compared
  // against a LOCAL root's identity. Inode numbers are per-filesystem, but the 9P
  // shares are not: this machine's `debian` and `debian-dev` report the SAME
  // (dev,ino) for /, /tmp and /home (dev 0; ino 2, 1, 16386 — README, "Measured fence
  // facts"), so an identity collision across two distributions read as containment, and
  // a workspace-write session could be authorized to write into another distribution's
  // /tmp — which `writableHostRootsFor` ALWAYS grants. `contains()` (./fs.js) already
  // requires both keys to name the same distribution before it accepts a
  // relative-path result; apply the same rule here, before anything is stat'd.
  //
  // The rule is deliberately the NARROW one: refuse only when BOTH sides parse as WSL
  // UNCs and their distributions differ. A drive path (parseWslUnc -> null) carries no
  // distribution, so a drive target or a drive root keeps the identity verdict it has
  // always had — the suite exercises both (a drive root is denied by identity, the
  // Windows temp dir is contained). Refusing when only ONE side parses would replace a
  // measured identity verdict with a blanket denial and silently void those pins, and it
  // is not needed to close the hole: the drive and share namespaces cannot collide (the
  // Windows temp dir's dev is its NTFS volume serial, 3764601112 here; every 9P share
  // reports 0). The distribution segment is a WINDOWS spelling — Windows folds it,
  // `wsl.exe -d DEBIAN` names the same distribution — so it is compared
  // case-insensitively, the way `isLexicallyUnderHost` folds the prefix and
  // `contains()` compares.
  const targetUnc = parseWslUnc(targetKey)
  const rootUnc = parseWslUnc(root)
  if (targetUnc !== null && rootUnc !== null
    && targetUnc.distro.toLowerCase() !== rootUnc.distro.toLowerCase()) return false
  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = targetKey
  // The walk starts AT the target, so the first iteration is the target's own
  // name — exempt from the rule below for the same reason the lexical path
  // exempts it (a final-component link is safe and works today).
  let isTarget = true
  for (;;) {
    const info = await statIfPresent(ancestor)
    if (info !== undefined && info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true
    // The walk has not reached the root yet, so this ancestor is a component
    // BELOW it — exactly the set the lexical path checks — and it must be
    // canonicalizable for the spelling to mean what it says. (`stat` above
    // follows the path, so it reports a link entry as absent; `canonicalizationOf`
    // is what sees it.)
    if (!isTarget && await canonicalizationOf(ancestor) === 'unresolvable') return false
    isTarget = false
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
  // joinWslUnc throws for an invalid distro name; converting the throw to a
  // filtered-out entry keeps this function total (never throws) so the caller
  // sees an empty allow-list (fail-closed) rather than a raw Error escaping
  // checkedTarget as a non-sandbox failure.
  //
  // The type check is load-bearing, not decoration: DISTRO_NAME.test(undefined)
  // coerces to the STRING "undefined", which matches the grammar — so an absent
  // distro used to produce a root spelled \\wsl.localhost\undefined\tmp. That
  // root can never match, silently dropping the distribution's /tmp from the
  // allow-list (a write the README grants was refused), and it disguised the
  // provider-side config bug that made the distro undefined in the first place.
  const distroTmp = typeof distro === 'string' && DISTRO_NAME.test(distro)
    ? joinWslUnc(distro, '/tmp')
    : null
  const roots = [policy.workspaceRoot, distroTmp, tmpdir()]
  return [...new Set(
    roots
      .filter((root) => typeof root === 'string' && root.length > 0)
      .map(canonicalHostPath),
  )]
}
