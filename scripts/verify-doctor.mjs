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
import { defaultDistro } from '../lib/wsl/world.js'

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
    batchError = null,
  } = overrides
  let calls = 0
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
    helperProbe: async () => helper,
    calls: () => calls,
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
  check('no command path is returned to the browser',
    !JSON.stringify(health).includes('/usr/bin'), JSON.stringify(health).slice(0, 200))
  check('every check carries its protocol remedy',
    health.checks.every((entry) => JSON.stringify(entry.remedy) === JSON.stringify(CHECK_REMEDIES[entry.id])))
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
      check('the live distro reports a status for every check',
        health.checks.length === CHECK_IDS.length && health.checks.every((entry) => entry.status !== 'unknown'),
        health.checks)
    } catch (error) {
      check('the live distro reports a status for every check', false, error)
    }
  }
}

const code = checker.failures > 0 ? 1 : checker.skipped > 0 ? 2 : 0
console.log(`\n${checker.passed} passed, ${checker.failures} failed, ${checker.skipped} skipped`)
process.exit(code)
