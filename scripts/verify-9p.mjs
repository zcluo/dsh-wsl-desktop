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
 * Run: node scripts/verify-9p.mjs [distro]
 */

import { mkdir, writeFile, link, rename, realpath, stat, rm, readFile, readdir, copyFile, chmod, constants } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { canonicalHostPath, isUnderHost } from '../lib/wsl/fence.js'
import { resolveDistro, resolveOtherDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro(process.argv[2])
const root = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-9p-probe`

let failures = 0

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

try {
  await writeFile(join(root, 'replace-me.txt'), 'old\n', 'utf8')
  await writeFile(join(root, 'replacement.txt'), 'new\n', 'utf8')
  await rename(join(root, 'replacement.txt'), join(root, 'replace-me.txt'))
  const after = await readFile(join(root, 'replace-me.txt'), 'utf8')
  probe('rename replaces an existing file (overwrite publication)', after === 'new\n', 'available', JSON.stringify(after))
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
// one). wsl.exe is the call a cold VM start can hang, so both calls are bounded
// and a fixture failure is reported as UNMEASURED: the fixture is this probe's,
// not the suite's precondition.
const WSL_TIMEOUT_MS = 30_000
const linkScratchLinux = '/tmp/dsh-wsl-9p-probe-link'
const linkScratch = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-9p-probe-link`
const linkFixture = `${linkScratch}\\root`
const linkOutside = `${linkScratch}\\outside`
const linkEntry = `${linkFixture}\\escape`
const linkOutsideLinux = `${linkScratchLinux}/outside`
const linkEntryLinux = `${linkScratchLinux}/root/escape`

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
  fact('a Linux symlink inside a fixture root', `UNMEASURED - the fixture could not be built (${linkProblem})`)
} else {
  const listed = (await readdir(linkFixture)).includes('escape')
  identityCheck('the symlink the probe created is listed by the share, so the answers below are about a link that exists',
    listed === true, `readdir(${linkFixture}) did not list "escape"`)
  let targetRead = ''
  let targetReadable = false
  try {
    targetRead = (await readFile(`${linkOutside}\\inside.txt`, 'utf8')).trim()
    targetReadable = true
  } catch (error) {
    targetRead = `${error.code} ${error.message}`
  }
  probe("the control: the link's own target is readable at its real path", targetReadable, 'available', targetRead)
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
    fact('realpath / read of the link (the file behind it exists)',
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
    identityCheck('realpath cannot see the link, so the share must not resolve it for create either',
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
    fact('a rename whose destination traverses the link',
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
    fact('mkdir through the link, at a spelling the share resolves elsewhere',
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
    identityCheck('the fence refuses the target its own canonicalization produces for that spelling',
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
let otherDistro = ''
let otherProblem = ''
try {
  const resolved = resolveOtherDistro(distro)
  if (resolved === undefined) otherProblem = `no distribution other than "${distro}" is installed`
  else if (resolved.toLowerCase() === distro.toLowerCase()) otherProblem = `the resolved second distribution is "${distro}" itself, so every row would compare the share with itself`
  else otherDistro = resolved
} catch (error) {
  otherProblem = String(error?.message ?? error)
}
if (otherDistro === '') {
  fact('cross-share identity', `UNMEASURED - ${otherProblem}`)
} else {
  for (const linuxPath of ['/', '/tmp', '/home']) {
    const label = linuxPath === '/' ? '<share root>' : linuxPath
    const spell = (name) => linuxPath === '/' ? `\\\\wsl.localhost\\${name}` : `\\\\wsl.localhost\\${name}${linuxPath.split('/').join('\\')}`
    try {
      const [here, there] = await Promise.all([
        stat(spell(distro), { bigint: true }),
        stat(spell(otherDistro), { bigint: true }),
      ])
      const same = here.dev === there.dev && here.ino === there.ino
      fact(`cross-share identity ${label}`,
        `${distro} (${here.dev},${here.ino}) vs ${otherDistro} (${there.dev},${there.ino}) -> ${same ? 'COLLIDES - the identity comparison cannot tell the two shares apart' : 'distinct'}`)
    } catch (error) {
      fact(`cross-share identity ${label}`, `UNMEASURED - ${error.code}`)
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
console.log(`\n${failures === 0 ? 'THE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES' : `${failures} PRIMITIVE(S) DIFFER FROM THE ASSUMED PROFILE`}`)
if (facts.length > 0) {
  console.log(`${facts.length} share fact(s) recorded above — NOT assertions: the fence's answers to them are pinned in verify-fs-fence.mjs`)
}
process.exitCode = failures === 0 ? 0 : 1
