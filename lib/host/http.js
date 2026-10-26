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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_BODY_BYTES, DEV_TOKEN_HEADER, tokenMatches } from '../http-admission.js'

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

/** Trust surface consumed here; the browser-side connection package owns the full type. */
export function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
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
