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
// The label says ONE element, and this is the value that would stop being one if anything on the
// path ever interpreted a model value: the vector must carry it WHOLE, shell metacharacters and
// all. (The separator half of a claim like this rides on the golden vector below.)
check('grep: the pattern stays ONE inert element, even when it reads like shell syntax',
  JSON.stringify(grepArgv({ pattern: 'a b; rm -rf /', path: '/ws' }, { maxMatches: 100 }))
    .includes('"a b; rm -rf /"'),
  grepArgv({ pattern: 'a b; rm -rf /', path: '/ws' }, { maxMatches: 100 }))
// GNU grep's --include goes through fnmatch, which has no brace expansion — so the braces have to
// reach grep as typed. Pinned as the element's whole text: a value split on its comma (what an
// expansion would look like) is no longer THAT element, even though a bare prefix check passes.
check('grep: include maps to --include= (fnmatch: braces are NOT expanded)',
  grepArgv({ pattern: 'x', path: '/ws', include: '*.{ts,tsx}' }, { maxMatches: 1 })
    .includes('--include=*.{ts,tsx}'),
  grepArgv({ pattern: 'x', path: '/ws', include: '*.{ts,tsx}' }, { maxMatches: 1 }))
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

// GOLDEN VECTORS — the whole argv of each builder, compared literally (Task 1 review, Finding 1).
// MEASURED before they existed, on this suite: a glob-side `VCS_EXCLUDES.slice(1)` that drops five
// of six prunes left it GREEN (15 passed, 0 failed), `%p\n` in place of the -printf format left it
// GREEN, and swapping the chain to `-o` `-prune` left it GREEN. The weak presence rows those
// mutations walked past are gone: their facts are measured here instead, once, over the entire
// vector — every name, the order, the separator and the output format included. A name-blind
// substring check cannot tell a dropped exclusion from a present one; a literal vector can.
// The glob vector's `--` is measured too: findutils 4.10.0 answers the same records with and
// without it, so it is pinned as generated rather than left to drift.
const GOLDEN_GREP = ['/usr/bin/grep', '-r', '-n', '-H', '-E', '--binary-files=without-match',
  '--exclude-dir=.git', '--exclude-dir=.svn', '--exclude-dir=.hg', '--exclude-dir=.bzr', '--exclude-dir=.jj', '--exclude-dir=.sl',
  '--include=*.ts', '--regexp', 'needle', '--', '/ws']
check('grep: the whole vector is golden (all six exclusions, order, include, separator)',
  JSON.stringify(grepArgv({ pattern: 'needle', path: '/ws', include: '*.ts' }, { maxMatches: 1 })) === JSON.stringify(GOLDEN_GREP),
  JSON.stringify(grepArgv({ pattern: 'needle', path: '/ws', include: '*.ts' }, { maxMatches: 1 })))
const GOLDEN_GLOB = ['/usr/bin/find', '--', '/ws',
  '-name', '.git', '-prune', '-o', '-name', '.svn', '-prune', '-o', '-name', '.hg', '-prune', '-o',
  '-name', '.bzr', '-prune', '-o', '-name', '.jj', '-prune', '-o', '-name', '.sl', '-prune', '-o',
  '-path', '/ws/*.ts', '-type', 'f', '-printf', '%T@ %p\\0']
check('glob: the whole vector is golden (six prunes in order, anchored path, NUL format)',
  JSON.stringify(globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })) === JSON.stringify(GOLDEN_GLOB),
  JSON.stringify(globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })))

console.log('\nthe properties the vectors above stand on')
// The host's list, item for item (host parity: tool-fs-search/src/glob.ts:37). Pinned as
// the literal list rather than as a length: a reorder or an added name is a behaviour
// change against the host, and this is the one place it would be noticed. (The golden
// vectors are built FROM this constant, so they notice it too — this row names the diff.)
check('glob: the VCS list is the host list, in the host order — no extension, no reorder',
  JSON.stringify(VCS_EXCLUDES) === JSON.stringify(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']),
  VCS_EXCLUDES)
// The exclusions ride on grep OPTIONS, so where they sit is part of the vector: past the `--`
// grep reads one as just another PATH OPERAND and stops excluding anything. (Their ORDER among
// themselves has no such consequence — GNU grep options commute — so it is not asserted here.)
{
  const argv = grepArgv({ pattern: 'x', path: '/ws', include: '*.ts' }, { maxMatches: 1 })
  const lastExclude = argv.map((element) => element.startsWith('--exclude-dir=')).lastIndexOf(true)
  const separator = argv.indexOf('--')
  check('grep: the exclusions precede the -- separator, because past it they are path operands',
    lastExclude !== -1 && lastExclude < separator, { lastExclude, separator, argv })
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
