/**
 * Environment the live verification suites need, resolved instead of hardcoded.
 *
 * The suites run real commands inside a real distribution, so they need a
 * distribution name and a Linux home directory. Both are properties of the
 * machine, not of the plugin: resolve them, and let an operator override either
 * one. Nothing here is a secret — the token file the host mints is never read.
 *
 * Overrides: `DSH_WSL_DISTRO`, `DSH_WSL_USER`, `DSH_WSL_HOME`.
 */

import { execFileSync } from 'node:child_process'

/** Distribution used when nothing else selects one. */
const FALLBACK_DISTRO = 'debian'

/**
 * Ceiling for the user probe, and how many times it is attempted.
 *
 * The ceiling is mandatory: this probe sits on the critical path of nearly every
 * suite, and wsl.exe is exactly the call a cold VM start can hang. The RETRY is
 * equally mandatory: a cold start can exceed the ceiling once and then answer
 * instantly, and an unhandled ETIMEDOUT used to throw out of module evaluation —
 * killing the suite with a stack trace before a single check printed, which reads
 * as a broken suite rather than a distro that was slow to wake.
 */
const PROBE_TIMEOUT_MS = 30_000
const PROBE_ATTEMPTS = 2

/**
 * The distribution under test.
 * @param {string|undefined} argument - explicit argv value, when the caller takes one.
 * @returns {string} the distribution name.
 */
export function resolveDistro(argument) {
  return argument ?? process.env.DSH_WSL_DISTRO ?? FALLBACK_DISTRO
}

/**
 * The Linux user the distribution runs commands as.
 * @param {string} [distro] - the distribution to ask; defaults to the selected one.
 * @returns {string} the login name reported inside that distribution.
 */
export function resolveLinuxUser(distro = resolveDistro()) {
  if (process.env.DSH_WSL_USER !== undefined) return process.env.DSH_WSL_USER
  // A ceiling is mandatory: this probe sits on the critical path of nearly
  // every suite, and wsl.exe is exactly the call a cold VM start can hang.
  //
  // The distribution is named explicitly: with no `-d` this probe answers for
  // the machine's DEFAULT distribution, so running a suite with
  // DSH_WSL_DISTRO=<other> returned another distribution's user and every
  // fixture path under `home` pointed at a home that does not exist there.
  const failures = []
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      const user = execFileSync('wsl.exe', ['-d', distro, '-e', 'id', '-un'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }).trim()
      if (user !== '') return user
      failures.push('empty answer')
    } catch (error) {
      // The CODE is what identifies the cause: 'ETIMEDOUT' for the cold-start case,
      // or the exit code for a distribution that is not there. The message would be
      // a truncated command line, which names nothing.
      failures.push(error?.code ?? error?.status ?? 'failed')
    }
  }
  // Still an error, but a LEGIBLE one: it names the distribution and the two ways
  // out, instead of surfacing a raw spawnSync ETIMEDOUT from module evaluation.
  throw new Error(
    `cannot resolve the Linux user in distribution "${distro}" (${failures.join(', ')}). `
    + `Wake the distribution once ("wsl.exe -d ${distro} -- true"), or set DSH_WSL_DISTRO / DSH_WSL_USER.`,
  )
}

/**
 * The Linux home directory of that user.
 * @param {string} [distro] - the distribution to ask; defaults to the selected one.
 * @returns {string} an absolute Linux path.
 */
export function resolveLinuxHome(distro) {
  if (process.env.DSH_WSL_HOME !== undefined) return process.env.DSH_WSL_HOME
  return `/home/${resolveLinuxUser(distro)}`
}
