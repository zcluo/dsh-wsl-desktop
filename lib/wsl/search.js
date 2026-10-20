/**
 * The realm's own search: the argv vectors for the distribution's grep and find.
 *
 * The host's grep/glob are removed inside a WSL realm on purpose — their argv[0] is a
 * packaged WINDOWS ripgrep binary — so without this module the realm has no search tool
 * at all. The distribution carries its own `/usr/bin/grep` and `/usr/bin/find`, and what
 * this module decides is only ever the ARGV VECTOR that runs them.
 *
 * No shell exists on that path, by construction: `sh -c`, a pipe, a redirect and a glob
 * expanded by a shell are all impossible here, because every model value (pattern, path,
 * include) is pushed as exactly ONE element. A value that reads like shell syntax is
 * therefore inert — `a b; rm -rf /` is one argument and nothing else. Sorting and
 * filtering happen in Node, on the parsed output.
 *
 * The other half of the job is what comes BACK. The distribution's tools print formats of
 * their own (`path:line:text` with no escaping; an mtime line followed by the NUL-terminated
 * path), and the parsers below turn that print into the host tool's shape, applying the caps
 * there — in Node, because the vectors ask for everything and only the consumer can stop. The
 * sort is Node's too: a realm has no shell to pipe into `sort`.
 *
 * What a FAILED run means is decided here as well (`searchFailure`), in the host's own two
 * names, so the tool that raises the failure does not get to invent a vocabulary of its
 * own — and so that the two classes stay apart in an offline row rather than in a `catch`
 * block nobody can test.
 *
 * The glob translation is MEASURED rather than assumed. GNU find's `-path` matches the
 * WHOLE printed path and its `*` crosses `/` (findutils 4.10.0, measured in the distribution),
 * so a leading `**` + `/` in a glob is exactly `*`: the translation COLLAPSES that prefix, it
 * does not expand it into a repeated segment, and the caller anchors the result to the
 * search root — an unanchored tail matches NOTHING, because `-path` sees the printed
 * absolute path and never the root-relative one the model wrote (also measured).
 * @module dsh-wsl-desktop/wsl/search
 */

/** VCS directories the listing must never descend into (host parity: glob.ts:37). */
export const VCS_EXCLUDES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

/**
 * Translate a model-facing path glob into the tail of a `find -path` pattern.
 *
 * MEASURED: GNU find's `-path` matches the WHOLE printed path and its `*` crosses `/`, so a
 * `**` + `/` prefix is exactly `*` — a collapse, not an expansion. The caller anchors the
 * result to the search root: an unanchored tail matches nothing (measured).
 *
 * A leading `/` is ripgrep's ANCHORED glob form; EVERY leading slash is therefore stripped, so
 * that `/**` + `/x.ts`, `**` + `/x.ts` and `//**` + `/*.ts` all mean the same thing here. One
 * slash is not enough: a doubled one would leave `/*.ts`, and the anchor would then build a
 * `//`-bearing -path pattern, which matches NOTHING (measured: the same fixture answers 2
 * records for the single-slash form and 0 for the doubled one — and the doubled-leading-slash
 * input family was found in review, after the first two were fixed).
 * @param {string} pattern - the model's glob.
 * @returns {string} the tail of the `-path` pattern; globArgv anchors it to the root.
 */
export function translateGlob(pattern) {
  return pattern.replace(/^\/+/, '').replace(/\*\*\//g, '').replace(/^\.\//, '')
}

/**
 * One `grep -E` argv vector. Every model value is ONE element; no shell exists.
 *
 * The VCS exclusion is not optional here: `grep -r` has no prune concept, and the host's
 * grep skips those directories because ripgrep does. Without the exclusions this vector
 * answers with `.git`'s own files (measured — see task-1-report.md).
 * @param {{ pattern: string, path: string, include?: string }} input - the model's request.
 * @param {{ maxMatches: number }} caps - the caller's cap; not consumed by the vector
 *   (the cap is applied where the output is parsed, not on the command line).
 * @returns {string[]} the argv, ready for the distribution's grep.
 */
export function grepArgv(input, caps) {
  void caps
  const argv = ['/usr/bin/grep', '-r', '-n', '-H', '-E', '--binary-files=without-match']
  // Measured: without these, the vector returns .git/x/hidden.ts — grep has no prune concept,
  // so the VCS exclusion rides on --exclude-dir (still one inert element per name). They are
  // OPTIONS, so they stand before --include= and before the `--`: after that separator grep
  // would read one of them as just another path operand.
  for (const name of VCS_EXCLUDES) argv.push(`--exclude-dir=${name}`)
  if (input.include !== undefined) argv.push(`--include=${input.include}`)
  argv.push('--regexp', input.pattern, '--', input.path)
  return argv
}

/**
 * One `find` argv vector: VCS pruned by -prune, the pattern anchored to the root, and each hit
 * paired with its mtime so the sort can happen in Node.
 *
 * PORTABLE ON PURPOSE, for the reason `pty.js`'s sweep already records: the mtime used to come
 * from `-printf '%T@ %p\0'`, which is a GNU EXTENSION. On a busybox `find` (Alpine, many minimal
 * distributions) that predicate is rejected, the refusal lands on stderr, and the empty stdout
 * parses as "no files match" — a silent empty answer, the one outcome a listing must never
 * produce. What the vector asks for instead is the pair every `find` carries: `-print0` (the
 * NUL-terminated listing) and `-exec … ;` (busybox's `FEATURE_FIND_EXEC` and
 * `FEATURE_FIND_PRINT0` are both default-on), with the distribution's own `stat` printing the
 * mtime in front of each path. That is ONE spawn, not two — find runs the stat itself, per
 * match, so the two halves of a record always describe the same hit.
 *
 * Why `stat` and not a shell loop: this module has no shell by construction (see the module
 * docblock), so `stat` has to be executed BY find. Why the bare name: no absolute spelling is
 * portable — coreutils ships `/usr/bin/stat` (Debian, Fedora) while busybox installs its applet
 * at `/bin/stat` (Alpine) — so a hardcoded path would break exactly the distributions this
 * change exists for; `-exec stat` is resolved by find's own `execvp` against the distribution's
 * PATH.
 *
 * The parenthesised `-o -print0` is NOT decoration, it is MEASURED defence: `-exec stat … ;`
 * and a following `-print0` are joined by an implicit AND, so when `stat` cannot be run the
 * `-print0` is never reached — and GNU find reports that on stderr while still exiting **0**
 * (measured: exit 0, empty stdout, two `<find>: 'stat': No such file or directory` lines). A
 * reader that takes stdout alone would see the SAME silent empty listing this change exists to
 * remove, one layer down. With the fallback group the paths are printed either way: the mtime
 * first when `stat` answers, bare NUL-framed paths when it does not — and a bare path is not a
 * readable record (`stat -c` always ends its line, so the parser needs that newline), which
 * leaves a NON-EMPTY print that parses to NO path. That is exactly the shape `search-tool.js`'s
 * own damage guard already raises on ("its output could not be read as path records"), so a
 * `stat`-less distribution fails LOUDLY through the existing boundary instead of answering an
 * empty listing. The group also means one unreadable file (a `stat` that fails per hit) only
 * costs that record, not the whole listing.
 *
 * `%.9Y` is the mtime in seconds: GNU coreutils answers fractional seconds (what `%T@` gave the
 * sort), busybox's format engine pads the same integer to nine digits instead, which parses back
 * to the identical whole second — so sub-second precision degrades on busybox and the ORDER, the
 * documented contract, does not. `-print0` rather than `-print` keeps the path in a NUL-framed
 * record, so a path containing a newline survives; `stat -c` always terminates its own line, and
 * the parser splits on that FIRST newline (a path may contain more).
 * @param {{ pattern: string, path: string }} input - the model's request.
 * @param {{ maxResults: number }} caps - the caller's cap; not consumed by the vector
 *   (the cap is applied where the output is parsed, not on the command line).
 * @returns {string[]} the argv, ready for the distribution's find.
 */
export function globArgv(input, caps) {
  void caps
  // Strip ONLY the trailing slashes: the formula is <path-without-trailing-slashes>/<tail>, so a
  // root path '/' deliberately yields '' and the anchored pattern keeps exactly ONE leading slash.
  // MEASURED, twice in the distribution: a '//'-prefixed -path pattern matches NOTHING, so
  // special-casing the root back to '/' would make a full-root search silently return empty.
  const root = input.path.replace(/\/+$/, '')
  // The separator is MEASURED, not assumed (findutils 4.10.0): the vector answers the SAME records
  // with and without it (exit 0 both ways), and a `--` in the expression position is rejected as
  // an unknown predicate — so all it ends is find's OWN option parsing, and nothing else moves.
  // It is NOT a licence to pass a path that begins with `-`; measured, `find -- -dashdir …`
  // reports "unknown predicate `-dashdir'" and exits 1 — a LOUD failure, which is why it is
  // accepted rather than guarded against here. Such a path cannot reach this vector anyway:
  // Task 3's path resolution turns the model's relative path into an ABSOLUTE one, so the first
  // dash-leading argument find could meet never is one. (Repeat these two facts where that
  // resolution happens: Task 3 owns that site, and this comment cannot stand in for it.)
  const argv = ['/usr/bin/find', '--', input.path]
  for (const name of VCS_EXCLUDES) argv.push('-name', name, '-prune', '-o')
  // -path matches the whole printed path, so the model's root-relative pattern is anchored here.
  // The mtime rides on -exec (see the docblock): it prints BEFORE the path, and its own newline is
  // the record's field separator — MEASURED on GNU find 4.10.0 + coreutils stat, where the output
  // per hit is `<mtime>\n<path>\0`. `;` and not `+`: with `+` find batches the names and runs stat
  // at flush points, so the printed mtimes would no longer line up with the paths -print0 streams
  // out; one stat per hit keeps the two halves interleaved. The trailing `-o -print0` is the
  // measured fallback for a distribution whose `stat` is missing (see the docblock): it keeps the
  // listing NON-EMPTY so the stat-less case fails loudly at the tool's damage guard instead of
  // silently answering "no files match". The parentheses are REQUIRED — find's implicit AND binds
  // tighter than `-o`, so without them the fallback would not attach to the -path/-type test.
  argv.push('-path', `${root}/${translateGlob(input.pattern)}`, '-type', 'f',
    '(', '-exec', 'stat', '-c', '%.9Y', '{}', ';', '-print0', '-o', '-print0', ')')
  return argv
}

/**
 * Cut one line to `maxBytes` UTF-8 BYTES without ever splitting a character.
 *
 * The cap's name is its contract, and a UTF-16 `length` is not that number: '中文中' is 3 units
 * but 9 bytes (measured), so a unit-counted cap of 3 passed the WHOLE line through at three times
 * the caller's number. This walks the string's CODE POINTS and adds each one's `Buffer.byteLength`
 * until the next would cross the cap, so the cut always lands between characters — a byte-wise slice
 * of the buffer instead answers one whole character plus the first byte of the next, printed as a
 * replacement character. (Code points, not grapheme clusters: a combining mark is a code point of
 * its own, which is as far as this cap's name claims to go.)
 *
 * It is exported because the parser is not the only place the cut happens: a tool that keeps the
 * complete records in its VALUE and cuts the model-facing text at the render boundary (the host's
 * split — its `previewLine` cuts there) must make the same cut, and a second implementation of a
 * byte-correct cut is how the two would come to disagree.
 * @param {string} text - the line to cut.
 * @param {number} maxBytes - the cap, in UTF-8 bytes.
 * @returns {string} the longest prefix that fits, ending on a character boundary.
 */
export function cutToBytes(text, maxBytes) {
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += ch.length
  }
  return text.slice(0, end)
}

/**
 * Parse `grep -H -n` output into the host's match shape.
 *
 * grep prints `path:line:text` with NO escaping, so the split is the fragile part and it is
 * fixed to the FIRST two colons: the path ends at the first, the number runs to the second,
 * and everything after the second is text — which is what lets a matching line carry colons
 * of its own. A line without a second colon is not a record and is skipped.
 *
 * A colon inside the PATH is the same ambiguity read the other way, and the print cannot settle
 * it: the field boundaries are gone before this function is ever called. What is left to choose
 * is which failure to take, and this function takes the recoverable one. The line-number field is
 * the test — it is a COUNT, so a field that is not a finite integer (`/ws/a:b.ts:7:x` leaves
 * `b.ts` where the number belongs) means the split landed inside the damage, and the record is
 * SKIPPED, exactly as an unreadable find record is. Skipping costs one RECOVERABLE false negative:
 * the model can re-run with `read`, a narrower path, or bash. Keeping it costs the whole CALL —
 * NaN is not lossless JSON, so the host's value snapshot rejects the value (packages/util/values/
 * src/index.ts:128-129), its schema declares this field an INTEGER (tool-fs-search/src/grep.ts:307),
 * and the tool answers with a ToolOutputError that takes every other match in the batch down with
 * it, behind an error that never mentions a colon.
 *
 * That guard is NOT a solution to the ambiguity and must not be read as one: it covers only the
 * fields that do not read as a line number at all (NaN, Infinity, a fraction like `9.30`), and it
 * cannot cover the ones that do. `/ws/2024:12:00.log:7:needle` mis-reads to a FINITE
 * `{path: '/ws/2024', lineNumber: 12, text: '00.log:7:needle'}` (measured) — a number no guard can
 * tell from a real one — and `''` or `' 7'` read as 0 and 7 just as silently, so a colon-bearing
 * path may be DROPPED or silently MIS-ATTRIBUTED, and only the print format could settle which.
 * The gap is listed with the realm's other differences from the host (Task 5, docs/SEARCH.md).
 *
 * The caps are applied HERE, in Node: the vector asks the tool for everything, so this is the
 * only place a limit can be applied — and a cap that reported nothing would make a cut answer
 * read as a complete one. A line over `maxLineBytes` is cut to the cap but is NOT a truncated
 * answer: the record survives, shortened, so `truncated` stays about what the CAP left out. That
 * cap is in BYTES, because that is the name's promise — see `cutToBytes` for the unit that makes
 * it so.
 * @param {string} stdout - grep's stdout, one `path:line:text` record per line.
 * @param {{ maxMatches: number, maxLineBytes: number }} caps - the caller's caps.
 * @returns {{ matches: Array<{path: string, lineNumber: number, text: string}>, truncated: boolean }}
 *   the records, and whether the CAP left at least one further record out. (A record skipped for
 *   being unreadable is not a truncation: the flag is about the cap, not about damage.)
 */
export function parseGrepOutput(stdout, caps) {
  const matches = []
  let truncated = false
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue
    const first = rawLine.indexOf(':')
    const second = first === -1 ? -1 : rawLine.indexOf(':', first + 1)
    if (second === -1) continue
    // A line number is a COUNT, so anything else here means the split landed in the damage (the
    // docblock has the reason this is a SKIP rather than a `NaN` handed to the caller). It is
    // skipped BEFORE the cap is consulted, so an unreadable record neither fills the cap nor sets
    // `truncated` (which is about the cap), and with `continue`, never `break` — a broken record
    // must not end the scan and quietly shorten the answer.
    const lineNumber = Number(rawLine.slice(first + 1, second))
    if (!Number.isInteger(lineNumber)) continue
    if (matches.length >= caps.maxMatches) { truncated = true; break }
    const text = rawLine.slice(second + 1).replace(/\r$/, '')
    matches.push({
      path: rawLine.slice(0, first),
      lineNumber,
      text: cutToBytes(text, caps.maxLineBytes),
    })
  }
  return { matches, truncated }
}

/**
 * Parse the glob listing `<mtime>\n<path>\0` and order by mtime ASCENDING, in Node (no shell sort).
 *
 * The record format is the vector's, and both halves of it are load-bearing: the mtime ends at
 * the FIRST newline and the NUL is the record separator, because a path may contain both a
 * newline and a space — a line-based record would split one path in two, and a space-based
 * field split would cut one at its first space. `stat -c` always terminates its line, so the
 * newline is the field boundary; the path starts right after it and runs to the NUL. The order
 * is the host's MEASURED one rather than the natural-looking one: the host sorts by mtime
 * ascending (oldest first), so a descender here would be a silent disagreement with it. The cap
 * is applied AFTER the sort, which is what makes "the first N" mean the N oldest rather than
 * whichever N find happened to print first.
 *
 * A record that cannot be read at all is DROPPED, symmetrically with the grep side (which drops a
 * line without a second colon, and one whose line-number field is not a finite integer — the two
 * tests differ only because the fields do: a count, an mtime). The vector's own `stat` always
 * emits the newline, so a record without one means the print was cut short (or `stat` failed for
 * that hit — find reports that on stderr and exits nonzero, which the tool raises), and a
 * non-finite mtime means a value this parser cannot order by — a phantom path, or an order that
 * depends on where a NaN landed in V8's sort, would be an answer nobody decided. The drop is
 * deliberately silent (`truncated` is about the CAP, not about damage): for a broken record, no
 * path is the better answer.
 * @param {string} stdout - find's stdout, `<mtime>\n<path>` records separated by NUL.
 * @param {{ maxResults: number }} caps - the caller's cap.
 * @returns {{ paths: string[], truncated: boolean }} the paths, oldest first, and whether the CAP
 *   left at least one further record out. (The caller's `root` is the tool's own: it fills it
 *   from the path the model asked for — this parser never guesses one.)
 */
export function parseGlobOutput(stdout, caps) {
  const entries = stdout.split('\0').filter(entry => entry !== '')
    .map((entry) => {
      const newline = entry.indexOf('\n')
      // No newline means this is not a record the vector could have printed: skip it (never a path
      // built out of the damage). Not seen: a finite-looking prefix — a record cut before its
      // newline — would pass the mtime check below, so the newline itself is what says the record
      // is whole.
      if (newline === -1) return null
      const mtime = Number(entry.slice(0, newline))
      return Number.isFinite(mtime) ? { mtime, path: entry.slice(newline + 1) } : null
    })
    .filter(entry => entry !== null)
    .sort((a, b) => a.mtime - b.mtime)
  const truncated = entries.length > caps.maxResults
  return { paths: entries.slice(0, caps.maxResults).map(entry => entry.path), truncated }
}

/**
 * Classify ONE failed search into the host's failure vocabulary.
 *
 * Two names, because the model's next move differs: `SEARCH_INVALID_PATTERN` means rewrite the
 * regex, `SEARCH_FAILED` means the search never ran as asked (a launch that never happened —
 * including the `ENOENT` of a distribution without `grep`/`find` — a kill, a timeout, or a print
 * that could not be read). The names are the host's own (`tool-fs-search/src/search-core.ts:67-97`).
 *
 * The rule is grep's EXIT CODE, and the honest boundary of that rule belongs here rather than in a
 * comment nobody reads: GNU grep exits 2 for every error it has, not only for a bad pattern, and its
 * stderr is the only thing that separates a rejected pattern from an unreadable target. What settles
 * the mapping is the caller's action — and for an exit 2 the excerpt is what actually says which one
 * happened — so the class is the exit code and the message carries the diagnostic verbatim. The
 * class is grep's ALONE: find has no such exit, so an exit 2 from it is an ordinary failure.
 *
 * What this function deliberately does NOT do is decide the one combination a caller can detect
 * better than it can: output that was printed but parsed to nothing. That is a failure of the PRINT
 * reader, it is raised loudly by the tool that sees it (a silent drop of a malformed record must not
 * become indistinguishable from a genuine "no matches"), and it arrives here as an ordinary error
 * with no exit code — `SEARCH_FAILED`.
 * @param {unknown} error - the failure as it surfaced: an `Error` (or Error-shaped value) whose
 *   `exitCode` is the run's exit code when there was one.
 * @param {string} toolName - `'grep'` or `'glob'`, the tool the failure is reported for.
 * @returns {{ code: 'SEARCH_INVALID_PATTERN' | 'SEARCH_FAILED', message: string }} the class and the
 *   model-facing message (the class name leads it: the message is what the model sees, and the code
 *   rides beside it for the layers that route on it).
 */
export function searchFailure(error, toolName) {
  const detail = error instanceof Error ? error.message : String(error?.message ?? error)
  const exitCode = typeof error === 'object' && error !== null ? error.exitCode : undefined
  const suffix = detail.length === 0 ? '' : `: ${detail}`
  if (toolName === 'grep' && exitCode === 2) {
    return { code: 'SEARCH_INVALID_PATTERN', message: `SEARCH_INVALID_PATTERN: grep rejected the pattern (exit 2)${suffix}` }
  }
  const where = typeof exitCode === 'number' ? ` (exit ${exitCode})` : ''
  return { code: 'SEARCH_FAILED', message: `SEARCH_FAILED: ${toolName} search failed${where}${suffix}` }
}
