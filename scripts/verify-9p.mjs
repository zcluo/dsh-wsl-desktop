/**
 * Probe the WSL 9P share for the filesystem primitives `fs-local` relies on.
 *
 * `LocalFileSystem` publishes an atomic write with a hard link (create-if-absent)
 * or a Win32 security-preserving replace, and derives target identity from
 * `realpath`. This asserts the profile the WSL provider is built for: everything
 * available except hard links, which the provider replaces with an exclusive copy.
 *
 * It also MEASURES the three share facts the fence's records rest on — symlink
 * traversal, cross-share identity and case resolution — and RECORDS them instead
 * of asserting them: see "The three facts the fence rests on" below for why, and
 * `scripts/verify-fs-fence.mjs` for the fence's own answers to them.
 *
 * With no second distribution to compare against, the cross-share identity facts
 * cannot be measured at all. The suite then SKIPS them — naming the precondition,
 * the three facts that therefore went unmeasured and the remedy — and exits 2,
 * which `verify-all.mjs` reports as SKIP instead of as a pass. A silent skip would
 * leave a green aggregate implying the fence's assumptions were established, so the
 * report's content is pinned by `scripts/verify-9p-skip.mjs`.
 *
 * Run: node scripts/verify-9p.mjs [distro]
 */

import { mkdir, writeFile, link, rename, realpath, stat, rm, readFile, readdir, copyFile, chmod, constants } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { canonicalHostPath, isUnderHost } from '../lib/wsl/fence.js'
import { PUBLICATION_CEILING_MS, PUBLICATION_POLL_MS, PUBLICATION_TAIL_MS, publishReplace } from '../lib/wsl/publish.js'
import { resolveDistro, resolveOtherDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro(process.argv[2])
// Both scratch trees this suite owns are made UNIQUE TO THIS PROCESS. They used to be
// machine-global (`/tmp/dsh-wsl-9p-probe`, `/tmp/dsh-wsl-9p-probe-link`), so two runs
// overlapping in time destroyed each other: one run's opening `rm -rf` deletes the
// other's root, and a `rm -rf` that races a concurrent write dies ENOTEMPTY. Measured
// with two overlapping runs of this probe: 17 of 20 runs crashed (13 ENOTEMPTY, 3 ENOENT,
// 1 EPERM) and the crash is the LAST cleanup, which runs before the report is printed —
// so the suite lost its whole verdict, not one row. The pid is enough: concurrent
// processes never share one, and a reused pid finds only its own leftover, which the
// opening `rm -rf` removes anyway.
const runSuffix = process.pid
const root = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-9p-probe-${runSuffix}`

let failures = 0
/** Share facts that could not be measured here; the suite's exit code reports them (see the tail). */
let skipped = 0
/** Checks that could not be evaluated here for the same reason; counted separately because the tail names facts. */
let skippedChecks = 0

/**
 * Record one probe outcome against its expected availability.
 * @param {string} label - what was attempted.
 * @param {boolean} available - whether the primitive worked.
 * @param {'available' | 'unavailable'} expected - the outcome the provider is built for.
 * @param {unknown} [detail] - context shown when the outcome differs.
 */
function probe(label, available, expected, detail) {
  const matches = expected === 'available' ? available : !available
  console.log(`  ${matches ? 'OK  ' : 'FAIL'}  ${label} — ${available ? 'available' : 'unavailable'}${matches ? '' : ` (expected ${expected})`}`)
  if (!matches && detail !== undefined) console.log(`        ${detailText(detail)}`)
  if (!matches) failures += 1
}

/**
 * Record one assertion about the provider's publication (boolean, not an
 * availability probe).
 * @param {string} label - what was asserted.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - context shown on failure.
 */
function publicationCheck(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

/**
 * Record one identity-mapping assertion (fence load-bearing; boolean, not an
 * availability probe).
 * @param {string} label - what was asserted.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - context shown on failure.
 */
function identityCheck(label, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : ` — ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
console.log(`probing ${root}\n`)

const seed = join(root, 'seed.txt')
await writeFile(seed, 'hello\n', 'utf8')

try {
  const realpathed = await realpath(seed)
  probe('realpath resolves on the share', true, 'available')
  probe('realpath keeps the share spelling', realpathed.toLowerCase().includes('wsl'), 'available', realpathed)
} catch (error) {
  probe('realpath resolves on the share', false, 'available', error)
  probe('realpath keeps the share spelling', false, 'available')
}

try {
  const info = await stat(seed)
  probe('stat exposes mtime and size for the version basis', Number.isFinite(info.mtimeMs) && Number.isFinite(info.size), 'available', `${info.mtimeMs} / ${info.size}`)
} catch (error) {
  probe('stat exposes mtime and size for the version basis', false, 'available', error)
}

try {
  await link(seed, join(root, 'hardlink.txt'))
  probe('hard link (create-if-absent publication)', true, 'unavailable')
} catch (error) {
  probe('hard link (create-if-absent publication)', false, 'unavailable', `${error.code} ${error.message}`)
}

// The wait is NOT re-implemented here. `lib/wsl/publish.js` owns it — the provider's
// `replaceFile` publishes through that function — and this probe drives THAT function
// against the real share, so the code being measured is the code that ships. Before it
// existed the probe carried its own copy of the wait, and that copy is exactly how a
// provider-side publication with no wait at all stayed invisible: the probe passed while
// `lib/wsl/fs.js` published once, unretried, and 2 of 200 writes through the provider's
// own `writeText` failed with EPERM against this share.

try {
  const replaced = join(root, 'replace-me.txt')
  const replacement = join(root, 'replacement.txt')
  await writeFile(replaced, 'old\n', 'utf8')
  await writeFile(replacement, 'new\n', 'utf8')
  const published = await publishReplace(replaced, replacement)
  // The landing is asserted from the CONTENT, not from the call returning: the
  // primitive's contract on this share is that the destination HOLDS the replacement,
  // and "the rename did not throw" would also accept a publication that landed nowhere.
  const value = await readFile(replaced, 'utf8').catch(() => null)
  probe('rename replaces an existing file (overwrite publication)', value === 'new\n', 'available',
    value === 'new\n'
      ? undefined
      : `the publication returned after ${published.attempts} attempt(s) and the destination holds ${JSON.stringify(value)}`)
} catch (error) {
  probe('rename replaces an existing file (overwrite publication)', false, 'available', `${error.code} ${error.message}`)
}

try {
  await copyFile(seed, join(root, 'copied.txt'), constants.COPYFILE_EXCL)
  probe('COPYFILE_EXCL copies (fallback publication)', true, 'available')
} catch (error) {
  probe('COPYFILE_EXCL copies (fallback publication)', false, 'available', `${error.code} ${error.message}`)
}

try {
  await chmod(seed, 0o600)
  probe('chmod is accepted', true, 'available')
} catch (error) {
  probe('chmod is accepted', false, 'available', `${error.code} ${error.message}`)
}

// The fs fence's identity fallback (lib/wsl/fence.js isUnderHost) authorizes
// containment on stat (dev,ino) equality against writable roots that live on
// THIS share, so the fence is only as strong as the share's identity mapping:
// distinct files must map to distinct identities, and one file must keep the
// same identity across the wsl.localhost / wsl$ host spellings.
try {
  await writeFile(join(root, 'identity-a.txt'), 'a', 'utf8')
  await writeFile(join(root, 'identity-b.txt'), 'b', 'utf8')
  const [ia, ib] = await Promise.all([stat(join(root, 'identity-a.txt')), stat(join(root, 'identity-b.txt'))])
  identityCheck('distinct files map to distinct (dev,ino)', ia.dev !== ib.dev || ia.ino !== ib.ino, `a=(${ia.dev},${ia.ino}) b=(${ib.dev},${ib.ino})`)
  const dollarRoot = root.replace('wsl.localhost', 'wsl$')
  const [inoHost, inoDollar] = await Promise.all([stat(join(root, 'identity-a.txt')), stat(join(dollarRoot, 'identity-a.txt'))])
  identityCheck('identity stable across wsl.localhost / wsl$ spellings', inoHost.ino === inoDollar.ino && inoHost.dev === inoDollar.dev, `host=${inoHost.ino} dollar=${inoDollar.ino}`)
} catch (error) {
  identityCheck('9P identity mapping (fence load-bearing)', false, `${error.code} ${error.message}`)
}

// ---------------------------------------------------------------------------
// The three facts the fence rests on
//
// The fence's records rest on three properties of the SHARE that this profile
// never pinned: whether realpath resolves a Linux symlink, whether two shares
// report distinct (dev,ino), and whether the share resolves a case-variant path
// the way Windows does. They are MEASURED here and recorded; the fence's own
// answer to them is pinned in `scripts/verify-fs-fence.mjs`, where the fence is
// the subject:
//
//   * case semantics: the containment comparison folds only the Windows prefix
//     and the identity walk answers behind it, so the fence adapts to either
//     answer, and verify-fs-fence.mjs asserts the fence answers the way the
//     share does.
//   * cross-share identity: the collision is a defect the fence defends against
//     by binding the identity walk to the distribution, and that defence is
//     pinned there too (a cross-distribution target under a root whose identity
//     it shares must be refused).
//   * symlink traversal: the fence's answer to it is a RULE — a target is
//     authorized only when every component between the writable root and the
//     target's own name either does not exist or canonicalizes — and it is
//     ASSERTED below, beside the share's own mkdir answer. The share's blindness
//     is the premise, so the assertion is written to hold on either answer.
//
// A FACT is therefore not a check. What is asserted beside one is only what
// makes it a measurement instead of a print: that the subject EXISTS and that
// the control answers. Without those, an ENOENT from a path that was never there
// reads as "the share refuses the link" — the vacuous-pin class (D2) this plan
// exists to remove. Asserting the share's own answer instead would redden this
// suite on a healthy machine that answers differently, which is the mirror of a
// check that can never fail.
// ---------------------------------------------------------------------------

const facts = []

/**
 * Record one measured property of the share.
 *
 * There is no HAZARD form any more: the one recorded hazard — mkdir through a
 * Linux symlink the canonicalizer cannot resolve, which created a directory
 * outside the writable root — is closed by the fence's rule and asserted below,
 * and a reporting path no check can redden is the class this plan removes.
 * Where a FUTURE hazard goes: THREE pieces were removed in commit cc23c91 and all
 * three come back together with `git show cc23c91^:scripts/verify-9p.mjs` — the
 * `{ hazard: true }` option on this function (which printed `HAZARD` instead of
 * `FACT  ` and collected the entry), the `const hazards = []` array beside `facts`,
 * and the final `for (const entry of hazards) console.log(...)` summary line. A
 * measured answer the fence does NOT cover must not sit among the FACTs, and the
 * fence's own answer to it belongs in `scripts/verify-fs-fence.mjs`.
 * @param {string} label - what was measured.
 * @param {string} value - the measured answer.
 */
function fact(label, value) {
  console.log(`  FACT    ${label} — ${value}`)
  facts.push({ label, value })
}

// ---------------------------------------------------------------------------
// The overwrite publication at a DOSE, through the PROVIDER's own helper
//
// The check above is ONE invocation, and one invocation measures a RATE rather than a
// capability: the share refuses a replace of an EXISTING file with ERROR_ACCESS_DENIED
// (Node reports EPERM) at a rate that follows how densely the SAME destination name is
// rewritten — 4.2% (42/1000) back-to-back, 1.5% (6/400) with 25 ms between iterations of the
// identical sequence, 0/200 at 100 ms, and 9.9% in an independent replay of the sequence.
// Every one of the 321 observed refusals cleared on a retry (8-49 ms, one 82 ms outlier, at
// most 3 attempts), the destination is not blocked while it is refused (unlink succeeded in
// 51/51), a destination that does not exist is never refused (0/1000), and the distribution's
// own rename never is (0/3000) — so the refusal is the SHARE's bounded, rate-dependent
// transient, not an unavailable primitive.
//
// WITHDRAWN from the record this row was added with: that the refusal was a race between the
// two CREATIONS, decaying with the gap between them. The three runs above change the DENSITY
// only — the intra-iteration gap between those two writes is the same ~2 ms in all of them —
// and the rate still collapses, so the runs that seemed to measure that gap were confounded:
// they moved the density and the per-iteration repetition too, and no single reading fits all
// of them (25/400 refused at ~90 ms per iteration on the old reading, against 0/400 at ~79 ms
// on the other). What SURVIVES is all the fix needs: a REPLACE-specific transient that clears
// on a retry. The better-supported reading is the destination name's own write recency and
// rewrite rate; the wait below is on the operation's own outcome either way, so it does not
// depend on which reading is right.
//
// This row is the pin for the PROVIDER's publication: it publishes up to 200 times through
// `publishReplace` — the function `lib/wsl/fs.js:replaceFile` itself calls — and asserts
// that every publication LANDED (the destination holds the replacement's bytes). Against a
// single unretried rename it reports the refusals as losses, which is precisely the
// user-visible failure it exists to prevent; the mutation that reddens it is making
// `publishReplace` a single attempt.
// ---------------------------------------------------------------------------

/** How many back-to-back publications the dose runs. */
const PUBLICATION_DOSE = 200

let publicationAttempts = 0
let publicationMisses = 0
let publicationRefusals = 0
let slowestRefusalMs = 0
/** How the FIRST publication that missed the bound missed it — the reason this row reports. */
let firstMiss = ''
// WHY A MISS ENDS THE DOSE. A publication the wait did not save is not the transient this row
// exists for — that one is waited out inside `publishReplace` and never counted here — and the
// remaining attempts cannot answer differently: each would pay the ceiling again. Running all
// 200 against a refusal that never clears cost 106.2 s per probe run, measured here with
// publishReplace's own rename replaced by a refusing one; the row then reported
// "200 of 200 did not land within 500 ms each (0 refused attempt(s))" — no errno at all, and a
// count that reads as though NOTHING had been refused, because the thrown error was swallowed.
// 106 s is already past the 300 s ceiling of the AGGREGATE that runs the probe several times
// (verify-all.mjs SIGKILLs a suite; verify-9p-skip.mjs spawns the probe ~9 times), so the
// reason was never printed anywhere. One miss and the reason below is printed in seconds.
for (let dose = 0; dose < PUBLICATION_DOSE; dose += 1) {
  const replaced = join(root, 'replace-me.txt')
  const replacement = join(root, 'replacement.txt')
  await writeFile(replaced, 'old\n', 'utf8')
  await writeFile(replacement, 'new\n', 'utf8')
  const startedAt = Date.now()
  publicationAttempts += 1
  let published
  try {
    published = await publishReplace(replaced, replacement)
  } catch (error) {
    // The wait gave up: the refusal outlived the ceiling, which is not the transient this row
    // waits out. The error is KEPT — swallowing it is what left the reason unprintable.
    publicationMisses += 1
    firstMiss = `${error.code} ${error.message} — the wait spent ${Date.now() - startedAt} ms before giving up`
    break
  }
  publicationRefusals += published.refusals
  // Only a REFUSED publication's wait is a window length worth recording: an ordinary
  // publication's few milliseconds are the share's speed, not the refusal's duration.
  if (published.refusals > 0) slowestRefusalMs = Math.max(slowestRefusalMs, published.waitedMs)
  const value = await readFile(replaced, 'utf8').catch(() => null)
  if (value !== 'new\n') {
    publicationMisses += 1
    firstMiss = `the publication returned after ${published.attempts} attempt(s) and the destination holds ${JSON.stringify(value)}`
    break
  }
}
probe('the overwrite publication lands at a dose, so a transient refusal is waited out instead of reported as unavailability',
  publicationMisses === 0, 'available',
  `${publicationMisses} of ${publicationAttempts} attempted did not land`
    + (publicationMisses === 0 ? '' : ` (stopped there: ${firstMiss})`)
    + (publicationRefusals === 0 ? '' : `; ${publicationRefusals} refused attempt(s) waited out`))
fact('the overwrite publication at a dose of up to ' + PUBLICATION_DOSE + ' back-to-back attempts',
  publicationAttempts + ' of ' + PUBLICATION_DOSE + ' attempted; ' + publicationMisses + ' did not land'
    + (publicationRefusals === 0 ? '' : '; ' + publicationRefusals + ' refused attempt(s), the slowest cleared in ' + slowestRefusalMs + ' ms')
    + (publicationMisses === 0 ? '' : '; the first failure: ' + firstMiss))

// The other half of the same guarantee, on the REAL share: the wait must not swallow a
// refusal that is not transient. A deterministic failure is produced by publishing a
// source that does not exist, and what must hold is that the publication REPORTS it and
// that the destination keeps its bytes — a retry that turned a real error into a
// success would be worse than the flake it replaced.
{
  const replaced = join(root, 'persistent-target.txt')
  const missing = join(root, 'never-created.txt')
  await rm(missing, { force: true })
  await writeFile(replaced, 'old\n', 'utf8')
  const started = Date.now()
  let code = 'returned'
  try {
    await publishReplace(replaced, missing)
  } catch (error) {
    code = error.code
  }
  const value = await readFile(replaced, 'utf8').catch(() => null)
  probe('a deterministic publication failure is reported, not swallowed by the wait, and the destination keeps its bytes',
    code !== 'returned' && value === 'old\n', 'available',
    `the publication returned ${code} after ${Date.now() - started} ms and the destination holds ${JSON.stringify(value)}`)
}

// The ceiling has to stay ABOVE the tail it was chosen for, or the wait becomes a coin flip
// again — and the tail is READ from the module that owns it, never repeated here as a literal.
// The earlier version of this row hardcoded "82 ms" from an older, smaller, UNLOADED record,
// which made it certify a margin it did not measure: 5 x 82 = 410 would have accepted a 411 ms
// ceiling, 1.10x the measured LOADED maximum of 373 ms — a worse margin than the 500 ms that
// measurement itself rejected — and it was green under every mutation either investigation
// named. A measurement hardcoded in a file the ceiling's owner does not own drifts the moment
// either one moves, and the drift is invisible. What reddens this row now, and must:
// dropping the ceiling below 5x the measured tail (measured: PUBLICATION_CEILING_MS = 500
// reddens it), or raising the tail past ceiling/5 (measured: PUBLICATION_TAIL_MS = 1000
// reddens it). Both mutations were run; see the R=1 section of the Tier 2 report.
probe('the publication ceiling stays above the measured tail of the refusal',
  PUBLICATION_CEILING_MS >= 5 * PUBLICATION_TAIL_MS, 'available',
  `ceiling=${PUBLICATION_CEILING_MS} ms against the measured tail of ${PUBLICATION_TAIL_MS} ms (5x = ${5 * PUBLICATION_TAIL_MS} ms)`)

// ---------------------------------------------------------------------------
// The BOUND: a refusal that does not clear must still surface
//
// The dose proves the wait works; these rows prove it STOPS. A retry that swallowed a
// persistent error would be worse than the flake it replaced, so the bound is asserted
// against a rename the probe controls rather than measures: it refuses a known number of
// times and records what it was asked. The error's IDENTITY matters as much as the count —
// `fs-local`'s publication inspects `error.code` (an ENOENT from `replaceFile` means "the
// target disappeared while staging" and falls back to a plain rename), so the module must
// rethrow what it was handed and never a wrapper of its own.
// ---------------------------------------------------------------------------

/** The refusal the controlled rename repeats, so the surfaced error is compared by IDENTITY. */
const PERSISTENT_REFUSAL = Object.assign(new Error('pin: the share refuses this publication'), { code: 'EPERM' })

/**
 * A rename under the probe's control, recording what the publication asked of it.
 * @param {number} refusals - how many attempts are refused before the publication lands.
 * @returns {{record: {calls: number, landed: boolean}, rename: (from: string, to: string) => Promise<void>}} the fake and its record.
 */
function controlledRename(refusals) {
  const record = { calls: 0, landed: false }
  return {
    record,
    rename: async () => {
      record.calls += 1
      if (record.calls <= refusals) throw PERSISTENT_REFUSAL
      record.landed = true
    },
  }
}

{
  const twice = controlledRename(2)
  // The throw is caught HERE rather than left to the module: a publication that never
  // retries at all must be REPORTED as a failing row, never crash the suite before it
  // prints one — the first run of this row did exactly that, so the suite reported
  // nothing about the bound it was added to measure.
  let outcome
  try {
    outcome = await publishReplace('/pin/replaced.txt', '/pin/replacement.txt', { rename: twice.rename })
  } catch (error) {
    outcome = { attempts: 1, refusals: 0, waitedMs: 0, error }
  }
  publicationCheck('a refused publication is retried until it lands, and the wait it spent is reported',
    twice.record.landed && outcome.attempts === 3 && outcome.refusals === 2 && outcome.waitedMs >= 2 * PUBLICATION_POLL_MS,
    `landed=${String(twice.record.landed)} attempts=${String(outcome.attempts)} refusals=${String(outcome.refusals)} waitedMs=${String(outcome.waitedMs)} poll=${String(PUBLICATION_POLL_MS)} thrown=${outcome.error === undefined ? 'none' : String(outcome.error.code)}`)
}

{
  const forever = controlledRename(Number.POSITIVE_INFINITY)
  const started = Date.now()
  let thrown
  try {
    await publishReplace('/pin/replaced.txt', '/pin/replacement.txt', { rename: forever.rename })
  } catch (error) {
    thrown = error
  }
  const elapsed = Date.now() - started
  publicationCheck('a refusal that never clears is reported as a failure instead of retried forever',
    thrown === PERSISTENT_REFUSAL
      && forever.record.calls >= 2
      && forever.record.calls <= PUBLICATION_CEILING_MS / PUBLICATION_POLL_MS + 2
      && elapsed >= PUBLICATION_CEILING_MS && elapsed <= PUBLICATION_CEILING_MS * 4,
    `thrown=${thrown === undefined ? 'none' : String(thrown.code)} sameError=${String(thrown === PERSISTENT_REFUSAL)} calls=${String(forever.record.calls)} elapsedMs=${String(elapsed)} ceiling=${String(PUBLICATION_CEILING_MS)}`)
}

/**
 * Whether a path exists, without reporting why it does not.
 * @param {string} path - the path to test.
 * @returns {Promise<boolean>} true when the path stats.
 */
async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const shareRoot = `\\\\wsl.localhost\\${distro}`

// P1: does the share resolve a Linux symlink?
//
// `canonicalHostPath` (lib/wsl/fence.js) canonicalizes with realpathSync.native
// and keeps the spelling when it fails, and the harness resolves a target the
// same way (fs-local/src/fsio.ts:161-210). So this answer decides whether
// containment for a path that traverses a link is lexical only.
//
// First on a link this probe did NOT create: /lib is a merged-/usr symlink, and
// its ENOENT only means something once the subject is proven PRESENT — a path
// that does not exist answers ENOENT too. The listing is that proof; the control
// is the link's own target, a plain directory of the same share.
let libListed = false
try {
  libListed = (await readdir(shareRoot)).includes('lib')
} catch {
  libListed = false
}
if (!libListed) {
  fact('realpath(/lib)', 'UNMEASURED - the share lists no /lib entry (not a merged-/usr distribution)')
} else {
  let control = 'unmeasured'
  let controlResolved = false
  try {
    // realpathSync.native is the call `canonicalHostPath` makes (lib/wsl/fence.js),
    // and the one the harness's own target resolution makes (fs-local/src/fsio.ts).
    control = realpathSync.native(`${shareRoot}\\usr\\lib`)
    controlResolved = true
  } catch (error) {
    control = `${error.code} ${error.message}`
  }
  probe("the control: /lib's own target (/usr/lib) resolves on the same share", controlResolved, 'available', control)
  const controlNote = controlResolved ? `resolves (${control})` : `did NOT resolve: ${control}`
  try {
    const resolved = realpathSync.native(`${shareRoot}\\lib`)
    fact('realpath(/lib), a merged-/usr symlink', `resolved to ${resolved} — a plain directory on this distribution, or a link the share follows`)
  } catch (error) {
    fact('realpath(/lib), a merged-/usr symlink', `${error.code} -> the link is NOT followed (control /usr/lib ${controlNote})`)
  }
}

// The authoritative form of P1: a link the PROBE creates — through the
// distribution's own `ln -s`, because the Windows side cannot create one
// (CreateSymbolicLinkW needs a privilege this host does not grant; measured
// EPERM), and a workspace's links are created by Linux tooling anyway. It lives
// in a fixture root that stands in for a writable root and points OUTSIDE it, so
// "outside" is a directory this probe owns and can inspect.
//
// The fixture needs wsl.exe twice — to create the link and to remove it, because
// the share can neither follow a link entry nor delete one (measured from the
// Windows side: unlink ENOENT, rm EISDIR, and ENOTEMPTY for a directory holding
// one). wsl.exe is the call a cold VM start can hang, so both calls are bounded and
// a fixture failure is reported as a SKIP: the fixture is this probe's own rather than
// a suite precondition, but this branch also holds THE ASSERTION the fence's rule is
// proved by (below), so losing it silently would report that rule as established
// without ever evaluating it — the class this plan removes. The facts it records are
// named in the SKIP block, counted in the tail, and NOT pushed into `facts` (which
// counts measurements).
const WSL_TIMEOUT_MS = 30_000
const linkScratchLinux = `/tmp/dsh-wsl-9p-probe-link-${runSuffix}`
const linkScratch = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-9p-probe-link-${runSuffix}`
const linkFixture = `${linkScratch}\\root`
const linkOutside = `${linkScratch}\\outside`
const linkEntry = `${linkFixture}\\escape`
const linkOutsideLinux = `${linkScratchLinux}/outside`
const linkEntryLinux = `${linkScratchLinux}/root/escape`

/** The share facts the link fixture records; each is lost when the fixture cannot be built. */
const LINK_FACTS = {
  follow: 'realpath / read of the link (the file behind it exists)',
  rename: 'a rename whose destination traverses the link',
  mkdir: 'mkdir through the link, at a spelling the share resolves elsewhere',
}

/**
 * The checks the link fixture evaluates; each is unevaluated when the fixture cannot be
 * built, and `fenceRefusal` is the assertion the fixture EXISTS for.
 */
const LINK_CHECKS = {
  listed: 'the symlink the probe created is listed by the share, so the answers below are about a link that exists',
  targetReadable: "the control: the link's own target is readable at its real path",
  createTraversal: 'realpath cannot see the link, so the share must not resolve it for create either',
  fenceRefusal: 'the fence refuses the target its own canonicalization produces for that spelling',
}

/**
 * Remove the symlink fixture through the distribution.
 *
 * The Windows side cannot do it (see above), and a throw from an exit or signal
 * handler would replace the suite's verdict, so this never throws — but a
 * leftover is not silent either.
 */
function removeLinkFixture() {
  try {
    execFileSync('wsl.exe', ['-d', distro, '-e', 'rm', '-rf', linkScratchLinux], { timeout: WSL_TIMEOUT_MS })
  } catch (error) {
    console.error(`verify-9p: the symlink fixture could not be removed: ${linkScratch} (${error?.code ?? error?.status ?? String(error)})`)
  }
}
// Node does not emit 'exit' when it dies from a signal, and this fixture cannot
// be removed from the Windows side at all, so it gets the handlers the plain
// probe root does not need (the shape verify-fs-fence.mjs uses).
process.on('exit', removeLinkFixture)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    removeLinkFixture()
    process.exit(code)
  })
}

let linkProblem = ''
try {
  execFileSync('wsl.exe', ['-d', distro, '-e', 'rm', '-rf', linkScratchLinux], { timeout: WSL_TIMEOUT_MS })
  await mkdir(linkFixture, { recursive: true })
  await mkdir(linkOutside, { recursive: true })
  await writeFile(`${linkOutside}\\inside.txt`, 'outside\n', 'utf8')
  execFileSync('wsl.exe', ['-d', distro, '-e', 'ln', '-s', linkOutsideLinux, linkEntryLinux], { timeout: WSL_TIMEOUT_MS })
} catch (error) {
  linkProblem = `${error?.code ?? error?.status ?? 'error'}: ${String(error?.message ?? error).slice(0, 120)}`
}

if (linkProblem !== '') {
  console.log(`  SKIP  the link fixture — the probe could not build it: ${linkProblem}`)
  console.log(`        NOT MEASURED (${Object.keys(LINK_FACTS).length} facts): ${Object.values(LINK_FACTS).join(', ')}`)
  // Every label below is interpolated from LINK_CHECKS: prose that merely DESCRIBES the
  // four would drift the moment one of them is reworded, and the reader of a SKIP has no
  // other way to know what did not run.
  console.log(`        NOT EVALUATED (${Object.keys(LINK_CHECKS).length} checks, every label from LINK_CHECKS): ${Object.values(LINK_CHECKS).map((label) => `"${label}"`).join('; ')}`)
  console.log(`        Of those, "${LINK_CHECKS.fenceRefusal}" is the assertion this fixture EXISTS for — the fence's rule for a target whose components cannot be canonicalized, which no other check in this suite covers.`)
  console.log(`        Remedy: wake the distribution once ("wsl.exe -d ${distro} -- true") and re-run — the fixture needs wsl.exe twice (to create the link, and to remove it) and is this probe's own, not the suite's precondition.`)
  skipped += Object.keys(LINK_FACTS).length
  skippedChecks += Object.keys(LINK_CHECKS).length
} else {
  const listed = (await readdir(linkFixture)).includes('escape')
  identityCheck(LINK_CHECKS.listed,
    listed === true, `readdir(${linkFixture}) did not list "escape"`)
  let targetRead = ''
  let targetReadable = false
  try {
    targetRead = (await readFile(`${linkOutside}\\inside.txt`, 'utf8')).trim()
    targetReadable = true
  } catch (error) {
    targetRead = `${error.code} ${error.message}`
  }
  probe(LINK_CHECKS.targetReadable, targetReadable, 'available', targetRead)
  if (listed && targetReadable) {
    // realpathSync.native is the fence's own call, so "blind" below is the fence's
    // blindness and not a different resolver's opinion.
    let realDetail = ''
    let realpathBlind = false
    try {
      realDetail = `resolved to ${realpathSync.native(linkEntry)}`
    } catch (error) {
      realDetail = error.code
      realpathBlind = true
    }
    let readDetail = ''
    let readTraversed = false
    try {
      await readFile(`${linkEntry}\\inside.txt`, 'utf8')
      readDetail = 'the file behind the link IS readable through it'
      readTraversed = true
    } catch (error) {
      readDetail = error.code
    }
    fact(LINK_FACTS.follow,
      readTraversed || realpathBlind === false
        ? `realpath ${realDetail}; read ${readDetail} -> the link IS resolved through the share`
        : `realpath ${realDetail}; read ${readDetail} -> the link is exposed but NOT followed`)
    // The dangerous combination is the one this share is in: realpath does NOT
    // resolve the link — so the fence's containment for this spelling is lexical
    // and authorizes it — while a write primitive DOES traverse it. Where realpath
    // resolves the link, the fence canonicalizes the real target instead and the
    // traversal is not a hole, so the assertion is conditional on the measured
    // blindness (the way verify-fs-fence.mjs conditions its case-variant answer
    // on the share's own case semantics).
    let createDetail = ''
    try {
      await writeFile(`${linkEntry}\\landed.txt`, 'landed\n', 'utf8')
      createDetail = 'created'
    } catch (error) {
      createDetail = `${error.code}`
    }
    const createLanded = await pathExists(`${linkOutside}\\landed.txt`)
    identityCheck(LINK_CHECKS.createTraversal,
      !(realpathBlind && createLanded),
      `realpath blind: ${realpathBlind}; create reported ${createDetail} and ${linkOutside}\\landed.txt exists: ${createLanded}`)
    // The rest of the write surface, which the fence's containment also rests on:
    // a rename whose destination traverses the link IS resolved by the server,
    // and so is a mkdir — which is the one the provider can actually reach.
    //
    // "It did not throw" is not the measurement: a destination that spells the
    // source's own path succeeds as a self-rename and says nothing about whether the
    // server resolved the link. The destination is therefore a SECOND fresh name, and
    // the answer is read from where the file actually is afterwards — the same
    // pathExists() the mkdir fact below reads its own landing from. A rename that does
    // not put the file at the link's target is recorded as not having landed there.
    let renameDetail = ''
    try {
      await writeFile(`${linkOutside}\\renamed-src.txt`, 'renamed\n', 'utf8')
      await rename(`${linkOutside}\\renamed-src.txt`, `${linkEntry}\\renamed-dst.txt`)
      renameDetail = 'accepted without error'
    } catch (error) {
      renameDetail = `reported ${error.code}`
    }
    const renameLanded = await pathExists(`${linkOutside}\\renamed-dst.txt`)
    fact(LINK_FACTS.rename,
      `rename ${renameDetail} and ${linkOutside}\\renamed-dst.txt exists: ${renameLanded} -> the file ${renameLanded ? 'landed AT' : 'did NOT land at'} the link's target (the SHARE resolves the destination spelling; the fence refuses it — the assertion below — and the provider never reaches this primitive anyway: the mkdir below aborts first, fs-local/src/fsio.ts:598)`)
    let mkdirDetail = ''
    try {
      await mkdir(`${linkEntry}\\dsh-link-dir`)
      mkdirDetail = 'created without error'
    } catch (error) {
      mkdirDetail = `reported ${error.code}`
    }
    const mkdirEscaped = await pathExists(`${linkOutside}\\dsh-link-dir`)
    // The share's answer, and only the share's: mkdir at a spelling that traverses
    // the link CREATES the directory at the link's target — outside the fixture root
    // that stands in for a writable root — while the client reports an error. The
    // landing, not the call's outcome, is the measurement.
    const rawSpelling = `${linkEntry}\\dsh-link-dir`
    const rawVerdict = await isUnderHost(rawSpelling, canonicalHostPath(linkFixture))
    fact(LINK_FACTS.mkdir,
      `mkdir ${mkdirDetail} and ${linkOutside}\\dsh-link-dir exists: ${mkdirEscaped}; isUnderHost(the raw spelling) === ${rawVerdict}`)
    // The fence's answer to that spelling is an ASSERTION now, not a record: the
    // HAZARD this line used to carry is closed by the rule in lib/wsl/fence.js
    // (`canonicalizationOf` / `componentsCanonicalize`) — a target is authorized
    // only when every component between the writable root and the target's own name
    // either does not exist or canonicalizes.
    //
    // What is asserted is the target key the WRITE hands the fence: `checkedTarget`
    // re-resolves the target and passes THAT key to `isUnderHost`. While the
    // canonicalizer is blind (measured above) the key is the spelling itself, and
    // the rule refuses it; on a share that DOES resolve the link the key is the
    // link's target, and containment refuses that. Both arms refuse, so the
    // assertion holds whichever way the share answers — and on this share the first
    // arm is the one that runs, which is what makes the escape unreachable.
    const fenceTarget = canonicalHostPath(rawSpelling)
    const fenceVerdict = await isUnderHost(fenceTarget, canonicalHostPath(linkFixture))
    identityCheck(LINK_CHECKS.fenceRefusal,
      fenceVerdict === false,
      `canonicalHostPath(${rawSpelling}) = ${fenceTarget}; isUnderHost(...) = ${fenceVerdict} (raw spelling: ${rawVerdict}; realpath blind: ${realpathBlind})`)
  }
}

// P2: do two shares report distinct identity for distinct objects?
//
// The fence's identity fallback compares (dev,ino) — the walk is now bound to the
// distribution, so a foreign target is refused before any stat (verify-fs-fence
// pins that), but the INPUT to that comparison is a property of the host: this is
// where a reader sees whether the two shares still collide.
//
// A machine with ONE distribution cannot answer any of these three rows, and the
// owner ruled that this is a SKIP rather than a FAIL: a missing precondition, not
// a broken profile. The SKIP is LOUD because it is quieter than the FAIL it
// replaces — the rows are named, counted, and the suite exits 2 so `verify-all`
// shows SKIP rather than PASS — so a green aggregate cannot imply these facts were
// established. Only this family is skipped: every fact that does not need a second
// share is still measured and printed below.

/** The share paths the cross-share rows compare; each is one measured fact. */
const CROSS_SHARE_PATHS = ['/', '/tmp', '/home']

/**
 * The FACT label of one cross-share row.
 * @param {string} linuxPath - the share path compared, `/` being the share root.
 * @returns {string} the label the row is recorded under.
 */
const crossShareLabel = (linuxPath) => `cross-share identity ${linuxPath === '/' ? '<share root>' : linuxPath}`

let otherDistro = ''
let otherProblem = ''
try {
  const resolved = resolveOtherDistro(distro)
  if (resolved === undefined) otherProblem = `no distribution other than "${distro}" is installed`
  // An EMPTY override is not a second share either, and it used to produce a SKIP
  // with no reason at all ("UNMEASURED - "), which names nothing.
  else if (resolved.trim() === '') otherProblem = 'DSH_WSL_OTHER_DISTRO is set to an empty value, so no second share is named'
  else if (resolved.toLowerCase() === distro.toLowerCase()) otherProblem = `the resolved second distribution is "${distro}" itself, so every row would compare the share with itself`
  else otherDistro = resolved
} catch (error) {
  otherProblem = String(error?.message ?? error)
}
// The SKIP must always name its precondition: a resolver that failed without a
// message must not produce a reasonless SKIP.
if (otherDistro === '' && otherProblem.trim() === '') otherProblem = 'the second distribution could not be resolved, and no reason was reported'
if (otherDistro === '') {
  console.log(`  SKIP  cross-share identity — no second share to compare against: ${otherProblem}`)
  console.log(`        NOT MEASURED (${CROSS_SHARE_PATHS.length} facts): ${CROSS_SHARE_PATHS.map(crossShareLabel).join(', ')}`)
  console.log("        Unestablished: whether two shares report the same (dev,ino) — the INPUT to the fence's identity fallback (lib/wsl/fence.js) and the premise of verify-fs-fence.mjs's cross-distribution assertions.")
  console.log('        Remedy: install a second WSL distribution, or point DSH_WSL_OTHER_DISTRO at one this machine already has (wsl.exe -l -q).')
  skipped += CROSS_SHARE_PATHS.length
} else {
  for (const linuxPath of CROSS_SHARE_PATHS) {
    const spell = (name) => linuxPath === '/' ? `\\\\wsl.localhost\\${name}` : `\\\\wsl.localhost\\${name}${linuxPath.split('/').join('\\')}`
    try {
      const [here, there] = await Promise.all([
        stat(spell(distro), { bigint: true }),
        stat(spell(otherDistro), { bigint: true }),
      ])
      const same = here.dev === there.dev && here.ino === there.ino
      fact(crossShareLabel(linuxPath),
        `${distro} (${here.dev},${here.ino}) vs ${otherDistro} (${there.dev},${there.ino}) -> ${same ? 'COLLIDES - the identity comparison cannot tell the two shares apart' : 'distinct'}`)
    } catch (error) {
      fact(crossShareLabel(linuxPath), `UNMEASURED - ${error.code}`)
    }
  }
}

// P3: does the share resolve a case-variant path the way Windows does?
//
// The containment comparison folds only the Windows prefix because the share
// resolves the Linux portion with Linux semantics (lib/wsl/fence.js). /tmp is
// the subject — it exists on every distribution — and /TMP is the variant.
try {
  const lower = await stat(`${shareRoot}\\tmp`, { bigint: true })
  try {
    const upper = await stat(`${shareRoot}\\TMP`, { bigint: true })
    fact('case-variant path /TMP (control: /tmp exists)',
      upper.dev === lower.dev && upper.ino === lower.ino
        ? 'FOLDED - /TMP and /tmp are one object (Windows semantics)'
        : 'DISTINCT object - a directory really exists at that spelling (Linux semantics)')
  } catch (error) {
    fact('case-variant path /TMP (control: /tmp exists)',
      error.code === 'ENOENT' ? 'ENOENT -> CASE-SENSITIVE (Linux semantics)' : `UNMEASURED - ${error.code}`)
  }
} catch (error) {
  fact('case-variant path /TMP (control: /tmp exists)', `UNMEASURED - the control /tmp does not answer: ${error.code}`)
}

// The fixture is removed through the distribution: a Linux symlink entry cannot
// be removed from the Windows side at all (see the P1 fixture above).
removeLinkFixture()

await rm(root, { recursive: true, force: true })
// The exit code is the aggregate's only view of this suite: 2 is a SKIP (a fact
// that could not be measured here), which `verify-all` shows as SKIP rather than
// as a pass — the same contract `verify-fs-fence.mjs` uses for its own skips.
if (failures > 0) {
  console.log(`\n${failures} PRIMITIVE(S) DIFFER FROM THE ASSUMED PROFILE${skipped === 0 && skippedChecks === 0 ? '' : `, AND ${skipped} SHARE FACT(S) WERE NOT MEASURED${skippedChecks === 0 ? '' : ` AND ${skippedChecks} CHECK(S) WERE NOT EVALUATED`} (see the SKIP above)`}`)
} else if (skipped > 0 || skippedChecks > 0) {
  console.log(`\nTHE PROFILE MATCHES WHAT THE PROVIDER ASSUMES, BUT ${skipped} SHARE FACT(S) WERE NOT MEASURED${skippedChecks === 0 ? '' : ` AND ${skippedChecks} CHECK(S) WERE NOT EVALUATED`} — exit 2, so verify-all reports this suite as SKIP`)
} else {
  console.log('\nTHE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES')
}
if (facts.length > 0) {
  console.log(`${facts.length} share fact(s) recorded above${skipped === 0 ? '' : `, ${skipped} NOT measured (named in the SKIP above)`} — NOT assertions: the fence's answers to them are pinned in verify-fs-fence.mjs`)
}
process.exitCode = failures > 0 ? 1 : skipped > 0 || skippedChecks > 0 ? 2 : 0
