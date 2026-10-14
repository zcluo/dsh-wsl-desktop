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
import { entrySetChanged, entrySetKey, watchStrategyFor, WATCH_INTERVAL_MS } from '../lib/wsl/watch.js'

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
check('the interval is a polling period, not a spin',
  Number.isInteger(WATCH_INTERVAL_MS) && WATCH_INTERVAL_MS >= 100 && WATCH_INTERVAL_MS <= 2000, WATCH_INTERVAL_MS)

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
