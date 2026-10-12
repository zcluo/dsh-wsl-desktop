/**
 * Inspect the browser half the running host actually serves.
 *
 * The host caches each client bundle in memory, so the file on disk is not
 * evidence of what the page receives. This reads the live module graph from the
 * page's own refresh stream, fetches the advertised bundle, and reports whether
 * it carries the given markers.
 *
 * Run: node scripts/inspect-live-client.mjs [marker ...]
 *
 * The host to read is `DSH_BASE_URL` (default http://127.0.0.1:19387, which is NOT the
 * port a restarted DSH serves — read `$env:DSH_WEB_URL` and pass it). The two suites
 * that read the same route take their base URL as argv[2], so this tool is the only
 * place the default is spelled.
 */

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

/**
 * Read the live client module graph from the page's refresh stream.
 * @returns {Promise<object|null>} the plugin's graph entry.
 */
async function liveEntry() {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, 8000)
  try {
    const response = await fetch(`${baseUrl}/plugins/events`, { signal: abort.signal })
    const reader = response.body.getReader()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return null
      buffered += Buffer.from(value).toString('utf8')
      let end
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (!line.startsWith('data: ')) continue
        // Guarded like verify-post-restart's read of the same field: a truncated
        // line or a graph entry that carries no `entries` used to crash the tool
        // instead of reporting that the plugin is not in the served module graph.
        let payload
        try {
          payload = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (payload.type !== 'graph') continue
        return (payload.graph?.entries ?? []).find((entry) => entry.id === 'dsh-wsl-desktop') ?? null
      }
    }
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

const entry = await liveEntry()
if (entry === null) {
  console.log('dsh-wsl-desktop is not in the served module graph')
  process.exitCode = 1
} else {
  console.log(`entry rev ${entry.rev}  ${entry.url}`)
  // 0.1.7 graph entries may lack the leading slash — verify-post-restart
  // documents and normalizes the same shape. Concatenating it raw would
  // fetch `127.0.0.1:19387plugins/…` and crash instead of reporting.
  const moduleUrl = `${baseUrl}${entry.url.startsWith('/') ? entry.url : `/${entry.url}`}`
  let response
  try {
    response = await fetch(moduleUrl)
  } catch (error) {
    console.log(`fetch failed: ${error?.message ?? error}`)
    process.exit(1)
  }
  const bundle = await response.text()
  console.log(`served ${response.status}, ${bundle.length} bytes`)
  for (const marker of markers) {
    console.log(`  ${bundle.includes(marker) ? 'has   ' : 'MISSING'} ${marker}`)
  }
}
