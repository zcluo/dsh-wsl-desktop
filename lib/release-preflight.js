/**
 * Pure decisions behind the live-release preflight.
 *
 * The preflight exists because the 0.6.0 release exposed two failure modes that
 * looked like code reds but were environment states: a production profile installs
 * the npm package with `developerTools: false` (every dev-token call is a 401), and a
 * staged generation can lag the tree while the host keeps serving the old bundle.
 * Both are decided from small, testable inputs — a patch file and a bootstrap
 * envelope — so this module carries no I/O and no `node:` imports.
 * @module dsh-wsl-desktop/release-preflight
 */

/** Markers the current browser half must carry in the served bundle. */
export const REQUIRED_CLIENT_MARKERS = Object.freeze([
  'bootstrapOnce',
  'data-wsl-degraded',
  'data-wsl-health',
  'data-wsl-degraded-retry',
])

/**
 * Read the developer-surface setting from an installed bundle patch.
 *
 * `sync.ps1` stages `config: { developerTools: true }`; the published package ships
 * no config block at all, so absence means off. An unreadable/missing patch is also
 * off: the preflight must not crash on the very state it reports.
 * @param {unknown} patchText - `cordis.patch.yml` contents.
 * @returns {{ found: boolean, developerTools: boolean }} the setting.
 */
export function parseDevSurface(patchText) {
  if (typeof patchText !== 'string') return { found: false, developerTools: false }
  const match = /^\s*developerTools:\s*(true|false)\s*$/mu.exec(patchText)
  if (match === null) return { found: false, developerTools: false }
  return { found: true, developerTools: match[1] === 'true' }
}

/**
 * Classify a bootstrap answer.
 * @param {{ status: number, json: object|null, expectedVersion: string, expectedCodes?: string[] }} input -
 *   the HTTP status, parsed body, and the version/codes this checkout requires.
 * @returns {{ kind: string, detail: string }} the verdict; `kind` is `ready` when the
 *   host is this tree with a working dev surface.
 */
export function classifyBootstrap({ status, json, expectedVersion, expectedCodes = [] }) {
  if (status === 401) {
    return { kind: 'dev-surface-disabled', detail: 'the route answered 401: the development token surface is off' }
  }
  if (status === 0 || status === undefined) {
    return { kind: 'unreachable', detail: 'no HTTP response: the desktop is not running or the URL is wrong' }
  }
  if (json === null || typeof json !== 'object' || json.ok !== true) {
    return { kind: 'bad-shape', detail: `HTTP ${status}: the route answered no bootstrap envelope` }
  }
  const value = json.value
  if (value === null || typeof value !== 'object') {
    return { kind: 'bad-shape', detail: `HTTP ${status}: bootstrap carried no value` }
  }
  if (value.pluginVersion !== expectedVersion) {
    return {
      kind: 'version-mismatch',
      detail: `host reports ${String(value.pluginVersion)}, this checkout is ${expectedVersion}`,
    }
  }
  const capability = value.capabilities?.status
  if (capability !== 'ok' && capability !== 'degraded' && capability !== 'pending') {
    return { kind: 'missing-capabilities', detail: `bootstrap carries no capability status (${String(capability)})` }
  }
  const codes = value.catalog?.codes
  const missing = codes === null || typeof codes !== 'object'
    ? expectedCodes
    : expectedCodes.filter((code) => !Object.hasOwn(codes, code))
  if (missing.length > 0) {
    return { kind: 'missing-codes', detail: `catalog is missing: ${missing.join(', ')}` }
  }
  return { kind: 'ready', detail: `host ${expectedVersion}, dev surface on` }
}

/**
 * Name the required markers a served bundle is missing.
 * @param {unknown} bundleText - the served client module.
 * @param {string[]} [markers] - the required markers.
 * @returns {string[]} the missing markers, in requirement order.
 */
export function missingClientMarkers(bundleText, markers = REQUIRED_CLIENT_MARKERS) {
  const text = String(bundleText ?? '')
  return markers.filter((marker) => !text.includes(marker))
}

/**
 * The operator-facing remedy for a host whose dev surface is off.
 * @returns {string} a short, copy-pasteable explanation.
 */
export function devSurfaceRemedy() {
  return [
    'The running host is not exposing its development surface (401).',
    'The published npm package ships developerTools: false by design; the staged dev',
    'generation turns it on.',
    'For a live verification run:',
    '  1. .\\scripts\\sync.ps1        (stage a dev generation with developerTools: true)',
    '  2. restart DSH Desktop       (the host half reloads; a page refresh is not enough)',
    '  3. node scripts/verify-all.mjs --live',
    'To return to the release shape afterwards, reinstall the registry bundle with',
    'plugin_manager remove_bundle + install_bundle dsh-wsl-desktop@<version>.',
  ].join('\n')
}
