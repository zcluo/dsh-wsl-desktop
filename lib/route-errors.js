/**
 * Turn a thrown failure into the wire envelope a browser may receive.
 *
 * The browser gets `{ code, params }` and nothing else: no message, no stack, no
 * stderr. A developer caller keeps the human message on the route's side, so
 * debugging does not lose what the fence removed.
 * @module dsh-wsl-desktop/route-errors
 */

import { SAFE_PARAMS } from './protocol.js'
import { WslDomainError } from './wsl/errors.js'

/** A param value longer than this is truncated on the wire. */
const PARAM_LIMIT = 200

/** The domain codes that are also protocol codes. */
const DOMAIN_TO_PROTOCOL = new Set([
  'distro-unreachable',
  'user-unknown',
  'path-not-found',
  'path-not-directory',
])

/**
 * A short correlation id for an unclassified failure.
 * @returns {string} six lowercase hex characters.
 */
function newRef() {
  return Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
}

/**
 * A route failure carrying a catalog code.
 */
export class WslRouteError extends Error {
  /**
   * @param {string} code - a catalog code; an unknown one becomes `internal`.
   * @param {Record<string, unknown>} [params] - values the UI may show.
   * @param {{ cause?: unknown, ref?: string }} [options] - the underlying failure and
   *   an optional correlation id for the internal fallback.
   */
  constructor(code, params = {}, options = {}) {
    const known = Object.hasOwn(SAFE_PARAMS, code)
    super(`route failure: ${known ? code : 'internal'}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WslRouteError'
    this.code = known ? code : 'internal'
    this.params = known ? params : { ref: params?.ref ?? options.ref ?? newRef() }
  }
}

/**
 * Classify one thrown failure.
 *
 * `discovery` names the caller's context: an ENOENT raised while discovering
 * distributions means wsl.exe is missing, while the same ENOENT inside a path probe
 * is a plugin fault.
 * @param {unknown} error - the thrown value.
 * @param {{ discovery?: boolean, ref?: string }} [options] - caller context.
 * @returns {WslRouteError} the coded failure.
 */
export function classifyRouteFailure(error, { discovery = false, ref } = {}) {
  if (error instanceof WslRouteError) return error
  if (error?.timedOut === true || error?.code === 'ETIMEDOUT') {
    return new WslRouteError('distro-unreachable', {}, { cause: error })
  }
  if (error?.code === 'ENOENT' && discovery) {
    return new WslRouteError('wsl-not-available', {}, { cause: error })
  }
  if (error instanceof WslDomainError && DOMAIN_TO_PROTOCOL.has(error.code)) {
    return new WslRouteError(error.code, {}, { cause: error })
  }
  return new WslRouteError('internal', { ref: ref ?? newRef() }, { cause: error })
}

/**
 * The exact object a browser caller may receive.
 * @param {unknown} error - the thrown value.
 * @param {{ discovery?: boolean, ref?: string }} [options] - caller context.
 * @returns {{ code: string, params: Record<string, string> }} the filtered envelope.
 */
export function browserFailure(error, options = {}) {
  const coded = classifyRouteFailure(error, options)
  const allowed = SAFE_PARAMS[coded.code] ?? []
  const params = {}
  for (const key of allowed) {
    const value = coded.params?.[key]
    if (value === undefined || value === null) continue
    params[key] = String(value).slice(0, PARAM_LIMIT)
  }
  return { code: coded.code, params }
}
