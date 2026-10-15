/**
 * Offline checks for the WSL search argv vectors.
 *
 * A WSL realm has NO search tool of the host's: the host's grep/glob are deliberately
 * removed there, because their argv[0] is a packaged WINDOWS ripgrep binary. The realm
 * gets its own instead, run by the distribution's own /usr/bin/grep and /usr/bin/find —
 * and everything this module decides is an ARGV VECTOR. That is what the rows below pin.
 *
 * There is no shell anywhere on that path. Every model value (pattern, path, include)
 * must therefore arrive as exactly ONE inert element, and a value that looks like shell
 * syntax is only ever a value.
 *
 * The translation is a MEASURED collapse rather than a guess: GNU find's `-path` matches
 * the whole path and its `*` crosses `/` (findutils 4.10.0 and grep 3.11, measured in the
 * distribution; the probe transcript is in task-1-report.md), so a glob's leading
 * double-star-and-slash is exactly `*` — the translation collapses, it does not expand.
 * (Written out, not spelled as the two-character sequence: it would close this comment.)
 * Run: node scripts/verify-search.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { globArgv, grepArgv, translateGlob, VCS_EXCLUDES } from '../lib/wsl/search.js'

const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 300) })
const { check } = checker

console.log('\nthe glob translation (the shape find actually matches)')
check('**/ collapses so that any depth matches — measured: find -path "*" crosses /',
  translateGlob('**/*.ts') === '*.ts', translateGlob('**/*.ts'))
check('a mid-pattern **/ keeps its prefix',
  translateGlob('src/**/*.ts') === 'src/*.ts', translateGlob('src/**/*.ts'))
check('a leading ./ is stripped',
  translateGlob('./src/*.js') === 'src/*.js', translateGlob('./src/*.js'))

console.log('\nthe argv vectors (one inert element per model value)')
check('grep: no shell, the pattern is one element, -- ends the options',
  JSON.stringify(grepArgv({ pattern: 'a b; rm -rf /', path: '/ws' }, { maxMatches: 100 }))
    .includes('"a b; rm -rf /"'))
check('grep: include maps to --include= (fnmatch: braces are NOT expanded)',
  grepArgv({ pattern: 'x', path: '/ws', include: '*.{ts,tsx}' }, { maxMatches: 1 }).some(a => a.startsWith('--include=')))
check('grep: every VCS name is excluded by --exclude-dir (measured missing -> .git hits)',
  VCS_EXCLUDES.every(name => grepArgv({ pattern: 'x', path: '/ws' }, { maxMatches: 1 }).includes(`--exclude-dir=${name}`)))
check('glob: VCS names are pruned, never merely filtered',
  globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 100 }).join(' ').includes('-prune'))
check('glob: the pattern is ANCHORED to the search root (unanchored matches nothing)',
  globArgv({ pattern: 'src/**/*.ts', path: '/ws' }, { maxResults: 100 }).includes('/ws/src/*.ts'))
// The root is the one path where anchoring can go wrong: stripping the trailing slashes yields ''
// and the formula happily produces `/`, so ANY extra slash here builds a '//'-prefixed pattern.
// MEASURED (twice, in the distribution): such a pattern matches nothing at all, so a full-root
// search would answer with an empty listing instead of failing — the worst shape there is.
{
  const argv = globArgv({ pattern: '**/*.ts', path: '/' }, { maxResults: 100 })
  check('glob: a root path keeps exactly ONE leading slash (a doubled one matches nothing)',
    argv.includes('/*.ts') && !argv.join(' ').includes('//'), argv)
}
// A leading `/` is ripgrep's ANCHORED glob form and means nothing extra here. Not stripping it is
// what lets the anchor above emit a '//'-bearing -path pattern — and such a pattern matches
// NOTHING (measured: the same fixture answers 2 records for the single-slash form, 0 for the
// doubled one), so the realm would answer with an empty listing instead of failing.
{
  const argv = globArgv({ pattern: '/**/*.ts', path: '/ws' }, { maxResults: 100 })
  check('glob: a leading / is the rg anchored form and is stripped (else a // tail matches nothing)',
    translateGlob('/**/*.ts') === '*.ts' && argv.includes('/ws/*.ts'),
    { translated: translateGlob('/**/*.ts'), argv })
}
check('glob: mtime is printed for the sort, NUL-terminated so spaces survive',
  globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 100 }).join(' ').includes('-printf'))

console.log('\nthe properties the vectors above stand on')
// The `--` is the other half of the row above: `--regexp` already consumes the pattern, and
// this is what keeps the PATH from being read as an option when a model value begins with
// one. Asserted separately so a failure names which half broke.
{
  const argv = grepArgv({ pattern: 'x', path: '/ws' }, { maxMatches: 1 })
  check('grep: -- stands between the model values and the path, so a leading dash is never an option',
    argv.at(-2) === '--' && argv.at(-1) === '/ws', argv)
}
// The host's list, item for item (host parity: tool-fs-search/src/glob.ts:37). Pinned as
// the literal list rather than as a length: a reorder or an added name is a behaviour
// change against the host, and this is the one place it would be noticed.
check('glob: the VCS list is the host list, in the host order — no extension, no reorder',
  JSON.stringify(VCS_EXCLUDES) === JSON.stringify(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']),
  VCS_EXCLUDES)
// The exclusions ride on grep OPTIONS, so where they sit in the vector is part of the
// vector: the presence row above proves all six are in it, this one proves none of them
// landed after `--`, where grep would read it as just another path operand.
{
  const argv = grepArgv({ pattern: 'x', path: '/ws', include: '*.ts' }, { maxMatches: 1 })
  const lastExclude = argv.map((element) => element.startsWith('--exclude-dir=')).lastIndexOf(true)
  const include = argv.findIndex((element) => element.startsWith('--include='))
  const separator = argv.indexOf('--')
  check('grep: the exclusions precede both --include= and the -- separator',
    lastExclude !== -1 && lastExclude < include && lastExclude < separator,
    { lastExclude, include, separator, argv })
}
// `-o` binds looser than the implicit `-a`, so the chain is a sequence of alternatives and
// the LAST prune must still precede the match action: an action placed inside the chain
// would fire only for a path that matched no earlier alternative.
{
  const argv = globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 100 })
  const lastPrune = argv.lastIndexOf('-prune')
  const matchAction = argv.indexOf('-path')
  check('glob: the whole prune chain stands before the match action',
    lastPrune !== -1 && matchAction !== -1 && lastPrune < matchAction, { lastPrune, matchAction, argv })
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
