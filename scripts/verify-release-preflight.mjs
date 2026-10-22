/**
 * Offline checks for the live-environment release preflight.
 *
 * The live preflight itself needs a running host, but its two dangerous decisions —
 * "is the dev surface enabled?" and "is this host really the tree we tested?" — are
 * pure: a YAML patch and a bootstrap envelope in, a verdict out. Those are pinned
 * here so the live suite cannot silently pass on a stale host.
 *
 * Run: node scripts/verify-release-preflight.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import {
  REQUIRED_CLIENT_MARKERS,
  classifyBootstrap,
  devSurfaceRemedy,
  missingClientMarkers,
  parseDevSurface,
} from '../lib/release-preflight.js'

const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

/** The patch shape `sync.ps1` stages: developerTools explicitly on. */
const STAGED_PATCH = `# Bundle patch for dsh-wsl-desktop.
- id: wsl-desktop-1022011123
  name: 'dsh-wsl-desktop'
  config:
    developerTools: true
`

/** The patch shipped in the npm package: no config block at all. */
const NPM_PATCH = `# Bundle patch for dsh-wsl-desktop.
- id: wsl-desktop
  name: 'dsh-wsl-desktop'
`

console.log('dev surface')

{
  const staged = parseDevSurface(STAGED_PATCH)
  check('a staged patch enables the dev surface', staged.found === true && staged.developerTools === true, staged)
  const release = parseDevSurface(NPM_PATCH)
  check('the npm patch leaves it off', release.found === false && release.developerTools === false, release)
  const explicitOff = parseDevSurface(NPM_PATCH + '  config:\n    developerTools: false\n')
  check('an explicit false is found and off',
    explicitOff.found === true && explicitOff.developerTools === false, explicitOff)
  const absent = parseDevSurface(null)
  check('an unreadable patch is treated as off, not as an exception',
    absent.found === false && absent.developerTools === false, absent)
}

console.log('\nbootstrap classification')

{
  const unauthorized = classifyBootstrap({ status: 401, json: null, expectedVersion: '0.6.0' })
  check('a 401 is the disabled dev surface, not a broken host',
    unauthorized.kind === 'dev-surface-disabled', unauthorized)
  const unreachable = classifyBootstrap({ status: 0, json: null, expectedVersion: '0.6.0' })
  check('a connection failure is unreachable', unreachable.kind === 'unreachable', unreachable)
  const serverError = classifyBootstrap({ status: 500, json: null, expectedVersion: '0.6.0' })
  check('a non-JSON 5xx is reported as a bad shape, not a version mismatch',
    serverError.kind === 'bad-shape', serverError)
  const wrongVersion = classifyBootstrap({
    status: 200,
    expectedVersion: '0.6.0',
    json: { ok: true, value: { pluginVersion: '0.5.1', capabilities: { status: 'ok' }, catalog: { codes: {} } } },
  })
  check('a different plugin version is a version mismatch',
    wrongVersion.kind === 'version-mismatch' && wrongVersion.detail.includes('0.5.1'), wrongVersion)
  const missingCode = classifyBootstrap({
    status: 200,
    expectedVersion: '0.6.0',
    expectedCodes: ['path-denied'],
    json: { ok: true, value: { pluginVersion: '0.6.0', capabilities: { status: 'ok' }, catalog: { codes: {} } } },
  })
  check('a catalog missing a required code is called out by code',
    missingCode.kind === 'missing-codes' && missingCode.detail.includes('path-denied'), missingCode)
  const ready = classifyBootstrap({
    status: 200,
    expectedVersion: '0.6.0',
    expectedCodes: ['path-denied', 'catalog-unavailable'],
    json: {
      ok: true,
      value: {
        pluginVersion: '0.6.0',
        capabilities: { status: 'ok' },
        catalog: { codes: { 'path-denied': {}, 'catalog-unavailable': {} } },
      },
    },
  })
  check('a current host with the catalog is ready', ready.kind === 'ready', ready)
}

console.log('\nclient markers')

{
  const current = 'bootstrapOnce data-wsl-degraded data-wsl-health data-wsl-degraded-retry'
  check('all current markers clear the bundle',
    missingClientMarkers(current).length === 0, missingClientMarkers(current))
  const stale = current.replace(' data-wsl-degraded-retry', '')
  check('a stale bundle names the missing marker',
    missingClientMarkers(stale).join(',') === 'data-wsl-degraded-retry', missingClientMarkers(stale))
  check('the required marker list is the current release surface',
    REQUIRED_CLIENT_MARKERS.includes('data-wsl-degraded-retry')
    && REQUIRED_CLIENT_MARKERS.includes('data-wsl-health'), REQUIRED_CLIENT_MARKERS)
}

console.log('\nremedy')

{
  const remedy = devSurfaceRemedy()
  check('the remedy names the staging script', remedy.includes('sync.ps1'), remedy)
  check('the remedy names the restart the host half needs', /restart/i.test(remedy), remedy)
  check('the remedy says the npm package ships the dev surface off',
    remedy.includes('developerTools'), remedy)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
