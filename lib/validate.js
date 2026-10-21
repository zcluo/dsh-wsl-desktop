/**
 * Grammar checks for the values a browser route call carries.
 *
 * The route must reject a malformed distro/path/user BEFORE a spawn or a UNC join:
 * otherwise the plain `Error`/`TypeError` becomes `internal`, and the catalog's
 * `path-invalid` / `distro-unknown` remedies never fire. These functions throw a
 * `WslRouteError`, so the same error travels through the dispatcher unchanged.
 * @module dsh-wsl-desktop/validate
 */

import { WslRouteError } from './route-errors.js'
import { DISTRO_NAME, LINUX_USER } from './wsl/paths.js'

/**
 * A browser-supplied Linux path: absolute, no control characters and no backslash.
 *
 * Backslash is refused because the path is later joined into a Windows UNC spelling;
 * accepting it would make the same input mean two things in two layers.
 */
const LINUX_PATH = /^\/(?:[^\x00-\x1F\x7F\\])*$/

/**
 * Require a usable distribution name.
 * @param {unknown} distro - the value.
 * @returns {string} the same value.
 * @throws {WslRouteError} `distro-unknown` when the value cannot be one.
 */
export function assertDistro(distro) {
  if (typeof distro !== 'string' || !DISTRO_NAME.test(distro)) {
    throw new WslRouteError('distro-unknown', { distro: typeof distro === 'string' ? distro : '' })
  }
  return distro
}

/**
 * Require an absolute Linux path.
 * @param {unknown} path - the value.
 * @returns {string} the same value.
 * @throws {WslRouteError} `path-invalid` when the value is not one.
 */
export function assertLinuxPath(path) {
  if (typeof path !== 'string' || !LINUX_PATH.test(path)) {
    throw new WslRouteError('path-invalid', { path: typeof path === 'string' ? path : '' })
  }
  return path
}

/**
 * Require an optional Linux user name.
 * @param {unknown} username - the value; undefined and '' mean the default user.
 * @returns {string|undefined} the same value.
 * @throws {WslRouteError} `user-unknown` when a non-empty value cannot be one.
 */
export function assertUser(username) {
  if (username === undefined || username === null || username === '') return undefined
  if (typeof username !== 'string' || !LINUX_USER.test(username)) {
    throw new WslRouteError('user-unknown', { user: typeof username === 'string' ? username : '' })
  }
  return username
}
