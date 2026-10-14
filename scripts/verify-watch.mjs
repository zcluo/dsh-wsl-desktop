/**
 * Offline checks for the WSL file-watch strategies.
 *
 * The strategies exist because of a measured fact: `fs.watch` throws EISDIR on the
 * distribution's 9P share, so the inherited chokidar-based watch cannot initialize
 * for ANY WSL target (docs/WATCH.md). They poll with `node:fs` instead.
 *
 * The io seam is injected so ticks are driven by hand: a suite that sleeps and races
 * the poll measures its own timing, not the behaviour.
 * Run: node scripts/verify-watch.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { entrySetChanged, entrySetKey, startWatch, watchStrategyFor, WATCH_INTERVAL_MS } from '../lib/wsl/watch.js'

const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 300) })
const { check } = checker

console.log('\nstrategy selection')
check('a directory target polls its entries', watchStrategyFor('directory') === 'dir-entries', watchStrategyFor('directory'))
check('a file target watches its stat', watchStrategyFor('file') === 'path-stat', watchStrategyFor('file'))
check('an absent target watches its stat — the contract observes it for creation',
  watchStrategyFor('absent') === 'path-stat', watchStrategyFor('absent'))

console.log('\nentry-set key and its difference')
check('the key ignores reading order', entrySetKey(['b', 'a']) === entrySetKey(['a', 'b']), entrySetKey(['b', 'a']))
check('an added entry changes the key', entrySetChanged(entrySetKey(['a']), entrySetKey(['a', 'b'])), 'add')
check('a removed entry changes the key', entrySetChanged(entrySetKey(['a', 'b']), entrySetKey(['a'])), 'remove')
check('a renamed entry changes the key', entrySetChanged(entrySetKey(['a']), entrySetKey(['b'])), 'rename')
check('the same entries in another order do not', !entrySetChanged(entrySetKey(['a', 'b']), entrySetKey(['b', 'a'])), 'no change')
check('the first reading is a baseline, not a change', !entrySetChanged(undefined, entrySetKey(['a'])), 'the ignoreInitial baseline')
check('the interval is the measured operating point, so a tune is a deliberate change',
  WATCH_INTERVAL_MS === 300, WATCH_INTERVAL_MS)

/**
 * A fake io whose readdir answer the test sets and whose ticks the test fires by hand.
 * @param {{ entries?: string[], readdirError?: Error | null }} [initial] - the starting directory.
 * @returns {object} the io seam plus the handles the checks read.
 */
function fakeIo({ entries = [], readdirError = null } = {}) {
  const io = {
    entries,
    readdirError,
    readdirCalls: 0,
    concurrent: 0,
    peakConcurrent: 0,
    ticks: [],
    watchFileCalls: [],
    unwatchFileCalls: [],
    cleared: 0,
    gate: null,
    async readdir() {
      io.readdirCalls += 1
      io.concurrent += 1
      io.peakConcurrent = Math.max(io.peakConcurrent, io.concurrent)
      if (io.gate !== null) await io.gate()
      io.concurrent -= 1
      if (io.readdirError !== null) throw io.readdirError
      return [...io.entries]
    },
    watchFile: (path, options, listener) => { io.watchFileCalls.push({ path, options, listener }) },
    unwatchFile: (path, listener) => { io.unwatchFileCalls.push({ path, listener }) },
    setInterval: (fn, intervalMs) => { io.ticks.push({ fn, intervalMs }); return io.ticks.length },
    clearInterval: () => { io.cleared += 1 },
  }
  return io
}

/** Start a directory watch over a fake io and hand back its handles. */
async function armDirWatch(io) {
  const notifications = []
  const errors = []
  const controller = new AbortController()
  const dispose = await startWatch({
    hostPath: '\\\\wsl.localhost\\debian-dev\\tmp\\probe',
    strategy: 'dir-entries',
    changed: (error) => { if (error === undefined) notifications.push(1); else errors.push(error) },
    signal: controller.signal,
    io,
  })
  return { notifications, errors, dispose, controller, tick: () => io.ticks.at(-1).fn() }
}

const ENOENT = () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })

console.log('\ndirectory polling')
{
  const io = fakeIo({ entries: ['a'] })
  const armed = await armDirWatch(io)
  check('the baseline reading does not notify', armed.notifications.length === 0, armed.notifications.length)
  check('one interval is registered at the constant period',
    io.ticks.length === 1 && io.ticks[0].intervalMs === WATCH_INTERVAL_MS, io.ticks.map((tick) => tick.intervalMs))
  await armed.tick()
  check('an unchanged directory does not notify', armed.notifications.length === 0, armed.notifications.length)
  io.entries = ['a', 'b']
  await armed.tick()
  check('an added entry notifies once', armed.notifications.length === 1, armed.notifications.length)
  await armed.tick()
  check('the next unchanged tick does not notify again', armed.notifications.length === 1, armed.notifications.length)
  io.entries = ['b']
  await armed.tick()
  check('a removed entry notifies', armed.notifications.length === 2, armed.notifications.length)
  io.entries = ['b', 'c', 'd', 'e']
  await armed.tick()
  check('a tick that sees several changes still notifies exactly once',
    armed.notifications.length === 3, armed.notifications.length)
  await armed.dispose()
  check('disposing clears the interval', io.cleared === 1, io.cleared)
  await armed.dispose()
  check('disposing twice does not clear again', io.cleared === 1, io.cleared)
}

console.log('\nabsence is an empty entry set, not a failure')
{
  const io = fakeIo()
  io.readdirError = ENOENT()
  const armed = await armDirWatch(io)
  check('an absent directory still reports the watch active', io.readdirCalls === 1 && io.ticks.length === 1, { calls: io.readdirCalls, ticks: io.ticks.length })
  io.readdirError = null
  io.entries = ['x']
  await armed.tick()
  check('the directory appearing notifies', armed.notifications.length === 1, armed.notifications.length)
  io.readdirError = ENOENT()
  await armed.tick()
  check('the directory disappearing notifies', armed.notifications.length === 2, armed.notifications.length)
  check('absence is never reported as an error', armed.errors.length === 0, armed.errors.map((error) => error.message))
  await armed.dispose()
}

console.log('\nfailures the consumer must see')
{
  const io = fakeIo({ entries: ['a'] })
  const armed = await armDirWatch(io)
  const unreachable = Object.assign(new Error('the share is unreachable'), { code: 'EIO' })
  io.readdirError = unreachable
  await armed.tick()
  check('any failure other than absence reaches the consumer', armed.errors.length === 1 && armed.errors[0] === unreachable,
    armed.errors.map((error) => error.message))
  await armed.dispose()
}
{
  const io = fakeIo()
  io.readdirError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  let thrown
  try {
    await startWatch({ hostPath: 'x', strategy: 'dir-entries', changed: () => {}, signal: new AbortController().signal, io })
  } catch (error) { thrown = error }
  check('a path that can never be read rejects the initialization', thrown?.code === 'EACCES', thrown?.message)
  check('the rejected initialization left no interval behind', io.ticks.length === 0, io.ticks.length)
}
{
  const io = fakeIo()
  const controller = new AbortController()
  controller.abort()
  let thrown
  try {
    await startWatch({ hostPath: 'x', strategy: 'path-stat', changed: () => {}, signal: controller.signal, io })
  } catch (error) { thrown = error }
  check('an already-aborted signal is refused before anything is registered',
    thrown?.name === 'AbortError' && io.watchFileCalls.length === 0, { name: thrown?.name, registered: io.watchFileCalls.length })
}

console.log('\na slow tick does not stack')
{
  const io = fakeIo({ entries: ['a'] })
  const armed = await armDirWatch(io)
  let release
  io.gate = () => new Promise((resolve) => { release = resolve })
  const slow = armed.tick()
  armed.tick()
  check('a tick is skipped while another is still running', io.peakConcurrent === 1, { peak: io.peakConcurrent, calls: io.readdirCalls })
  release()
  await slow
  io.gate = null
  await armed.dispose()
}

console.log('\na late abort stops the poll')
{
  const io = fakeIo({ entries: ['a'] })
  const armed = await armDirWatch(io)
  const callsBefore = io.readdirCalls
  armed.controller.abort()
  await armed.tick()
  check('the poll stops, because a leaked poller costs a syscall every interval',
    io.cleared === 1 && io.readdirCalls === callsBefore, { cleared: io.cleared, callsBefore, callsAfter: io.readdirCalls })
}

console.log('\npath polling (a file, and a path observed for creation)')
{
  const io = fakeIo()
  const controller = new AbortController()
  const notifications = []
  const dispose = await startWatch({
    hostPath: '\\\\wsl.localhost\\debian-dev\\tmp\\f.txt',
    strategy: 'path-stat',
    changed: (error) => { if (error === undefined) notifications.push(1) },
    signal: controller.signal,
    io,
  })
  check('the stat watcher is registered on the host path at the constant period',
    io.watchFileCalls.length === 1 && io.watchFileCalls[0].path.endsWith('f.txt') && io.watchFileCalls[0].options.interval === WATCH_INTERVAL_MS,
    io.watchFileCalls.map((call) => call.options))
  check('reporting the watch active does not notify', notifications.length === 0, notifications.length)
  io.watchFileCalls[0].listener()
  check('a stat change notifies', notifications.length === 1, notifications.length)
  await dispose()
  check('disposing removes THIS registration, not every watcher of that path',
    io.unwatchFileCalls.length === 1 && io.unwatchFileCalls[0].listener === io.watchFileCalls[0].listener,
    io.unwatchFileCalls.map((call) => typeof call.listener))
  await dispose()
  check('disposing twice does not remove again', io.unwatchFileCalls.length === 1, io.unwatchFileCalls.length)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
