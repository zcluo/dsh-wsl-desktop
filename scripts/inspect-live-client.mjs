/**
 * Inspect the browser half the running host actually serves.
 *
 * The host caches each client bundle in memory, so the file on disk is not
 * evidence of what the page receives. This reads the live module graph from the
 * page's own refresh stream, fetches the advertised bundle, and reports whether
 * it carries the given markers.
 *
 * Run: node scripts/inspect-live-client.mjs [marker ...]
 */

const baseUrl = 'http://127.0.0.1:19387'
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
        const payload = JSON.parse(line.slice(6))
        if (payload.type !== 'graph') continue
        return payload.graph.entries.find((entry) => entry.id === 'dsh-wsl-desktop') ?? null
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
  const response = await fetch(`${baseUrl}${entry.url}`)
  const bundle = await response.text()
  console.log(`served ${response.status}, ${bundle.length} bytes`)
  for (const marker of markers) {
    console.log(`  ${bundle.includes(marker) ? 'has   ' : 'MISSING'} ${marker}`)
  }
}
