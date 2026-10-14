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
