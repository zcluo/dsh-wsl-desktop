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
import { listDistros, defaultDistro, runWslShell, listLinuxDir, checkLinuxPath, resolveDistroHome, hostExecutable, planWsl, buildWslExecArgv } from '../lib/wsl/world.js'
import {
  parseWslUnc,
  joinWslUnc,
  windowsToMntPath,
  mntToWindowsPath,
  isWindowsPathShaped,
  shellQuote,
} from '../lib/wsl/paths.js'

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
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `\n        ${String(detail)}`}`)
}

console.log('path translation')
check(
  'parseWslUnc splits a UNC workspace path',
  JSON.stringify(parseWslUnc('\\\\wsl.localhost\\example\\home\\user')) === JSON.stringify({ distro: 'example', linuxPath: '/home/user' }),
  parseWslUnc('\\\\wsl.localhost\\example\\home\\user'),
)
check('parseWslUnc accepts the wsl$ alias', parseWslUnc('\\\\wsl$\\Ubuntu\\srv')?.distro === 'Ubuntu')
check('parseWslUnc rejects a drive path', parseWslUnc('E:\\projects') === null)
check('joinWslUnc round-trips', parseWslUnc(joinWslUnc('example', '/home/user'))?.linuxPath === '/home/user')
check('joinWslUnc maps the root', joinWslUnc('example', '/') === '\\\\wsl.localhost\\example')
check('windowsToMntPath maps a drive', windowsToMntPath('E:\\projects\\x') === '/mnt/e/projects/x')
check('mntToWindowsPath round-trips', mntToWindowsPath('/mnt/e/projects/x') === 'E:\\projects\\x')
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
const resolved = await resolveDistroHome(distro)
check("the default user's home resolves to an absolute Linux path",
  resolved.user.length > 0 && resolved.home.startsWith('/'), resolved)
const byName = await resolveDistroHome(distro, resolved.user)
check('resolving an explicit user matches the default-user resolution',
  byName.user === resolved.user && byName.home === resolved.home, byName)

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
