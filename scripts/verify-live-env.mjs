/**
 * The live release preflight: is this running host the tree we just tested?
 *
 * The 0.6.0 release exposed two environment states that looked like code reds:
 *  - a production profile installs the npm package with `developerTools: false`, so
 *    every dev-token call is a 401 and three live suites go red with no cause;
 *  - a staged generation can lag the tree while the host keeps serving the old
 *    host half and client bundle.
 * This runs FIRST in `verify-all --live` and turns both into one actionable line.
 *
 * Run: node scripts/verify-live-env.mjs [baseUrl]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeChecker } from './suite-shell.mjs'
import { DEV_TOKEN_HEADER, dshHome, ensureDevToken } from './dev-token.mjs'
import { readServedClient } from './live-client.mjs'
import {
  REQUIRED_CLIENT_MARKERS,
  classifyBootstrap,
  devSurfaceRemedy,
  missingClientMarkers,
  parseDevSurface,
} from '../lib/release-preflight.js'

const baseUrl = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const endpoint = `${baseUrl}/wsl-desktop/api`
const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const expectedCodes = ['path-denied', 'catalog-unavailable', 'host-plugin-stale']
const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

/** The installed bundle patch, for diagnosing the dev-surface state. */
const profile = process.env.DSH_WSL_PROFILE ?? 'desktop'
const patchPath = join(dshHome(), 'profiles', profile, 'node_modules', 'dsh-wsl-desktop', 'cordis.patch.yml')
let installedSurface = { found: false, developerTools: false }
try {
  installedSurface = parseDevSurface(await readFile(patchPath, 'utf8'))
} catch {
  installedSurface = { found: false, developerTools: false }
}
if (!installedSurface.developerTools) {
  console.log(`        installed patch: ${patchPath} (developerTools off or unreadable)`)
}

console.log(`preflighting the live host at ${baseUrl}\n`)

const token = await ensureDevToken()
let boot
let bootJson = null
try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [DEV_TOKEN_HEADER]: token },
    body: JSON.stringify({ method: 'bootstrap', params: {} }),
  })
  boot = response.status
  try {
    bootJson = await response.json()
  } catch {
    bootJson = null
  }
} catch (error) {
  boot = 0
  console.log(`        POST ${endpoint} failed: ${error?.message ?? error}`)
}

const verdict = classifyBootstrap({ status: boot, json: bootJson, expectedVersion, expectedCodes })
check('the running host is this checkout behind an enabled dev surface', verdict.kind === 'ready', verdict.detail)
if (verdict.kind === 'dev-surface-disabled') {
  console.log(`\n${devSurfaceRemedy()}\n`)
}
if (verdict.kind === 'version-mismatch' || verdict.kind === 'missing-codes') {
  console.log('        stage this checkout with .\\scripts\\sync.ps1, then RESTART DSH Desktop;')
  console.log('        a page refresh reloads the client half but not the host half.\n')
}

let served = null
try {
  served = await readServedClient(baseUrl)
  check('the page is served the current browser half',
    served.bundle.length > 0 && missingClientMarkers(served.bundle).length === 0,
    missingClientMarkers(served.bundle))
} catch (error) {
  check('the page is served the current browser half', false, error?.message ?? error)
}

if (verdict.kind === 'ready' && served !== null && missingClientMarkers(served.bundle).length === 0) {
  console.log(`\nready: host ${expectedVersion}, client rev ${served.entry.rev}, ${served.bundle.length} bytes`)
}

const code = checker.failures > 0 ? 1 : 0
console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exitCode = code
