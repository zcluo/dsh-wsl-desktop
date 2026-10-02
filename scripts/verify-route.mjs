/**
 * The route's admission rules, and the transport fence in front of them.
 *
 * The pure rules are checked directly. The fence is checked against the running
 * host, and the important assertion is not the status code but the ABSENCE of
 * the side effect: an unauthenticated `text/plain` POST used to run arbitrary
 * commands inside a distribution, so the probe writes a file and the suite
 * asserts the file was never created.
 *
 * The fence is probed again with a VALID token and a foreign Host — the case the
 * security audit found missing. A development token replaces the
 * browser-authentication arm only, never the Host/Origin arm, so the rebinding
 * refusal must still stand for a token holder. That pair is the ONLY
 * behavioural cover for the handler's fence call: the offline checks in
 * verify-modules.mjs execute the pure rule or read lib/index.js as text, and no
 * offline caller can run the handler at all. To reproduce their RED without a
 * host, drive this suite against scripts/mock-route-host.mjs — its header
 * carries the two commands.
 *
 * Requires the installed plugin behind a running host (`developerTools: true`,
 * which `scripts/sync.ps1` stages). Run: node scripts/verify-route.mjs [baseUrl]
 */

import { existsSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import {
  DEV_TOKEN_HEADER as HOST_TOKEN_HEADER, MAX_BODY_BYTES, bodyAdmission, dispatchAdmission, methodAdmission, preflight, tokenMatches,
} from '../lib/http-admission.js'
import { DEV_TOKEN_HEADER, ensureDevToken } from './dev-token.mjs'
import { resolveDistro } from './env.mjs'
import { detailText } from './detail.mjs'

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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

/**
 * Post one envelope and return the raw response facts.
 * @param {object} envelope - the request body.
 * @param {{ contentType?: string, token?: string|null, body?: string, host?: string }} [options] - wire overrides; `host` forges the Host header.
 * @returns {Promise<{ status: number, json: any|null, text: string }>} the response.
 */
async function post(envelope, options = {}) {
  const contentType = options.contentType ?? 'application/json'
  const body = options.body ?? JSON.stringify(envelope)
  const headers = {
    'content-type': contentType,
    ...(options.token === undefined || options.token === null
      ? {}
      : { [DEV_TOKEN_HEADER]: options.token }),
    ...(options.host === undefined ? {} : { host: options.host }),
  }
  const { status, text } = options.host === undefined
    ? await fetchPost(headers, body)
    : await rawPost(headers, body)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // A refusal may answer with an empty or non-JSON body; the status carries it.
  }
  return { status, json, text }
}

/**
 * Post through the Fetch API.
 * @param {Record<string, string>} headers - the wire headers.
 * @param {string} body - the request body.
 * @returns {Promise<{ status: number, text: string }>} the response facts.
 */
async function fetchPost(headers, body) {
  const response = await fetch(endpoint, { method: 'POST', headers, body })
  return { status: response.status, text: await response.text() }
}

/**
 * Post through node:http, which — unlike the Fetch API — can forge the Host
 * header. Fetch refuses to set it (a forbidden header name) and undici drops it
 * in silence: measured, the server saw the URL's authority while an Origin
 * header passed through untouched. A probe presenting a foreign authority needs
 * this client, which is also the one a local script would use.
 * @param {Record<string, string>} headers - the wire headers, `host` included.
 * @param {string} body - the request body.
 * @returns {Promise<{ status: number, text: string }>} the response facts.
 */
function rawPost(headers, body) {
  const target = new URL(endpoint)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers,
    }, (response) => {
      response.setEncoding('utf8')
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
    })
    request.on('error', reject)
    request.end(body)
  })
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

// The probe path is UNIQUE TO THIS PROCESS. It was the fixed machine-global
// `/tmp/dsh-wsl-fence-probe.txt`, so a CONCURRENT run's pre-removal could land between the POST
// and the existence check below and report a real escape as contained. The pre-removal stays —
// it can now only remove this process's own path — and the ABSENCE is asserted before the POST
// as well, so the check after it is a change this run made, not an absence that was already
// there. `existsSync` under the share root is the only channel the fence check has, so the
// positive control further down proves that channel can see this write at all.
const probeFile = `/tmp/dsh-wsl-fence-probe-${process.pid}.txt`
rmSync(`${shareRoot}${probeFile}`, { force: true })
// The removal is on the line AFTER the spelling ON PURPOSE: verify-all-skip's section H scans
// for exactly this shape (a `dsh-` name under a fixed root, spelled without a pid, created or
// removed within one line of where it is spelled) and accepts this one only because of the pid.
// Putting an intermediate const between the spelling and the removal would move this file
// outside the scan's window, and a dropped suffix would then be undetectable.
const probeHostPath = `${shareRoot}${probeFile}`
const probeAbsentBefore = !existsSync(probeHostPath)
check('the escape probe starts from an absent path, so its absence below is a change this run made',
  probeAbsentBefore, `path=${probeHostPath} exists=${!probeAbsentBefore}`)

console.log('\ntransport fence (live host)')
const unauthenticated = await post({ method: 'execInWsl', params: { cwd: '/tmp', command: `echo BYPASSED > ${probeFile}` } }, {
  contentType: 'text/plain',
})
check('an unauthenticated text/plain POST is refused', unauthenticated.status === 401, unauthenticated.status)
const escaped = existsSync(probeHostPath)
check('and the command it carried did not run',
  escaped === false && probeAbsentBefore,
  `probe file exists: ${escaped} (absent before the POST: ${probeAbsentBefore}); path=${probeHostPath}`)
rmSync(probeHostPath, { force: true })

const unauthenticatedJson = await post({ method: 'listDistros', params: {} })
check('the fence covers the read-only methods too', unauthenticatedJson.status === 401, unauthenticatedJson.status)

console.log('\ndevelopment surface')
const token = await ensureDevToken()
const authorized = await post({ method: 'listDistros', params: {} }, { token })
check('a caller holding the token reaches the acceptance surface',
  authorized.status === 200 && authorized.json?.ok === true, `${authorized.status} ${authorized.text.slice(0, 120)}`)
// POSITIVE CONTROL for the transport-fence pair above, and what makes that pair evidence rather
// than a blind spot: "the file is absent" only means "the command did not run" if the SAME write
// is observable through the SAME measurement when it DOES run. An admitted caller (developer
// token, served authority) sends the same shape, and the file must appear under the share root.
const controlFile = `/tmp/dsh-wsl-fence-control-${process.pid}.txt`
const controlHostPath = `${shareRoot}${controlFile}`
rmSync(controlHostPath, { force: true })
const admitted = await post({ method: 'execInWsl', params: { distro, cwd: '/tmp', command: `echo ADMITTED > ${controlFile}` } }, { token })
const controlLanded = existsSync(controlHostPath)
check('LIVE, positive control: an ADMITTED caller writing the same shape DOES land where the fence check looks',
  admitted.status === 200 && controlLanded,
  `${admitted.status} exists=${controlLanded} path=${controlHostPath} ${admitted.text.slice(0, 120)}`)
rmSync(controlHostPath, { force: true })
// The token is a credential for the browser-authentication arm ONLY. No case
// posted a VALID token with a foreign Host, which is how the route came to skip
// both arms for a token holder. 403 AND a bodyless refusal: a JSON envelope
// would be the method-level refusal (dispatchAdmission), a different decision.
// The two probes below are the ONLY behavioural cover for the handler's fence
// call — the offline checks either execute the pure rule or read the source.
const foreignHost = await post({ method: 'listDistros', params: {} }, { token, host: 'attacker.example' })
check('LIVE, the only behavioural cover for the fence seam: a token holder with a foreign Host is still refused (a token does not replace the fence)',
  foreignHost.status === 403 && foreignHost.json === null,
  `${foreignHost.status} ${foreignHost.text.slice(0, 120)}`)
// The control for that probe: the same forged-Host transport and the same
// token, but the authority the host actually serves — so the refusal above is
// the Host VALUE, not the raw client.
const servedAuthority = new URL(baseUrl).host
const trustedHost = await post({ method: 'listDistros', params: {} }, { token, host: servedAuthority })
check('LIVE, behavioural control for that probe: the same token against the served authority is admitted',
  trustedHost.status === 200 && trustedHost.json?.ok === true,
  `${trustedHost.status} ${trustedHost.text.slice(0, 120)}`)
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
