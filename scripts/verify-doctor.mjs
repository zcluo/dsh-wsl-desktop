/**
 * Offline checks for the distro doctor, plus one live row.
 *
 * The doctor is advisory: it reports what it measured, never blocks creation, and
 * never returns a command's PATH back to the browser. The probes are injected so the
 * assembly and the cache can be exercised without a distribution; the live row asks
 * the real distro only once and SKIPs (exit 2) when none can be resolved.
 *
 * Run: node scripts/verify-doctor.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { CHECK_IDS, CHECK_REMEDIES } from '../lib/protocol.js'
import { clearHealthCache, healthFor, parseDoctorOutput } from '../lib/wsl/doctor.js'
import { defaultDistro, parseWslVersionTable } from '../lib/wsl/distros.js'

const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 400) })
const { check } = checker

/** A batch print with every command present. */
const BATCH_OK = [
  'bash\t/usr/bin/bash',
  'python3\t/usr/bin/python3',
  'unshare\t/usr/bin/unshare',
  'setpriv\t/usr/bin/setpriv',
  'findmnt\t/usr/bin/findmnt',
  'mount\t/usr/bin/mount',
  'getent\t/usr/bin/getent',
  'python3-version\tPython 3.10.12',
].join('\n') + '\n'

/**
 * A doctor harness with injected probes.
 * @param {object} [overrides] - batch text, probe answers, or a batch error.
 * @returns {object} the options plus a batch-call counter.
 */
function harness(overrides = {}) {
  const {
    batch = BATCH_OK,
    runner = 'helper',
    nnp = true,
    helper = 'dsh-wsl-confine v1.2',
    wslVersion = '2',
    batchError = null,
  } = overrides
  let calls = 0
  let helperCalls = 0
  const seen = []
  return {
    async run(options) {
      calls += 1
      seen.push(options.wslPath)
      if (batchError !== null) throw batchError
      return { exitCode: 0, stdout: batch, stderr: '' }
    },
    runnerProbe: async () => runner,
    nnpProbe: async () => nnp,
    wslVersionProbe: async () => wslVersion,
    helperProbe: async () => {
      helperCalls += 1
      return helper
    },
    calls: () => calls,
    helperCalls: () => helperCalls,
    seen: () => seen,
  }
}

console.log('\nparser')
{
  const parsed = parseDoctorOutput(`${BATCH_OK}broken line\nkey\tvalue\twith tab\n`)
  check('the markers are keyed by their first tab',
    parsed.bash === '/usr/bin/bash' && parsed['python3-version'] === 'Python 3.10.12',
    parsed)
  check('a value keeps later tabs', parsed.key === 'value\twith tab', parsed.key)
  check('a line with no tab is ignored, not guessed at', parsed['broken line'] === undefined, Object.keys(parsed))
}

console.log('\nWSL version table')
{
  const table = [
    '  NAME            STATE           VERSION',
    '* debian-dev      Running         2',
    '  arch            Stopped         1',
  ].join('\n')
  check('the active marker is optional and the last column is the version',
    parseWslVersionTable(table, 'debian-dev') === '2', parseWslVersionTable(table, 'debian-dev'))
  check('a WSL1 row is read as 1', parseWslVersionTable(table, 'arch') === '1')
  check('an absent distribution is null', parseWslVersionTable(table, 'missing') === null)
  check('a malformed version is null, not a guess',
    parseWslVersionTable('  NAME  STATE  VERSION\n  d  Running  n/a', 'd') === null)
  check('a tab-separated row parses',
    parseWslVersionTable('d\tRunning\t2', 'd') === '2')
  check('a distribution name with a single space still matches',
    parseWslVersionTable('  NAME            STATE           VERSION\n* Ubuntu 22.04    Running         2', 'Ubuntu 22.04') === '2')
}

console.log('\nassembly')
{
  clearHealthCache()
  const h = harness()
  const health = await healthFor({ distro: 'd', ...h, now: () => 1_000 })
  check('every check is reported in the protocol order',
    health.checks.map((entry) => entry.id).join(',') === CHECK_IDS.join(','), health.checks.map((entry) => entry.id))
  check('a complete distro passes every check',
    health.checks.every((entry) => entry.status === 'pass'),
    health.checks.filter((entry) => entry.status !== 'pass'))
  check('ok and restricted are both true', health.ok === true && health.restricted === true, health)
  check('a WSL2 host passes the wsl2 row',
    health.checks.find((entry) => entry.id === 'wsl2')?.status === 'pass',
    health.checks.find((entry) => entry.id === 'wsl2'))
  check('no command path is returned to the browser',
    !JSON.stringify(health).includes('/usr/bin'), JSON.stringify(health).slice(0, 200))
  check('every check carries its protocol remedy',
    health.checks.every((entry) => {
      const base = CHECK_REMEDIES[entry.id]
      return entry.remedy?.kind === base.kind
        && entry.remedy?.value === base.value
        && entry.remedy?.families === undefined
    }),
    health.checks.map((entry) => entry.remedy))
  check('the health answer does not ship the dead family map',
    !JSON.stringify(health).includes('"families"'), JSON.stringify(health).slice(0, 200))
}
{
  clearHealthCache()
  const withoutBash = BATCH_OK.split('\n').filter((line) => !line.startsWith('bash\t')).join('\n')
  const health = await healthFor({ distro: 'd', ...harness({ batch: withoutBash }), now: () => 1_000 })
  const bash = health.checks.find((entry) => entry.id === 'bash')
  check('a missing bash is a hard failure', bash.status === 'fail' && health.ok === false, bash)
}
{
  clearHealthCache()
  const withoutPython = BATCH_OK.split('\n').filter((line) => !line.startsWith('python3\t')).join('\n')
  const health = await healthFor({ distro: 'd', ...harness({ batch: withoutPython }), now: () => 1_000 })
  const python = health.checks.find((entry) => entry.id === 'python3')
  check('a missing python3 is a warning, not a hard failure',
    python.status === 'warn' && health.ok === true, { python, ok: health.ok })
}
{
  clearHealthCache()
  const withoutUnshare = BATCH_OK.split('\n').filter((line) => !line.startsWith('unshare\t')).join('\n')
  const health = await healthFor({ distro: 'd', ...harness({ batch: withoutUnshare }), now: () => 1_000 })
  const util = health.checks.find((entry) => entry.id === 'util-linux')
  check('missing util-linux warns and clears restricted',
    util.status === 'warn' && health.restricted === false && health.ok === true, { util, restricted: health.restricted })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ runner: null }), now: () => 1_000 })
  const runner = health.checks.find((entry) => entry.id === 'runner')
  check('no runner warns and clears restricted',
    runner.status === 'warn' && health.restricted === false, { runner, restricted: health.restricted })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ wslVersion: '1' }), now: () => 1_000 })
  const row = health.checks.find((entry) => entry.id === 'wsl2')
  check('a WSL1 distribution fails the wsl2 row and the whole answer',
    row.status === 'fail' && health.ok === false, { row, ok: health.ok })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ wslVersion: null }), now: () => 1_000 })
  const row = health.checks.find((entry) => entry.id === 'wsl2')
  check('an unreadable WSL version is unmeasured, not a failure',
    row.status === 'unknown' && health.ok === true, { row, ok: health.ok })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ nnp: false }), now: () => 1_000 })
  const nnp = health.checks.find((entry) => entry.id === 'nnp')
  check('nnp false warns and clears restricted',
    nnp.status === 'warn' && health.restricted === false && health.ok === true, { nnp, restricted: health.restricted })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ runner: 'sudo-unshare', helper: null }), now: () => 1_000 })
  const helper = health.checks.find((entry) => entry.id === 'helper')
  check('a helper that is not installed is a warning beside a working runner',
    helper.status === 'warn' && health.restricted === true, { helper, restricted: health.restricted })
}
{
  clearHealthCache()
  const health = await healthFor({ distro: 'd', ...harness({ batch: '' }), now: () => 1_000 })
  check('an empty batch leaves every check unknown, not failed',
    health.checks.every((entry) => entry.status === 'unknown') && health.ok === true,
    health.checks.map((entry) => entry.status))
}

console.log('\ncache')
{
  clearHealthCache()
  let clock = 1_000_000
  const h = harness()
  const now = () => clock
  const first = await healthFor({ distro: 'd', ...h, now })
  clock += 1_000
  const second = await healthFor({ distro: 'd', ...h, now })
  check('a second call inside the TTL is served from cache',
    h.calls() === 1 && second.cached === true && first.cached === false, { calls: h.calls(), first: first.cached, second: second.cached })
  clock += 60_000
  const third = await healthFor({ distro: 'd', ...h, now })
  check('after the TTL the doctor measures again',
    h.calls() === 2 && third.cached === false, { calls: h.calls(), cached: third.cached })
}
{
  clearHealthCache()
  const h = harness()
  await healthFor({ distro: 'd', wslPath: 'C:\\a\\wsl.exe', ...h, now: () => 1 })
  await healthFor({ distro: 'd', wslPath: 'C:\\a\\wsl.exe', ...h, now: () => 2 })
  check('the same configured world is cached', h.calls() === 1, h.calls())
  await healthFor({ distro: 'd', wslPath: 'C:\\b\\wsl.exe', ...h, now: () => 3 })
  check('a different configured wsl.exe is a different cache entry', h.calls() === 2, h.calls())
}
{
  clearHealthCache()
  const h = harness()
  for (let index = 0; index < 40; index += 1) {
    await healthFor({ distro: 'd', username: `u${index}`, ...h, now: () => 10_000 })
  }
  const before = h.calls()
  await healthFor({ distro: 'd', username: 'u0', ...h, now: () => 10_000 })
  check('the health cache is bounded', h.calls() > before, { before, after: h.calls() })
}

{
  clearHealthCache()
  const h = harness()
  const [first, second] = await Promise.all([
    healthFor({ distro: 'd', ...h, now: () => 20_000 }),
    healthFor({ distro: 'd', ...h, now: () => 20_000 }),
  ])
  check('two concurrent calls share one doctor run', h.calls() === 1, h.calls())
  check('and they receive the same measured answer',
    first.checks.length === second.checks.length && second.cached !== true,
    { first: first.checks.length, second: second.checks.length })
}
{
  clearHealthCache()
  let attempts = 0
  const result = await healthFor({
    distro: 'd',
    run: async () => {
      attempts += 1
      if (attempts === 1) return { exitCode: null, timedOut: true, stdout: '', stderr: '' }
      return { exitCode: 0, stdout: BATCH_OK, stderr: '' }
    },
    runnerProbe: async () => 'helper',
    nnpProbe: async () => true,
    helperProbe: async () => 'dsh-wsl-confine v1.2',
    now: () => 30_000,
  })
  check('a timed-out batch is retried once',
    attempts === 2 && result.checks.find((check) => check.id === 'bash')?.status === 'pass',
    { attempts, bash: result.checks.find((check) => check.id === 'bash') })
}

console.log('\nconfigured wsl.exe path')
{
  clearHealthCache()
  const h = harness()
  await healthFor({
    distro: 'd',
    wslPath: 'C:\\custom\\wsl.exe',
    ...h,
    runnerProbe: async (options) => {
      await options.run({ distro: 'd', command: 'probe', linuxCwd: '/' })
      return 'helper'
    },
    nnpProbe: async () => true,
    helperProbe: async () => 'dsh-wsl-confine v1.2',
    now: () => 3_000,
  })
  check('every probe the doctor issues carries the configured wsl.exe path',
    h.seen().every((value) => value === 'C:\\custom\\wsl.exe'), h.seen())
}

console.log('\nhelper probe gating')
{
  clearHealthCache()
  const h = harness({ runner: 'sudo-unshare', helper: 'dsh-wsl-confine v1.2' })
  const result = await healthFor({ distro: 'd', ...h, now: () => 4_000 })
  const helper = result.checks.find((check) => check.id === 'helper')
  check('a non-helper runner does not execute the helper probe', h.helperCalls() === 0, h.helperCalls())
  check('the helper row is the unmeasured advisory, not a version claim',
    helper?.status === 'warn' && helper.detail.includes('not selected'), helper)
}
{
  clearHealthCache()
  const h = harness()
  const result = await healthFor({
    distro: 'd',
    ...h,
    runnerProbe: async () => { throw new Error('runner probe down') },
    now: () => 4_500,
  })
  const helper = result.checks.find((check) => check.id === 'helper')
  check('a failed runner probe leaves the helper row unmeasured, not absent',
    helper?.status === 'unknown', helper)
  check('and still executes no helper probe', h.helperCalls() === 0, h.helperCalls())
}

console.log('\nremedy families')
{
  clearHealthCache()
  const fedoraBatch = 'bash\t/bin/bash\npython3\t/usr/bin/python3\nunshare\t/usr/bin/unshare\nsetpriv\t/usr/bin/setpriv\nfindmnt\t/usr/bin/findmnt\nmount\t/usr/bin/mount\ngetent\t/usr/bin/getent\npython3-version\tPython 3.11.2\nos-id\tfedora\nos-like\trhel fedora\n'
  const fedora = await healthFor({ distro: 'd', ...harness({ batch: fedoraBatch }), now: () => 5_000 })
  const pythonFedora = fedora.checks.find((check) => check.id === 'python3')
  check('the answer names the measured family', fedora.family === 'fedora', fedora.family)
  check('a Fedora remedy selects dnf, not apt-get',
    pythonFedora?.remedy?.value.includes('dnf') === true, pythonFedora?.remedy?.value)
}
{
  clearHealthCache()
  const debianBatch = 'bash\t/bin/bash\npython3\t/usr/bin/python3\nunshare\t/usr/bin/unshare\nsetpriv\t/usr/bin/setpriv\nfindmnt\t/usr/bin/findmnt\nmount\t/usr/bin/mount\ngetent\t/usr/bin/getent\npython3-version\tPython 3.11.2\nos-id\tdebian\nos-like\tdebian\n'
  const debian = await healthFor({ distro: 'd', ...harness({ batch: debianBatch }), now: () => 6_000 })
  const pythonDebian = debian.checks.find((check) => check.id === 'python3')
  check('a Debian remedy selects apt-get',
    debian.family === 'debian' && pythonDebian?.remedy?.value.includes('apt-get') === true,
    pythonDebian?.remedy?.value)
}
{
  clearHealthCache()
  const unknown = await healthFor({ distro: 'd', ...harness(), now: () => 7_000 })
  check('an os-release-less distro keeps the generic command, not a guess',
    unknown.family === null && unknown.checks[0]?.remedy !== undefined, unknown.family)
}

console.log('\nlive row')
{
  let live
  try {
    live = process.env.DSH_WSL_DISTRO ?? await defaultDistro()
  } catch {
    live = undefined
  }
  if (live === undefined) {
    checker.skip(1)
    console.log('  SKIP  the live health row — no default distribution is resolvable; set DSH_WSL_DISTRO to run it')
  } else {
    try {
      const health = await healthFor({ distro: live })
      // A legitimate cold-VM timeout may leave one probe unknown; that is not a
      // defect. The live row asserts the shape and the ONE check that is a hard
      // failure if unmeasured, plus the no-path boundary.
      check('the live distro reports the protocol checks in order',
        health.checks.map((entry) => entry.id).join(',') === CHECK_IDS.join(','),
        health.checks.map((entry) => entry.id))
      const bash = health.checks.find((entry) => entry.id === 'bash')
      check('the live distro measures its bash row',
        ['pass', 'warn', 'fail'].includes(bash?.status), bash)
      check('the live answer carries no command path or stderr',
        !JSON.stringify(health).includes('/usr/bin/') && !JSON.stringify(health).includes('stderr'),
        JSON.stringify(health).slice(0, 160))
    } catch (error) {
      check('the live distro reports a health answer', false, error)
    }
  }
}

const code = checker.failures > 0 ? 1 : checker.skipped > 0 ? 2 : 0
console.log(`\n${checker.passed} passed, ${checker.failures} failed, ${checker.skipped} skipped`)
process.exit(code)
