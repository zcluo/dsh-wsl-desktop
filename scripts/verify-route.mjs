/**
 * The route's admission rules, and the transport fence in front of them.
 *
 * The pure rules are checked directly. The fence is checked against the running
 * host, and the important assertion is not the status code but the ABSENCE of
 * the side effect: an unauthenticated `text/plain` POST used to run arbitrary
 * commands inside a distribution, so the probe writes a file and the suite
 * asserts the file was never created.
 *
 * Requires the installed plugin behind a running host (`developerTools: true`,
 * which `scripts/sync.ps1` stages). Run: node scripts/verify-route.mjs [baseUrl]
 */

import { existsSync, rmSync } from 'node:fs'
import {
  DEV_TOKEN_HEADER as HOST_TOKEN_HEADER, MAX_BODY_BYTES, bodyAdmission, dispatchAdmission, methodAdmission, preflight, tokenMatches,
} from '../lib/http-admission.js'
import { DEV_TOKEN_HEADER, ensureDevToken } from './dev-token.mjs'
import { resolveDistro } from './env.mjs'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:19387'
const endpoint = `${baseUrl}/wsl-desktop/api`
// The side-effect probe needs a share this distribution actually exposes; a
// hardcoded name would make the load-bearing "it did not run" assertion check
// the wrong share and pass vacuously on any other machine.
const distro = resolveDistro()
const shareRoot = `\\\\wsl.localhost\\${distro}`

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${String(detail)}`}`)
  if (!ok) failures += 1
}

/**
 * Post one envelope and return the raw response facts.
 * @param {object} envelope - the request body.
 * @param {{ contentType?: string, token?: string|null, body?: string }} [options] - wire overrides.
 * @returns {Promise<{ status: number, json: any|null, text: string }>} the response.
 */
async function post(envelope, options = {}) {
  const contentType = options.contentType ?? 'application/json'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      ...(options.token === undefined || options.token === null
        ? {}
        : { [DEV_TOKEN_HEADER]: options.token }),
    },
    body: options.body ?? JSON.stringify(envelope),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // A refusal may answer with an empty or non-JSON body; the status carries it.
  }
  return { status: response.status, json, text }
}

console.log(`checking the route at ${endpoint}\n`)

console.log('admission rules (pure)')
check('a non-POST is refused', preflight({ httpMethod: 'GET', contentType: 'application/json' }).status === 405)
check('a text/plain body is refused (it would be a CORS-simple request)',
  preflight({ httpMethod: 'POST', contentType: 'text/plain' }).status === 415)
check('a charset parameter is still application/json',
  preflight({ httpMethod: 'POST', contentType: 'application/json; charset=utf-8' }).ok === true)
check('an absent content-type is refused',
  preflight({ httpMethod: 'POST', contentType: undefined }).status === 415)
check('an oversized body is refused', bodyAdmission({ byteLength: MAX_BODY_BYTES + 1 }).status === 413)
check('a body at the ceiling is admitted', bodyAdmission({ byteLength: MAX_BODY_BYTES }).ok === true)
check('a missing method name is refused', methodAdmission({ method: undefined }).status === 400)
check('an unknown method is refused', dispatchAdmission({ method: 'nope', developer: true, known: false, browserReachable: false }).status === 404)
check('a browser caller cannot reach a command-executing method',
  dispatchAdmission({ method: 'execInWsl', developer: false, known: true, browserReachable: false }).status === 403)
check('a browser caller can reach a discovery method',
  dispatchAdmission({ method: 'listDistros', developer: false, known: true, browserReachable: true }).ok === true)
check('a developer caller can reach everything',
  dispatchAdmission({ method: 'execInWsl', developer: true, known: true, browserReachable: false }).ok === true)
check('the token comparison is length- and value-checked',
  tokenMatches('abc', 'abc', (l, r) => l.equals(r)) === true
  && tokenMatches('abc', 'abd', (l, r) => l.equals(r)) === false
  && tokenMatches('', 'abc', (l, r) => l.equals(r)) === false
  && tokenMatches(undefined, 'abc', (l, r) => l.equals(r)) === false)
check('the host half uses the same header name', DEV_TOKEN_HEADER === HOST_TOKEN_HEADER)

const probeFile = '/tmp/dsh-wsl-fence-probe.txt'
rmSync(`${shareRoot}${probeFile}`, { force: true })

console.log('\ntransport fence (live host)')
const unauthenticated = await post({ method: 'execInWsl', params: { cwd: '/tmp', command: `echo BYPASSED > ${probeFile}` } }, {
  contentType: 'text/plain',
})
check('an unauthenticated text/plain POST is refused', unauthenticated.status === 401, unauthenticated.status)
const escaped = existsSync(`${shareRoot}${probeFile}`)
check('and the command it carried did not run', escaped === false, `probe file exists: ${escaped}`)

const unauthenticatedJson = await post({ method: 'listDistros', params: {} })
check('the fence covers the read-only methods too', unauthenticatedJson.status === 401, unauthenticatedJson.status)

console.log('\ndevelopment surface')
const token = await ensureDevToken()
const authorized = await post({ method: 'listDistros', params: {} }, { token })
check('a caller holding the token reaches the acceptance surface',
  authorized.status === 200 && authorized.json?.ok === true, `${authorized.status} ${authorized.text.slice(0, 120)}`)
const wrongToken = await post({ method: 'listDistros', params: {} }, { token: 'nope' })
check('a wrong token is refused', wrongToken.status === 401, wrongToken.status)
const badType = await post({ method: 'listDistros', params: {} }, { token, contentType: 'text/plain' })
check('the media type is still enforced for a developer caller', badType.status === 415, badType.status)
const unknown = await post({ method: 'no-such-method', params: {} }, { token })
check('an unknown method answers 404', unknown.status === 404, unknown.status)
const oversized = await post({ method: 'listDistros', params: {} }, {
  token,
  body: JSON.stringify({ method: 'listDistros', params: { pad: 'x'.repeat(MAX_BODY_BYTES + 1024) } }),
})
check('an oversized body answers 413', oversized.status === 413, oversized.status)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
