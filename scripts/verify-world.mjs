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
import { fileURLToPath } from 'node:url'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { listDistros, defaultDistro, runWslShell, listLinuxDir, checkLinuxPath, resolveDistroHome, probeEvidence, hostExecutable, planWsl, buildWslExecArgv } from '../lib/wsl/world.js'
import {
  parseWslUnc,
  joinWslUnc,
  windowsToMntPath,
  mntToWindowsPath,
  isWindowsPathShaped,
  shellQuote,
} from '../lib/wsl/paths.js'
import { detailText } from './detail.mjs'

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
const home = resolveLinuxHome()
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

console.log('\ndirectory facts')
const listing = await listLinuxDir(distro, home)
check('listing returns the requested path', listing.path === home, listing.path)
check('listing reports entries', Array.isArray(listing.entries), listing)
console.log(`        ${listing.entries.length} entries; first: ${listing.entries.slice(0, 5).map((e) => `${e.name}(${e.kind[0]})`).join(' ')}`)
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
