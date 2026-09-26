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
 * The distribution under test.
 * @param {string|undefined} argument - explicit argv value, when the caller takes one.
 * @returns {string} the distribution name.
 */
export function resolveDistro(argument) {
  return argument ?? process.env.DSH_WSL_DISTRO ?? FALLBACK_DISTRO
}

/**
 * The Linux user the distribution runs commands as.
 * @returns {string} the login name reported inside the distribution.
 */
export function resolveLinuxUser() {
  if (process.env.DSH_WSL_USER !== undefined) return process.env.DSH_WSL_USER
  // A ceiling is mandatory: this probe sits on the critical path of nearly
  // every suite, and wsl.exe is exactly the call a cold VM start can hang.
  return execFileSync('wsl.exe', ['-e', 'id', '-un'], { encoding: 'utf8', timeout: 15_000 }).trim()
}

/**
 * The Linux home directory of that user.
 * @returns {string} an absolute Linux path.
 */
export function resolveLinuxHome() {
  if (process.env.DSH_WSL_HOME !== undefined) return process.env.DSH_WSL_HOME
  return `/home/${resolveLinuxUser()}`
}
