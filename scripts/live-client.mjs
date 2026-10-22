/**
 * Read the browser half the running host actually serves.
 *
 * The host caches each client bundle in memory, so the file on disk is not evidence
 * of what the page receives. This reads the live module graph from the page's own
 * refresh stream and fetches the advertised bundle. Two callers use it: the
 * inspect-live-client diagnostic and the live release preflight.
 * @module scripts/live-client
 */

/**
 * The plugin's live graph entry, or null when it is not in the served module graph.
 * @param {string} baseUrl - the desktop web origin.
 * @returns {Promise<object|null>} the graph entry.
 */
async function liveEntry(baseUrl) {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, 8000)
  let finished = false
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
        // line or a graph entry that carries no `entries` must report "not in the
        // graph", not crash the caller.
        let payload
        try {
          payload = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (payload.type !== 'graph') continue
        const entry = (payload.graph?.entries ?? []).find((item) => item.id === 'dsh-wsl-desktop') ?? null
        // Close the stream before returning: an SSE body left open keeps a libuv
        // handle closing while the process exits, which trips the Windows async
        // assertion. `process.exit` is not the fix; the handle must be cancelled.
        finished = true
        try {
          await reader.cancel()
        } catch {
          // The stream may already be closed; nothing to do.
        }
        return entry
      }
    }
  } finally {
    clearTimeout(timer)
    if (!finished) abort.abort()
  }
}

/**
 * Fetch the served browser half.
 * @param {string} baseUrl - the desktop web origin.
 * @returns {Promise<{ entry: object, url: string, status: number, bundle: string }>} the served module.
 * @throws {Error} when the plugin is absent from the graph or its bundle cannot be fetched.
 */
export async function readServedClient(baseUrl) {
  const entry = await liveEntry(baseUrl)
  if (entry === null) throw new Error('dsh-wsl-desktop is not in the served module graph')
  // 0.1.7 graph entries may lack the leading slash — verify-post-restart documents and
  // normalizes the same shape. Concatenating it raw fetches `hostplugins/...`.
  const url = `${baseUrl}${entry.url.startsWith('/') ? entry.url : `/${entry.url}`}`
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(`fetching the served client failed: ${error?.message ?? error}`)
  }
  return { entry, url, status: response.status, bundle: await response.text() }
}
