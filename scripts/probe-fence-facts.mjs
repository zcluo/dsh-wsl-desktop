/**
 * The runtime facts the security audit could not observe from source.
 *
 * The audit's open records are blocked on properties of THIS machine — the 9P
 * share's case semantics, whether realpath resolves a Linux symlink through it,
 * whether two distributions' shares report colliding (dev,ino), and whether the
 * fixture root the fs-fence suite assumes already exists — and not properties of
 * this repository. A fix written against a guessed answer is a fix for a
 * different machine, so the answers are measured and recorded (README,
 * "Measured fence facts") before anything is changed.
 *
 * Read-only by construction: every probe is a stat, a realpath or a read, and
 * `isUnderHost` is the same stat walk the fence itself runs. A probe that would
 * have to create something to answer reports UNMEASURED instead — UNMEASURED is
 * a result, never a failure to work around.
 *
 * Run: node scripts/probe-fence-facts.mjs [second-distribution]
 */

import { realpathSync, statSync } from 'node:fs'
import { joinWslUnc } from '../lib/wsl/paths.js'
import { isUnderHost } from '../lib/wsl/fence.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'

const primary = resolveDistro()
// The second distribution must BE a second distribution. Without this guard one typo —
// or a copy-pasted invocation — makes every F3 row compare a share with ITSELF, and the
// identities are then trivially equal: the probe prints COLLIDES and the reader takes it
// for the cross-share finding. The case-insensitive comparison is not cosmetic: a
// distribution name is a Windows spelling, so `wsl.exe -d DEBIAN` names the same
// distribution. Measured with the guard absent (`node scripts/probe-fence-facts.mjs
// debian`): F3 reported COLLIDES for all three paths, and F5 reported `true` — which is
// the LEXICAL fast path containing `<primary>/<home>/proj/src/main.py` under
// `<primary>/<home>/proj`, not a walk verdict at all, while the parenthetical beside it
// claimed the walk had short-circuited on the absent root.
const requested = process.argv[2] // a SECOND distribution, or the probe reports UNMEASURED
const otherIsPrimary = requested !== undefined && requested.toLowerCase() === primary.toLowerCase()
const other = otherIsPrimary ? undefined : requested
// The reason is built per probe, because the ARTEFACT is per probe: passing the primary
// distribution twice leaves F3 comparing a share's (dev,ino) with its own, so F3's artefact
// is a vacuous COLLIDES — but F5's target is a path under the PRIMARY share, which the
// lexical fast path contains before any walk runs, so F5's artefact is a lexical `true`
// (measured above). One shared string described F3's artefact to F5, which made the F5 row
// wrong about the probe it was reporting.
const unmeasured = (selfComparison) => requested === undefined
  ? 'UNMEASURED - pass a second distribution as argv[2]'
  : `UNMEASURED - "${requested}" IS the primary distribution; ${selfComparison}`
const home = resolveLinuxHome()
const rows = []

function report(label, value) {
  rows.push({ label, value })
  console.log(label.padEnd(52), value)
}

// F1: case semantics of the share. `TMP` vs an existing `tmp`.
try {
  const upper = statSync(joinWslUnc(primary, '/TMP'))
  const lower = statSync(joinWslUnc(primary, '/tmp'))
  report('F1 case: /TMP resolves', upper.dev === lower.dev && upper.ino === lower.ino ? 'FOLDED (Windows semantics)' : 'DISTINCT')
} catch (error) {
  report('F1 case: /TMP resolves', error.code === 'ENOENT' ? 'ENOENT -> CASE-SENSITIVE (Linux semantics)' : 'probe failed: ' + error.code)
}

// F2: does realpath resolve a Linux symlink through the share? /lib -> usr/lib on merged-/usr.
//
// The control is the same call on the link's OWN target, a plain directory of the same
// share. Without it an ENOENT below could equally mean "the share did not answer", and
// the row would record a broken probe as a fact. With it, ENOENT is the ANSWER: the
// share exposes the link's entry but does not follow it.
let control = 'unmeasured'
try {
  control = 'resolves (' + realpathSync.native(joinWslUnc(primary, '/usr/lib')) + ')'
} catch (error) {
  control = 'fails: ' + error.code
}
try {
  const resolved = realpathSync.native(joinWslUnc(primary, '/lib'))
  report('F2 symlink: realpath(/lib)', resolved.includes('usr') ? 'RESOLVED to ' + resolved : 'NOT resolved: ' + resolved)
} catch (error) {
  report('F2 symlink: realpath(/lib)',
    error.code === 'ENOENT' ? 'ENOENT -> the link is NOT followed (control /usr/lib ' + control + ')' : 'probe failed: ' + error.code)
}

// F3: cross-share identity. Requires a second distribution.
//
// The pair is what the fence compares (lib/wsl/fence.js isUnderHost matches
// `dev === dev && ino === ino`), and on Windows every 9P share reports dev 0 — so a
// dev-only comparison would print COLLIDES on every machine and answer nothing about
// the inode half. Both halves are reported and both are compared.
if (other === undefined) {
  report('F3 cross-share identity',
    unmeasured('a share compared with itself reports a vacuous COLLIDES'))
} else {
  for (const rel of ['', '/tmp', '/home']) {
    try {
      const a = statSync(joinWslUnc(primary, rel === '' ? '/' : rel), { bigint: true })
      const b = statSync(joinWslUnc(other, rel === '' ? '/' : rel), { bigint: true })
      const same = a.dev === b.dev && a.ino === b.ino
      report('F3 identity ' + (rel === '' ? '<share root>' : rel),
        'dev ' + a.dev + ' vs ' + b.dev + ', ino ' + a.ino + ' vs ' + b.ino + ' -> ' + (same ? 'COLLIDES' : 'distinct'))
    } catch (error) {
      report('F3 identity ' + rel, 'probe failed: ' + error.code)
    }
  }
}

// F4: the fixture-root precondition D2 turns on.
const root = joinWslUnc(primary, home + '/proj')
let rootExists = true
try {
  statSync(root)
  report('F4 fixture root ' + root, 'EXISTS')
} catch (error) {
  rootExists = false
  report('F4 fixture root ' + root, error.code + ' (verify-fs-fence.mjs never creates it)')
}

// F5: would the walk run? Only meaningful with an existing root AND a target the
// lexical fast path does not already contain — i.e. a second distribution's
// share. Asking the question of the PRIMARY distro's own path would be answered
// "true" by the lexical fast path alone, a vacuous result that measures nothing.
//
// The verdict alone cannot be read: with the root absent (F4) the walk short-circuits to
// false and never compares anything, so the row states that precondition instead of
// letting "false" be read as "the walk ran and denied".
if (other === undefined) {
  report('F5 isUnderHost(foreign target, root)',
    unmeasured('the target is a path under the primary share, which the lexical fast path contains on its own'
      + ' — the true it would report is a vacuous fast-path result, not a walk verdict'))
} else {
  try {
    const verdict = await isUnderHost(joinWslUnc(other, home + '/proj/src/main.py'), root)
    report('F5 isUnderHost(foreign target, root)',
      String(verdict) + (rootExists ? '' : ' (root absent, so the walk short-circuits; see F4)'))
  } catch (error) {
    report('F5 isUnderHost(foreign target, root)', 'probe failed: ' + String(error).slice(0, 60))
  }
}

console.log('\n' + JSON.stringify(rows, null, 2))
