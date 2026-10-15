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
 * their own (`path:line:text` with no escaping, `%T@ %p` NUL-separated), and the parsers
 * below turn that print into the host tool's shape, applying the caps there — in Node,
 * because the vectors ask for everything and only the consumer can stop. The sort is Node's
 * too: a realm has no shell to pipe into `sort`.
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
 * A leading `/` is ripgrep's ANCHORED glob form; it is stripped so that `/**` + `/x.ts` and
 * `**` + `/x.ts` mean the same thing here. WITHOUT the strip a pattern such as `/**` + `/*.ts`
 * would emit a `//`-bearing -path pattern, which matches NOTHING (measured: the same fixture
 * answers 2 records for the single-slash form and 0 for the doubled one).
 * @param {string} pattern - the model's glob.
 * @returns {string} the tail of the `-path` pattern; globArgv anchors it to the root.
 */
export function translateGlob(pattern) {
  return pattern.replace(/^\//, '').replace(/\*\*\//g, '').replace(/^\.\//, '')
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
 * One `find` argv vector: VCS pruned by -prune, the pattern anchored to the root, mtime
 * printed for the sort in Node.
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
  // It is NOT a licence to pass a path that begins with `-`: measured, `find -- -dashdir …` still
  // fails with "unknown predicate `-dashdir'", because find ends its path list at the first
  // dash-leading argument. Task 3's path resolution must refuse such a path.
  const argv = ['/usr/bin/find', '--', input.path]
  for (const name of VCS_EXCLUDES) argv.push('-name', name, '-prune', '-o')
  // -path matches the whole printed path, so the model's root-relative pattern is anchored here.
  argv.push('-path', `${root}/${translateGlob(input.pattern)}`, '-type', 'f', '-printf', '%T@ %p\\0')
  return argv
}

/**
 * Parse `grep -H -n` output into the host's match shape.
 *
 * grep prints `path:line:text` with NO escaping, so the split is the fragile part and it is
 * fixed to the FIRST two colons: the path ends at the first, the number runs to the second,
 * and everything after the second is text — which is what lets a matching line carry colons
 * of its own. The other direction of the same ambiguity, a colon inside the PATH, cannot be
 * resolved from this print at all (grep offers no escaping), so it is disclosed rather than
 * guessed at. A line without a second colon is not a record and is skipped.
 *
 * The caps are applied HERE, in Node: the vector asks the tool for everything, so this is the
 * only place a limit can be applied — and a cap that reported nothing would make a cut answer
 * read as a complete one. A line over `maxLineBytes` is cut to the cap but is NOT a truncated
 * answer: the record survives, shortened, so `truncated` stays about dropped records.
 * @param {string} stdout - grep's stdout, one `path:line:text` record per line.
 * @param {{ maxMatches: number, maxLineBytes: number }} caps - the caller's caps.
 * @returns {{ matches: Array<{path: string, lineNumber: number, text: string}>, truncated: boolean }}
 *   the records, and whether at least one further record was dropped.
 */
export function parseGrepOutput(stdout, caps) {
  const matches = []
  let truncated = false
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue
    const first = rawLine.indexOf(':')
    const second = first === -1 ? -1 : rawLine.indexOf(':', first + 1)
    if (second === -1) continue
    if (matches.length >= caps.maxMatches) { truncated = true; break }
    const text = rawLine.slice(second + 1).replace(/\r$/, '')
    matches.push({
      path: rawLine.slice(0, first),
      lineNumber: Number(rawLine.slice(first + 1, second)),
      text: text.length > caps.maxLineBytes ? text.slice(0, caps.maxLineBytes) : text,
    })
  }
  return { matches, truncated }
}

/**
 * Parse `find -printf '%T@ %p\0'` and order by mtime ASCENDING, in Node (no shell sort).
 *
 * The record format is the vector's, and both halves of it are load-bearing: the mtime ends at
 * the FIRST space (a path may contain one), and the NUL is the separator because a path may
 * contain a newline — a line-based record would split one path in two. The order is the host's
 * MEASURED one rather than the natural-looking one: the host sorts by mtime ascending (oldest
 * first), so a descender here would be a silent disagreement with it. The cap is applied AFTER
 * the sort, which is what makes "the first N" mean the N oldest rather than whichever N find
 * happened to print first.
 * @param {string} stdout - find's stdout, `%T@ %p` records separated by NUL.
 * @param {{ maxResults: number }} caps - the caller's cap.
 * @returns {{ paths: string[], truncated: boolean }} the paths, oldest first, and whether at
 *   least one further record was dropped. (The caller's `root` is the tool's own: it fills it
 *   from the path the model asked for — this parser never guesses one.)
 */
export function parseGlobOutput(stdout, caps) {
  const entries = stdout.split('\0').filter(entry => entry !== '')
    .map((entry) => {
      const space = entry.indexOf(' ')
      return { mtime: Number(entry.slice(0, space)), path: entry.slice(space + 1) }
    })
    .sort((a, b) => a.mtime - b.mtime)
  const truncated = entries.length > caps.maxResults
  return { paths: entries.slice(0, caps.maxResults).map(entry => entry.path), truncated }
}
