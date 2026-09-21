/**
 * Pure path translation between the Windows host and a WSL distribution.
 *
 * Nothing here touches the filesystem: a workspace is identified by its UNC
 * spelling (`\\wsl.localhost\<distro>\<linux>`) because that is the only form
 * the Windows-side harness accepts as an absolute workspace path, while the
 * distribution itself needs the Linux spelling. Every crossing converts
 * explicitly instead of guessing from a separator.
 * @module dsh-wsl-desktop/wsl/paths
 */

/** UNC hosts Windows uses for the WSL 9P share. */
const UNC_HOSTS = new Set(['wsl.localhost', 'wsl$'])

/** A distribution name that is safe to concatenate into a UNC path. */
export const DISTRO_NAME = /^[A-Za-z0-9._-]+$/

/** A Linux user name that is safe to pass as a single wsl.exe -u option value. */
export const LINUX_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*\$?$/

/**
 * Split a WSL UNC path into its distribution and Linux path.
 * @param {unknown} raw - candidate path.
 * @returns {{ distro: string, linuxPath: string } | null} the target, or null when the path is not a WSL UNC path.
 */
export function parseWslUnc(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const slashed = raw.replace(/\\/g, '/')
  if (!slashed.startsWith('//')) return null
  const segments = slashed.split('/').filter((segment) => segment !== '')
  const host = (segments[0] ?? '').toLowerCase()
  if (!UNC_HOSTS.has(host)) return null
  const distro = segments[1] ?? ''
  if (distro === '') return null
  const rest = segments.slice(2).join('/')
  return { distro, linuxPath: rest === '' ? '/' : `/${rest}` }
}

/**
 * Build the UNC spelling of a path inside a distribution.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux path.
 * @returns {string} the `\\wsl.localhost\<distro>\<linux>` spelling.
 * @throws Error when the distribution name could escape the share root.
 */
export function joinWslUnc(distro, linuxPath) {
  if (!DISTRO_NAME.test(distro)) {
    throw new Error(`wsl: distribution name ${JSON.stringify(distro)} is not usable in a UNC path`)
  }
  const posix = linuxPath.startsWith('/') ? linuxPath : `/${linuxPath}`
  const suffix = posix === '/' ? '' : posix.replace(/\//g, '\\')
  return `\\\\wsl.localhost\\${distro}${suffix}`
}

/**
 * Translate a Windows drive path into its WSL mount path.
 * @param {string} path - absolute Windows path.
 * @returns {string | null} `/mnt/<drive>/…`, or null when the path is not a drive path.
 */
export function windowsToMntPath(path) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  return `/mnt/${(match[1] ?? '').toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

/**
 * Translate a WSL drive mount back into a Windows path.
 * @param {string} linuxPath - `/mnt/<drive>/…`.
 * @returns {string | null} the Windows path, or null when the mount is not a single drive letter.
 */
export function mntToWindowsPath(linuxPath) {
  const match = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(linuxPath)
  if (match === null) return null
  const rest = (match[2] ?? '').replace(/\//g, '\\')
  return `${(match[1] ?? '').toUpperCase()}:\\${rest}`
}

/**
 * Whether a value is spelled like a Windows path.
 * @param {string} value - candidate value, typically an environment value.
 * @returns {boolean} true for a drive or UNC spelling.
 */
export function isWindowsPathShaped(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Quote one value for a POSIX shell word.
 * @param {string} value - the raw value.
 * @returns {string} a single-quoted shell word.
 */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
