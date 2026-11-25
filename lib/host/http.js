/**
 * The route's HTTP seam: reading a JSON body, answering with one, and deciding
 * whether a caller may reach the development-token surface.
 *
 * Extracted verbatim from `lib/index.js` (C3). Nothing in here is new behaviour;
 * the move exists so the plugin entry file carries wiring and lifecycle rather
 * than request plumbing.
 * @module dsh-wsl-desktop/host/http
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_BODY_BYTES, DEV_TOKEN_HEADER, tokenMatches } from '../http-admission.js'

/** Ceiling for the route-failure log, so a repeated failure cannot fill the disk. */
const ROUTE_LOG_MAX_BYTES = 256 * 1024

/**
 * The harness home that holds the user preset root.
 * @returns {string} the resolved `$DSH_HOME`.
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Read one JSON request body, bounded.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns {Promise<{ text: string | null, byteLength: number }>} the body, or null past the ceiling.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return { text: null, byteLength: size }
    }
    chunks.push(chunk)
  }
  return { text: Buffer.concat(chunks, size).toString('utf8'), byteLength: size }
}

/**
 * Answer one request with a JSON envelope and an explicit status.
 * @param {import('node:http').ServerResponse} res - the response to complete.
 * @param {number} status - the HTTP status.
 * @param {{ ok: boolean }} payload - the envelope, success or failure.
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Answer with one admission rejection.
 * @param {import('node:http').ServerResponse} res - the response to complete.
 * @param {import('../http-admission.js').Rejection} rejection - the refusal.
 */
export function sendRejection(res, rejection) {
  sendJson(res, rejection.status, { ok: false, code: rejection.code, error: rejection.message })
}

/**
 * Trust surface consumed here; the browser-side connection package owns the full type.
 *
 * `ctx.connection` is the only spelling that works, and it works because this
 * plugin declares `connection` in its `inject` list. There is deliberately NO
 * `ctx.get` fallback: Cordis resolves an injected service property against the
 * CALLING context and THROWS for a service the caller never injected (`cannot get
 * property "connection" without inject`) rather than returning `undefined`, so a
 * fallback could not rescue that case — and when the service is genuinely
 * unprovided, `ctx.get` returns `undefined` too, which the caller already
 * handles. A fallback here would suggest a protection that does not exist.
 * @param {object} ctx - the plugin context.
 * @returns {object | undefined} the connection handle, when this composition has one.
 */
export function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Ask the composition's connection service to admit one request.
 *
 * Two accessors have carried the same two arms (403 for an untrusted Host/Origin,
 * 401 for an unauthenticated browser) across desktop generations:
 *
 * - `admit(request)` returns the arms as an `{ peer } | { rejection }` union. It
 *   exists in every published 0.1.x/0.2.1/0.2.2 release and on master.
 * - `requestRejection(request)` returned the rejection directly. Master (harness
 *   commit 71753fdf91, which no published 0.2.2 tag contains) dropped it; every
 *   published release still has it.
 *
 * WHICH CALLER MAY CALL `admit` IS GENERATION-DEPENDENT, and that is the trap this
 * file exists to make impossible to fall into twice. The published generation
 * reads a constructor-bound verifier, so any caller holding the service can call
 * it. The master generation instead stores `this.authentication =
 * ctx['connection.authentication']` and re-reads it inside `admit()`; Cordis's
 * traceable proxy rewrites that `this` into a shadow, so `this.authentication`
 * resolves against the CALLING fiber — and a caller whose own `inject` does not
 * name the sub-service gets `cannot get property "connection.authentication"
 * without inject`, thrown from inside `admit`. Measured on the real Cordis build:
 * that is a 500 on every request, and the fix is `openAdmission` below, never a
 * claim in a comment.
 *
 * FAILURE DIRECTION: every shape this function does not positively recognise
 * throws. An `admit` that answers something other than the two documented arms is
 * a host this file was not written against, and the one answer that must never be
 * produced from it is "admitted" — a thrown error is caught by the route's guard
 * and answered as a JSON `internal`, while a silent `undefined` runs the command.
 * (`requestRejection`'s own contract is different and is honoured as-is: it
 * returns the status or `undefined` for admitted, so `undefined` is its answer,
 * not an unknown shape.)
 * @param {object} connection - the handle `connectionOf` returned.
 * @param {import('node:http').IncomingMessage} req - the request to admit.
 * @returns {number | undefined} the status that refuses the request, or undefined when it may proceed.
 * @throws {Error} when the handle exposes no accessor, or `admit` answers an unrecognised shape.
 */
export function rejectRequest(connection, req) {
  if (typeof connection?.admit === 'function') {
    const admission = connection.admit(req)
    if (admission === null || typeof admission !== 'object') {
      throw new Error(`connection.admit answered ${admission === null ? 'null' : typeof admission} instead of an admission`)
    }
    if ('rejection' in admission) return admission.rejection
    if ('peer' in admission) return undefined
    throw new Error(`connection.admit answered an admission carrying neither arm (keys: ${Object.keys(admission).join(', ') || 'none'})`)
  }
  if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  throw new Error(`the composition exposes no connection admission (got ${connection === undefined ? 'undefined' : typeof connection})`)
}

/**
 * Open the admission call the route uses, for whichever generation is running.
 *
 * The plugin's MODULE-LEVEL `inject` may only name services every published host
 * provides, so it cannot name `connection.authentication` (0.8.1 did, and died
 * pending on every published host). But the master generation's `admit()` needs
 * the CALLING context to have that service available, or it throws. Both
 * constraints are satisfiable at once because Cordis has two inject mechanisms:
 *
 * - module-level `export const inject` gates the WHOLE plugin fiber — a name
 *   nothing provides leaves the plugin pending forever, with no `apply()`;
 * - function-level `ctx.inject(names, callback)` starts a CHILD fiber. A name
 *   nothing provides leaves only that child pending; the parent still runs
 *   `apply()`, still registers its route, and emits no warning.
 *
 * So: the parent injects the published top-level services, and the child asks for
 * the sub-service too. On the master generation the child resolves and its
 * `connection` handle can call `admit()` (the child's fiber names the
 * sub-service, so the shadowed read succeeds). On the published generation the
 * child never resolves — and none is needed, because that generation's `admit()`
 * already works from the parent's own handle. The returned function picks
 * whichever is live at request time.
 *
 * A stale child cannot silently admit: the fallback is the parent's handle, whose
 * accessor is verified by `rejectRequest` on every call.
 * @param {object} ctx - the plugin context inside `apply`.
 * @returns {(connection: object, req: import('node:http').IncomingMessage) => Promise<number | undefined>} the request-time admission call, given the parent's handle.
 */
export function openAdmission(ctx) {
  let childScope = null
  let settleChild
  const childSettled = new Promise((resolve) => { settleChild = resolve })
  ctx.inject(['connection', 'connection.authentication'], (childCtx) => {
    childScope = childCtx
    settleChild()
  })
  // The child fiber settles a tick AFTER `apply()` returns (measured), so the
  // first request can arrive before it exists. On a master-built host that first
  // request would otherwise hit the parent handle and throw. Wait for the child
  // ONCE, with a bound: on the published generation the child never settles, so
  // the wait is paid at most once rather than on every request.
  let firstCallWaited = false
  return async (connection, req) => {
    if (childScope === null && !firstCallWaited) {
      firstCallWaited = true
      await Promise.race([childSettled, new Promise((resolve) => { setTimeout(resolve, CHILD_SETTLE_BOUND_MS) })])
    }
    // Re-read through the live scope rather than capturing one handle: a child
    // fiber can be torn down and rebuilt, and a captured service would then be
    // stale. Reading `undefined` (no child) simply falls back to the parent.
    const viaChild = childScope === null ? undefined : Reflect.get(childScope, 'connection')
    return rejectRequest(viaChild ?? connection, req)
  }
}

/** How long the first request waits for `openAdmission`'s child fiber to settle. */
const CHILD_SETTLE_BOUND_MS = 250

/**
 * Append one route failure to a log the operator can read.
 *
 * The route answers the browser with a code and nothing else — deliberately, so
 * a host path or a wsl.exe stderr never crosses the wire. That is right for
 * production and useless when the ROUTE ITSELF throws before it can name a
 * reason: the browser shows `internal`, the host logs through a channel the
 * desktop does not surface, and the only remaining evidence is this file. It is
 * written on the operator's own disk, never sent anywhere.
 * @param {string} step - the admission step that failed.
 * @param {unknown} error - the thrown value.
 * @returns {Promise<void>} settlement; a logging failure never masks the refusal.
 */
export async function logRouteFailure(step, error) {
  try {
    const path = join(dshHome(), 'wsl-desktop-route-error.log')
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const line = `${new Date().toISOString()} [${step}] ${detail}\n`
    await mkdir(dirname(path), { recursive: true })
    // Bounded, because a route that fails on every request would otherwise fill
    // the operator's disk. Crossing the cap restarts the file with a note, so
    // the NEWEST failure is always present and the file never grows without
    // limit. A silently truncated diagnostic is worse than a fresh one.
    let size = 0
    try {
      size = (await stat(path)).size
    } catch {
      size = 0
    }
    if (size + Buffer.byteLength(line) > ROUTE_LOG_MAX_BYTES) {
      await writeFile(path, `[truncated above ${ROUTE_LOG_MAX_BYTES} bytes]\n`, 'utf8')
    }
    await writeFile(path, line, { flag: 'a' })
  } catch {
    // A diagnostic that throws must not change the response the caller gets.
  }
}

/**
 * This installation's development token, minted on first use.
 *
 * The file is owner-only and lives outside the repository. A web page cannot
 * read it, which is what keeps the acceptance surface unreachable from a
 * cross-site request even though the route itself is on loopback.
 * @returns {Promise<string>} the token.
 */
export async function devToken() {
  const path = join(dshHome(), 'wsl-desktop-dev-token')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length > 0) return existing
    // An empty file is unusual — treat it like absent and re-mint below.
  } catch (error) {
    // ENOENT = first use. Any other read failure (ACL, AV lock, disk) must
    // fail loud rather than silently rotate the credential and revoke every
    // scripted caller.
    if (error?.code !== 'ENOENT') throw error
  }
  const minted = randomBytes(32).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${minted}\n`, { mode: 0o600 })
  return minted
}

/**
 * Whether one request may use the acceptance surface.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {{ developerTools: boolean }} config - resolved plugin config.
 * @returns {Promise<boolean>} true for a caller presenting this installation's token.
 */
export async function isDeveloperCaller(req, config) {
  if (config.developerTools !== true) return false
  return tokenMatches(req.headers[DEV_TOKEN_HEADER], await devToken(), timingSafeEqual)
}
