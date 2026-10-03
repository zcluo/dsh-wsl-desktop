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
import { LoginShellUnresolvedError, listDistros, defaultDistro, runWslShell, listLinuxDir, checkLinuxPath, resolveDistroHome, resolveLoginShell, defaultWorkspaceUnc, probeEvidence, hostExecutable, planWsl, buildWslExecArgv, decodeWslOutput } from '../lib/wsl/world.js'
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
/**
 * Run one scripted probe and return the THROWN OBJECT, or the value.
 *
 * `settle` above reports a message, which is all a row needs to show that a failure
 * happened. A row whose claim IS the type of that failure needs the object: `instanceof`
 * cannot be read off a string, and "a plain Error is not enough" is a claim about the
 * object alone.
 * @param {() => Promise<object>} work - the probe to run.
 * @returns {Promise<{ value?: object, thrown?: unknown }>} the value, or the throwable.
 */
async function rejection(work) {
  try {
    return { value: await work() }
  } catch (thrown) {
    return { thrown }
  }
}
const pathRetry = scriptedRunner([timedOutProbe, { exitCode: 0, stdout: 'dir\n', stderr: '', timedOut: false }])
const pathFacts = await settle(() => checkLinuxPath(distro, '/', { run: pathRetry.run }))
check('checkLinuxPath repeats a timed-out probe exactly once and answers from the repeat',
  pathRetry.calls.length === 2 && pathFacts.isDirectory === true,
  { calls: pathRetry.calls.length, facts: pathFacts })
// The count is asserted WITH the ceiling: `[].every(…)` is true, so a probe that asked the
// runner for nothing at all would satisfy a bare `.every` while claiming it asked for 60s.
check('checkLinuxPath asks for the documented 60s ceiling, on both attempts',
  pathRetry.calls.length === 2 && pathRetry.calls.every((call) => call.timeoutMs === 60_000),
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
check('listLinuxDir asks for the documented 60s ceiling and keeps its raw framing, on both attempts',
  listingRetry.calls.length === 2
  && listingRetry.calls.every((call) => call.timeoutMs === 60_000 && call.raw === true),
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
  homeProbeRetry.calls.length === 3 && homeProbeRetry.calls.every((call) => call.timeoutMs === 60_000),
  homeProbeRetry.calls.map((call) => call.timeoutMs))
// The retry must not launder a persistent stall into an answer: two timeouts still throw, and
// the message still carries the probe's own evidence rather than a guess about the path.
// The runner is CAPTURED: "it must try twice before it gives up" is a claim about the number
// of attempts, and the message alone does not measure it — a probe that never retried throws
// the very same `探针超时` error on its first attempt, which is why this row used to pass
// with the repeat absent.
const twiceRetry = scriptedRunner([timedOutProbe, timedOutProbe])
let twiceTimedOut = ''
try {
  await checkLinuxPath(distro, '/', { run: twiceRetry.run })
} catch (error) {
  twiceTimedOut = error instanceof Error ? error.message : String(error)
}
check('a probe that times out twice still fails loudly, naming the timeout, after exactly two attempts',
  twiceRetry.calls.length === 2
  && twiceTimedOut.includes('探针超时') && twiceTimedOut.includes('/'),
  `${twiceRetry.calls.length} attempt(s); ${twiceTimedOut || '(no error was thrown — a persistent stall was reported as an answer)'}`)
console.log('\nthe login-shell probe: the same 60s ceiling and one repeat, and a stall is never an answer')
// The ONE probe whose fallback is a VALUE rather than an error. resolveLoginShell
// returns '/bin/bash' whenever the parse does not start with '/', and a probe that never
// answered parses to '' — so a stalled relay was reported as a real shell, a value the
// caller cannot tell from a distribution that genuinely uses bash. It was also the only
// parsed-output probe left with no runner seam, which is why the quiet wrong answer could
// not be pinned behaviourally: these rows drive the policy through the INJECTED runner,
// exactly as the three probes above, and the attempt COUNT is the assertion.
const loginShellRetry = scriptedRunner([
  timedOutProbe,
  { exitCode: 0, stdout: '/bin/zsh\n', stderr: '', timedOut: false },
])
const loginShellFacts = await settle(() => resolveLoginShell(distro, undefined, { run: loginShellRetry.run }))
const loginShellCommands = loginShellRetry.calls.map((call) => call.command)
check('resolveLoginShell repeats a timed-out probe exactly once, asking the SAME question, and answers from the repeat',
  loginShellRetry.calls.length === 2
  && loginShellCommands[0] === loginShellCommands[1]
  && loginShellFacts === '/bin/zsh',
  { calls: loginShellRetry.calls.length, commands: loginShellCommands, facts: loginShellFacts })
check('resolveLoginShell asks for the documented 60s ceiling on both attempts',
  loginShellRetry.calls.length === 2 && loginShellRetry.calls.every((call) => call.timeoutMs === 60_000),
  loginShellRetry.calls.map((call) => call.timeoutMs))
// The username is part of the QUESTION at both layers ('-u' and the getent argument), so
// the repeat has to carry it: a retry that dropped it would answer about the distribution
// DEFAULT user instead of the session's.
const namedLoginShell = scriptedRunner([
  timedOutProbe,
  { exitCode: 0, stdout: '/bin/bash\n', stderr: '', timedOut: false },
])
await settle(() => resolveLoginShell(distro, 'zcluo', { run: namedLoginShell.run }))
check('the repeat of a NAMED-user login-shell probe keeps the username, so it asks about the same user',
  namedLoginShell.calls.length === 2
  && namedLoginShell.calls.every((call) => call.username === 'zcluo' && String(call.command).includes("'zcluo'")),
  namedLoginShell.calls.map((call) => ({ username: call.username, command: call.command })))
// THE defect: a stall that survives the repeat. '/bin/bash' is a plausible shell for this
// distribution, so returning it here is a wrong ANSWER the caller cannot distinguish from a
// real one — not an error. A timeout is not an answer (checkLinuxPath refuses it for the
// same reason), so this must redden, and the count proves the repeat ran before the failure.
const loginShellTwice = scriptedRunner([timedOutProbe, timedOutProbe])
const loginShellStall = await settle(() => resolveLoginShell(distro, undefined, { run: loginShellTwice.run }))
check('a login-shell probe that times out twice fails loudly after exactly two attempts, instead of answering /bin/bash',
  loginShellTwice.calls.length === 2
  && typeof loginShellStall.error === 'string'
  && loginShellStall.error.includes('探针超时')
  && loginShellStall.error.includes(distro)
  && loginShellStall.error.includes('/bin/bash') === false,
  { calls: loginShellTwice.calls.length, outcome: loginShellStall })
// Even a timed-out probe whose stream happens to carry something path-shaped must not be
// trusted: a killed process is cut mid-write, and '/bin/bash' truncated to '/bin' still
// starts with '/'. The answer here is the timeout itself, so the repeat does not launder it.
const truncatedStall = scriptedRunner([
  { exitCode: null, stdout: '/bin/bas', stderr: '', timedOut: true },
  timedOutProbe,
])
const truncatedFacts = await settle(() => resolveLoginShell(distro, undefined, { run: truncatedStall.run }))
check('a timed-out login-shell probe is refused even when its truncated stream looks like a path',
  truncatedStall.calls.length === 2 && typeof truncatedFacts.error === 'string',
  { calls: truncatedStall.calls.length, outcome: truncatedFacts })
// The control: a probe that RAN and exited 0 with an empty field IS the documented fallback
// (a user whose passwd field 7 is empty). "Or a distribution without getent" used to be named
// here and is NOT this case: an absent getent never reached this branch as an empty FIELD, it
// arrived as `cut`'s exit 0 over an empty stream (see the finding-2 rows below). Without this
// row the fix could "pass" by refusing every empty answer, breaking the promised fallback.
const ranEmpty = scriptedRunner([{ exitCode: 0, stdout: '\n', stderr: '', timedOut: false }])
const ranEmptyFacts = await settle(() => resolveLoginShell(distro, undefined, { run: ranEmpty.run }))
check('the control: a probe that RAN and exited 0 with an empty field still falls back to /bin/bash, in one attempt',
  ranEmpty.calls.length === 1 && ranEmptyFacts === '/bin/bash',
  { calls: ranEmpty.calls.length, facts: ranEmptyFacts })
// The control's OTHER half, and the reason the fallback must be keyed on EMPTY rather than on
// "does not start with /". An ANSWERED field 7 that is not an absolute path is still an answer:
// `nologin` is a deliberate "this account has no interactive shell" marker, so replacing it with
// /bin/bash invents a shell the distribution never measured — both callers SPAWN this value
// (subprocess.js:173 hands it back as the resolved executable, subprocess.js:273 makes it
// spawnTerminal's whole argv), and spawnTerminal's own comment refuses exactly that substitution
// ("substituting a shell the probe never measured is the silent wrong answer round 4 removed").
// A measured `nologin` reaches the terminal and fails there, which is the account's own ruling.
// Asserted through the same injected runner, and the attempt COUNT is asserted too: a retry here
// would mean the answer was read as inconclusive, which it is not.
const answeredNologin = scriptedRunner([{ exitCode: 0, stdout: 'nologin\n', stderr: '', timedOut: false }])
const answeredNologinFacts = await settle(() => resolveLoginShell(distro, undefined, { run: answeredNologin.run }))
check('an ANSWERED non-path field 7 (nologin) reaches the caller as itself, in one attempt, not as an invented /bin/bash',
  answeredNologin.calls.length === 1 && answeredNologinFacts === 'nologin',
  { calls: answeredNologin.calls.length, facts: answeredNologinFacts })
// A non-zero exit with no answer is the third way a probe fails to answer, and it used to
// read as the same '/bin/bash'. It is refused WITH the probe's own evidence, so an operator
// can tell "the distribution failed" from "this user has no login shell".
const failedLoginShell = scriptedRunner([
  { exitCode: 258, stdout: '', stderr: 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND', timedOut: false },
])
const failedLoginShellFacts = await settle(() => resolveLoginShell(distro, undefined, { run: failedLoginShell.run }))
check('a login-shell probe that exited non-zero is refused with its evidence, not answered /bin/bash',
  failedLoginShell.calls.length === 1
  && typeof failedLoginShellFacts.error === 'string'
  && failedLoginShellFacts.error.includes('Wsl/Service/WSL_E_DISTRO_NOT_FOUND'),
  { calls: failedLoginShell.calls.length, outcome: failedLoginShellFacts })
// Finding 1 (round 5). Round 4 made the stall loud and threw a PLAIN Error; the caller's own
// comment, six lines above the first call, is why that is wrong: the terminal controller
// catches `SubprocessExecutableNotFoundError` to SKIP a candidate and continue down its shell
// list, and the controller's default candidates include three Windows shell names
// (pwsh/powershell/cmd) that each ask THIS question. A plain Error therefore aborted the whole
// discovery — every distro lost its shell dropdown — while the answer it replaced (the old
// /bin/bash from a probe that never ran) is the silent wrong answer round 4 removed. Both
// constraints hold at once ONLY if the failure has a type the caller can act on, which is what
// these rows and the source pin below pin.
const loginShellClass = scriptedRunner([timedOutProbe, timedOutProbe])
const loginShellClassOutcome = await rejection(() => resolveLoginShell(distro, undefined, { run: loginShellClass.run }))
const loginShellThrown = loginShellClassOutcome.thrown
check('a stalled login-shell probe rejects with the exported structured class, carrying the probe evidence',
  loginShellClass.calls.length === 2
  && loginShellThrown instanceof LoginShellUnresolvedError
  && loginShellThrown.name === 'LoginShellUnresolvedError'
  && loginShellThrown.message.includes('探针超时')
  && loginShellThrown.message.includes(distro),
  { calls: loginShellClass.calls.length,
    error: loginShellThrown instanceof Error ? `${loginShellThrown.name}: ${loginShellThrown.message}` : String(loginShellThrown) })
// SKIP, not abort — the consequence, executed. The host half cannot be imported in this
// checkout (its @deepseek-ai/* imports do not resolve, which is why verify-modules SKIPs it),
// so the chain is split and each link is pinned where it CAN be: this row runs the caller's
// decision over the class the rejection actually carries, and the source pin below asserts
// that subprocess.js tests exactly this class and rethrows
// `SubprocessExecutableNotFoundError` — which shells.ts:51-57 catches to return `undefined`
// for that candidate. The third candidate ANSWERS, so the row also disproves an abort: an
// abort would take the healthy candidate down with the stalled two.
const candidateOutcomes = scriptedRunner([
  timedOutProbe, timedOutProbe,
  timedOutProbe, timedOutProbe,
  { exitCode: 0, stdout: '/bin/zsh\n', stderr: '', timedOut: false },
])
const skippedCandidates = []
const discoveredShells = []
let discoveryAbort = ''
for (const candidate of ['pwsh', 'cmd', 'zsh']) {
  try {
    discoveredShells.push(await resolveLoginShell(distro, undefined, { run: candidateOutcomes.run }))
  } catch (error) {
    if (error instanceof LoginShellUnresolvedError) { skippedCandidates.push(candidate); continue }
    // Recorded rather than rethrown: an abort is the defect this row exists to
    // catch, and an uncaught throw here would kill the rows after it instead.
    discoveryAbort = `${candidate}: ${error instanceof Error ? error.message : String(error)}`
    break
  }
}
check('two stalled candidates are SKIPPED, not aborted: the list continues and the answering candidate still arrives',
  discoveryAbort === ''
  && candidateOutcomes.calls.length === 5
  && skippedCandidates.join(',') === 'pwsh,cmd'
  && discoveredShells.join(',') === '/bin/zsh',
  { aborted: discoveryAbort, attempts: candidateOutcomes.calls.length, skipped: skippedCandidates, discovered: discoveredShells })
// Finding 2 (round 5): "a distribution without getent" was named as part of the /bin/bash
// fallback, and it is a silent wrong answer of the SAME class as the stall, one layer down.
// Measured in the distribution by driving the probe's OWN command string (recorded by the
// injected runner above) with `getent` shadowed by a function that cannot run: under POSIX sh
// the masked pipeline exits 0 with empty output, so the fallback answered /bin/bash for a probe
// that never ran. The command now carries getent's own status, so this asserts shell semantics
// rather than a spelling — and the control below proves the healthy case was not refused.
const loginShellProbeCommand = loginShellRetry.calls[0]?.command ?? ''
const shadowedGetent = `getent() { printf 'bash: getent: command not found\\n' >&2; return 127; }; ${loginShellProbeCommand}`
const absentGetent = await settle(() => runWslShell({ distro, linuxCwd: '/', command: shadowedGetent, loginShell: false, timeoutMs: 60_000 }))
check("with getent unable to run, the login-shell probe command reports failure instead of cut's exit 0",
  loginShellProbeCommand.includes('getent')
  && typeof absentGetent.exitCode === 'number' && absentGetent.exitCode !== 0,
  { command: loginShellProbeCommand, exitCode: absentGetent.exitCode, stdout: absentGetent.stdout, stderr: absentGetent.stderr })
const absentGetentRunner = scriptedRunner([{ exitCode: absentGetent.exitCode, stdout: absentGetent.stdout, stderr: absentGetent.stderr, timedOut: false }])
const absentGetentFacts = await settle(() => resolveLoginShell(distro, undefined, { run: absentGetentRunner.run }))
check('a getent that could not run is refused, not answered /bin/bash',
  absentGetentRunner.calls.length === 1 && typeof absentGetentFacts.error === 'string',
  { calls: absentGetentRunner.calls.length, outcome: absentGetentFacts })
const healthyLoginShellProbe = await settle(() => runWslShell({ distro, linuxCwd: '/', command: loginShellProbeCommand, loginShell: false, timeoutMs: 60_000 }))
check("the control: the same command with the distribution's own getent still answers a login shell",
  healthyLoginShellProbe.exitCode === 0 && String(healthyLoginShellProbe.stdout).trim().startsWith('/'),
  healthyLoginShellProbe)
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
// ... and the lookup's FAILURE has to be skippable, which is the finding-1 half that only the
// host half can carry: subprocess.js is what turns `LoginShellUnresolvedError` into
// `SubprocessExecutableNotFoundError`. It cannot be imported here (the same @deepseek-ai/*
// imports the row above documents), so the translation is a SOURCE pin — the technique these
// rows already use — while the class it tests and the consequence of skipping are behavioural
// rows driven through the injected runner above. The ORDER is asserted, not just the presence:
// a `cause`-carrying rethrow placed before the guard would translate every transport failure,
// and the COUNT is asserted so the deliberate asymmetry with spawnTerminal is a decision the
// next edit has to re-make rather than an accident (spawnTerminal has no candidate list to
// skip down, so it reports the probe's failure as itself).
const windowsFallbackAt = subprocessCode.indexOf('WINDOWS_SHELLS.has(base)')
const loginShellGuardAt = subprocessCode.indexOf('error instanceof LoginShellUnresolvedError')
const loginShellTranslateAt = subprocessCode.indexOf('new SubprocessExecutableNotFoundError(error.message, { cause: error })')
const siblingLookupThrowAt = subprocessCode.indexOf('new SubprocessExecutableNotFoundError(``)')
check('subprocess.js translates an unresolved login shell — and only there — into the class the terminal controller SKIPS on',
  windowsFallbackAt >= 0
  && loginShellGuardAt > windowsFallbackAt
  && loginShellTranslateAt > loginShellGuardAt
  && siblingLookupThrowAt > loginShellTranslateAt
  && (subprocessCode.match(/cause: error/g) ?? []).length === 1,
  { windowsFallbackAt, loginShellGuardAt, loginShellTranslateAt, siblingLookupThrowAt,
    window: subprocessCode.slice(Math.max(0, windowsFallbackAt - 40), windowsFallbackAt + 500) })
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
