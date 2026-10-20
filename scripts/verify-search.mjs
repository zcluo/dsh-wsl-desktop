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
import { globArgv, grepArgv, parseGlobOutput, parseGrepOutput, searchFailure, translateGlob, VCS_EXCLUDES } from '../lib/wsl/search.js'

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
// Carried from the final review (its finding 3) rather than invented here: the trailing-slash strip
// on `input.path` had no row. The block above reads the ONE path where that strip decides
// CORRECTNESS — the root — while `'/ws/'` is the same expression read where nothing else in this
// suite would notice it going away. Whether such a spelling can REACH the vector is not settled by
// reading the realm, and the two branches of the root's spelling disagree: the UNC branch provably
// cannot hand a trailing separator to `resolveRoot`'s `processPath` output (`parseWslUnc` rebuilds
// the Linux path from NON-EMPTY segments — `paths.js:34-45` — so only the root `/` ends in one),
// while the `/mnt/<drive>` branch CAN (`windowsToMntPath('E:\ws\')` is `/mnt/e/ws/`, `paths.js:72`)
// and `posix.normalize` PRESERVES a trailing slash (measured: `normalize('/ws/')` is `'/ws/'`).
// Whether a host `targetKey` can carry that separator in its spelling at all is invisible from this
// checkout, so the row stands on a case that cannot be ruled out rather than on unreachability —
// which is all the more reason to keep it: drop the strip and the formula's own separator doubles
// instead — `/ws//*.ts` — the `//`-bearing -path pattern measured above to match NOTHING.
{
  const argv = globArgv({ pattern: '**/*.ts', path: '/ws/' }, { maxResults: 100 })
  check('glob: a trailing slash on the search root is stripped too (else the anchor doubles its own separator)',
    argv.includes('/ws/*.ts') && !argv.join(' ').includes('//'), argv)
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
  '-path', '/ws/*.ts', '-type', 'f',
  '(', '-exec', 'stat', '-c', '%.9Y', '{}', ';', '-print0', '-o', '-print0', ')']
check('glob: the whole vector is golden (six prunes in order, anchored path, portable mtime pairing)',
  JSON.stringify(globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })) === JSON.stringify(GOLDEN_GLOB),
  JSON.stringify(globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })))
// PORTABILITY (the defect this row was added for): `-printf` is a GNU extension, and on a busybox
// `find` its refusal is SILENT once stderr is not read — an empty stdout that parses as "no files
// match". This is the row that keeps the glob vector off that class of predicate: it asserts the
// ABSENCE of the GNU-only spelling over the whole vector, so a future edit that reintroduces
// `-printf` (or its `%T@` token) fails here rather than shipping a silent empty listing. `\b`
// matters in the predicate test, because `-print` is a PREFIX of `-printf`.
{
  const argv = globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })
  const text = argv.join(' ')
  check('glob: the listing vector carries no GNU-only predicate (-printf / %T@) — busybox refuses it silently',
    !argv.some((element) => /^-printf$/.test(element))
    && !/-printf\b/.test(text)
    && !/%T@/.test(text)
    // The portable half has to be PRESENT, or this row would pass on a vector that prints nothing
    // at all: `-print0` (busybox FEATURE_FIND_PRINT0) and the `-exec stat … ;` pairing.
    && argv.includes('-print0')
    && argv.includes('-exec') && argv.includes('stat') && argv.includes(';'),
    { argv, printf: /-printf\b/.test(text), mtimeToken: /%T@/.test(text) })
}
// The SECOND silent-empty shape, and it is not hypothetical: `-exec stat … ;` and the `-print0`
// that follows it are joined by find's implicit AND, so a distribution whose `stat` is missing
// never reaches `-print0` — and MEASURED on GNU find 4.10.0, it still exits **0** with empty
// stdout, printing only "`stat`: No such file or directory" on stderr (which this tool does not
// read into the answer). That is the original defect one layer down: a stat-less listing would
// answer "no files match". The vector's `-o -print0` fallback is what this row exists to keep,
// and the grouping is what makes it attach to the -path/-type test at all — find's implicit AND
// binds tighter than `-o`, so without the parentheses the fallback would be an expression of its
// own and every file in the tree would print. Both facts are asserted: the group exists, and the
// fallback sits INSIDE it rather than dangling past a bare `-o` chain.
{
  const argv = globArgv({ pattern: '**/*.ts', path: '/ws' }, { maxResults: 1 })
  const open = argv.indexOf('(')
  const close = argv.lastIndexOf(')')
  const group = open === -1 || close === -1 ? [] : argv.slice(open + 1, close)
  check('glob: the listing keeps printing paths when stat is absent — the -o -print0 fallback, inside its own group',
    // The group holds the mtime pairing followed by the fallback, and both -print0 tokens are IN it.
    JSON.stringify(group) === JSON.stringify(['-exec', 'stat', '-c', '%.9Y', '{}', ';', '-print0', '-o', '-print0'])
    && argv.filter((element) => element === '-print0').length === 2
    // and nothing may sit between the group and the pattern test that would change what it attaches
    && argv[open - 1] === 'f' && close === argv.length - 1,
    { open, close, group })
}

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
// colons. (The other direction of the same ambiguity is read one row down — and it is a SKIP rather
// than a pin: nothing here can undo it, but the record it damages can be dropped.)
{
  const out = parseGrepOutput('/ws/a.ts:12:x = 1: done\n', { maxMatches: 5, maxLineBytes: 99 })
  check('grep: a colon in the TEXT stays text — the split never reaches for the last colon',
    out.matches[0].path === '/ws/a.ts' && out.matches[0].lineNumber === 12 && out.matches[0].text === 'x = 1: done', out)
}
// Carried from the controller's ruling 25, which REVERSES ruling 20, rather than invented here. It
// reads the SAME ambiguity as the row above from the other side — a colon inside the PATH — and this
// direction cannot be resolved from the print at all: grep prints `path:line:text` with no escaping,
// so the field boundaries are gone before this function sees the string (the host dodges this by
// reading ripgrep's JSON; the realm has only this print). What is left is which FAILURE to take, and
// the ruling takes the recoverable one. Ruling 20 pinned the outcome as a decision — path cut at the
// first colon, number field `b.ts`, NaN — on the sound ground that the print cannot be repaired; what
// it did not weigh is what a NaN DOES downstream: it is not lossless JSON, so the host's value
// snapshot rejects the whole value and the ENTIRE call fails (ToolOutputError), taking every other
// match in the batch with it behind an error that never mentions a colon. A dropped record loses one
// record, and the model can re-run with `read`, a narrower path, or bash. So the answer here is an
// EMPTY list and NO truncation: unreadable rather than capped.
{
  const out = parseGrepOutput('/ws/a:b.ts:7:x\n', { maxMatches: 5, maxLineBytes: 99 })
  check('grep: a colon in the PATH leaves NO record — the unreadable line is skipped, never kept as NaN',
    JSON.stringify(out) === JSON.stringify({ matches: [], truncated: false }), out)
}
// The second half of that field test, and it is not decoration: the test is a finite INTEGER, not
// merely a finite number, because a colon-bearing path can land on a value that is finite and still
// not a line number. The fixture's real path is `/ws/build:9.30:logs/x.ts` — a tagged directory,
// legal on Linux — whose `:9.30:` segment leaves `9.30` between the first two colons. A
// `Number.isFinite` guard keeps that record and hands the host a FRACTIONAL line number for a field
// its schema declares an INTEGER (grep.ts:307): the same class of failure as the NaN above, by the
// same route (invalid tool output loses the whole call). `Number.isInteger` refuses NaN, Infinity and
// 9.30 alike. (Beyond ruling 25's two rows; declared as such in the round's report.)
{
  const out = parseGrepOutput('/ws/build:9.30:logs/x.ts:12:needle\n', { maxMatches: 5, maxLineBytes: 99 })
  check('grep: a FINITE but NON-INTEGER line number is damage too — the field is a count, so it is skipped',
    JSON.stringify(out) === JSON.stringify({ matches: [], truncated: false }), out)
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
// The parked minor the task review named, carried into ruling 25's round rather than invented here:
// the silent half of a drop. `truncated` is about the CAP — "there was more and the cap stopped me"
// — so a record the parser could not READ must not set it, and this row exists because the code was
// already right with nothing saying so. The fixture puts the unreadable record exactly where the cap
// is full, which is the only place the two can be confused: an implementation that consults the cap
// first sees a full answer with a record left over and reports a truncation that never happened.
{
  const out = parseGrepOutput('/a:1:x\n/b:c.ts:7:y\n', { maxMatches: 1, maxLineBytes: 99 })
  check('grep: a dropped record does NOT set truncated — the flag is about the cap, not about damage',
    JSON.stringify(out) === JSON.stringify({ matches: [{ path: '/a', lineNumber: 1, text: 'x' }], truncated: false }), out)
}
// Beyond ruling 25's two rows, and declared as such: the ruling pins that a dropped record does not
// set the flag, not that it leaves the scan running. A parser that BREAKS at the first unreadable
// line passes both of those rows and still answers with a silently short list — the exact shape this
// suite exists to keep out. The readable record after the broken one is the only place it shows.
{
  const out = parseGrepOutput('/a:1:x\n/b:c.ts:7:y\n/c:2:z\n', { maxMatches: 5, maxLineBytes: 99 })
  check('grep: a dropped record does not END the scan — the readable records after it still answer',
    JSON.stringify(out) === JSON.stringify({
      matches: [{ path: '/a', lineNumber: 1, text: 'x' }, { path: '/c', lineNumber: 2, text: 'z' }],
      truncated: false,
    }), out)
}
// The cap's second field: maxMatches bounds how many records come back, maxLineBytes bounds how
// much of ONE line does. A mutilated line is not a truncation of the ANSWER, so it does not set
// that flag — it is the record, cut to fit.
{
  const out = parseGrepOutput(`/a:1:${'x'.repeat(20)}\n`, { maxMatches: 5, maxLineBytes: 4 })
  check('grep: a line over maxLineBytes is cut to the cap',
    out.matches[0].text === 'xxxx' && out.truncated === false, out)
}
// Carried from the controller's ruling 21 (Task 2 report, C2) rather than invented here. The unit is
// the whole point of the cap's NAME, and a UTF-16 `length` is not that unit: '中文中' is 3 units but
// 9 bytes (measured), so a unit-counted cap of 3 let the entire line through at THREE times the
// number the caller asked for — a cap that is not the cap it says it is. The cut is by CODE POINT,
// sizing each one in UTF-8 bytes, so the character that would cross the cap is dropped WHOLE and
// never halved into a replacement character.
{
  const out = parseGrepOutput('/a:1:中文中\n', { maxMatches: 5, maxLineBytes: 3 })
  check('grep: maxLineBytes counts BYTES, not UTF-16 units — a cap of 3 keeps one CJK character',
    out.matches[0].text === '中' && Buffer.byteLength(out.matches[0].text, 'utf8') === 3
    && out.truncated === false, out)
}
// The same cut read from the other side, and the reason this row is not decorative: a cap that falls
// BETWEEN characters must still stop on a boundary. 4 bytes cannot hold a second 3-byte character,
// so the answer is the SAME as at cap 3 — which a byte-slice of the buffer would not give (that
// answers one whole character plus the first byte of the next, as a replacement character).
{
  const out = parseGrepOutput('/a:1:中文中\n', { maxMatches: 5, maxLineBytes: 4 })
  check('grep: a cap BETWEEN characters keeps the whole ones — 4 bytes still holds exactly one',
    out.matches[0].text === '中' && Buffer.byteLength(out.matches[0].text, 'utf8') === 3
    && out.truncated === false, out)
}

// The mtime field ends at the FIRST newline, because a path may contain a space (and a newline);
// the NUL separator is what keeps that path whole. And the order is the host's MEASURED one: the
// host sorts by mtime ASCENDING (oldest first), and the sort is Node's here because a realm has no
// shell to pipe into `sort`.
{
  const out = parseGlobOutput('3.0\n/ws/b c.ts\0' + '1.0\n/ws/a.ts\0', { maxResults: 9 })
  check('glob: NUL-separated records, ordered by mtime ASCENDING (host parity), spaces intact',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts', '/ws/b c.ts']) && out.truncated === false, out)
}
// The same separator seen from the other side: the character a line-based record could never
// carry. A path with a newline in it is legal in Linux, and this is the row that says why the
// record format is NUL rather than a line — the mtime's own newline is the FIRST one, so the
// path's newline is simply part of the path.
check('glob: a newline inside a path survives — the NUL separator exists for exactly this',
  JSON.stringify(parseGlobOutput('1.0\n/ws/a\nb.ts\0', { maxResults: 9 }).paths) === JSON.stringify(['/ws/a\nb.ts']))
// Truncation, said out loud, for the same reason as the grep row above.
check('glob: the cap reports truncation, because a silent cap reads as a complete listing',
  parseGlobOutput('1.0\n/a\0' + '2.0\n/b\0', { maxResults: 1 }).truncated === true)
// WHICH records the cap keeps is a second decision, and the sort makes it: the cap keeps the
// OLDEST — the first N by mtime, not the first N find happened to print. The fixture's find
// order is deliberately the reverse of its mtime order, so the two answers differ.
{
  const out = parseGlobOutput('3.0\n/ws/b.ts\0' + '1.0\n/ws/a.ts\0', { maxResults: 1 })
  check('glob: the cap keeps the OLDEST records — the sort runs before the slice',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts']), out)
}
// Carried from the controller's ruling 22 (Task 2 report, C3) rather than invented here: the two
// parsers must refuse the same class of input. The vector's own `stat -c` ALWAYS terminates its
// line, so a record without a newline did not come from a whole print — the tool or the vector is
// in trouble — and inventing a path out of a broken record is worse than dropping it. The fixture
// is that cut in BOTH of its measured shapes: a valid mtime whose newline was never printed (the
// old code answered the phantom path '1759050000.5'; its prefix is a perfectly good number, so
// checking the number alone would NOT catch this — it is the NEWLINE that says the record is
// whole), and the flat 'nospace' of the original measurement, which became a phantom path too
// (the `%T@ %p` format this replaces used a space; the newline is the same boundary). The drop is
// silent by design (`truncated` is about the CAP, not about damage), which is why it is stated
// here and in the parser's docblock instead of being left to be discovered.
{
  const out = parseGlobOutput('1.0\n/ws/a.ts\0' + '1759050000.5\0' + 'nospace\0', { maxResults: 9 })
  check('glob: a record with no newline is skipped, never a phantom path — stat always emits one',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts']), out)
}
// The same rule for the mtime, and it is not a formality: the mtime is what the sort orders by, and
// ordering is the entire reason this parser exists (the cap keeps the OLDEST). `Number('abc')` is
// NaN, and a comparator that returns NaN is not an order anyone decided — it is wherever V8 happens
// to leave the record. So the record is dropped rather than sorted on a value it does not have.
{
  const out = parseGlobOutput('1.0\n/ws/a.ts\0' + 'abc\n/ws/b.ts\0', { maxResults: 9 })
  check('glob: a record whose mtime is not a number is skipped, not ordered on NaN',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/a.ts']), out)
}
// The portable format's own new risk, pinned rather than assumed: `stat -c '%.9Y'` is coreutils'
// fractional seconds but busybox's format engine pads the INTEGER to nine digits, so the same file
// prints `1700000000.250000000` on one and `1700000000.000000000` on the other. Both must read as
// the same ORDER — the contract is the order, not the precision — and both must sort/keep together
// with an exact-tie path. An integer mtime (a busybox reading, or a filesystem without sub-second
// timestamps) is the shape the old `%T@ %p` fixture never had.
{
  const out = parseGlobOutput('1700000000.250000000\n/ws/a.ts\0' + '1700000000.000000000\n/ws/b.ts\0', { maxResults: 9 })
  check('glob: a whole-second (busybox-shaped) mtime sorts beside a fractional one, not after every path',
    JSON.stringify(out.paths) === JSON.stringify(['/ws/b.ts', '/ws/a.ts']), out)
}

console.log('\nthe failure vocabulary (the host\'s two classes, told apart at the call boundary)')
// The realm's tools fail in two shapes the model must be able to tell apart, because the
// next action differs: a rejected PATTERN means rewrite the regex, a launch failure means
// the search never ran at all. The names are the host's own (search-core.ts:67-97).
// grep exits 2 for a syntax error, and the class is GREP'S alone — find has no such exit,
// so the same code arriving from glob is an ordinary failure and must not be reported as a
// pattern problem. Both halves ride in the one assertion: the guard and the class.
{
  const rejected = Object.assign(new Error('grep: Unmatched ( or \\('), { exitCode: 2 })
  const invalid = searchFailure(rejected, 'grep')
  check('grep exit 2 is SEARCH_INVALID_PATTERN — and the same exit from find is not',
    invalid.code === 'SEARCH_INVALID_PATTERN' && searchFailure(rejected, 'glob').code === 'SEARCH_FAILED',
    { grep: invalid, glob: searchFailure(rejected, 'glob') })
}
// EVERYTHING else is SEARCH_FAILED — including the shape a distribution without grep
// produces. A launch that never started is not an invalid pattern, and reporting it as one
// would send the model off rewriting a regex that was never the problem. The detail has to
// survive into the message for the same reason: the tool's error text is all the model gets.
{
  const failed = searchFailure(Object.assign(new Error('spawn /usr/bin/grep ENOENT'), { code: 'ENOENT' }), 'grep')
  check('a launch failure (ENOENT) is SEARCH_FAILED, never an invalid pattern, and says so',
    failed.code === 'SEARCH_FAILED' && failed.message.includes('ENOENT'), failed)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
