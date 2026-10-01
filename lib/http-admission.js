/**
 * Route admission: the ordered checks one request passes before a method runs.
 *
 * The route is on loopback and its methods can run commands, so admission is an
 * authority decision rather than a formality. Keeping it here — a pure module
 * with no harness imports — is what lets a standalone suite prove each rule
 * without a running host; the transport fence's CALL stays in the caller,
 * because it needs the composition's connection service, while the rule about
 * which of its arms a development token may replace is here, because it is pure.
 *
 * @module dsh-wsl-desktop/http-admission
 */

/** Request bodies here are small JSON objects; anything larger is hostile. */
export const MAX_BODY_BYTES = 64 * 1024

/** Header a development caller presents to reach the acceptance surface. */
export const DEV_TOKEN_HEADER = 'x-dsh-wsl-dev-token'

/**
 * @typedef {{ status: number, code: string, message: string }} Rejection
 * @typedef {{ ok: true } | Rejection} Admission
 */

/**
 * The transport fence's decision for one caller.
 *
 * `connection.requestRejection` returns one of exactly two arms from a single
 * call: 403 when the Host/Origin is not trusted (the DNS-rebinding defence) and
 * 401 when the browser session is not authenticated. A development token is a
 * credential for the second arm only — a local script cannot present a browser
 * cookie — and never for the first: a token holder gains nothing from a trusted
 * Host, so replacing that arm would drop the defence for every caller.
 * @param {{ rejection: number | undefined, developer: boolean }} request - the fence's answer and the resolved caller.
 * @returns {number | undefined} the status that still refuses the request, or undefined when it may proceed.
 */
export function fenceRejection({ rejection, developer }) {
  // Whitelisted by exact value: an arm this build does not know is not
  // replaceable by a token, so a new rejection fails closed for every caller.
  if (rejection === 401 && developer) return undefined
  return rejection
}

/**
 * The checks that need no body: the transport fence, the method, and the media
 * type. The fence is applied by the caller before this runs.
 * @param {{ httpMethod?: string, contentType?: unknown }} request - the wire facts.
 * @returns {Admission} the outcome.
 */
export function preflight({ httpMethod, contentType }) {
  if (httpMethod !== 'POST') {
    return { status: 405, code: 'method-not-allowed', message: '仅支持 POST' }
  }
  // The essence must be exactly application/json: `text/plain` would make the
  // request CORS-simple, so a cross-site page could send it without a preflight.
  const essence = String(contentType).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    return { status: 415, code: 'unsupported-media-type', message: 'content-type 必须是 application/json' }
  }
  return { ok: true }
}

/**
 * The check that needs the body's size, before it is parsed.
 * @param {{ byteLength?: number }} request - the wire facts.
 * @returns {Admission} the outcome.
 */
export function bodyAdmission({ byteLength }) {
  if (typeof byteLength === 'number' && byteLength > MAX_BODY_BYTES) {
    return { status: 413, code: 'payload-too-large', message: `请求体超过 ${MAX_BODY_BYTES} 字节` }
  }
  return { ok: true }
}

/**
 * The check that needs the parsed body's method name.
 * @param {{ method?: unknown }} envelope - the parsed request body.
 * @returns {Admission} the outcome.
 */
export function methodAdmission({ method }) {
  if (typeof method !== 'string' || method.length === 0) {
    return { status: 400, code: 'bad-request', message: '请求体缺少 method 字符串' }
  }
  return { ok: true }
}

/**
 * The namespace check: which caller may reach which method.
 *
 * A development caller may use everything. An authenticated browser caller may
 * use only the read-only discovery methods, because the rest execute commands,
 * create sessions, or rewrite the preset root.
 * @param {{ method: string, developer: boolean, known: boolean, browserReachable: boolean }} request - the resolved caller and method.
 * @returns {Admission} the outcome.
 */
export function dispatchAdmission({ method, developer, known, browserReachable }) {
  if (!known) {
    return { status: 404, code: 'unknown-method', message: `未知方法：${method}` }
  }
  if (!developer && !browserReachable) {
    return {
      status: 403,
      code: 'method-forbidden',
      message: `${method} 需要开发令牌（该路由可被浏览器同源访问）`,
    }
  }
  return { ok: true }
}

/**
 * Compare a presented development token with the installation's own.
 * @param {unknown} presented - the header value.
 * @param {string} expected - this installation's token.
 * @param {(left: Buffer, right: Buffer) => boolean} equals - constant-time comparison.
 * @returns {boolean} true when the caller presented the token.
 */
export function tokenMatches(presented, expected, equals) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && equals(left, right)
}
