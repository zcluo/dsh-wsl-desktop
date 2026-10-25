/**
 * Offline checks for the typed failures the world probes raise.
 *
 * The route maps a failure to a browser code without reading a message: it needs a
 * typed code on the error. The probes take an injectable `run`, so those paths are
 * exercised here with no distribution.
 *
 * Run: node scripts/verify-world-errors.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { checkLinuxPath, listLinuxDir, resolveDistroHome } from '../lib/wsl/world.js'
import { listDistros } from '../lib/wsl/distros.js'
import { WslDomainError } from '../lib/wsl/errors.js'
import { browserFailure, routeErrorFor } from '../lib/route-errors.js'

const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 300) })
const { check } = checker

/**
 * One fake probe outcome in the shape runWslShell returns.
 * @param {string} stdout - the captured text.
 * @param {number} [exitCode] - the exit code.
 * @param {string} [stderr] - the captured error text.
 * @param {boolean} [raw] - whether the probe asks for Buffers (`raw: true`).
 * @returns {{ exitCode: number, stdout: string|Buffer, stderr: string|Buffer }} the outcome.
 */
function outcome(stdout, exitCode = 0, stderr = '', raw = false) {
  return {
    exitCode,
    stdout: raw ? Buffer.from(stdout) : stdout,
    stderr: raw ? Buffer.from(stderr) : stderr,
  }
}

/**
 * Capture the rejection of one call.
 * @param {() => Promise<unknown>} call - the call under test.
 * @returns {Promise<unknown>} the rejection reason, or null.
 */
async function rejectionOf(call) {
  try {
    await call()
    return null
  } catch (error) {
    return error
  }
}

console.log('\ndiscovery failures')
{
  // The real producer: a non-existent wsl.exe. The route maps ENOENT during
  // discovery to `wsl-not-available`; a wrapper that discards the spawn code
  // makes the most common first-run state indistinguishable from a plugin bug.
  const failure = await rejectionOf(() => listDistros({ wslPath: 'dsh-wsl-no-such-executable.exe' }))
  check('a missing wsl.exe rejects', failure !== null)
  check('its spawn code survives the discovery wrapper',
    failure?.code === 'ENOENT' || failure?.cause?.code === 'ENOENT', failure?.code ?? failure?.cause?.code)
  const wire = browserFailure(failure, { discovery: true })
  check('the browser receives wsl-not-available, not internal', wire.code === 'wsl-not-available', wire)
}

console.log('\nlistLinuxDir')
{
  const missing = await rejectionOf(() => listLinuxDir('d', '/gone', {
    run: async () => outcome('__DSH_LIST_MISSING__\n', 3, '', true),
  }))
  check('a missing directory is a typed path-not-found',
    missing instanceof WslDomainError && missing.code === 'path-not-found',
    { type: missing?.name, code: missing?.code })
}
{
  const notDirectory = await rejectionOf(() => listLinuxDir('d', '/etc/hostname', {
    run: async () => outcome('__DSH_LIST_NOT_DIR__\n', 4, '', true),
  }))
  check('a file path is path-not-directory', notDirectory?.code === 'path-not-directory', notDirectory?.code)
  const denied = await rejectionOf(() => listLinuxDir('d', '/root', {
    run: async () => outcome('__DSH_LIST_DENIED__\n', 5, 'cd: Permission denied', true),
  }))
  check('a permission failure is path-denied, not path-not-found',
    denied?.code === 'path-denied', denied?.code)
  check('the host-side message keeps the denied stderr',
    denied?.message.includes('Permission denied') === true, denied?.message)
  const wire = browserFailure(routeErrorFor(denied, { path: '/root' }))
  check('the browser receives path-denied with the caller path',
    wire.code === 'path-denied' && wire.params.path === '/root', wire)
}
{
  const down = await rejectionOf(() => listLinuxDir('d', '/home', {
    run: async () => outcome('', 1, 'cold', true),
  }))
  check('a failed listing without the marker is distro-unreachable',
    down instanceof WslDomainError && down.code === 'distro-unreachable',
    { type: down?.name, code: down?.code })
}
{
  const listing = await listLinuxDir('d', '/home', {
    run: async () => outcome('d\tok\0d\tbad\\name\0d\tbad\nname\0', 0, '', true),
  })
  check('a successful listing keeps its NUL-framed entries',
    listing.entries.length === 1 && listing.entries[0].name === 'ok' && listing.hidden === 2,
    listing)
}

console.log('\ncheckLinuxPath')
{
  const missing = await checkLinuxPath('d', '/gone', { run: async () => outcome('missing\n') })
  const other = await checkLinuxPath('d', '/file', { run: async () => outcome('other\n') })
  const dir = await checkLinuxPath('d', '/home', { run: async () => outcome('dir\n') })
  check('the three answers become the three facts',
    missing.exists === false && missing.isDirectory === false
    && other.exists === true && other.isDirectory === false
    && dir.exists === true && dir.isDirectory === true,
    { missing, other, dir })
}
{
  const down = await rejectionOf(() => checkLinuxPath('d', '/home', {
    run: async () => outcome('', 1, 'cold'),
  }))
  check('a probe that could not run is distro-unreachable, not "missing"',
    down instanceof WslDomainError && down.code === 'distro-unreachable',
    { type: down?.name, code: down?.code })
}

console.log('\nresolveDistroHome')
{
  const unknown = await rejectionOf(() => resolveDistroHome('d', 'ghost', {
    run: async ({ command }) => command.includes('getent passwd') ? outcome('\n') : outcome('me\n'),
  }))
  check('a named user with no home is a typed user-unknown',
    unknown instanceof WslDomainError && unknown.code === 'user-unknown',
    { type: unknown?.name, code: unknown?.code })
}
{
  const defaultDown = await rejectionOf(() => resolveDistroHome('d', undefined, {
    run: async () => outcome('\n'),
  }))
  check('a failed default-user probe is distro-unreachable',
    defaultDown instanceof WslDomainError && defaultDown.code === 'distro-unreachable',
    { type: defaultDown?.name, code: defaultDown?.code })
}
{
  const answer = await resolveDistroHome('d', 'me', {
    run: async ({ command }) => command.includes('getent passwd') ? outcome('/home/me\n') : outcome('me\n'),
  })
  check('a measured user keeps the exact home', answer.user === 'me' && answer.home === '/home/me', answer)
}
{
  const answer = await resolveDistroHome('d', undefined, {
    run: async ({ command }) => command.includes('id -un') ? outcome('me\n') : outcome('/home/me\n'),
  })
  check('the default user resolves through id -un, then getent',
    answer.user === 'me' && answer.home === '/home/me', answer)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
