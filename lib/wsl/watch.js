/**
 * File watching for the distribution's 9P share.
 *
 * The share does not support the primitive the host backend is built on: `fs.watch`
 * throws `EISDIR` on `\\wsl.localhost\…` for a DIRECTORY target and for a FILE target
 * alike (measured; docs/WATCH.md). `LocalFileSystem.watch` watches a directory in
 * both branches — the target, or a file target's `dirname` — so it cannot initialize
 * here at all, and `ctx.fs.watch` rejects for every WSL target: the workspace's file
 * tree loses its live refresh and keeps manual refresh only.
 *
 * This module is the strategy that does work over the share: user-space polling on
 * `node:fs` alone. (chokidar is not importable: it is a transitive dependency of the
 * host's fs-local, and this plugin declares no dependencies.)
 *
 * - `dir-entries` — one readdir per tick, comparing the entry-name set. Measured ~0ms
 *   CPU per 3s and 2-3ms latency at 200 entries. Blind to a child's CONTENT change,
 *   which is not what a consumer of a directory target asks for.
 * - `path-stat` — `fs.watchFile` on one path. Measured ~0ms CPU per 3s and 52ms. Also
 *   covers a file target and an absent path observed for creation.
 * @module dsh-wsl-desktop/wsl/watch
 */

// `readdir` comes from the PROMISE surface, because the io seam calls it promise-style
// (`await io.readdir(path)`) and the injected fake is async: the callback-style
// `fs.readdir` throws ERR_INVALID_ARG_TYPE the moment it is handed no callback
// (measured), so the same call that passes the suite would refuse every WSL target.
// The stat poller's two calls are the callback surface's own and stay on `node:fs`.
import { unwatchFile as nodeUnwatchFile, watchFile as nodeWatchFile } from 'node:fs'
import { readdir as nodeReaddir } from 'node:fs/promises'

/**
 * The polling period of both strategies.
 *
 * A constant, not a config field: both strategies measured ~0ms CPU per 3s at 200
 * entries, so there is no lever to hand an operator. If a deployment ever measures
 * cost, this is the single place it would be turned.
 */
export const WATCH_INTERVAL_MS = 300

/**
 * The strategy for a target.
 * @param {'directory' | 'file' | 'absent'} kind - what the target is right now.
 * @returns {'dir-entries' | 'path-stat'} the strategy name.
 */
export function watchStrategyFor(kind) {
  return kind === 'directory' ? 'dir-entries' : 'path-stat'
}

/**
 * The comparison key of one directory reading.
 * @param {readonly string[]} names - entry names, in any order.
 * @returns {string} the key: sorted and NUL-joined.
 */
export function entrySetKey(names) {
  return [...names].sort().join('\0')
}

/**
 * Whether a directory reading differs from the previous one.
 * @param {string | undefined} previousKey - the previous key; undefined before the first reading.
 * @param {string} nextKey - this reading's key.
 * @returns {boolean} true only when a baseline exists AND differs — the first reading
 *   establishes the baseline silently, mirroring fs-local's `ignoreInitial: true`.
 *   Without it every watch would report a change the moment it opens.
 */
export function entrySetChanged(previousKey, nextKey) {
  return previousKey !== undefined && previousKey !== nextKey
}

/**
 * The io and timer surface this module uses.
 *
 * NOT all of it is `node:fs`: `readdir` is the `node:fs/promises` surface, for the reason
 * the import note above records, so "the default is node:fs" would name the wrong module
 * for one of the three calls.
 *
 * Injectable so the suite drives ticks and IO by hand: with the real timers a check
 * would have to sleep and race the poll it is measuring.
 */
const NODE_IO = {
  readdir: nodeReaddir,
  watchFile: nodeWatchFile,
  unwatchFile: nodeUnwatchFile,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

/**
 * Read one directory reading as a key, answering an absent directory with the empty set.
 *
 * The contract observes a path for CREATION as well as for change, so a directory that
 * is not there is an empty entry set rather than a failure — its deletion and its
 * reappearance are both changes. One qualification: an EMPTY directory produces this same
 * key, so an empty directory being created or removed notifies nobody (the limitation
 * `docs/WATCH.md` states). Every other error belongs to the caller.
 * @param {string} hostPath - the target's host path.
 * @param {object} io - the io seam.
 * @returns {Promise<string>} the entry-set key.
 */
async function readEntryKey(hostPath, io) {
  try {
    return entrySetKey(await io.readdir(hostPath))
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * One close path for both strategies: idempotent, stops the strategy, detaches the
 * abort listener it added.
 *
 * The base contract uses `signal` to cancel INITIALIZATION only — the caller closes an
 * initialized watcher. Stopping an active poll on a later abort as well is a deliberate
 * superset: a leaked poller costs a syscall every interval forever, and the disposer is
 * idempotent, so honouring a late abort cannot double-close.
 * @param {() => void} stop - the strategy's own teardown.
 * @param {AbortSignal} signal - the signal the caller passed.
 * @returns {() => Promise<void>} the disposer.
 */
function makeDisposer(stop, signal) {
  let stopped = false
  const onAbort = () => { void dispose() }
  /**
   * Stop observing.
   * @returns {Promise<void>} once stopped.
   */
  function dispose() {
    if (stopped) return Promise.resolve()
    stopped = true
    stop()
    signal.removeEventListener('abort', onAbort)
    return Promise.resolve()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return dispose
}

/**
 * Poll one directory's direct entries.
 * @param {object} options - as {@link startWatch}.
 * @returns {Promise<() => Promise<void>>} the disposer once the baseline is read.
 */
async function startDirEntries({ hostPath, changed, signal, intervalMs, io }) {
  let previousKey
  let ticking = false
  let stopped = false

  /**
   * One poll: read the entries, compare, notify at most once.
   * @returns {Promise<void>} once this tick has settled.
   */
  const tick = async () => {
    if (ticking || stopped) return
    ticking = true
    try {
      const key = await readEntryKey(hostPath, io)
      const previous = previousKey
      previousKey = key
      if (entrySetChanged(previous, key)) changed()
    } catch (error) {
      changed(error instanceof Error ? error : new Error(String(error)))
    } finally {
      ticking = false
    }
  }

  // The baseline is read BEFORE the watch reports itself active: a change landing
  // between the call and the first tick must be a change, not the baseline. It also
  // makes initialization fail loudly for a path that can never be read, which is what
  // the base contract's `@throws cannot initialize` asks for.
  previousKey = await readEntryKey(hostPath, io)
  signal.throwIfAborted()
  // The callback RETURNS the tick's promise rather than discarding it (`void tick()`):
  // the real `setInterval` ignores a callback's return value, while the injected seam
  // hands it back, and only a poll the seam hands back can be awaited. `tick` reports
  // every failure through `changed`, so nothing is left unhandled either way.
  const timer = io.setInterval(() => tick(), intervalMs)
  return makeDisposer(() => { stopped = true; io.clearInterval(timer) }, signal)
}

/**
 * Watch one path's stat.
 * @param {object} options - as {@link startWatch}.
 * @returns {() => Promise<void>} the disposer.
 */
function startPathStat({ hostPath, changed, signal, intervalMs, io }) {
  const listener = () => { changed() }
  io.watchFile(hostPath, { interval: intervalMs, persistent: true }, listener)
  // The listener goes to `unwatchFile` so only THIS registration is removed: Node
  // refcounts one StatWatcher per path, and `unwatchFile(path)` without a listener
  // would drop every consumer watching that same path.
  return makeDisposer(() => io.unwatchFile(hostPath, listener), signal)
}

/**
 * Observe one target through a strategy the share supports.
 * @param {object} options - the watch request.
 * @param {string} options.hostPath - the target's HOST path (a UNC spelling for WSL).
 * @param {'dir-entries' | 'path-stat'} options.strategy - from {@link watchStrategyFor}.
 * @param {(error?: Error) => void} options.changed - the invalidation callback.
 * @param {AbortSignal} options.signal - cancels initialization.
 * @param {number} [options.intervalMs] - the polling period.
 * @param {object} [options.io] - the io seam; defaults to `NODE_IO` — `readdir` from
 *   `node:fs/promises`, the stat poller from `node:fs`, and the real timers.
 * @returns {Promise<() => Promise<void>>} the disposer once observation is active.
 */
export async function startWatch({ hostPath, strategy, changed, signal, intervalMs = WATCH_INTERVAL_MS, io = NODE_IO }) {
  signal.throwIfAborted()
  if (strategy === 'path-stat') return startPathStat({ hostPath, changed, signal, intervalMs, io })
  return startDirEntries({ hostPath, changed, signal, intervalMs, io })
}
