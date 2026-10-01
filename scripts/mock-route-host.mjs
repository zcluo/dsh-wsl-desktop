/**
 * Reproduction harness for the two LIVE fence probes in verify-route.mjs.
 *
 * Those probes need the installed plugin behind the running desktop, and the
 * desktop serves a new host half only after a restart — so proving that they can
 * FAIL is awkward exactly when the fix is not deployed yet. This mock reproduces
 * the handler's decision path with the plugin's REAL pure admission functions
 * and the harness's fence contract (403 for an untrusted Host, 401 for an absent
 * browser cookie), so the suite can be driven end to end without a host:
 *
 *   # one shell — a scratch DSH_HOME, so the operator's real token file is untouched
 *   $env:DSH_HOME = "$env:TEMP\dsh-fence-mock-home"
 *   node scripts/mock-route-host.mjs old            # prints the URL it bound
 *   # another shell, same DSH_HOME
 *   $env:DSH_HOME = "$env:TEMP\dsh-fence-mock-home"
 *   node scripts/verify-route.mjs http://127.0.0.1:<printed port>
 *
 * Variant `old` applies the fence only when !developer — the D4 defect — and the
 * probe "LIVE, the only behavioural cover for the fence seam: a token holder
 * with a foreign Host is still refused" FAILS with 200 where 403 is required.
 * Variant `new` (the default) applies the shipped rule and every check passes.
 *
 * NOT a verification suite: verify-all.mjs does not run it, and it ships no
 * product code. The admission RULES it applies are the plugin's own functions;
 * the CALL ORDER is mirrored by hand, so a reordering inside lib/index.js's
 * handler must be mirrored here or this harness drifts. The live suite against
 * the real host remains the check that counts.
 *
 * Run: node scripts/mock-route-host.mjs [old|new] [pluginRoot] [port]
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [variant = 'new', root = join(here, '..'), port = '0'] = process.argv.slice(2)
if (variant !== 'old' && variant !== 'new') {
  console.error(`unknown variant ${variant}: use old or new`)
  process.exit(2)
}
const {
  DEV_TOKEN_HEADER, bodyAdmission, dispatchAdmission, fenceRejection, methodAdmission, preflight,
} = await import(pathToFileURL(join(root, 'lib/http-admission.js')).href)

/** The browser-reachable namespace, mirrored from lib/index.js. */
const BROWSER_METHODS = new Set(['listDistros', 'defaultDistro', 'listDir', 'checkPath', 'resolve', 'resolveHome', 'wslPresetFor'])
/** Only the read-only method the fence probes call; the rest never run here. */
const METHODS = { listDistros: async () => ['debian'] }

/**
 * The harness fence, as connection.requestRejection returns it: 403 for an
 * authority that is not loopback, else 401 because a scripted caller has no
 * browser cookie.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {401|403} the arm that applies.
 */
function requestRejection(req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
  return loopback ? 401 : 403
}

/**
 * The token read, as isDeveloperCaller performs it.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<boolean>} true when the caller presented this installation's token.
 */
async function isDeveloperCaller(req) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  let expected
  try {
    expected = (await readFile(join(home, 'wsl-desktop-dev-token'), 'utf8')).trim()
  } catch {
    return false
  }
  const presented = req.headers[DEV_TOKEN_HEADER]
  return typeof presented === 'string' && presented.length > 0 && presented === expected
}

/**
 * Answer one request with a JSON envelope.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {object} payload - the envelope.
 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const server = createServer(async (req, res) => {
  if (new URL(req.url, 'http://x').pathname !== '/wsl-desktop/api') {
    res.writeHead(404)
    res.end()
    return
  }
  const rejection = requestRejection(req)
  const developer = await isDeveloperCaller(req)
  // The two fence applications under test. `old` is the pre-fix gate: a token
  // holder skipped BOTH arms.
  const effective = variant === 'old'
    ? (rejection !== undefined && !developer ? rejection : undefined)
    : fenceRejection({ rejection, developer })
  if (effective !== undefined) {
    res.writeHead(effective, { 'content-type': 'text/plain; charset=utf-8' })
    res.end()
    return
  }
  const early = preflight({ httpMethod: req.method, contentType: req.headers['content-type'] })
  if (early.ok !== true) {
    send(res, early.status, { ok: false, code: early.code, error: early.message })
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  const sized = bodyAdmission({ byteLength: Buffer.byteLength(text) })
  if (sized.ok !== true) {
    send(res, sized.status, { ok: false, code: sized.code, error: sized.message })
    return
  }
  let envelope
  try {
    envelope = JSON.parse(text || '{}')
  } catch {
    send(res, 400, { ok: false, code: 'bad-request', error: 'not json' })
    return
  }
  const named = methodAdmission({ method: envelope?.method })
  if (named.ok !== true) {
    send(res, named.status, { ok: false, code: named.code, error: named.message })
    return
  }
  const method = envelope.method
  const run = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : undefined
  const admitted = dispatchAdmission({ method, developer, known: run !== undefined, browserReachable: BROWSER_METHODS.has(method) })
  if (admitted.ok !== true) {
    send(res, admitted.status, { ok: false, code: admitted.code, error: admitted.message })
    return
  }
  send(res, 200, { ok: true, value: await run(envelope.params ?? {}) })
})

server.listen(Number(port), '127.0.0.1', () => {
  const bound = server.address().port
  console.log(`mock route host (${variant}) on http://127.0.0.1:${bound}`)
  console.log(`drive it with: node scripts/verify-route.mjs http://127.0.0.1:${bound}`)
})
