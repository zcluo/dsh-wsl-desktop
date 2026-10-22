/**
 * Inspect the browser half the running host actually serves.
 *
 * The host caches each client bundle in memory, so the file on disk is not evidence
 * of what the page receives. This reads the live module graph from the page's own
 * refresh stream, fetches the advertised bundle, and reports whether it carries the
 * given markers.
 *
 * Run: node scripts/inspect-live-client.mjs [marker ...]
 *
 * The host to read is `DSH_BASE_URL` (default http://127.0.0.1:19387, which is NOT the
 * port a restarted DSH serves — read `$env:DSH_WEB_URL` and pass it). The two suites
 * that read the same route take their base URL as argv[2], so this tool is the only
 * place the default is spelled.
 */

import { readServedClient } from './live-client.mjs'

// The harness exports DSH_WEB_URL for the host it just started, and `verify-all --live`
// runs this suite with NO argv (its spawnSync inherits the environment). Reading only
// argv[2] meant the live mode was structurally broken after every restart: DSH's web port
// CHANGES each time, so the list fell back to the hardcoded 19387 and every live suite
// reported a connection refusal against a port nothing serves. The environment knows the
// answer; guessing is what made the documented --live workflow unusable.
// DSH_BASE_URL stays first: it is this tool's own override, and the two suites that
// read the same route take theirs as argv[2].
const baseUrl = process.env.DSH_BASE_URL ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const markers = process.argv.slice(2)

let served
try {
  served = await readServedClient(baseUrl)
} catch (error) {
  console.log(error?.message ?? error)
  process.exit(1)
}
console.log(`entry rev ${served.entry.rev}  ${served.entry.url}`)
console.log(`served ${served.status}, ${served.bundle.length} bytes`)
for (const marker of markers) {
  console.log(`  ${served.bundle.includes(marker) ? 'has   ' : 'MISSING'} ${marker}`)
}
