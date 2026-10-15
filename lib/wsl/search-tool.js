/**
 * The realm's `grep` and `glob`: the host's two names, run by the distribution's own tools.
 *
 * A WSL realm removes the host's search tools ON PURPOSE (their `argv[0]` is a packaged
 * WINDOWS ripgrep binary), and this module is what puts the two NAMES back — one row per
 * tool inside the `wsl-world` group, exactly the way `bash` and `fs` are re-mounted there.
 * Both rows name this ONE module, and `config.tool` is what says which of the two tools
 * that instance registers: two rows naming one module would otherwise register the same
 * tool twice, and a row that names neither is refused at mount time rather than mounting
 * nothing in silence.
 *
 * What is deliberately NOT the host's, and each one is declared in the tool's own
 * description as well (the wording lives THERE, where the model reads it before calling —
 * repeating the list here would be a second contract to keep in sync):
 *
 *  - **the backend**: `/usr/bin/grep -E` and `/usr/bin/find` as the distribution ships them;
 *  - **the pattern dialect**: POSIX extended for `grep`; for `find` the search root anchors
 *    the glob and `*` crosses `/` (measured, findutils 4.10.0);
 *  - **the ignore behaviour**: `.gitignore` is not read, only the six VCS directories are
 *    skipped, and — unlike the host, whose ripgrep skips every hidden entry — dotted
 *    directories ARE searched;
 *  - **`include`**: fnmatch over each file's BASE NAME, so braces and directory parts never
 *    match anything (`grep --include` semantics, measured in the distribution);
 *  - **the cap**: a result at the limit is TRUNCATED and says so, and nothing is spilled to
 *    a file (the host reports where it saved the complete result; this world keeps none).
 *
 * The VALUE of each tool is the host's own shape (`{matches:[{path,lineNumber,line}]}`,
 * `{root,paths}`) — the parsers' `text` field is mapped to `line` here, and `truncated` is
 * NOT a field: it is a fact about what the text withheld, so it is stated in the text, which
 * is where the host states it too.
 *
 * Failures are classified by `searchFailure` (the host's two names) and raised as a
 * {@link HarnessError} subclass, so the registry exposes `{ name, code }` on the result the
 * same way it does for the host's own `SearchError`.
 * @module dsh-wsl-desktop/wsl/search-tool
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cutToBytes, globArgv, grepArgv, parseGlobOutput, parseGrepOutput, searchFailure } from './search.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wsl-search'

/**
 * Services these tools use. `fs` is the REALM's filesystem provider — the `wsl-world`
 * group isolates `fs` — which is what turns the model's path into the Linux absolute one
 * the distribution's own tools can open; `workingDirectory` is the session workspace that
 * a relative path resolves against.
 */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'fs', 'workingDirectory']

/**
 * The caps, mirroring `@deepseek-ai/dsh-tool-fs-search`'s defaults field for field, so the
 * two worlds' searches are the same SIZE even though their engines differ. They are module
 * constants rather than a plugin config because this module is mounted twice in one group
 * (one instance per tool) and a config that had to be repeated on both rows would be a
 * second place to drift; a deployment that needs different numbers adds a config then.
 */
const MAX_MATCHES = 250
const MAX_LINE_BYTES = 2000
const MAX_RESULTS = 100
const RAW_OUTPUT_MAX_BYTES = 20_000_000
const GRACE_MS = 3_000
const STDERR_MAX_BYTES = 64 * 1024
const TIMEOUT_MS = 30_000

/**
 * The parsers are asked to RETAIN EVERYTHING; the cap is applied where the model's text is
 * written ({@link renderGrep} / {@link renderGlob}).
 *
 * That split is forced, not preferred: `output.render(args, value)` is the only place a tool
 * writes the text, the `value` it receives is the frozen snapshot the registry validated, and
 * a cap applied any earlier would leave the text unable to tell "exactly at the cap" from
 * "the cap withheld the rest" — the silent-cut shape this whole capability refuses. The host
 * splits it in exactly the same place (its parsers return every record and its
 * `retainGrepMatches`/`globCardPage` cut inside `render`).
 *
 * What bounds "keep everything" is therefore the stdout budget at the spawn seam
 * ({@link RAW_OUTPUT_MAX_BYTES}): a run that produced more than that is refused loudly below
 * rather than parsed partially, so "all the records" is always a number the seam retained.
 */
const RETAIN_ALL_MATCHES = { maxMatches: Number.POSITIVE_INFINITY, maxLineBytes: Number.POSITIVE_INFINITY }
const RETAIN_ALL_PATHS = { maxResults: Number.POSITIVE_INFINITY }

/** One failed search, carrying the host's classification code on the result. */
class SearchError extends HarnessError {}

/**
 * Raise the classified failure for a failed run, a failed launch, or a print that could not
 * be read. `searchFailure` owns WHICH class this is; this function only carries it.
 * @param {unknown} error - the failure, with `exitCode` attached when the run exited.
 * @param {string} toolName - `'grep'` or `'glob'`.
 */
function raise(error, toolName) {
  const { code, message } = searchFailure(error, toolName)
  throw new SearchError(message, code)
}

/**
 * Raise for a run that COMPLETED with an exit code neither tool accepts, handing the code
 * and the diagnostic tail to {@link searchFailure} — the exit code is what tells a rejected
 * grep pattern apart from every other failure.
 * @param {string} toolName - `'grep'` or `'glob'`.
 * @param {number} exitCode - the process's exit code.
 * @param {string} stderr - the retained stderr tail.
 */
function raiseExit(toolName, exitCode, stderr) {
  const detail = stderr.trim()
  const error = new Error(detail.length === 0 ? `${toolName} exited ${exitCode}` : detail)
  error.exitCode = exitCode
  raise(error, toolName)
}

/**
 * Resolve the model's path to the search root both tools run against.
 *
 * The root is a LINUX ABSOLUTE path, and this is the site where that happens — the reason
 * the vectors never meet a dash-leading path. MEASURED (findutils 4.10.0): `find -- -dashdir`
 * reports "unknown predicate `-dashdir'" and exits 1, a LOUD failure, which is why the vector
 * layer accepts such a path instead of guarding against it; and it cannot arrive here, because
 * the resolution below turns the model's path into an absolute one and an absolute path never
 * begins with `-`. (Task 2 left those two facts in `globArgv`'s comment and named this site —
 * this is that site.)
 *
 * The resolution is the realm's OWN filesystem provider rather than a second path grammar
 * grown here: `ctx.fs` is the service the `fs` row mounts into this group, and it is what
 * knows the Windows/UNC spellings of the distribution's files.
 * @param {object} ctx - the realm's plugin context.
 * @param {object} exec - the tool-execution context (owner agent and abort signal).
 * @param {{ path?: string }} input - the model's arguments.
 * @returns {Promise<{ workdir: string, root: string }>} the session workspace (the spawn cwd)
 *   and the absolute Linux search root.
 */
async function resolveRoot(ctx, exec, input) {
  const workdir = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const target = await ctx.fs.resolve(input.path ?? '.', { cwd: workdir, signal: exec.signal })
  return { workdir, root: ctx.fs.processPath(target) }
}

/**
 * Run one search command inside the distribution and return what it printed.
 *
 * Only the TRANSPORT failures are raised here (a launch that never happened, a kill, a print
 * the seam could not retain whole): which exit codes are acceptable is the calling tool's own
 * business, because `grep` and `find` disagree about it. A nonzero exit is returned to the
 * caller, which raises it with its code attached — that code is the whole classification.
 * @param {object} ctx - the realm's plugin context.
 * @param {object} exec - the tool-execution context (abort signal).
 * @param {string} toolName - `'grep'` or `'glob'`; named in every failure message.
 * @param {string[]} argv - the vector from `grepArgv`/`globArgv`.
 * @param {string} workdir - the session workspace, as the subprocess provider maps it.
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>} the run's output.
 */
async function runCommand(ctx, exec, toolName, argv, workdir) {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv,
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: GRACE_MS,
      signal: exec.signal,
    })
  } catch (error) {
    // A launch that never happened (a NUL in argv, a signal already aborted, a provider that
    // refused) is reported without claiming execution began — and it is SEARCH_FAILED, the
    // same class as the `ENOENT` of a distribution without grep/find.
    raise(error, toolName)
  }
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    raise(error, toolName)
  }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) raise(new Error('the run produced no collected output streams'), toolName)
  if (stdout.lossy) {
    // The seam retained less than the tool printed, and a partial print parses into a short
    // answer that reads exactly like a complete one — the one outcome a search must never
    // report quietly.
    raise(new Error(`it printed more than the ${RAW_OUTPUT_MAX_BYTES}-byte output budget; narrow pattern, path, or include and retry`), toolName)
  }
  if (outcome.signal !== null || outcome.exitCode === null) {
    raise(new Error(`it was killed by signal ${outcome.signal ?? '(unknown)'}`), toolName)
  }
  return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode }
}

/**
 * Bound one matched line to {@link MAX_LINE_BYTES} and mark the cut.
 *
 * The marker is the host's own (` (line truncated)`, `search-core.ts:325-330`), and it is
 * exact rather than a guess because the VALUE keeps the complete line: a cut line is a strict
 * prefix of what the search read, so "was anything cut" is answered by comparing the two, not
 * by comparing a length against a cap that a line may meet without being cut.
 * @param {string} line - the complete matched line.
 * @returns {string} the preview, suffixed when bytes were cut.
 */
function previewLine(line) {
  const kept = cutToBytes(line, MAX_LINE_BYTES)
  return kept === line ? kept : `${kept} (line truncated)`
}

/**
 * The model-facing `grep` page: a found-count header, the retained matches grouped by file,
 * and — when the cap cut the list — a footer that says so AND says the rest was not saved.
 * The host's footer carries a recovery locator there; this world has no spill file, so the
 * honest footer is the one that says so instead of pointing at a file that does not exist.
 * @param {{ matches: Array<{path: string, lineNumber: number, line: string}> }} value - the tool's value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function renderGrep(value) {
  const seen = value.matches.length
  if (seen === 0) return [{ type: 'text', text: 'No matches found' }]
  const kept = value.matches.slice(0, MAX_MATCHES)
  const truncated = seen > MAX_MATCHES
  const header = truncated
    ? `Found ${kept.length} of ${seen} matches`
    : `Found ${seen} ${seen === 1 ? 'match' : 'matches'}`
  const byFile = new Map()
  for (const match of kept) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections = [...byFile].map(([path, group]) => (
    `${path}\n${group.map((match) => `Line ${match.lineNumber}: ${previewLine(match.line)}`).join('\n')}`
  ))
  const footer = truncated
    ? '\n\n(The complete result was not saved; narrow pattern, path, or include to see more.)'
    : ''
  return [{ type: 'text', text: `${header}\n\n${sections.join('\n\n')}${footer}` }]
}

/**
 * The model-facing `glob` page: the paths themselves when they fit, and the first page plus a
 * footer that says how many were withheld and that the rest was not saved.
 * @param {{ root: string, paths: string[] }} value - the tool's value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function renderGlob(value) {
  if (value.paths.length === 0) return [{ type: 'text', text: 'No files found' }]
  if (value.paths.length <= MAX_RESULTS) return [{ type: 'text', text: value.paths.join('\n') }]
  const page = value.paths.slice(0, MAX_RESULTS).join('\n')
  return [{
    type: 'text',
    text: `${page}\n\n(Showing ${MAX_RESULTS} of ${value.paths.length} paths, oldest first. The complete list was not saved; narrow pattern or path to see more.)`,
  }]
}

/**
 * The `grep` tool: which line of which file matches, with line numbers, grouped by file.
 * @param {object} ctx - the realm's plugin context (the services `execute` reaches).
 * @returns {object} the registry-ready tool definition.
 */
function grepTool(ctx) {
  return defineTool({
    name: 'grep',
    description: 'Search file contents inside the WSL distribution, with the distribution\'s own grep. '
      + 'Returns matching lines with line numbers, grouped by file, each path exactly as grep printed it (absolute). '
      + '.gitignore is not read — only the six VCS directories are skipped — and dotted directories ARE searched. '
      + 'Binary files are never matched: the distribution\'s grep treats a binary file as non-matching, so its bytes never enter a result line — the host\'s rg reports a match for the same file. '
      + 'A path containing a colon can make a match wrong or missing: `path:line:text` is printed with no escaping, so a colon inside a path can be taken for a field separator, and the match then names the wrong file and line number with nothing in the result to mark it wrong — or the record is dropped. Narrow the path, or use `read`, when a name contains one. '
      + `Up to ${MAX_MATCHES} matches; a capped result says how many were withheld, and the complete list is not saved anywhere.`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for, in POSIX extended form — not ripgrep\'s: \\d and (?i) are not available (write [0-9], or spell out the case alternation). '
          + 'A pattern that matches nothing returns no matches, not an error.',
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.',
      },
      include: {
        type: 'string',
        description: 'One glob filter for which files to search (e.g. "*.ts"). It is matched against each file\'s BASE NAME, so a glob carrying a directory ("src/*.ts") matches nothing — narrow with path instead — '
          + 'and there is no brace expansion, so "*.{ts,tsx}" matches nothing either. Not a list; negation is not supported.',
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => renderGrep(value),
    },
    async execute(args, exec) {
      if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
      const { workdir, root } = await resolveRoot(ctx, exec, args)
      const argv = grepArgv(
        { pattern: args.pattern, path: root, ...args.include !== undefined ? { include: args.include } : {} },
        { maxMatches: MAX_MATCHES },
      )
      const run = await runCommand(ctx, exec, 'grep', argv, workdir)
      if (run.exitCode === 1) return { matches: [] }
      if (run.exitCode !== 0) raiseExit('grep', run.exitCode, run.stderr)
      const parsed = parseGrepOutput(run.stdout, RETAIN_ALL_MATCHES)
      // grep prints `path:line:text` for every match, so output that parses to NOTHING is
      // output the print reader could not read at all — a colon inside a path is the known
      // cause. That must not answer as "No matches found", which is what a silent drop would
      // look like: the two are distinguishable precisely because a genuine empty result
      // prints not a single byte.
      //
      // That premise leans on `--binary-files=without-match` in `grepArgv` (`search.js`), and
      // this coupling is the part no assertion can see. The flag's VALUE is the gap the tool
      // description declares — a binary file is treated as non-matching, so its bytes never
      // enter a line — and the measurement below is what makes this guard's premise provable:
      // WITH the flag a binary file's match yields no line, no stdout byte and exit 1
      // (measured, GNU grep 3.11), so a non-empty print here really is unreadable output.
      // Measured without it: exit 0, an EMPTY stdout, and the `Binary file … matches` notice
      // on STDERR — this guard reads stdout, so it would not fire; the call would answer
      // "No matches found" and drop the notice, and the loud failure this guard exists for
      // would need a grep that put that notice on stdout. The flag's presence is pinned
      // byte-for-byte by the golden vector in `scripts/verify-search.mjs`; the reason it must
      // stay is here. (Carried ruling 38, task 4; its wording states the result first under
      // ruling 47's minor, alongside the declared gap.)
      if (run.stdout.length > 0 && parsed.matches.length === 0) {
        raise(new Error(`its output could not be read as match records (${run.stdout.length} bytes; a path containing a colon is the known cause) — narrow the path and retry`), 'grep')
      }
      return { matches: parsed.matches.map((match) => ({ path: match.path, lineNumber: match.lineNumber, line: match.text })) }
    },
  })
}

/**
 * The `glob` tool: files, not directories, whose paths match a glob pattern.
 * @param {object} ctx - the realm's plugin context (the services `execute` reaches).
 * @returns {object} the registry-ready tool definition.
 */
function globTool(ctx) {
  return defineTool({
    name: 'glob',
    description: 'Find files (not directories) inside the WSL distribution, with the distribution\'s own find. '
      + 'Returns absolute paths exactly as find printed them, in modification-time order. '
      + '.gitignore is not read — only the six VCS directories are skipped — and dotted directories ARE searched. '
      + `Up to ${MAX_RESULTS} paths; a capped result says how many were withheld, and the complete list is not saved anywhere.`,
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). Interpreted relative to the search root, and "*" crosses "/" as "*" and "**/" alike, '
          + 'so "src/*.ts" also matches files deeper than one level, while a pattern with no "/" matches at any depth and a leading "/" means the same as none. '
          + 'A pattern that matches nothing returns an empty list, not an error.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.',
      },
    },
    timeoutMs: TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderGlob(value),
    },
    async execute(args, exec) {
      if (args.pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
      if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
      const { workdir, root } = await resolveRoot(ctx, exec, args)
      const argv = globArgv({ pattern: args.pattern, path: root }, { maxResults: MAX_RESULTS })
      const run = await runCommand(ctx, exec, 'glob', argv, workdir)
      if (run.exitCode !== 0) raiseExit('glob', run.exitCode, run.stderr)
      const parsed = parseGlobOutput(run.stdout, RETAIN_ALL_PATHS)
      // The `-printf` emits one `%T@ %p` record per hit, so a non-empty print that parsed to
      // NO path is damaged output (the reader drops a record it cannot read, silently by
      // design) — and silence here would be indistinguishable from "no files match", which
      // find prints as nothing at all.
      if (run.stdout.length > 0 && parsed.paths.length === 0) {
        raise(new Error(`its output could not be read as path records (${run.stdout.length} bytes)`), 'glob')
      }
      return { root, paths: parsed.paths }
    },
  })
}

/** The sentence each tool adds to the system prompt while that tool exists in the scope. */
const PROMPTS = {
  grep: 'Use the grep tool — not shell grep — to search file contents in this WSL session; it is the distribution\'s own grep.',
  glob: 'Use the glob tool — not shell find — to discover files by path pattern in this WSL session; it is the distribution\'s own find.',
}

/**
 * Register the ONE tool this row names, plus its scope-aware prompt guidance.
 *
 * The section is registered the way the host registers its own (`grep.ts:275-282`): its text
 * is a function of the scope and is EMPTY while the tool is not resolvable there, so the
 * guidance cannot outlive the tool it describes. The section name is `wsl:`-prefixed rather
 * than the host's `tool:` — a composition that mounted both would otherwise have two
 * sections claiming one name.
 * @param {object} ctx - the realm's plugin context; registrations are effects scoped to it.
 * @param {{ tool?: string } | undefined} config - the row's config: which tool this is.
 */
export function apply(ctx, config) {
  const tool = config?.tool
  if (tool !== 'grep' && tool !== 'glob') {
    throw new Error(`wsl-search: this row must name the tool it registers as config.tool ("grep" or "glob"), got ${JSON.stringify(tool ?? null)}`)
  }
  ctx.systemPrompt.section({
    name: `wsl:${tool}`,
    order: ctx.systemPrompt.getSectionOrder(tool === 'grep' ? 'TOOL_GREP' : 'TOOL_GLOB'),
    text: ({ scope }) => ctx.tools.get(tool, scope) === undefined ? '' : PROMPTS[tool],
  })
  ctx.tools.register(tool === 'grep' ? grepTool(ctx) : globTool(ctx))
}
