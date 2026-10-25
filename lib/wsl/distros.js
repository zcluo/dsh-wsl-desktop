/**
 * Distribution discovery: which distributions exist, which one is the default, and
 * which WSL version each one runs.
 *
 * Split out of `world.js` (C3). Everything here reaches `wsl.exe` or the Lxss
 * registry and answers a question ABOUT a distribution; `world.js` keeps what
 * happens INSIDE one. The two import the decoder and the child environment from
 * `proc.js`, so neither imports the other.
 *
 * The re-exports at the bottom keep `world.js`'s public surface unchanged; that is
 * a compatibility shim, not a second home for the code.
 * @module dsh-wsl-desktop/wsl/distros
 */

import { execFileSync } from 'node:child_process'
import { WSL_CHILD_ENV, decodeWslOutput, execFileAsync } from './proc.js'

/** Short ceiling for the registry and `wsl.exe` discovery calls. */
const DISCOVERY_TIMEOUT_MS = 10_000

/** Windows registry key holding the WSL distribution registrations. */
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/**
 * List the installed WSL distributions.
 *
 * The configured path is spawned here too: this call is a probe like any other,
 * and a deployment that set the path because `wsl.exe` is not on PATH would get
 * an empty discovery while its real spawns worked.
 * @param {{ wslPath?: string }} [options] - the configured `wsl.exe` path.
 * @returns {Promise<string[]>} distribution names in `wsl.exe` order.
 */
export async function listDistros({ wslPath = 'wsl.exe' } = {}) {
  let stdout
  try {
    ({ stdout } = await execFileAsync(wslPath, ['-l', '-q'], {
      encoding: 'buffer',
      timeout: DISCOVERY_TIMEOUT_MS,
      // The discovery call is a wsl.exe spawn like any other: without this its
      // output is UTF-16LE and only the fallback probe reads it.
      env: { ...process.env, ...WSL_CHILD_ENV },
    }))
  } catch (error) {
    // The spawn code is the only thing that distinguishes "wsl.exe is not
    // installed" (ENOENT) from a plugin fault; dropping it would turn the most
    // common first-run state into `internal`. The message stays host-side.
    const failure = new Error(`无法列出 WSL 发行版：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    if (typeof error?.code === 'string') failure.code = error.code
    throw failure
  }
  return decodeWslOutput(stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * The WSL major version of one distribution, from `wsl.exe -l -v`.
 *
 * WSL1 is explicitly unsupported (its syscall translation layer has no mount
 * namespace), but until now nothing in the product asked the host which version a
 * distribution runs. The output is a table:
 *
 *   `  NAME      STATE           VERSION`
 *   `* debian    Running         2`
 *
 * The active marker is optional; the version is the last column. A table that
 * cannot be parsed answers `null` — an unmeasured fact is not a failure.
 * @param {string} distro - the distribution name.
 * @param {{ wslPath?: string }} [options] - the configured `wsl.exe` path.
 * @returns {Promise<'1'|'2'|null>} the major version, or null when unreadable.
 */
export async function wslMajorVersion(distro, { wslPath = 'wsl.exe' } = {}) {
  let stdout
  try {
    ({ stdout } = await execFileAsync(wslPath, ['-l', '-v'], {
      encoding: 'buffer',
      timeout: DISCOVERY_TIMEOUT_MS,
      env: { ...process.env, ...WSL_CHILD_ENV },
    }))
  } catch {
    return null
  }
  return parseWslVersionTable(decodeWslOutput(stdout), distro)
}

/**
 * Pick one distribution's major version out of a `wsl.exe -l -v` table.
 *
 * Kept pure and exported so the table's spacing variants are testable without a
 * real WSL host. The active marker (`*`) is optional; the last column is VERSION.
 * @param {unknown} text - the decoded table.
 * @param {string} distro - the distribution name.
 * @returns {'1'|'2'|null} the major version, or null when the row is absent.
 */
export function parseWslVersionTable(text, distro) {
  const lines = String(text ?? '').split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.replace(/\0/g, '').trim()
    if (line === '') continue
    const cells = line.replace(/^\*\s*/, '').split(/\s{2,}|\t/).filter((cell) => cell !== '')
    if (cells.length < 2) continue
    if (cells[0] !== distro) continue
    const version = cells[cells.length - 1]
    return version === '1' || version === '2' ? version : null
  }
  return null
}

/**
 * The Lxss registry values and the two REG_SZ lines the default-distribution read needs.
 *
 * The patterns live HERE, once, because the async and the sync reader each carried their
 * own copy: a registry-format change had two homes, and only one of them was exercised by
 * whichever caller the operator happened to hit.
 */
const DEFAULT_DISTRIBUTION_VALUE = 'DefaultDistribution'
const DISTRIBUTION_NAME_VALUE = 'DistributionName'
const GUID_PATTERN = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/iu
const NAME_PATTERN = /DistributionName\s+REG_SZ\s+(.+)/iu

/**
 * The distribution a `DistributionName` line names.
 * @param {unknown} output - the registry query's stdout.
 * @returns {string | undefined} the name, or undefined when the line names none.
 */
function distroFromRegistryOutput(output) {
  const distro = NAME_PATTERN.exec(String(output))?.[1]?.trim()
  return distro === undefined || distro === '' ? undefined : distro
}

/**
 * The Lxss subkey a `DefaultDistribution` line names.
 * @param {unknown} output - the registry query's stdout.
 * @returns {string | undefined} the GUID, or undefined when the line names none.
 */
function guidFromRegistryOutput(output) {
  return GUID_PATTERN.exec(String(output))?.[1]
}

/**
 * Read the user's default distribution from the Lxss registry. Non-fatal:
 * `undefined` when the value is absent or unreadable.
 * @returns {Promise<string | undefined>} the default distribution name.
 */
export async function defaultDistro() {
  try {
    const value = await execFileAsync('reg.exe', ['query', LXSS_KEY, '/v', DEFAULT_DISTRIBUTION_VALUE], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = guidFromRegistryOutput(value.stdout)
    if (guid === undefined) return undefined
    const name = await execFileAsync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', DISTRIBUTION_NAME_VALUE], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    return distroFromRegistryOutput(name.stdout)
  } catch {
    // A missing or unreadable registry value leaves the caller its own fallback.
    return undefined
  }
}

/**
 * Synchronous default-distribution read for plan steps that cannot await.
 *
 * Cached after the first read: a shell plan is built synchronously, and the
 * registry does not change while the process runs.
 * @returns {string | undefined} the default distribution name.
 */
let syncDefaultResolved = false
let syncDefault
export function defaultDistroSync() {
  if (syncDefaultResolved) return syncDefault
  syncDefaultResolved = true
  try {
    const value = execFileSync('reg.exe', ['query', LXSS_KEY, '/v', DEFAULT_DISTRIBUTION_VALUE], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = guidFromRegistryOutput(value)
    if (guid === undefined) return undefined
    const name = execFileSync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', DISTRIBUTION_NAME_VALUE], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    syncDefault = distroFromRegistryOutput(name)
  } catch {
    // An unreadable registry leaves the caller its own fail-loud path.
    syncDefault = undefined
  }
  return syncDefault
}
