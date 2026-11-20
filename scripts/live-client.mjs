/**
 * Read the browser half the running host actually serves.
 *
 * The host caches each client bundle in memory, so the file on disk is not evidence
 * of what the page receives. This reads the live module graph from the page's own
 * refresh stream and fetches the advertised bundle. Two callers use it: the
 * inspect-live-client diagnostic and the live release preflight.
 *
 * THREE OUTCOMES, kept apart on purpose. "The graph does not list the plugin" and
 * "this host does not publish a graph at all" are different findings, and only the
 * first is a defect of this plugin. Desktop 0.2.2-rc.5 replaced the
 * `/plugins/events` HTTP SSE stream with the `pluginEvents` Remote service (harness
 * commit bd1d6dcd0c), so that path answers 404 and there is nothing to read. The
 * previous version folded that into "the plugin is not in the served module
 * graph", which reddened three suites on a host where the plugin was fine — the
 * "cannot measure" -> "is broken" lie this project keeps having to remove.
 * @module scripts/live-client
 */

/** The graph is not published by this host, so the served client cannot be measured. */
export class ClientGraphUnavailableError extends Error {
  /**
   * @param {number} status - the HTTP status the graph endpoint answered with, or 0 when the stream ended early.
   */
  constructor(status) {
    super(status === 0
      ? 'the host closed the module-graph stream without sending a graph'
      : `the host does not serve the module graph at /plugins/events (HTTP ${String(status)})`)
    this.name = 'ClientGraphUnavailableError'
    this.status = status
  }
}

/**
 * The plugin's live graph entry.
 * @param {string} baseUrl - the desktop web origin.
 * @returns {Promise<{ kind: 'ok', entry: object } | { kind: 'absent' } | { kind: 'unmeasurable', status: number }>} the outcome.
 */
export async function readClientGraph(baseUrl) {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, 8000)
  let finished = false
  try {
    let response
    try {
      response = await fetch(`${baseUrl}/plugins/events`, { signal: abort.signal })
    } catch (error) {
      // A refused or timed-out connection is also "cannot measure": the graph was
      // never read, so nothing about the plugin follows from it.
      return { kind: 'unmeasurable', status: 0, reason: error?.message ?? String(error) }
    }
    if (!response.ok) return { kind: 'unmeasurable', status: response.status }
    const reader = response.body.getReader()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { kind: 'unmeasurable', status: 0 }
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
        return entry === null ? { kind: 'absent' } : { kind: 'ok', entry }
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
 * @throws {ClientGraphUnavailableError} when this host publishes no readable graph.
 * @throws {Error} when the graph is readable but does not list this plugin, or its bundle cannot be fetched.
 */
export async function readServedClient(baseUrl) {
  const outcome = await readClientGraph(baseUrl)
  if (outcome.kind === 'unmeasurable') throw new ClientGraphUnavailableError(outcome.status)
  if (outcome.kind === 'absent') throw new Error('dsh-wsl-desktop is not in the served module graph')
  const { entry } = outcome
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
