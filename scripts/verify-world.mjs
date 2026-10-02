/**
 * Standalone verification of the WSL world core.
 *
 * These modules import nothing from the harness, so they run under plain Node
 * outside the profile. This is the evidence for path translation and for
 * commands actually executing inside a distribution — the running Desktop host
 * caches plugin modules by URL and cannot reload them without a restart.
 *
 * Run: node scripts/verify-world.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { listDistros, defaultDistro, runWslShell, listLinuxDir, checkLinuxPath, resolveDistroHome, resolveLoginShell, defaultWorkspaceUnc, probeEvidence, hostExecutable, planWsl, buildWslExecArgv, decodeWslOutput } from '../lib/wsl/world.js'
import {
  parseWslUnc,
  joinWslUnc,
  windowsToMntPath,
  mntToWindowsPath,
  isWindowsPathShaped,
  shellQuote,
} from '../lib/wsl/paths.js'
import { detailText } from './detail.mjs'
import { blankLiterals } from './source-text.mjs'

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
}

/**
 * Resolve a home without letting a probe failure abort the suite.
 *
 * `resolveDistroHome` throws when the probe produces nothing, and that includes
 * a TRANSIENT `wsl.exe` failure — measured once in six full runs. An uncaught
 * throw there stops every check after it, so the outcome is reported instead: a
 * red check naming the reason beats a suite that silently truncates. An
 * INCONCLUSIVE probe — one that did not complete and answer — gets one retry
 * first, so the same transient does not turn into a red gate that says nothing
 * about the code under test.
 * @param {string} distro - distribution to resolve in.
 * @param {string} [user] - user to resolve, or the default user when omitted.
 * @returns {Promise<{ ok: boolean, attempts: number, value?: { user: string, home: string }, detail?: string }>} the outcome and how many probes it took.
 */
async function homeOf(distro, user) {
  const attempt = async () => {
    try {
      return { ok: true, value: await resolveDistroHome(distro, user) }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const first = await attempt()
  // `退出码 0` in the evidence is the probe saying "I ran and found nothing",
  // which is a conclusive answer about the user. Anything else — a non-zero code,
  // a timeout, no code at all — is the probe failing, and that is the transient.
  // `attempts` is reported so the retry can be asserted as a fact rather than
  // inferred from the message wording.
  if (first.ok || first.detail.includes('退出码 0')) return { ...first, attempts: 1 }
  const second = await attempt()
  if (second.ok) return { ...second, attempts: 2 }
  return { ok: false, attempts: 2, detail: `${second.detail}（重试一次后仍失败）` }
}

console.log('path translation')
check(
  'parseWslUnc splits a UNC workspace path',
  JSON.stringify(parseWslUnc('\\\\wsl.localhost\\example\\home\\user')) === JSON.stringify({ distro: 'example', linuxPath: '/home/user' }),
  parseWslUnc('\\\\wsl.localhost\\example\\home\\user'),
)
check('parseWslUnc accepts the wsl$ alias', parseWslUnc('\\\\wsl$\\Ubuntu\\srv')?.distro === 'Ubuntu')
check('parseWslUnc rejects a drive path', parseWslUnc('Q:\\work') === null)
check('joinWslUnc round-trips', parseWslUnc(joinWslUnc('example', '/home/user'))?.linuxPath === '/home/user')
check('joinWslUnc maps the root', joinWslUnc('example', '/') === '\\\\wsl.localhost\\example')
check('windowsToMntPath maps a drive', windowsToMntPath('Q:\\work\\x') === '/mnt/q/work/x')
check('mntToWindowsPath round-trips', mntToWindowsPath('/mnt/q/work/x') === 'Q:\\work\\x')
check('isWindowsPathShaped sees drive and UNC', isWindowsPathShaped('C:\\x') && isWindowsPathShaped('\\\\wsl.localhost\\d'))
check('shellQuote escapes an apostrophe', shellQuote("a'b") === `'a'\\''b'`)

console.log('\ndistribution discovery')
const distros = await listDistros()
check('at least one distribution is installed', distros.length > 0, distros)
console.log(`        distros: ${distros.join(', ')}`)
const fallback = await defaultDistro()
const distro = resolveDistro(fallback ?? distros[0])
const home = resolveLinuxHome(distro)
check('the selected distribution is installed', distros.includes(distro), { distro, distros })
console.log(`        running checks in: ${distro} as ${home}`)

console.log('\nexecution inside the distribution')
const identity = await runWslShell({
  distro,
  linuxCwd: home,
  command: 'uname -s; id -un; pwd; echo "$WSL_DISTRO_NAME"',
})
check('command exits 0', identity.exitCode === 0, identity.stderr)
const [kernel, user, cwd, insideDistro] = identity.stdout.trim().split('\n')
check('kernel is Linux', kernel === 'Linux', kernel)
check('pwd is the requested Linux directory', cwd === home, cwd)
check('WSL_DISTRO_NAME matches', insideDistro === distro, insideDistro)
console.log(`        user: ${user}`)
console.log(`        argv: ${identity.argv.slice(0, 8).join(' ')} …`)

// The repo's own drive mount, derived from this file's location — never a
// machine-specific literal drive letter.
const repoMount = windowsToMntPath(fileURLToPath(new URL('..', import.meta.url)))
const viaMount = await runWslShell({ distro, linuxCwd: repoMount ?? '/', command: 'pwd; ls -d /mnt/*' })
check('a Windows drive is addressable from the distribution', viaMount.exitCode === 0 && viaMount.stdout.includes('/mnt/'), viaMount.stderr)

console.log('\nhost commands reachable from inside the distribution')
const cmd = hostExecutable('cmd.exe')
check('a host executable resolves to its /mnt path', /^\/mnt\/[a-z]\/windows\/system32\/cmd\.exe$/i.test(String(cmd)), cmd)
const interop = await runWslShell({
  distro,
  linuxCwd: '/',
  // `appendWindowsPath = false` keeps cmd.exe off PATH, so interop needs the absolute path.
  command: `${cmd} /c "echo host-interop-ok"`,
})
check('cmd.exe runs through interop', interop.exitCode === 0 && interop.stdout.includes('host-interop-ok'), `exit=${String(interop.exitCode)} out=${JSON.stringify(interop.stdout)} err=${JSON.stringify(interop.stderr)}`)

console.log('\ndecoding: NUL-framed data vs UTF-16LE diagnostics')
// Two shapes share one decoder. The listing protocol frames every entry
// NUL-terminated, while wsl.exe emits its OWN diagnostics as UTF-16LE (a NUL
// high byte in most code units). A probe of 'contains any NUL' decoded a framed
// listing as UTF-16LE: the framing was destroyed and listLinuxDir returned []
// for EVERY directory — while this suite stayed green, because its listing
// assertion was only Array.isArray(entries), and [] is an array.
const framedBytes = Buffer.from('d\talpha\0f\tbeta\0', 'utf8')
check('NUL-framed UTF-8 data is not mistaken for UTF-16LE',
  decodeWslOutput(framedBytes).split('\0').filter((chunk) => chunk.includes('\t')).length === 2,
  JSON.stringify(decodeWslOutput(framedBytes)))
const utf16Diagnostic = 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
check('UTF-16LE diagnostics still decode',
  decodeWslOutput(Buffer.from(utf16Diagnostic, 'utf16le')) === utf16Diagnostic,
  JSON.stringify(decodeWslOutput(Buffer.from(utf16Diagnostic, 'utf16le'))))
// The class the UTF-16LE fallback actually counts. Its predicate tests
// `buffer[i + 1] === 0` with no constraint on the LOW byte, so EVERY code unit below
// U+0100 counts — Latin-1 included, not only ASCII. The doc said "only ASCII code
// units contribute a NUL high byte", which understated the class; the real one is
// pinned by DECODING a Latin-1-only buffer, not by reading the sentence.
const latin1Only = '\u00e9\u00e9\u00e9\u00e9\u00ff\u00ff'
check('a Latin-1-only UTF-16LE buffer is read as UTF-16LE (the class is U+0100, not ASCII)',
  decodeWslOutput(Buffer.from(latin1Only, 'utf16le')) === latin1Only,
  JSON.stringify(decodeWslOutput(Buffer.from(latin1Only, 'utf16le'))))
const nulFramedAscii = 'alpha.txt\u0000beta.txt\u0000'
check('the control: NUL-framed ASCII data is NOT read as UTF-16LE',
  decodeWslOutput(Buffer.from(nulFramedAscii, 'utf8')) === nulFramedAscii,
  JSON.stringify(decodeWslOutput(Buffer.from(nulFramedAscii, 'utf8'))))
const missingDistro = await runWslShell({ distro: 'dsh-wsl-no-such-distro', linuxCwd: '/', command: 'true', loginShell: false, timeoutMs: 30_000 })
check('a wsl.exe-level failure decodes to readable text, not mojibake',
  missingDistro.exitCode !== 0 && /Wsl\/Service|WSL_E_/i.test(missingDistro.stdout + missingDistro.stderr),
  JSON.stringify((missingDistro.stdout + missingDistro.stderr).slice(0, 160)))

console.log('\ndirectory facts')
// Both directory probes are UNIQUE TO THIS PROCESS. They were machine-global
// (`<home>/dsh-wsl-listing-probe`, `<home>/dsh-wsl-short-probe`), the class
// verify-9p.mjs and verify-confinement.mjs were fixed for: each run opens with an
// `rm -rf` and closes with another, so two runs overlapping in time delete each other's
// fixture — and the check that reddens then is this suite's, on a healthy tree. What the
// assertions depend on is the PREFIX (a directory under the session home) and the
// CONTENT (two entries, one-character names), never the full name, so the pid costs them
// nothing. A fourth instance of this class was found in verify-route.mjs and
// verify-post-restart.mjs while fixing this one; those are recorded in
// verify-all-skip.mjs's KNOWN_FIXED_SCRATCH, because they are LIVE suites whose fix
// cannot be verified without the desktop host.
const runSuffix = process.pid
const listingProbe = `${home}/dsh-wsl-listing-probe-${runSuffix}`
await runWslShell({ distro, linuxCwd: '/', command: 'rm -rf ' + listingProbe + ' && mkdir -p ' + listingProbe + ' && touch ' + listingProbe + '/alpha.txt && mkdir ' + listingProbe + '/beta' })
const listing = await listLinuxDir(distro, listingProbe)
check('listing returns the requested path', listing.path === listingProbe, listing.path)
check('listing recovers every entry, with its kind',
  listing.entries.length === 2
    && listing.entries.some((entry) => entry.name === 'alpha.txt' && entry.kind === 'file')
    && listing.entries.some((entry) => entry.name === 'beta' && entry.kind === 'directory'),
  listing)
await runWslShell({ distro, linuxCwd: '/', command: 'rm -rf ' + listingProbe })
// One-character names are the case that defeats a NUL-vs-UTF-16LE heuristic:
// the payload becomes 'f\ta\0f\tb\0', where every NUL sits on exactly the byte
// positions UTF-16LE uses, so a majority test accepts it and the framing is
// destroyed. The listing protocol must not depend on that guess.
const shortProbe = `${home}/dsh-wsl-short-probe-${runSuffix}`
await runWslShell({ distro, linuxCwd: '/', command: 'rm -rf ' + shortProbe + ' && mkdir -p ' + shortProbe + ' && touch ' + shortProbe + '/a ' + shortProbe + '/b ' + shortProbe + '/c' })
const shortListing = await listLinuxDir(distro, shortProbe)
check('a directory of one-character names still lists every entry',
  shortListing.entries.length === 3 && ['a', 'b', 'c'].every((name) => shortListing.entries.some((entry) => entry.name === name && entry.kind === 'file')),
  shortListing)
await runWslShell({ distro, linuxCwd: '/', command: 'rm -rf ' + shortProbe })
const homeListing = await listLinuxDir(distro, home)
check('the user home lists without error', homeListing.path === home && Array.isArray(homeListing.entries), homeListing)
console.log('        ' + homeListing.entries.length + ' entries in ' + home + '; first: ' + homeListing.entries.slice(0, 5).map((e) => e.name + '(' + e.kind[0] + ')').join(' '))
const facts = await checkLinuxPath(distro, home)
check('an existing directory is reported as a directory', facts.isDirectory === true, facts)
const missing = await checkLinuxPath(distro, '/definitely-not-here-xyz')
check('a missing path is reported missing', missing.exists === false, missing)

console.log('\nsubprocess argv translation')
const execPlan = planWsl(home, distro)
const execArgv = buildWslExecArgv(execPlan, ['bash', '-lc', 'pwd'])
check('the argv starts with the distribution selector', execArgv[0] === 'wsl.exe' && execArgv[1] === '-d' && execArgv[2] === distro, execArgv)
check('the Linux working directory becomes --cd', execArgv.includes('--cd') && execArgv[execArgv.indexOf('--cd') + 1] === home, execArgv)
check('the program is executed without a re-parsing shell', execArgv[execArgv.indexOf('--cd') + 2] === '-e', execArgv)
const execRun = spawnSync(execArgv[0], execArgv.slice(1), { encoding: 'utf8', cwd: process.env.SystemRoot ?? process.cwd() })
check('the translated argv runs the program in the distribution', execRun.status === 0 && execRun.stdout.trim() === home, `status=${execRun.status} out=${JSON.stringify(execRun.stdout)} err=${JSON.stringify(execRun.stderr)}`)
const identityArgv = buildWslExecArgv(execPlan, ['bash', '-lc', 'printf "%s\\n" "$@"', '--', 'one two', 'three'])
const identityRun = spawnSync(identityArgv[0], identityArgv.slice(1), { encoding: 'utf8', cwd: process.env.SystemRoot ?? process.cwd() })
check('an argument containing spaces stays one argument', identityRun.stdout.includes('one two'), identityRun.stdout)
const bareName = spawnSync(execArgv[0], buildWslExecArgv(execPlan, ['echo', 'bare-name']).slice(1), { encoding: 'utf8', cwd: process.env.SystemRoot ?? process.cwd() })
check('a bare name resolves against the distribution PATH', bareName.status === 0 && bareName.stdout.includes('bare-name'), `status=${bareName.status} err=${bareName.stderr}`)

console.log('\nhome resolution')
const resolved = await homeOf(distro)
check("the default user's home resolves to an absolute Linux path",
  resolved.ok && resolved.value.user.length > 0 && resolved.value.home.startsWith('/'),
  resolved.detail ?? resolved.value)
const byName = resolved.ok ? await homeOf(distro, resolved.value.user) : { ok: false, detail: 'the default user did not resolve' }
check('resolving an explicit user matches the default-user resolution',
  byName.ok && resolved.ok && byName.value.user === resolved.value.user && byName.value.home === resolved.value.home,
  byName.detail ?? byName.value)

// The failure path, deterministically: a distribution that does not exist makes
// the probe itself fail, so the message must carry the probe's own evidence.
// Without it "wsl.exe blipped" and "the user really is absent" read exactly the
// same — which is how one transient failure in a full run looked like a code
// defect until the probe was repeated by hand.
// The evidence is built by a pure function, so the cases a distribution cannot
// be made to produce on demand are tested directly.
check('a timed-out probe names the timeout rather than a missing code',
  probeEvidence({ exitCode: null, stderr: '', timedOut: true }).includes('探针超时'),
  probeEvidence({ exitCode: null, stderr: '', timedOut: true }))
check('a probe that reported no code at all says so',
  probeEvidence({ exitCode: null, stderr: '', timedOut: false }).includes('探针未正常退出'),
  probeEvidence({ exitCode: null, stderr: '', timedOut: false }))
check('a successful probe carries its stderr when there is one',
  probeEvidence({ exitCode: 0, stderr: 'some warning', timedOut: false }).includes('stderr: some warning'),
  probeEvidence({ exitCode: 0, stderr: 'some warning', timedOut: false }))

const absent = await homeOf('dsh-wsl-no-such-distro', 'root')
check('an unresolvable home is reported, not thrown',
  absent.ok === false && typeof absent.detail === 'string' && absent.detail.length > 0, absent)
// Distinguishability is the property the evidence exists for, so that is what is
// pinned — not the presence of two words. A message that printed a fixed code
// would satisfy the wording while making the two causes identical again.
const absentUser = await homeOf(distro, 'definitely-no-such-user-xyz')
check('an unresolvable home reports the probe evidence, not just a guess',
  absent.ok === false && absent.detail.includes('探针') && absent.detail.includes('退出码'), absent.detail)
// The attempt COUNT is the property; the wording is only how it is reported. A
// message that printed the retry phrase without retrying would satisfy a word
// match, which is the same weakness this suite already had to fix twice.
check('an inconclusive probe is retried before it is reported',
  absent.ok === false && absent.attempts === 2, `attempts=${String(absent.attempts)} ${String(absent.detail)}`)
check('a failed probe and an absent user do not read the same',
  absent.ok === false && absentUser.ok === false
  && absentUser.detail.includes('退出码 0')
  && !absent.detail.includes('退出码 0'),
  `failed probe: ${absent.detail}\n        absent user: ${absentUser.detail}`)

console.log('\nthe documented probe policy: a 60s ceiling and one retry after a timeout')
// README.md states the policy for exactly these probes: 探针超时 60s + 超时后一次透明重试 ——
// 桌面重启后的首个 wsl.exe 冷启动可以超过短上限 —— and it names listLinuxDir, checkLinuxPath
// and resolveDistroHome in the same sentence. The confinement and PTY probes implemented it
// (resolveIdentity / detectRunner / noNewPrivs / python3); these three did not, so a wsl.exe
// stall longer than their 30s ceiling threw straight out of checkLinuxPath into lib/index.js's
// workspaceFlow — ONE throw that the acceptance suite then reported as FOUR red rows, including
// 'the dialog's directory listing works', whose own step had already answered. The stall is not
// hypothetical: measured on this machine as 无法检查 /：（探针超时） after 30.4s and 30.5s on two
// consecutive calls while the shared VM ran at load ~11 with its swap 95% full — and the same
// transient was already recorded in this suite's own history as 'measured once in six full runs'.
//
// The policy is asserted BEHAVIOURALLY, through the injected runner: a probe that times out must
// be repeated exactly once, and the answer must come from the repeat. A source pin on the
// timeoutMs value would be satisfied by a probe that never retried.
const timedOutProbe = { exitCode: null, stdout: '', stderr: '', timedOut: true }
/**
 * A runner that replays scripted outcomes and records every request it was handed.
 * @param {Array<object|Error>} outcomes - one outcome per call, in order.
 * @returns {{ run: (options: object) => Promise<object>, calls: object[] }} the runner and its requests.
 */
function scriptedRunner(outcomes) {
  const calls = []
  return {
    calls,
    run: async (options) => {
      calls.push(options)
      const next = outcomes.shift()
      if (next === undefined) throw new Error('scriptedRunner: no outcome left for this call')
      if (next instanceof Error) throw next
      return next
    },
  }
}
/**
 * Run one scripted probe and report its outcome instead of throwing.
 *
 * These checks exist to redden a MISSING retry, and a missing retry is exactly what
 * makes the call throw — so an uncaught throw here would kill the suite before it
 * printed the row that names the defect (the same reason `homeOf` above reports its
 * outcome rather than letting a transient abort every check after it).
 * @param {() => Promise<object>} work - the probe to run.
 * @returns {Promise<object>} the value, or `{ error }` when it threw.
 */
async function settle(work) {
  try {
    return await work()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
const pathRetry = scriptedRunner([timedOutProbe, { exitCode: 0, stdout: 'dir\n', stderr: '', timedOut: false }])
const pathFacts = await settle(() => checkLinuxPath(distro, '/', { run: pathRetry.run }))
check('checkLinuxPath repeats a timed-out probe exactly once and answers from the repeat',
  pathRetry.calls.length === 2 && pathFacts.isDirectory === true,
  { calls: pathRetry.calls.length, facts: pathFacts })
check('checkLinuxPath asks for the documented 60s ceiling',
  pathRetry.calls.every((call) => call.timeoutMs === 60_000),
  pathRetry.calls.map((call) => call.timeoutMs))
// The listing's own protocol is NUL-framed and raw, so the scripted answer is a Buffer exactly
// as runWslShell returns one: a string here would pass through toString('utf8') unchanged and
// stop testing the framing.
const listingRetry = scriptedRunner([
  timedOutProbe,
  { exitCode: 0, stdout: Buffer.from('f\talpha.txt\0d\tbeta\0', 'utf8'), stderr: '', timedOut: false },
])
const listingFacts = await settle(() => listLinuxDir(distro, '/', { run: listingRetry.run }))
check('listLinuxDir repeats a timed-out probe exactly once and answers from the repeat',
  listingRetry.calls.length === 2 && listingFacts.entries.length === 2
  && listingFacts.entries.some((entry) => entry.name === 'alpha.txt' && entry.kind === 'file'),
  { calls: listingRetry.calls.length, facts: listingFacts })
check('listLinuxDir asks for the documented 60s ceiling and keeps its raw framing',
  listingRetry.calls.every((call) => call.timeoutMs === 60_000 && call.raw === true),
  listingRetry.calls.map((call) => ({ timeoutMs: call.timeoutMs, raw: call.raw })))
// resolveDistroHome makes TWO probes and either can stall: the login-name probe before the
// getent one, and the getent probe itself. Both halves are pinned separately, because a retry
// added to only the first would leave the second exactly the stall it always was.
const userProbeRetry = scriptedRunner([
  timedOutProbe,
  { exitCode: 0, stdout: 'zcluo\n', stderr: '', timedOut: false },
  { exitCode: 0, stdout: '/home/zcluo\n', stderr: '', timedOut: false },
])
const userProbeFacts = await settle(() => resolveDistroHome(distro, undefined, { run: userProbeRetry.run }))
// The repeated request must be the SAME probe, so the assertion is on the commands, not only
// on the count: 'id -un' twice and then the home probe once, with the user coming from the
// repeat. A retry that asked a different question would satisfy a bare count.
const userProbeCommands = userProbeRetry.calls.map((call) => call.command)
check('resolveDistroHome repeats a timed-out login-name probe exactly once',
  userProbeRetry.calls.length === 3
  && userProbeCommands[0] === 'id -un' && userProbeCommands[1] === 'id -un'
  && userProbeFacts.user === 'zcluo',
  { calls: userProbeRetry.calls.length, commands: userProbeCommands, facts: userProbeFacts })
const homeProbeRetry = scriptedRunner([
  { exitCode: 0, stdout: 'zcluo\n', stderr: '', timedOut: false },
  timedOutProbe,
  { exitCode: 0, stdout: '/home/zcluo\n', stderr: '', timedOut: false },
])
const homeProbeFacts = await settle(() => resolveDistroHome(distro, undefined, { run: homeProbeRetry.run }))
const homeProbeCommands = homeProbeRetry.calls.map((call) => call.command)
check('resolveDistroHome repeats a timed-out home probe exactly once and answers from the repeat',
  homeProbeRetry.calls.length === 3
  && homeProbeCommands[0] === 'id -un'
  && homeProbeCommands[1] === homeProbeCommands[2] && homeProbeCommands[1] !== 'id -un'
  && homeProbeFacts.home === '/home/zcluo',
  { calls: homeProbeRetry.calls.length, commands: homeProbeCommands, facts: homeProbeFacts })
check('resolveDistroHome asks for the documented 60s ceiling on both probes',
  homeProbeRetry.calls.every((call) => call.timeoutMs === 60_000),
  homeProbeRetry.calls.map((call) => call.timeoutMs))
// The retry must not launder a persistent stall into an answer: two timeouts still throw, and
// the message still carries the probe's own evidence rather than a guess about the path.
let twiceTimedOut = ''
try {
  await checkLinuxPath(distro, '/', { run: scriptedRunner([timedOutProbe, timedOutProbe]).run })
} catch (error) {
  twiceTimedOut = error instanceof Error ? error.message : String(error)
}
check('a probe that times out twice still fails loudly, naming the timeout',
  twiceTimedOut.includes('探针超时') && twiceTimedOut.includes('/'),
  twiceTimedOut || '(no error was thrown — a persistent stall was reported as an answer)')
console.log('\nthe selftest default workspace (the default PATH has to be exercised, not assumed)')
// Finding 2. `resolveDistroHome(undefined, ...)` cannot run at all: wsl.exe cannot
// be handed an undefined distribution name, so the expression the selftest default
// used threw before any probe — and the {user, home} object that call would have
// returned is not a path while resolveLocation requires a non-empty string. Both
// legs are pinned, and then the REPLACEMENT is exercised for real: a default that
// no suite ever resolves is exactly how the old one stayed broken while every suite
// passed, because they all pass cwd.
let undefinedDistroError = ''
try {
  await resolveDistroHome(undefined, undefined)
} catch (error) {
  undefinedDistroError = error instanceof Error ? error.message : String(error)
}
check('resolveDistroHome(undefined, ...) refuses before any probe (the distribution name is validated)',
  /非法的发行版名/.test(undefinedDistroError), { error: undefinedDistroError })
// The host half is not importable here (its harness dependencies are absent, which is
// why verify-modules SKIPs that import), so the selftest default is pinned as SOURCE —
// over comment- and literal-blanked text, because the fixed line's own comment names
// the old expression and a raw match would have been satisfied by that comment.
const indexRaw = await readFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
const indexCode = blankLiterals(indexRaw)
const resolveLocationAt = indexCode.indexOf('async function resolveLocation')
const resolveLocationRawAt = indexRaw.indexOf('async function resolveLocation')
check('resolveLocation refuses a non-string location (so the old default had two ways to die)',
  resolveLocationAt >= 0
    && /typeof location !== (?:''|'string')/.test(indexCode.slice(resolveLocationAt, resolveLocationAt + 700))
    && resolveLocationRawAt >= 0
    && /缺少路径/.test(indexRaw.slice(resolveLocationRawAt, resolveLocationRawAt + 700)),
  { blanked: indexCode.slice(resolveLocationAt, resolveLocationAt + 200), raw: indexRaw.slice(resolveLocationRawAt, resolveLocationRawAt + 200) })
check('index.js no longer hands an undefined distribution to resolveDistroHome',
  /resolveDistroHome\(undefined/.test(indexCode) === false,
  indexCode.slice(Math.max(0, indexCode.indexOf('defaultWorkspaceUnc') - 200), indexCode.indexOf('defaultWorkspaceUnc') + 200))
check('index.js builds its selftest default from defaultWorkspaceUnc()',
  /defaultWorkspaceUnc\(/.test(indexCode), indexCode.slice(Math.max(0, indexCode.indexOf('selftest') - 100), indexCode.indexOf('selftest') + 400))
// The default itself, called for real. A probe failure is REPORTED rather than thrown,
// so one transient does not stop every check after it (the same ruling homeOf() makes).
const defaultOutcome = await (async () => {
  try {
    return { ok: true, value: await defaultWorkspaceUnc() }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
})()
const defaultWorkspace = defaultOutcome.ok ? defaultOutcome.value : null
check('the default workspace resolves through the DEFAULT distribution, not an undefined name',
  defaultWorkspace !== null && typeof defaultWorkspace.distro === 'string' && defaultWorkspace.distro === await defaultDistro(),
  defaultOutcome.detail ?? defaultWorkspace)
const defaultHome = defaultWorkspace === null ? null : (await homeOf(defaultWorkspace.distro)).value ?? null
check('its Linux path is that distribution home',
  defaultWorkspace !== null && defaultHome !== null && defaultWorkspace.linuxPath === defaultHome.home,
  { linuxPath: defaultWorkspace?.linuxPath, home: defaultHome?.home })
const parsedDefault = defaultWorkspace === null ? null : parseWslUnc(defaultWorkspace.uncPath)
check('its UNC spelling round-trips to the same distribution and path',
  defaultWorkspace !== null && parsedDefault !== null
    && parsedDefault.distro === defaultWorkspace.distro && parsedDefault.linuxPath === defaultWorkspace.linuxPath,
  { uncPath: defaultWorkspace?.uncPath, parsed: parsedDefault })
check('the default is not under /tmp (the fence refuses a workspace rooted there)',
  defaultWorkspace !== null && defaultWorkspace.linuxPath.startsWith('/tmp') === false,
  defaultWorkspace?.linuxPath)
// The point of the finding: this default is USED, so it has to be usable — a
// directory that really exists and lists.
const defaultListing = defaultWorkspace === null ? null : await listLinuxDir(defaultWorkspace.distro, defaultWorkspace.linuxPath)
check('the default workspace is a real, listable directory in that distribution',
  defaultListing !== null && defaultListing.entries.length > 0,
  { path: defaultListing?.path, entries: defaultListing?.entries.length })

console.log('\nthe configured wsl.exe path reaches every spawn site')
// Finding 4. buildWslExecArgv honoured `options.wslPath` while runWslShell and
// listDistros spawned the literal 'wsl.exe' — and so did every probe. The proof is
// mechanical: point the configured path at a file that does not exist. A site that
// honours the configuration must FAIL; a site that ignores it keeps working, which is
// the split brain the finding describes (working spawns, failing probes, confined
// modes ending in SandboxUnavailableError).
const bogusWsl = join(tmpdir(), 'dsh-wsl-no-such-wsl.exe')
/** Resolve one promise into an outcome instead of throwing. */
const attempt = async (work) => {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
const bogusRun = await attempt(() => runWslShell({ distro, linuxCwd: '/', command: 'echo should-not-run', loginShell: false, timeoutMs: 30_000, wslPath: bogusWsl }))
check('runWslShell FAILS on a configured path that does not exist', bogusRun.ok === false, bogusRun)
const defaultRun = await attempt(() => runWslShell({ distro, linuxCwd: '/', command: 'echo __WSLPATH_OK__', loginShell: false, timeoutMs: 60_000 }))
check('the control: the default path still runs the command',
  defaultRun.ok === true && defaultRun.value.stdout.includes('__WSLPATH_OK__'), defaultRun)
check('and reports argv[0] as the executable it used',
  defaultRun.ok === true && defaultRun.value.argv[0] === 'wsl.exe',
  defaultRun.ok ? { argv: defaultRun.value.argv.slice(0, 2) } : defaultRun)
const namedRun = await attempt(() => runWslShell({ distro, linuxCwd: '/', command: 'echo hi', loginShell: false, timeoutMs: 60_000, wslPath: 'wsl.exe' }))
check('an explicitly configured wsl.exe is reported as argv[0]',
  namedRun.ok === true && namedRun.value.argv[0] === 'wsl.exe',
  namedRun.ok ? { argv: namedRun.value.argv.slice(0, 2) } : namedRun)
const bogusList = await attempt(() => listDistros({ wslPath: bogusWsl }))
check('listDistros FAILS on a configured path that does not exist', bogusList.ok === false, bogusList)
const realList = await attempt(() => listDistros())
check('listDistros with no argument still lists this machine',
  realList.ok === true && Array.isArray(realList.value) && realList.value.length > 0, realList)
// The half that broke the confined modes: the probes. Each is named individually,
// so a failure detail says WHICH probe kept ignoring the configuration.
const probeRows = [
  ['resolveDistroHome', () => resolveDistroHome(distro, undefined, { wslPath: bogusWsl })],
  ['listLinuxDir', () => listLinuxDir(distro, '/', { wslPath: bogusWsl })],
  ['checkLinuxPath', () => checkLinuxPath(distro, '/', { wslPath: bogusWsl })],
  ['resolveLoginShell', () => resolveLoginShell(distro, undefined, { wslPath: bogusWsl })],
  ['defaultWorkspaceUnc', () => defaultWorkspaceUnc({ wslPath: bogusWsl })],
]
for (const [name, work] of probeRows) {
  const row = await attempt(work)
  check(`${name} FAILS on a configured path that does not exist`, row.ok === false, row)
}
console.log('\nthe configured path is threaded at every call site (source pins, comments blanked)')
/** One lib file, with comment and string bodies blanked: a pin must read CODE, not prose about it. */
const readBlanked = async (relative) => blankLiterals(await readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8'))
const shellCode = await readBlanked('lib/wsl/shell.js')
check('shell.js threads its config wslPath into the probe runner',
  /runWslShell\(\{ \.\.\.options, wslPath: this\.config\.wslPath \}\)/.test(shellCode),
  shellCode.slice(Math.max(0, shellCode.indexOf('probeOptions') - 100), shellCode.indexOf('probeOptions') + 300))
check('index.js configures a wsl.exe path',
  /wslPath: z\.string\(\)\.default\(''\)/.test(indexCode) && /wslPath: z\.string\(\)\.default\('wsl\.exe'\)/.test(indexRaw),
  indexCode.slice(Math.max(0, indexCode.indexOf('wslPath:') - 80), indexCode.indexOf('wslPath:') + 120))
check('index.js keeps the configured path where the route methods read it',
  /routeWslPath = config\.wslPath/.test(indexCode),
  indexCode.slice(Math.max(0, indexCode.indexOf('routeWslPath') - 80), indexCode.indexOf('routeWslPath') + 200))
// Per SITE, not a total: a total cannot tell which site lost the option, and a
// threshold lets one site drop out while the number stays high. The price is stated
// rather than hidden: ADDING a probe site has to add its row here, or this check
// reddens — which is the intent, because a new site without the option is exactly
// the defect this pins.
const countOf = (pattern) => (indexCode.match(pattern) ?? []).length
const indexSites = [
  ['listDistros', /listDistros\(\{ wslPath: routeWslPath \}\)/g, 1],
  ['listLinuxDir', /listLinuxDir\([^)]*\{ wslPath: routeWslPath \}\)/g, 2],
  ['checkLinuxPath', /checkLinuxPath\([^)]*\{ wslPath: routeWslPath \}\)/g, 3],
  ['resolveDistroHome', /resolveDistroHome\([^)]*\{ wslPath: routeWslPath \}\)/g, 1],
  ['defaultWorkspaceUnc', /defaultWorkspaceUnc\(\{ wslPath: routeWslPath \}\)/g, 1],
  ['execInWsl runWslShell', /wslPath: routeWslPath,\s*\n\s*\}\)/g, 1],
]
check('index.js passes the configured path at every probe site',
  indexSites.every(([, pattern, want]) => countOf(pattern) === want),
  { sites: indexSites.map(([name, pattern, want]) => `${name}=${countOf(pattern)}/${want}`) })
const subprocessCode = await readBlanked('lib/wsl/subprocess.js')
// Anchored on the LOOKUP's own request literal and the call that consumes it, not on "the
// first `runWslShell(`": the lookup now builds its options once and hands that object to an
// `ask` closure (so a repeat repeats the SAME request), which moved the call site away from
// the options it carries. The assertion is strictly stronger than the positional one it
// replaces: the configured path must be INSIDE the request literal, and runWslShell must be
// handed that very object.
const lookupRequestAt = subprocessCode.indexOf('const request = {')
const lookupAskAt = subprocessCode.indexOf('const ask = ()')
check('subprocess.js threads it into the executable-lookup probe',
  lookupRequestAt >= 0 && lookupAskAt > lookupRequestAt
  && /wslPath: this\.config\.wslPath/.test(subprocessCode.slice(lookupRequestAt, lookupAskAt))
  && /const ask = \(\) => runWslShell\(request\)/.test(subprocessCode),
  subprocessCode.slice(lookupRequestAt, lookupAskAt + 120) || subprocessCode.slice(0, 400))
const loginShellCalls = (subprocessCode.match(/resolveLoginShell\(plan\.distro, this\.config\.username, \{ wslPath: this\.config\.wslPath \}\)/g) ?? []).length
check('subprocess.js threads it into both resolveLoginShell calls',
  loginShellCalls >= 2, { loginShellCalls })

// The executable lookup is the FOURTH probe the documented sentence names (README.md:132 /
// README.en.md:132 — 探针超时 60s + 超时后一次透明重试), and it is output-parsed: its empty
// answer is read below as "no such executable", a class the terminal controller catches to
// SKIP a shell candidate. Its policy is a SOURCE pin, like the shell.js rows above, because
// subprocess.js imports @deepseek-ai/* — unresolvable in this checkout, so no executor-level
// check is constructible. A source pin is weak on purpose here; the mutation recorded with it
// is what shows the pin is not a constant.
const lookupCeiling = /const LOOKUP_TIMEOUT_MS = 60_000/.test(subprocessCode)
const lookupRetry = /const ask = \(\) => runWslShell\(request\)/.test(subprocessCode)
  && /let result = await ask\(\)\s*\n\s*if \(result\.timedOut === true\) result = await ask\(\)/.test(subprocessCode)
check('subprocess.js gives the executable lookup the documented 60s ceiling',
  lookupCeiling,
  subprocessCode.slice(Math.max(0, subprocessCode.indexOf('LOOKUP_TIMEOUT_MS') - 260), subprocessCode.indexOf('LOOKUP_TIMEOUT_MS') + 60))
check('subprocess.js repeats the SAME executable lookup once, and only on a timeout',
  lookupRetry,
  subprocessCode.slice(Math.max(0, subprocessCode.indexOf('const ask =') - 120), subprocessCode.indexOf('const ask =') + 320))
const ptyCode = await readBlanked('lib/wsl/pty.js')
check('pty.js threads it into the bridge-runtime probe',
  /\.\.\.options\.wslPath !== undefined && options\.wslPath !== '' \? \{ wslPath: options\.wslPath \} : \{\}/.test(ptyCode),
  ptyCode.slice(Math.max(0, ptyCode.indexOf('requireBridgeRuntime') - 100), ptyCode.indexOf('requireBridgeRuntime') + 500))
console.log('\nexec-boundary validation')
let threw = false
try {
  runWslShell({ distro: 'x -u root', linuxCwd: '/', command: 'true' })
} catch {
  threw = true
}
check('a separator-bearing distro is rejected before any spawn', threw)
threw = false
try {
  buildWslExecArgv({ distro: 'x', linuxCwd: '/' }, ['id'], { username: 'u\n-w' })
} catch {
  threw = true
}
check('a separator-bearing username is rejected before any spawn', threw)
threw = false
try {
  runWslShell({ distro: '../escape', linuxCwd: '/', command: 'true' })
} catch {
  threw = true
}
check('a traversal-shaped distro is rejected before any spawn', threw)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
