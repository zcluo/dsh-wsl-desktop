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
import { classifyPublish, compareVersions, installWindow, liveGateEvidence } from '../lib/release-check.js'

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

console.log('\nlive-gate evidence')

{
  /** A receipt that satisfies every condition, so each case below differs by ONE fact. */
  const good = {
    receiptVersion: 1,
    version: '0.8.1',
    liveRan: true,
    counts: { total: 31, passed: 29, skipped: 2, failed: 0 },
    rows: [
      { suite: 'verify-route.mjs', outcome: 'passed', reason: '', detail: '', precondition: '' },
      { suite: 'verify-modules.mjs', outcome: 'skipped', reason: 'declared-skip', detail: '', precondition: 'no node_modules' },
    ],
  }
  check('a live run of the target version is evidence',
    liveGateEvidence({ receipt: good, target: '0.8.1' }).ready === true,
    liveGateEvidence({ receipt: good, target: '0.8.1' }))
  // `liveRan` records the FLAG, not that anything ran. A receipt with no rows, or
  // one whose covering suite skipped, would otherwise pass on a run that never
  // reached the host at all — the same "green summary hides what did not run"
  // failure the receipt exists to prevent, reintroduced one layer up.
  check('a receipt with NO per-suite rows is refused',
    liveGateEvidence({ receipt: { ...good, rows: [] }, target: '0.8.1' }).ready === false,
    liveGateEvidence({ receipt: { ...good, rows: [] }, target: '0.8.1' }).blockers)
  check('a receipt with no rows field at all is refused',
    liveGateEvidence({ receipt: { ...good, rows: undefined }, target: '0.8.1' }).ready === false)
  check('a receipt whose covering suite SKIPPED is refused, however green the counts',
    liveGateEvidence({
      receipt: { ...good, rows: [{ suite: 'verify-route.mjs', outcome: 'skipped', reason: 'declared-skip', detail: '', precondition: 'no host' }] },
      target: '0.8.1',
    }).ready === false,
    liveGateEvidence({
      receipt: { ...good, rows: [{ suite: 'verify-route.mjs', outcome: 'skipped', reason: 'declared-skip', detail: '', precondition: 'no host' }] },
      target: '0.8.1',
    }).blockers)
  check('a receipt whose covering suite FAILED is refused',
    liveGateEvidence({
      receipt: { ...good, rows: [{ suite: 'verify-route.mjs', outcome: 'failed', reason: 'checks-failed', detail: '', precondition: '' }] },
      target: '0.8.1',
    }).ready === false)
  check('a receipt that does not mention the covering suite is refused',
    liveGateEvidence({ receipt: { ...good, rows: [{ suite: 'verify-protocol.mjs', outcome: 'passed' }] }, target: '0.8.1' }).ready === false)
  check('and the refusal names the suite that carries the seam',
    liveGateEvidence({ receipt: { ...good, rows: [] }, target: '0.8.1' }).blockers.some((line) => line.includes('verify-route.mjs')), null)
  // A future receipt schema could redefine `counts` or `liveRan`; the gate reads
  // those fields, so it must refuse a version it does not know how to read.
  check('an unknown receipt schema version is refused rather than interpreted',
    liveGateEvidence({ receipt: { ...good, receiptVersion: 99 }, target: '0.8.1' }).ready === false,
    liveGateEvidence({ receipt: { ...good, receiptVersion: 99 }, target: '0.8.1' }).blockers)
  // The whole reason this gate exists: on 2026-11-14 the offline matrix was
  // green while every route call failed, because the covering suite sits in LIVE.
  check('an offline-only run is NOT evidence, however green it is',
    liveGateEvidence({ receipt: { ...good, liveRan: false }, target: '0.8.1' }).ready === false,
    liveGateEvidence({ receipt: { ...good, liveRan: false }, target: '0.8.1' }).blockers)
  check('and the refusal says why in terms of the seam it leaves uncovered',
    liveGateEvidence({ receipt: { ...good, liveRan: false }, target: '0.8.1' })
      .blockers.some((line) => line.includes('route-admission')), null)
  check('a missing receipt is refused rather than assumed',
    liveGateEvidence({ receipt: null, target: '0.8.1' }).ready === false)
  check('a run with failures is not evidence',
    liveGateEvidence({ receipt: { ...good, counts: { ...good.counts, failed: 1 } }, target: '0.8.1' }).ready === false)
  check('an unreadable failure count is not evidence either',
    liveGateEvidence({ receipt: { ...good, counts: undefined }, target: '0.8.1' }).ready === false)
  // A receipt from an earlier build would otherwise vouch for a tree it never saw.
  check('a receipt for a DIFFERENT version is refused',
    liveGateEvidence({ receipt: { ...good, version: '0.8.0' }, target: '0.8.1' }).ready === false,
    liveGateEvidence({ receipt: { ...good, version: '0.8.0' }, target: '0.8.1' }).blockers)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
