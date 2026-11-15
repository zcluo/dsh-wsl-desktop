/**
 * Pure publish-readiness rules.
 *
 * The 0.7.0 release learned two preconditions the hard way: an expired npm token
 * (checked by the caller, not here) and pnpm's `minimumReleaseAge` refusing a
 * just-published version during `install_bundle`. These rules are pure so the
 * release runbook and the offline suite can pin them without a registry.
 * @module dsh-wsl-desktop/release-check
 */

/**
 * Compare two dotted numeric versions.
 * @param {string} a - the left version.
 * @param {string} b - the right version.
 * @returns {number} -1, 0 or 1.
 */
export function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/**
 * Decide whether a version can be published.
 * @param {{ target: string, latest: string|null, published?: boolean, localTag?: boolean, remoteTag?: boolean, dirty?: boolean }} input -
 *   the target and the facts gathered by the caller.
 * @returns {{ ready: boolean, blockers: string[] }} the verdict.
 */
export function classifyPublish({ target, latest, published = false, localTag = false, remoteTag = false, dirty = false }) {
  const blockers = []
  if (latest === null || latest === undefined) {
    blockers.push('the registry latest version is unknown (npm view failed)')
  } else if (compareVersions(target, latest) <= 0) {
    blockers.push(`target ${target} is not newer than the registry latest ${latest}`)
  }
  if (published === true) blockers.push(`target ${target} is already published`)
  if (localTag === true) blockers.push(`a local tag v${target} already exists`)
  if (remoteTag === true) blockers.push(`a remote tag v${target} already exists`)
  if (dirty === true) blockers.push('the working tree carries tracked changes')
  return { ready: blockers.length === 0, blockers }
}

/**
 * When a freshly published version becomes installable under pnpm's minimum age.
 * @param {{ publishedAt: string|null, minimumReleaseAgeMinutes: number, now: Date }} input -
 *   the registry publish time, the configured window and the current time.
 * @returns {{ ready: boolean|null, readyAt: Date|null, detail: string }} the verdict.
 */
export function installWindow({ publishedAt, minimumReleaseAgeMinutes, now = new Date() }) {
  if (publishedAt === null || publishedAt === undefined || publishedAt === '') {
    return { ready: null, readyAt: null, detail: 'the registry publish time is unreadable; wait one full window before retrying' }
  }
  const published = new Date(publishedAt)
  if (Number.isNaN(published.getTime()) || !Number.isFinite(minimumReleaseAgeMinutes)) {
    return { ready: null, readyAt: null, detail: 'the publish time or the minimum age is unreadable' }
  }
  const readyAt = new Date(published.getTime() + minimumReleaseAgeMinutes * 60_000)
  return {
    ready: now.getTime() >= readyAt.getTime(),
    readyAt,
    detail: now.getTime() >= readyAt.getTime()
      ? 'outside the minimumReleaseAge window'
      : `inside the minimumReleaseAge window until ${readyAt.toISOString()}`,
  }
}

/** The receipt schema this check knows how to read. */
const RECEIPT_VERSION = 1

/**
 * The one suite that reaches the route handler, and therefore the only evidence
 * that the seam works on the installed plugin. Its admitted `bootstrap` check is
 * what failed to run before 2026-11-14 while the offline gate stayed green.
 */
const COVERING_SUITE = 'verify-route.mjs'

/**
 * Decide whether a recorded gate run may vouch for this release.
 *
 * The route-admission seam is covered ONLY by the live suites: an offline run
 * cannot execute the handler at all, because reaching it needs a browser cookie
 * or the development token. On 2026-11-14 a host change broke every route call
 * while the offline gate stayed green at 25/27 — `verify-route.mjs` already
 * asserted the admitted `bootstrap`, it simply never ran, because it sits in the
 * LIVE list. The test was there; the release path never demanded it.
 *
 * So the release path now demands the receipt of a run that INCLUDED the live
 * suites, describes the version being released, and failed nothing. The version
 * comparison is what stops a receipt from an older build vouching for this one.
 *
 * `receipt.version` is read from the REPOSITORY manifest, while the live suites
 * exercise the INSTALLED plugin — so the two could describe different code. They
 * cannot here, and the reason is transitive: `verify-live-env.mjs` compares the
 * running host's reported `pluginVersion` against that same manifest and turns a
 * mismatch into a FAILED check, which lands in `counts.failed` and trips the
 * rule above. A stale install therefore cannot produce a usable receipt; it
 * produces a red one.
 * @param {{ receipt: object|null, target: string }} input - the parsed receipt, or null when absent.
 * @returns {{ ready: boolean, blockers: string[] }} the verdict.
 */
export function liveGateEvidence({ receipt, target }) {
  if (receipt === null || typeof receipt !== 'object') {
    return {
      ready: false,
      blockers: ['no gate receipt: run `node scripts/verify-all.mjs --live --receipt` before releasing'],
    }
  }
  const blockers = []
  // The schema version is checked FIRST because every rule below reads fields this
  // function assumes it understands. A future receipt that redefines `counts` or
  // `liveRan` would otherwise be interpreted as if it still meant the old thing.
  if (receipt.receiptVersion !== RECEIPT_VERSION) {
    blockers.push(`the receipt is schema version ${String(receipt.receiptVersion)}, and this check understands ${RECEIPT_VERSION}`)
    return { ready: false, blockers }
  }
  if (receipt.liveRan !== true) {
    blockers.push('the recorded gate run did NOT include the live suites (--live), and those are the only cover for the route-admission seam')
  }
  const failed = receipt?.counts?.failed
  if (typeof failed !== 'number' || failed > 0) {
    blockers.push(`the recorded gate run reported ${typeof failed === 'number' ? failed : 'an unreadable number of'} failure(s)`)
  }
  if (receipt.version !== target) {
    blockers.push(`the receipt describes version ${String(receipt.version)}, not the target ${target} — re-run the gate after the version bump`)
  }
  // `liveRan` records the FLAG, not that anything ran. Without this the gate would
  // accept a receipt whose live suites all skipped — a run that never reached the
  // host — which is the "a green summary hides what did not run" failure this
  // whole artefact exists to prevent, reintroduced one layer up.
  const rows = Array.isArray(receipt.rows) ? receipt.rows : null
  if (rows === null) {
    blockers.push('the receipt carries no per-suite rows, so it cannot show that the suite covering the route-admission seam passed')
  } else {
    const covering = rows.find((row) => row?.suite === COVERING_SUITE)
    if (covering === undefined) {
      blockers.push(`the receipt has no row for ${COVERING_SUITE}, the only suite that reaches the route handler`)
    } else if (covering.outcome !== 'passed') {
      blockers.push(`${COVERING_SUITE} is recorded as ${String(covering.outcome)}${covering.reason === undefined || covering.reason === '' ? '' : ` (${covering.reason})`}, and it is the only suite that reaches the route handler`)
    }
  }
  return { ready: blockers.length === 0, blockers }
}
