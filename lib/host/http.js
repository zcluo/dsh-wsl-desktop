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
 * `ctx.get` fallback: Cordis resolves a service property against the CALLING
 * context and THROWS for a service the caller never injected (`cannot get
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
