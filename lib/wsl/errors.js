/**
 * Typed failures the world probes raise.
 *
 * The route must turn a failure into a browser code WITHOUT reading a message: the
 * message may carry wsl.exe stderr and resolved paths, and matching on it is how a
 * wording change becomes a routing bug. These codes are the domain facts; the
 * protocol catalog owns the wire vocabulary the browser sees.
 * @module dsh-wsl-desktop/wsl/errors
 */

/** The domain codes a `WslDomainError` may carry. */
export const DOMAIN_CODES = Object.freeze([
  'distro-unreachable',
  'user-unknown',
  'path-not-found',
  'path-not-directory',
  'path-denied',
])

/**
 * A failure with a machine-readable domain code.
 */
export class WslDomainError extends Error {
  /**
   * @param {string} code - one of {@link DOMAIN_CODES}.
   * @param {string} message - the host-side diagnostic (never sent to the browser).
   * @param {{ cause?: unknown }} [options] - the underlying failure.
   */
  constructor(code, message, options = {}) {
    if (!DOMAIN_CODES.includes(code)) {
      throw new Error(`wsl: unknown domain code ${JSON.stringify(code)}`)
    }
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WslDomainError'
    this.code = code
  }
}
