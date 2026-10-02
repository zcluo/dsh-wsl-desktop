/**
 * Run every verification suite and report one summary.
 *
 * The suites are independent Node programs, so this only sequences them and
 * aggregates exit codes: it never swallows a failure, and a suite that crashes
 * is reported with its own exit code rather than as a pass.
 *
 * Suites that need the running Desktop host are opt-in (`--live`), because they
 * mutate host state (they create and remove a workspace, and one of them creates
 * sessions) and are meaningless without the plugin installed.
 *
 * A suite's exit code 2 is its own SKIP: a check it could not evaluate on this
 * machine. That used to be printed and then ignored — the aggregate exited 0 however
 * many suites skipped — so a gate reading only the exit code could not tell "every
 * suite ran" from "one suite never ran". A skip is now accepted only from a suite
 * DECLARED_SKIPS names together with the precondition that justifies it; an
 * undeclared skip fails the aggregate instead.
 *
 * Run: node scripts/verify-all.mjs [--live]
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blankLiterals } from './source-text.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const live = process.argv.includes('--live')

/**
 * The milliseconds one suite may run before this aggregate kills it.
 *
 * Every suite bounds its own external calls, but a hung fs-on-UNC or jsdom run must fail
 * the aggregator rather than hang it. The name is not decoration: what a kill MEANS is
 * reported from this value (see outcomeOf), so a suite THIS aggregate stopped cannot be
 * read as a suite whose checks failed — and a pin can shorten it to produce that ending
 * on purpose.
 */
const SUITE_CEILING_MS = 300_000

/** The ceiling as a message spells it. */
const ceilingText = () => `${Number((SUITE_CEILING_MS / 1000).toFixed(1))}s`

/**
 * What one suite's run WAS.
 *
 * spawnSync funnels several different endings through one `status` field, and `?? 1`
 * reported every one of them as "the suite exited 1": a suite THIS aggregate killed at
 * its own ceiling — a bound on the whole run, which a loaded machine reaches — was
 * byte-identical in the summary to a suite whose checks failed. Observed:
 * verify-confinement.mjs and verify-confinement-skip.mjs printed FAIL (exit 1) in
 * aggregate runs while each printed ALL CHECKS PASSED and exited 0 run alone, and nothing
 * in that summary let a reader tell a broken suite from one the aggregator itself stopped.
 *
 * Measured endings on this platform (Windows, Node 24) — the numbers, not assumptions:
 *   ceiling hit         status null, signal 'SIGKILL', error ETIMEDOUT
 *   spawn failed        status null, signal null,      error ENOENT
 *   exited 3            status 3,    signal null,      error null
 *   killed by a signal  status 1,    signal null,      error null   <- indistinguishable
 * The last line is the honest limit: on Windows a child that dies from a signal is
 * reported exactly like one that exited 1, so this identifies the endings THIS aggregate
 * produces itself — its ceiling, and a spawn that never happened — and does not pretend
 * to identify a kill from anywhere else.
 *
 * @param {string} suite - the suite's file name.
 * @param {import('node:child_process').SpawnSyncReturns<Buffer>} run - the finished run.
 * @param {number} elapsedMs - how long the aggregate waited for it.
 * @returns {{suite: string, code: number, how: 'exited' | 'ceiling' | 'signalled' | 'unstarted', note: string}} the outcome.
 */
function outcomeOf(suite, run, elapsedMs) {
  const { status, signal } = run
  const error = run.error ?? null
  const seconds = (elapsedMs / 1000).toFixed(1)
  // The elapsed test backstops a platform that reports the kill without ETIMEDOUT: at
  // the ceiling's own expiry, a child still without a status was stopped by it.
  const outOfTime = error?.code === 'ETIMEDOUT' || (status === null && signal !== null && elapsedMs >= SUITE_CEILING_MS)
  if (outOfTime) return { suite, code: 1, how: 'ceiling', note: `killed at this aggregate's ${ceilingText()} ceiling after ${seconds}s — the suite did not finish` }
  if (status === null && signal !== null) return { suite, code: 1, how: 'signalled', note: `killed by ${signal} after ${seconds}s — the suite did not finish` }
  if (status === null) return { suite, code: 1, how: 'unstarted', note: `could not be started${error === null ? ' (no exit status and no error)' : `: ${error.code ?? error.message}`}` }
  return { suite, code: status, how: 'exited', note: '' }
}

/** Suites that run against the distribution and the source tree alone (verify-package needs only npm and the package root). */
const STANDALONE = [
  'verify-modules.mjs',
  'verify-package.mjs',
  'verify-fs-fence.mjs',
  'verify-fs-fence-skip.mjs',
  'verify-world.mjs',
  'verify-preset.mjs',
  'verify-9p.mjs',
  'verify-9p-skip.mjs',
  'verify-confinement.mjs',
  'verify-confinement-skip.mjs',
  'verify-terminal.mjs',
  'verify-pty-handle.mjs',
  'verify-client-ui.mjs',
  'verify-client-dom.mjs',
  'verify-sync.mjs',
  'verify-all-skip.mjs',
]

/** Suites that require the installed plugin behind a running Desktop host. */
const LIVE = ['verify-route.mjs', 'inspect-live-client.mjs', 'verify-post-restart.mjs']

/**
 * The suites that may legitimately SKIP, each with the precondition that allows it.
 *
 * A suite exits 2 when a check of its own could not be evaluated here, and the
 * suite's own SKIP block names what it could not evaluate. The aggregate cannot see
 * that block — it reads exit codes — so the declaration is what makes the skip
 * reviewable: it is the claim that this state belongs to the MACHINE rather than to
 * the code, and it names the condition under which that is true.
 *
 * The list was derived by READING the suites for the branches that set exit 2, not
 * from what they are expected to do on any one machine. Every entry below cites the
 * branch it comes from — as TEXT, not as a line number, and the stale check below
 * re-resolves every citation against the file on every run. A line number rots silently:
 * the pid-suffix commit in this range moved all seven of them at once, and the table went
 * on pointing at whatever now sat at those numbers. A citation that no longer resolves
 * fails the run before any suite starts, naming the text it could not find; a suite whose
 * skip cannot be justified by such a branch is not declared, and its skip fails the run.
 * Adding an entry is a claim about the machine class the suite may skip on: a suite that
 * CAN skip without an entry is a skip that arrives undeclared the day its precondition
 * occurs, and this run fails then, naming it — which is when the question of declaring it
 * is answerable.
 *
 * A suite with more than one exit-2 branch lists all of them: the aggregate sees one
 * exit code and cannot tell which branch produced it, so an entry that named only
 * one of them would cover a skip it does not describe.
 *
 * Each precondition states the CONDITION ITS BRANCH TESTS, in every way that branch can
 * fire — not merely the way that happens to occur on this machine. An entry narrower
 * than its branch is the defect this table exists to prevent: a claim that does not
 * cover what it certifies. Measured, when this rule was applied to the entries below:
 * verify-client-ui.mjs's icon branch fires for an existing checkout that does not carry
 * the icon source, so a precondition reading "the harness checkout is absent" named a
 * condition that was not the branch's, and the suite skips in cases it did not cover.
 */
const DECLARED_SKIPS = [
  {
    // verify-modules.mjs — the branch tests `!existsSync(DSH_WSL_DEPS ?? <plugin root>/node_modules)`,
    // which is true when the plugin root carries no node_modules AND when an override names a
    // directory that is not there. Either way lib/index.js cannot be imported, which is the
    // suite's motivating check.
    suite: 'verify-modules.mjs',
    branch: ['!existsSync(deps)'],
    precondition: 'the dependency directory the suite resolves (DSH_WSL_DEPS when it names one, otherwise the plugin root node_modules) does not exist, so lib/index.js cannot be imported here',
  },
  {
    // verify-package.mjs — the branch tests `!(status === 0 && a version in stdout)`, so it
    // fires for an npm that cannot be spawned, one that exits non-zero, and one that answers
    // without a version.
    suite: 'verify-package.mjs',
    branch: ['!npmUsable'],
    precondition: 'npm --version cannot be spawned, exits non-zero, or answers without a version, so the packed artifact cannot be produced or inspected here',
  },
  {
    // verify-fs-fence.mjs — the branch tests `publicationCode === null`, which a missing
    // checkout AND an existing checkout without packages/fs/fs-local/src/fsio.ts both produce;
    // and `!otherReachable`, true with no second distribution installed, an empty
    // DSH_WSL_OTHER_DISTRO, one naming this distribution, a resolver that threw, or a resolved
    // share that does not exist. (Its third exit-2 print sits behind the link-fixture FAIL,
    // so a run that reaches it exits 1: not a skip-only branch.)
    suite: 'verify-fs-fence.mjs',
    branch: ['publicationCode === null', '!otherReachable'],
    precondition: 'the checkout file packages/fs/fs-local/src/fsio.ts cannot be read (no checkout, or one without it), or there is no second WSL distribution share to compare against (none installed, the override names none or names this one, the resolver failed, or the resolved share does not exist)',
  },
  {
    // verify-9p.mjs — the branch tests `linkProblem !== ''`, set by any throw while the
    // fixture is built through wsl.exe (a cold VM start, a timeout, an unwritable share);
    // and `otherDistro === ''`, the same resolver conditions as the entry above.
    suite: 'verify-9p.mjs',
    branch: ["linkProblem !== ''", "otherDistro === ''"],
    precondition: 'the probe could not build its own symlink fixture through wsl.exe, or there is no second WSL distribution share to compare against (none installed, the override names none or names this one, or its share does not exist)',
  },
  {
    // verify-confinement.mjs — every branch has its OWN precondition, and the entry names all of
    // them: `windowsToMntPath(helperPathFile) === null` (the checkout
    // has no /mnt spelling); that OR `unshare -r id -u` answering something other
    // than 0 (no unprivileged user namespace); `FIXTURE_SOURCE_MNT === null`, which is
    // about the HOST TEMP directory, not the checkout; the fixture setup not answering
    // fixtures-ok; and the grant probe not answering the expected version.
    suite: 'verify-confinement.mjs',
    branch: ['windowsToMntPath(helperPathFile)', 'mnt === null', 'unshare -r id -u', 'FIXTURE_SOURCE_MNT === null', 'fixtures-ok', 'grantProbe ==='],
    precondition: 'the checkout has no mountable drive path for the shipped helper, the distribution has no unprivileged user namespace, the host temp directory has no /mnt spelling, the fixtures could not be built in the distribution, or the sudoers grant does not cover them',
  },
  {
    // verify-client-ui.mjs — the branch tests `iconSource === null` after the read is caught,
    // which a missing checkout AND an existing checkout that does not carry
    // packages/client/ui-primitives/src/icons/index.tsx both produce. Measured with --checkout
    // pointed at a directory holding only a package.json: 30 check(s) passed, 1 skipped, exit 2.
    suite: 'verify-client-ui.mjs',
    branch: ['iconSource === null'],
    precondition: 'the shipped icon source (packages/client/ui-primitives/src/icons/index.tsx) is not readable — no checkout, or one that does not carry that file — so the trigger geometry cannot be checked against the artwork',
  },
  {
    // verify-client-dom.mjs — the branch is the catch around
    // `createRequire(join(checkout, 'package.json'))('jsdom')`, which throws for a missing
    // checkout AND for an existing one without the dependency.
    suite: 'verify-client-dom.mjs',
    branch: ["createRequire(join(checkout, 'package.json'))"],
    precondition: 'there is no harness checkout to resolve jsdom from, or jsdom is not installed in one, so the browser half cannot be run in a real DOM',
  },
]

const suites = live ? [...STANDALONE, ...LIVE] : STANDALONE
const results = []
/** The declaration of one suite, by name. */
const declarations = new Map(DECLARED_SKIPS.map((entry) => [entry.suite, entry]))

// The suites' own check() contract, verified mechanically BEFORE anything runs: a
// check whose second argument is a string literal passes a truthy value where the
// boolean belongs, so it prints PASS unconditionally and asserts nothing at all.
// That class has appeared twice in this repository — once among the round-1 suite
// findings (a range asserted where the contract named an exact value, a grep that
// could never match, an assertion that was false === false) and once in a pin
// written while fixing them — so it is scanned for rather than trusted.
{
  const offenders = []
  for (const suite of suites) {
    const source = readFileSync(join(here, suite), 'utf8')
    for (const match of source.matchAll(/\bcheck\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*['"`]/g)) {
      const line = source.slice(0, match.index).split('\n').length
      offenders.push(`${suite}:${line}`)
    }
  }
  if (offenders.length > 0) {
    console.log(`\nFAIL  a check() passes its detail string where the boolean belongs (always PASS): ${offenders.join(', ')}`)
    process.exit(1)
  }
  console.log(`check() contract clean across ${suites.length} suites`)
}

/**
 * The expressions that determine one suite's OWN process exit code.
 *
 * Only two statements set it: a `process.exit(...)` call, and an assignment to
 * `process.exitCode`. Reading THOSE — rather than searching the file for an exit-2
 * shape — is what makes "this suite can skip" a statement about the suite's own exit
 * code. A `cond ? 2 : 0` that computes a CHILD process's expected code, or a
 * comparison against 2 anywhere else in the file, is not this suite's exit code:
 * measured on a sibling suite whose working tree carried
 * `const expectedCode = ... ? 2 : 0` for a child it spawns, while its own tail was
 * `process.exitCode = failures === 0 ? 0 : 1` — a shape search called that suite one
 * that skips, and this scan would have called its declaration stale the day it made
 * one. The text must be comment- and literal-blanked first, so a suite that merely
 * NAMES the convention in prose is not read as a suite that performs it.
 * @param {string} source - the suite's source, blanked.
 * @returns {string[]} one entry per exit-code expression, in source order.
 */
function exitCodeExpressions(source) {
  const found = []
  for (const match of source.matchAll(/process\.exit\s*\(/g)) {
    found.push(callBody(source, match.index + match[0].length - 1))
  }
  for (const match of source.matchAll(/process\.exitCode\s*=(?!=)/g)) {
    found.push(statementTail(source, match.index + match[0].length))
  }
  return found
}

/**
 * The body of the call whose `(` is at openIndex, up to its matching `)`.
 * @param {string} source - the source text.
 * @param {number} openIndex - the index of `(`.
 * @returns {string} the call's argument text.
 */
function callBody(source, openIndex) {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(openIndex + 1, index)
    }
  }
  return source.slice(openIndex + 1)
}

/**
 * Whether a ternary is still open in the text read so far.
 *
 * A depth-0 `?` counts unless it is optional chaining (`?.`) or half of a nullish
 * coalescing (`??`), and a depth-0 `:` answers one. A `?` or `:` inside brackets,
 * parentheses or braces belongs to something nested and is skipped. A `?` inside a REGEX
 * literal is counted as a ternary: blankLiterals does not parse regexes, and the direction
 * that errs in is the safe one — a longer expression can only add outcomes.
 * @param {string} text - one statement's text so far.
 * @returns {boolean} whether an unanswered `?` remains.
 */
function ternaryOpen(text) {
  let depth = 0
  let open = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (depth !== 0) continue
    else if (char === '?' && text[index + 1] !== '.' && text[index - 1] !== '?') open += 1
    else if (char === ':' && open > 0) open -= 1
  }
  return open > 0
}

/**
 * The rest of the statement after `process.exitCode =`, up to the `;` or the newline
 * that closes it.
 *
 * A wrapped expression keeps going past a newline in TWO cases, both measured spellings
 * rather than guesses: the text so far ends on an operator (a ternary broken after its
 * `?`), or a depth-0 `?` is still unanswered (a ternary broken after its TRUE branch —
 * `process.exitCode = failures > 0 ? 1` / `  : skipped > 0 ? 2 : 0`). The second case
 * was missing, and it is the one an editor produces when a line grows: the reader stopped
 * at the first newline, saw `failures > 0 ? 1`, concluded this suite's exit code could
 * not be 2, and failed the whole aggregate with a STALE declaration on a healthy tree.
 * @param {string} source - the source text.
 * @param {number} startIndex - the index just after the `=`.
 * @returns {string} the assigned expression.
 */
function statementTail(source, startIndex) {
  let depth = 0
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (depth === 0 && char === ';') return source.slice(startIndex, index)
    else if (depth === 0 && char === '\n') {
      const soFar = source.slice(startIndex, index)
      if (/[?:,|&+*=(<>-]$/.test(soFar.trimEnd()) || ternaryOpen(soFar)) continue
      return soFar
    }
  }
  return source.slice(startIndex)
}

/**
 * A NUMBER in the source, as opposed to a digit inside a name: `exitCode2` is a name,
 * and reading it as a number would make its suite look like one whose exit code is
 * spelled out. Neighbouring word and `.` characters are what distinguish the two.
 */
const NUMBER_TOKEN = /(?<![\w$.])\d+(?![\w$.])/

/**
 * Whether one exit-code expression can BE 2.
 *
 * Three cases, and the middle one is the point:
 *  - the whole expression is a number — 2 or not;
 *  - it holds no NUMBER at all (a name, a call: `process.exit(code)`): its value cannot
 *    be read from the source, so it is not claimed unable to be 2. The other answer
 *    would report a declaration stale for a suite that can skip;
 *  - otherwise the outcomes are spelled out, and it can be 2 exactly when a ternary
 *    BRANCH is 2: `cond ? 2 : ...`, or `... : 2`. A guard that merely compares with 2
 *    (`code === 2 ? 1 : 0`) is not a branch, and neither is arithmetic.
 * @param {string} expression - one exit-code expression.
 * @returns {boolean} whether it can be 2.
 */
function canBeTwo(expression) {
  const text = expression.trim()
  if (/^\d+$/.test(text)) return Number(text) === 2
  if (!NUMBER_TOKEN.test(text)) return true
  return /[?:]\s*2(?![0-9])/.test(text)
}

/**
 * Whether a suite's own source can make its process exit 2 — the state this
 * aggregate renders as SKIP.
 * @param {string} source - the suite's source, comment- and literal-blanked.
 * @returns {boolean} whether some expression that sets its exit code can be 2.
 */
function canExitTwo(source) {
  return exitCodeExpressions(source).some(canBeTwo)
}

/**
 * Whether one branch citation still resolves in the suite it cites.
 *
 * Two arms, because a citation legitimately lives in either place: the BLANKED arm
 * compares code against code, blanking both sides so a citation that carries a string
 * literal still matches (a citation of a command the suite runs lives inside a literal,
 * and blanking the file removes that body), and the RAW arm covers exactly that case.
 * The raw arm can also be satisfied by prose, which is the honest limit of a text
 * citation: it proves the entry points at text the file carries, not that the text sits
 * on the exit-2 path.
 * @param {string} source - the suite's source, raw.
 * @param {string} citation - the cited text.
 * @returns {boolean} whether it resolves.
 */
function citationResolves(source, citation) {
  return blankLiterals(source).includes(blankLiterals(citation)) || source.includes(citation)
}

// Every declaration must still be LIVE. A declared suite whose own exit-code
// expression cannot be 2 can never skip anywhere — however many exit-2 shapes it
// mentions — so the entry has rotted: a renamed suite, a deleted skip branch, an
// override that grew a `? 2 : 0` for something else. That is a property of the
// REPOSITORY rather than of this machine, and it is the stale-declaration class an
// operator can always clear (remove the entry, or restore the branch), so it fails
// here, before any suite runs.
//
// The other class — a declaration whose precondition simply does not hold on this
// machine — is NOT a defect and does not fail the run: it is dormant, and the summary
// reports it (see below).
{
  const stale = []
  for (const { suite, branch } of DECLARED_SKIPS) {
    if (!suites.includes(suite)) {
      stale.push(`${suite} is not in the suite list, so the declaration can never apply`)
      continue
    }
    let source = null
    try {
      source = readFileSync(join(here, suite), 'utf8')
    } catch {
      source = null
    }
    // Blanked first: a suite that merely NAMES the convention in a comment or a string
    // (several do) must not be read as one that performs it, and blankLiterals is this
    // repository's one owner for that pass.
    if (source === null) stale.push(`${suite} is not readable as a suite of this directory`)
    // The citation is checked BEFORE the exit expression, because a citation that no
    // longer resolves is the same class one step earlier: the entry describes a branch
    // this file does not have any more, so what it certifies is unknown rather than false.
    else if (!Array.isArray(branch) || branch.length === 0) {
      stale.push(`${suite} declares no branch citation, so the entry cannot be checked against the suite it declares`)
    } else {
      const unresolved = branch.filter((citation) => !citationResolves(source, citation))
      if (unresolved.length > 0) stale.push(`${suite} cites branch text it no longer carries: ${JSON.stringify(unresolved)}`)
      else if (!canExitTwo(blankLiterals(source))) stale.push(`${suite} has no exit-code expression that can be 2, so it cannot skip`)
    }
  }
  if (stale.length > 0) {
    console.log(`\nFAIL  a declared skip is STALE — the suite it names cannot skip any more: ${stale.join('; ')}`)
    console.log('      A declaration is honest only while the skip it describes is possible AND the entry still')
    console.log('      points at it: remove the entry, restore the exit-2 branch, or re-point its branch citation')
    console.log('      at the text that branch carries now.')
    process.exit(1)
  }
  console.log(`declared-skip table clean across ${DECLARED_SKIPS.length} suite(s)`)
}

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  // A hard ceiling per suite (SUITE_CEILING_MS). What a stopped run MEANS is decided by
  // outcomeOf rather than by the exit code it does not have.
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit', timeout: SUITE_CEILING_MS, killSignal: 'SIGKILL' })
  results.push(outcomeOf(suite, run, Date.now() - startedAt))
}

console.log('\n=== summary ===')
// Exit code 2 is a suite's own SKIP (a check that could not run here, e.g.
// `verify-client-ui` without the harness checkout). It is shown, it is never a pass,
// and it is accepted ONLY from a suite DECLARED_SKIPS names together with the
// precondition that justifies it: an undeclared skip is a suite that never ran and
// nobody said so, which is the one thing this aggregate must not report green.
for (const entry of results) {
  const { suite, code, how, note } = entry
  // A suite this aggregate stopped, or could not start, produced no exit code at all:
  // printing "exit 1" would report the aggregator's own act as the suite's verdict.
  if (how !== 'exited') console.log(`  FAIL (${note})  ${suite}`)
  else if (code === 0) console.log(`  PASS  ${suite}`)
  else if (code !== 2) console.log(`  FAIL (exit ${code})  ${suite}`)
  else if (declarations.has(suite)) {
    console.log(`  SKIP  ${suite}`)
    console.log(`        declared skip: ${declarations.get(suite).precondition}`)
  } else console.log(`  FAIL (undeclared skip)  ${suite}`)
}

const passed = results.filter((entry) => entry.code === 0)
const skipped = results.filter((entry) => entry.code === 2 && declarations.has(entry.suite))
const undeclared = results.filter((entry) => entry.code === 2 && !declarations.has(entry.suite))
const failed = results.filter((entry) => entry.code !== 0 && entry.code !== 2)

if (undeclared.length > 0) {
  const names = undeclared.map((entry) => entry.suite).join(', ')
  console.log(`\nFAIL  undeclared skip: ${names}`)
  console.log(`      ${undeclared.length === 1 ? 'Its skip is' : 'Their skips are'} NOT DECLARED: exit 2 means the suite did not`)
  console.log('      evaluate every check here, and a gate that reads only this exit code cannot tell')
  console.log('      that from a full run. A skip is accepted only from a suite DECLARED_SKIPS names')
  console.log('      together with the precondition that justifies it: add an entry for')
  console.log(`      ${names} to DECLARED_SKIPS in scripts/verify-all.mjs, or remove the precondition`)
  console.log('      that forced the skip.')
}

// A suite the aggregate stopped itself established nothing, and saying so is the point:
// its checks are UNMEASURED, not failed, and the remedy is to run it again where it has the
// machine to itself. It stays a failure of this run — the ceiling bounds the run, and a
// green aggregate must not stand for checks nobody performed — but a reader can now tell it
// from a defect without re-running every suite by hand.
const unfinished = results.filter((entry) => entry.how === 'ceiling' || entry.how === 'signalled')
if (unfinished.length > 0) {
  console.log(`\nNOTE  stopped before finishing (${unfinished.length}): ${unfinished.map((entry) => entry.suite).join(', ')}`)
  console.log('      A stopped suite\'s checks are UNMEASURED, not failed. Re-run each alone to see')
  console.log('      whether it is broken or whether this run was simply too slow:')
  for (const entry of unfinished) console.log(`        node scripts/${entry.suite}`)
}

// A declaration whose precondition does not hold here was not exercised: its suite ran
// its checks. That is not a defect of this machine and must not redden it — the entry
// names the machine class that HAS the precondition — but it is reported, because a
// declaration that is never exercised anywhere is how a table like this rots unnoticed.
// (A declaration that CANNOT be exercised any more is caught above, before anything
// runs, and that is the part an operator can act on.)
const dormant = DECLARED_SKIPS.filter((entry) => results.some((run) => run.suite === entry.suite && run.code === 0))
if (dormant.length > 0) {
  console.log(`\nNOTICE  declared skips not exercised here (their suites ran): ${dormant.map((entry) => entry.suite).join(', ')}`)
}

console.log(`\n${passed.length}/${results.length} suites passed`
  + `${skipped.length === 0 ? '' : ` (${skipped.length} declared skip: ${skipped.map((entry) => entry.suite).join(', ')})`}`
  + `${failed.length + undeclared.length === 0 ? '' : ` (${failed.length + undeclared.length} failed: ${[...failed, ...undeclared].map((entry) => entry.suite).join(', ')})`}`
  + `${live ? '' : ' (live suites skipped; add --live to include them)'}`)
process.exit(failed.length === 0 && undeclared.length === 0 ? 0 : 1)
