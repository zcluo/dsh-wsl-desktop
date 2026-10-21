/**
 * The distribution doctor: a read-only health check behind one browser method.
 *
 * It exists because the prerequisites that decide whether a WSL session can work are
 * currently spread across README prose and `DISTRO-SUPPORT.md`: the user discovers a
 * missing `python3` or a missing runner when the first command fails, not before. The
 * doctor turns those facts into a checklist, with the fix attached.
 *
 * It is ADVISORY. `ok:false` means a hard prerequisite is missing; it never disables
 * creation, because `danger-full-access` may still be usable without the runner.
 * @module dsh-wsl-desktop/wsl/doctor
 */

import { CHECK_IDS, CHECK_REMEDIES } from '../protocol.js'
import { HELPER_PATH, HELPER_VERSION, detectNoNewPrivs, detectRunner } from './confinement.js'
import { shellQuote } from './paths.js'
import { runWslShell } from './world.js'
import { WslDomainError } from './errors.js'

/** How long one health answer is reused. */
export const HEALTH_CACHE_MS = 60_000

/** The batch's own ceiling. */
const BATCH_TIMEOUT_MS = 15_000

/** Each cached probe's race, because their own ceiling is 60s + a retry. */
const PROBE_RACE_MS = 20_000

/** The helper version probe's race. */
const HELPER_RACE_MS = 10_000

/** The batch: command availability, the Python version, and the distro family. */
const BATCH_SCRIPT = 'for c in bash python3 unshare setpriv findmnt mount getent; do '
  + 'printf \'%s\\t%s\\n\' "$c" "$(command -v "$c" 2>/dev/null || true)"; done; '
  + 'printf \'python3-version\\t%s\\n\' "$(python3 -V 2>&1 || true)"; '
  + '. /etc/os-release 2>/dev/null || true; '
  + 'printf \'os-id\\t%s\\n\' "${ID:-}"; '
  + 'printf \'os-like\\t%s\\n\' "${ID_LIKE:-}"'

/** Cached answers, keyed by distribution and user. */
const healthCache = new Map()

/** In-flight answers, so two dialogs do not run two doctors. */
const healthInflight = new Map()

/** Forget every cached answer; used by the verification suites. */
export function clearHealthCache() {
  healthCache.clear()
  healthInflight.clear()
}

/**
 * Parse the batch's `key<TAB>value` lines.
 * @param {unknown} stdout - the batch's stdout.
 * @returns {Record<string, string>} the markers; a malformed line is ignored.
 */
export function parseDoctorOutput(stdout) {
  const values = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const key = line.slice(0, tab)
    if (!/^[a-z0-9-]+$/.test(key)) continue
    values[key] = line.slice(tab + 1).replace(/\r$/, '')
  }
  return values
}

/**
 * Settle one promise or give up waiting, without cancelling the probe.
 * @param {Promise<unknown>} promise - the probe.
 * @param {number} ms - the ceiling.
 * @returns {Promise<{ value?: unknown, error?: unknown, timedOut?: true }>} the outcome.
 */
async function bounded(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms)
    timer.unref?.()
  })
  const settled = Promise.resolve(promise).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  const outcome = await Promise.race([settled, timeout])
  clearTimeout(timer)
  return outcome
}

/**
 * Parse `Python 3.10.12` into its first two components.
 * @param {unknown} text - the version line.
 * @returns {{major: number, minor: number} | null} the version, or null.
 */
function pythonVersion(text) {
  const match = /^Python\s+(\d+)\.(\d+)/.exec(String(text ?? '').trim())
  return match === null ? null : { major: Number(match[1]), minor: Number(match[2]) }
}

/**
 * The package-manager family from `/etc/os-release`.
 * @param {Record<string, string>} values - the batch markers.
 * @returns {'debian'|'fedora'|'arch'|'alpine'|'suse'|null} the family, or null.
 */
function distroFamily(values) {
  const id = String(values['os-id'] ?? '').trim().toLowerCase()
  const like = String(values['os-like'] ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  const names = [id, ...like]
  if (names.some((name) => name === 'debian' || name === 'ubuntu')) return 'debian'
  if (names.some((name) => name === 'fedora' || name === 'rhel' || name === 'centos')) return 'fedora'
  if (names.includes('arch')) return 'arch'
  if (names.includes('alpine')) return 'alpine'
  if (names.some((name) => name.startsWith('suse') || name === 'opensuse')) return 'suse'
  return null
}

/**
 * One check's remedy with the command chosen for the measured family.
 * @param {string} id - the check id.
 * @param {string|null} family - the distro family.
 * @returns {object} the remedy.
 */
function remedyFor(id, family) {
  const remedy = CHECK_REMEDIES[id]
  if (family === null || remedy?.kind !== 'command' || remedy.families === undefined) return remedy
  return { ...remedy, value: remedy.families[family] ?? remedy.value }
}

/**
 * Run the batch once, retrying a timeout once (the cold-start window).
 * @param {{ distro: string, username?: string, run: Function, wslPath?: string }} options - probe inputs.
 * @returns {Promise<Record<string, string>>} the parsed markers.
 */
async function runBatch({ distro, username, run, wslPath }) {
  const options = {
    distro,
    linuxCwd: '/',
    command: BATCH_SCRIPT,
    loginShell: false,
    timeoutMs: BATCH_TIMEOUT_MS,
    ...(typeof username === 'string' && username !== '' ? { username } : {}),
    ...(typeof wslPath === 'string' && wslPath !== '' ? { wslPath } : {}),
  }
  try {
    let result = await run(options)
    if (result?.timedOut === true) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      result = await run(options)
    }
    if (result?.timedOut === true) {
      throw new WslDomainError('distro-unreachable', 'doctor：批处理探针超时')
    }
    if (result?.exitCode !== 0) {
      const stderr = String(result?.stderr ?? '').trim()
      throw new WslDomainError('distro-unreachable', `doctor：批处理探针失败${stderr === '' ? '' : `：${stderr}`}`)
    }
    return parseDoctorOutput(result?.stdout)
  } catch (error) {
    if (error instanceof WslDomainError) throw error
    throw new WslDomainError('distro-unreachable', `doctor：批处理探针失败`, { cause: error })
  }
}

/**
 * Ask the installed helper for its version.
 * @param {{ distro: string, username?: string, run: Function, wslPath?: string }} options - probe inputs.
 * @returns {Promise<string | null>} the version line, or null.
 */
async function probeHelperVersion({ distro, username, run, wslPath }) {
  try {
    const result = await run({
      distro,
      linuxCwd: '/',
      command: `sudo -n ${shellQuote(HELPER_PATH)} --version 2>/dev/null || true`,
      loginShell: false,
      timeoutMs: 10_000,
      ...(typeof username === 'string' && username !== '' ? { username } : {}),
      ...(typeof wslPath === 'string' && wslPath !== '' ? { wslPath } : {}),
    })
    const text = String(result?.stdout ?? '').trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * Measure one distribution and assemble the checklist.
 * @param {object} options - probe inputs.
 * @returns {Promise<object>} the health answer.
 */
async function computeHealth({ distro, username, run, wslPath, now, runnerProbe, nnpProbe, helperProbe }) {
  // The cached probes call `run` themselves and do not know about the plugin's
  // configured wsl.exe path, so the doctor binds it once for every probe it hands
  // them. Without this they silently fall back to the bare `wsl.exe`.
  const probeRun = (options) => run({
    ...options,
    ...(typeof wslPath === 'string' && wslPath !== '' ? { wslPath } : {}),
  })
  const probeOptions = {
    distro,
    ...(typeof username === 'string' && username !== '' ? { username } : {}),
    run: probeRun,
    cacheKey: typeof wslPath === 'string' ? wslPath : '',
  }
  const [values, runnerOutcome, nnpOutcome] = await Promise.all([
    runBatch({ distro, username, run, wslPath }),
    bounded(Promise.resolve().then(() => runnerProbe(probeOptions)), PROBE_RACE_MS),
    bounded(Promise.resolve().then(() => nnpProbe(probeOptions)), PROBE_RACE_MS),
  ])

  const measured = Object.keys(values).length > 0
  const family = distroFamily(values)
  const runner = runnerOutcome?.value ?? null
  const nnp = nnpOutcome?.value ?? null
  // The helper version is only asked for AFTER the runner probe selected the
  // helper: its selection script proves ownership and permissions, and the
  // sudoers grant names that path. Asking unconditionally would execute an
  // unvalidated, user-writable path as root and duplicate the version fact.
  const helperOutcome = runner === 'helper'
    ? await bounded(
      Promise.resolve().then(() => helperProbe({ distro, username, run, wslPath })),
      HELPER_RACE_MS,
    )
    : null
  const helperVersion = helperOutcome?.value ?? null
  const python = pythonVersion(values['python3-version'])
  const missingCommands = ['unshare', 'setpriv', 'findmnt', 'mount']
    .filter((name) => String(values[name] ?? '').trim() === '')

  /** @type {Array<object>} */
  const checks = []
  /**
   * Add one check with its protocol remedy.
   * @param {string} id - the check id.
   * @param {string} status - pass|warn|fail|unknown.
   * @param {string} [detail] - a short, path-free fact.
   */
  const add = (id, status, detail) => {
    checks.push({ id, status, ...(detail === undefined ? {} : { detail }), remedy: remedyFor(id, family) })
  }

  if (!measured) {
    for (const id of CHECK_IDS) add(id, 'unknown', 'not measured')
  } else {
    add('bash', String(values.bash ?? '').trim() === '' ? 'fail' : 'pass',
      String(values.bash ?? '').trim() === '' ? 'command not found' : 'found')
    const pythonPresent = String(values.python3 ?? '').trim() !== ''
    const pythonOk = pythonPresent && python !== null && (python.major > 3 || (python.major === 3 && python.minor >= 8))
    add('python3', pythonOk ? 'pass' : 'warn',
      pythonOk ? `Python ${python.major}.${python.minor}` : pythonPresent ? 'version unreadable or below 3.8' : 'not found')
    add('util-linux', missingCommands.length === 0 ? 'pass' : 'warn',
      missingCommands.length === 0 ? 'unshare, setpriv, findmnt and mount found' : `missing: ${missingCommands.join(', ')}`)
    add('getent', String(values.getent ?? '').trim() === '' ? 'warn' : 'pass',
      String(values.getent ?? '').trim() === '' ? 'not found; the provider default shell is used' : 'found')
    if (runnerOutcome?.timedOut === true || runnerOutcome?.error !== undefined) {
      add('runner', 'unknown', 'probe timed out')
    } else {
      add('runner', runner === 'helper' || runner === 'sudo-unshare' ? 'pass' : 'warn',
        runner === null ? 'not available' : String(runner))
    }
    if (runner !== 'helper') {
      // Nothing was executed: the helper is not the selected runner. The runner
      // selection already proved that; a warning here is advisory, not a
      // measurement of an unvalidated path.
      add('helper', 'warn', runner === 'sudo-unshare'
        ? 'not selected; the runner uses sudo-unshare'
        : 'not available')
    } else if (helperOutcome?.timedOut === true || helperOutcome?.error !== undefined) {
      add('helper', 'unknown', 'probe timed out')
    } else if (helperVersion === `dsh-wsl-confine ${HELPER_VERSION}`) {
      add('helper', 'pass', helperVersion)
    } else {
      add('helper', 'warn', helperVersion === null ? `not installed or not ${HELPER_VERSION}` : helperVersion)
    }
    if (nnpOutcome?.timedOut === true || nnpOutcome?.error !== undefined) {
      add('nnp', 'unknown', 'probe timed out')
    } else if (nnp === true) {
      add('nnp', 'pass', 'supported')
    } else if (nnp === false) {
      add('nnp', 'warn', 'unsupported by setpriv')
    } else {
      add('nnp', 'unknown', 'unmeasured')
    }
  }

  const statusOf = (id) => checks.find((entry) => entry.id === id)?.status
  return {
    distro,
    user: typeof username === 'string' && username.trim() !== '' ? username.trim() : null,
    checkedAt: new Date(now()).toISOString(),
    cached: false,
    family,
    runner,
    ok: !checks.some((entry) => entry.status === 'fail'),
    restricted: statusOf('util-linux') === 'pass' && statusOf('runner') === 'pass' && statusOf('nnp') === 'pass',
    checks,
  }
}

/**
 * Measure the distribution, serving a cached answer for 60s.
 * @param {object} options - probe inputs; the probes are injectable for the suite.
 * @returns {Promise<object>} the health answer.
 */
export async function healthFor({
  distro,
  username,
  run = runWslShell,
  wslPath,
  now = Date.now,
  runnerProbe = detectRunner,
  nnpProbe = detectNoNewPrivs,
  helperProbe = probeHelperVersion,
}) {
  const key = `${distro}\0${username ?? ''}\0${wslPath ?? ''}`
  const cached = healthCache.get(key)
  if (cached !== undefined && now() - cached.at < HEALTH_CACHE_MS) {
    return { ...cached.result, cached: true }
  }
  const inflight = healthInflight.get(key)
  if (inflight !== undefined) return inflight
  const pending = computeHealth({ distro, username, run, wslPath, now, runnerProbe, nnpProbe, helperProbe })
    .then((result) => {
      healthCache.set(key, { at: now(), result })
      // The key carries a browser-supplied user; a page could churn spellings to
      // grow this map and force repeated privileged probes. Keep the newest 32.
      if (healthCache.size > 32) healthCache.delete(healthCache.keys().next().value)
      return result
    })
    .finally(() => {
      healthInflight.delete(key)
    })
  healthInflight.set(key, pending)
  return pending
}
