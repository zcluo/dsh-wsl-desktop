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
  if (latest !== null && latest !== undefined && compareVersions(target, latest) <= 0) {
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
export function installWindow({ publishedAt, minimumReleaseAgeMinutes, now }) {
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
