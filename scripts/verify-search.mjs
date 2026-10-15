/**
 * Offline checks for the WSL search argv vectors.
 *
 * A WSL realm has NO search tool of the host's: the host's grep/glob are deliberately
 * removed there, because their argv[0] is a packaged WINDOWS ripgrep binary. The realm
 * gets its own instead, run by the distribution's own /usr/bin/grep and /usr/bin/find —
 * and everything this module decides is an ARGV VECTOR, or the reading of what one PRINTS.
 * That is what the rows below pin.
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
import { globArgv, grepArgv, parseGlobOutput, parseGrepOutput, translateGlob, VCS_EXCLUDES } from '../lib/wsl/search.js'

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
// Carried from Task 1's review (Ruling 14) rather than invented here, and it is ONE character:
// stripping a single slash is not enough. `//**/*.ts` is the third input family of the same
// "silent empty result" shape — after the root path and the single-slash form above — because a
// one-slash strip leaves `/**/*.ts`, translates it to `/*.ts`, and the anchor then builds the
// `//`-bearing -path pattern that matches NOTHING (measured on one fixture: the single-slash
// form answers 2 records, the doubled one 0). Every leading slash is therefore stripped.
{
  const argv = globArgv({ pattern: '//**/*.ts', path: '/ws' }, { maxResults: 100 })
  check('glob: EVERY leading / is stripped (one left behind rebuilds the //-bearing pattern that matches nothing)',
    translateGlob('//**/*.ts') === '*.ts' && argv.includes('/ws/*.ts'),
    { translated: translateGlob('//**/*.ts'), argv })
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

console.log('\nthe parsers (host shape, without the host binary)')

// The other half of the module, and the half no argv row can reach: a perfect vector is still
// read WRONG if what the tool PRINTS never becomes the host's shape. The subject here is a
// string, so no distribution is involved — and every string is the format the vectors above
// ask for. The splits are where it can go wrong: grep prints `path:line:text` with no escaping
// and find prints `%T@ %p` NUL-separated, so WHICH separator is a separator is the whole game.
const grepOut = parseGrepOutput('/ws/a.ts:12:const x = 1\n/ws/b.ts:3:export {}\n', { maxMatches: 10, maxLineBytes: 1024 })
check('grep: the path ends at the FIRST colon, the number sits between the two, the text follows the second',
  grepOut.matches[0].path === '/ws/a.ts' && grepOut.matches[0].lineNumber === 12
  && grepOut.matches[0].text === 'const x = 1' && grepOut.truncated === false, JSON.stringify(grepOut))
// Not an edge case: the print has no escaping, so a matching line that CONTAINS a colon arrives
// with three or more of them. Reaching for the last one — or taking the third field of a plain
// split — reads such a line as less than it is, and the text is the field that must keep its
// colons. (The other direction of the same ambiguity, a colon in the PATH, is a gap this parser
// cannot resolve — grep offers no escaping — and is disclosed rather than asserted here.)
{
  const out = parseGrepOutput('/ws/a.ts:12:x = 1: done\n', { maxMatches: 5, maxLineBytes: 99 })
  check('grep: a colon in the TEXT stays text — the split never reaches for the last colon',
    out.matches[0].path === '/ws/a.ts' && out.matches[0].lineNumber === 12 && out.matches[0].text === 'x = 1: done', out)
}
// A file authored on Windows keeps its CR, and the terminator belongs to the file's line ending
// rather than to the line's text — grep prints it verbatim because it is simply the last
// character. Left in, every match's text differs from the line the model asked about.
check('grep: CRLF is trimmed, so a Windows-authored line keeps its text',
  parseGrepOutput('/ws/a.txt:1:hello\r\n', { maxMatches: 5, maxLineBytes: 99 }).matches[0].text === 'hello')
// The cap is applied HERE, in Node, not on the command line: the vector asks the tool for
// everything, so the parser is the only thing that can stop — and a cap that says nothing is
// the empty-result family one step on, where a cut answer reads as a complete one.
check('grep: the cap truncates AND says so, because a silent cap reads as a complete answer',
  parseGrepOutput('/a:1:x\n/a:2:y\n', { maxMatches: 1, maxLineBytes: 99 }).truncated === true)
// The cap's second field: maxMatches bounds how many records come back, maxLineBytes bounds how
// much of ONE line does. A mutilated line is not a truncation of the ANSWER, so it does not set
// that flag — it is the record, cut to fit.
{
  const out = parseGrepOutput(`/a:1:${'x'.repeat(20)}\n`, { maxMatches: 5, maxLineBytes: 4 })
  check('grep: a line over maxLineBytes is cut to the cap',
    out.matches[0].text === 'xxxx' && out.truncated === false, out)
}

// The mtime field is the FIRST space's business only, because a path may contain one; the NUL
// separator is what keeps that path whole. And the order is the host's MEASURED one: the host
// sorts by mtime ASCENDING (oldest first), and the sort is Node's here because a realm has no
// shell to pipe into `sort`.
{
  const out = parseGlobOutput('3.0 /ws/b c.ts\0' + '1.0 /ws/a.ts\0', { maxResults: 9 })
  check('glob: NUL-separated records, ordered by mtime ASCENDING (host parity), spaces intact',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts', '/ws/b c.ts']) && out.truncated === false, out)
}
// The same separator seen from the other side: the character a line-based record could never
// carry. A path with a newline in it is legal in Linux, and this is the row that says why the
// record format is NUL rather than a line.
check('glob: a newline inside a path survives — the NUL separator exists for exactly this',
  JSON.stringify(parseGlobOutput('1.0 /ws/a\nb.ts\0', { maxResults: 9 }).paths) === JSON.stringify(['/ws/a\nb.ts']))
// Truncation, said out loud, for the same reason as the grep row above.
check('glob: the cap reports truncation, because a silent cap reads as a complete listing',
  parseGlobOutput('1.0 /a\0' + '2.0 /b\0', { maxResults: 1 }).truncated === true)
// WHICH records the cap keeps is a second decision, and the sort makes it: the cap keeps the
// OLDEST — the first N by mtime, not the first N find happened to print. The fixture's find
// order is deliberately the reverse of its mtime order, so the two answers differ.
{
  const out = parseGlobOutput('3.0 /ws/b.ts\0' + '1.0 /ws/a.ts\0', { maxResults: 1 })
  check('glob: the cap keeps the OLDEST records — the sort runs before the slice',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts']), out)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
