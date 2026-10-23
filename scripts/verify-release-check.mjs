/**
 * Offline checks for the publish-readiness rules.
 *
 * The 0.7.0 release exposed two preconditions that were only discovered at the
 * last minute: the npm token had expired, and pnpm's minimumReleaseAge refused the
 * freshly published version when the profile was reinstalled. Both are pure facts
 * about versions, tags and timestamps, so they are pinned here rather than learned
 * again on the next release.
 *
 * Run: node scripts/verify-release-check.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { classifyPublish, compareVersions, installWindow } from '../lib/release-check.js'

const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

console.log('version ordering')

{
  check('a minor bump is newer', compareVersions('0.7.0', '0.6.0') === 1)
  check('a patch bump is newer', compareVersions('0.7.1', '0.7.0') === 1)
  check('numeric, not lexical: 0.10.0 beats 0.9.0', compareVersions('0.10.0', '0.9.0') === 1)
  check('equal versions compare equal', compareVersions('0.7.0', '0.7.0') === 0)
  check('a lower version is older', compareVersions('0.6.9', '0.7.0') === -1)
}

console.log('\npublish target')

{
  const ready = classifyPublish({
    target: '0.8.0', latest: '0.7.0', published: false, localTag: false, remoteTag: false, dirty: false,
  })
  check('a newer, unpublished, untagged, clean target is ready',
    ready.ready === true && ready.blockers.length === 0, ready)

  check('a version already on the registry is blocked',
    classifyPublish({ target: '0.7.0', latest: '0.7.0', published: true }).blockers
      .some((entry) => entry.includes('already published')) === true)
  check('an unreadable registry latest blocks instead of passing',
    classifyPublish({ target: '0.8.0', latest: null }).blockers
      .some((entry) => entry.includes('unknown')) === true)
  check('an undefined registry latest blocks instead of passing',
    classifyPublish({ target: '0.8.0' }).blockers.length > 0)
  check('a target not newer than latest is blocked',
    classifyPublish({ target: '0.7.0', latest: '0.7.0', published: false }).blockers
      .some((entry) => entry.includes('not newer')) === true)
  check('an existing local tag is blocked',
    classifyPublish({ target: '0.8.0', latest: '0.7.0', localTag: true }).blockers
      .some((entry) => entry.includes('local tag')) === true)
  check('an existing remote tag is blocked',
    classifyPublish({ target: '0.8.0', latest: '0.7.0', remoteTag: true }).blockers
      .some((entry) => entry.includes('remote tag')) === true)
  check('tracked working-tree changes block the release',
    classifyPublish({ target: '0.8.0', latest: '0.7.0', dirty: true }).blockers
      .some((entry) => entry.includes('working tree')) === true)
}

console.log('\nminimumReleaseAge window')

{
  const notYet = installWindow({
    publishedAt: '2026-10-23T16:09:26.988Z',
    minimumReleaseAgeMinutes: 60,
    now: new Date('2026-10-23T16:30:00.000Z'),
  })
  check('a fresh publish is inside the window', notYet.ready === false, notYet)
  check('the ready time is publishedAt + the configured age',
    notYet.readyAt.toISOString() === '2026-10-23T17:09:26.988Z', notYet.readyAt?.toISOString?.())
  const ready = installWindow({
    publishedAt: '2026-10-23T16:09:26.988Z',
    minimumReleaseAgeMinutes: 60,
    now: new Date('2026-10-23T17:10:00.000Z'),
  })
  check('a publish older than the window is installable', ready.ready === true, ready)
  check('an unreadable publish time is reported, not guessed',
    installWindow({ publishedAt: null, minimumReleaseAgeMinutes: 60, now: new Date() }).ready === null)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
