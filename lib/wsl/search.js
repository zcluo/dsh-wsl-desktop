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
 * @param {string} pattern - the model's glob.
 * @returns {string} the tail of the `-path` pattern; globArgv anchors it to the root.
 */
export function translateGlob(pattern) {
  return pattern.replace(/\*\*\//g, '').replace(/^\.\//, '')
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
  const argv = ['/usr/bin/find', input.path]
  for (const name of VCS_EXCLUDES) argv.push('-name', name, '-prune', '-o')
  // -path matches the whole printed path, so the model's root-relative pattern is anchored here.
  argv.push('-path', `${root}/${translateGlob(input.pattern)}`, '-type', 'f', '-printf', '%T@ %p\\0')
  return argv
}
