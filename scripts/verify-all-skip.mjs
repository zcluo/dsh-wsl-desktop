/**
 * Pin verify-all.mjs's ruling on a suite's SKIP: it is accepted only when it is
 * DECLARED.
 *
 * A suite's exit code 2 means it could not evaluate a check on this machine, and the
 * aggregate used to print that, count it in its summary, and then exit 0 whatever the
 * count — so a CI gate reading only the exit code could not tell "every suite ran"
 * from "one suite never ran". A skip is now accepted only from a suite the
 * declaration table names TOGETHER WITH the precondition that justifies it, and an
 * undeclared skip fails the aggregate.
 *
 * The aggregate runs the REAL suites, so its own skip can only be produced on a
 * machine that happens to have the precondition. This pin therefore builds copies of
 * the aggregate whose suite list and declaration table are fixture suites in this
 * process's scratch directory, and reads the copies' real exit codes and real
 * summaries: every assertion runs on every machine. The declared case is proven
 * LOAD-BEARING rather than assumed — ONE declaration, two runs of the same
 * conditional fixture, one dormant and one skipped.
 *
 * What this pin does NOT do is decide, by searching a real suite's source for a shape,
 * whether that suite can skip. That question belongs to the aggregate, which asks it of
 * the suite's own exit-code expression; a shape found anywhere in a file is not the same
 * statement — a sibling suite carried a ternary for a CHILD process's exit code while
 * its own tail could not be 2, and a shape search called it a suite that skips. Section F
 * pins that rule's decisions on fixtures, through the aggregate's behaviour.
 *
 * Run: node scripts/verify-all-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blankLiterals } from './source-text.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const aggregateSource = readFileSync(join(here, 'verify-all.mjs'), 'utf8')
/** The aggregate's own relative import; a copy of it needs this file beside it. */
const sourceTextSource = readFileSync(join(here, 'source-text.mjs'), 'utf8')

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

// Scratch OUTSIDE the repository: the copies and the fixture suites are this pin's
// own residue and must never appear in the tree it is measuring.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-verify-all-skip-'))
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch (error) {
    console.error(`verify-all-skip: the scratch directory could not be removed: ${scratch} (${error?.code ?? error?.message ?? String(error)})`)
  }
})

/**
 * The fixture suites the copies run.
 *
 * \`fixture-conditional\` is the one the declared case rests on: its exit-2 path is
 * live in its source, and it is taken only when the pin sets FIXTURE_FORCE_SKIP — so
 * the SAME copy and the SAME declaration are measured dormant and skipped, and a
 * declaration that could never fire cannot satisfy the dormant assertion.
 */
const FIXTURES = {
  'fixture-skip.mjs': [
    '// A suite that skips: the shape a suite uses when a check cannot run here.',
    "console.log('  SKIP  the fixture check — the pin forced the skip')",
    'process.exit(2)',
    '',
  ].join('\n'),
  'fixture-pass.mjs': [
    "console.log('  PASS  the fixture check')",
    'process.exit(0)',
    '',
  ].join('\n'),
  'fixture-fail.mjs': [
    "console.log('  FAIL  the fixture check')",
    'process.exit(1)',
    '',
  ].join('\n'),
  'fixture-conditional.mjs': [
    '// A suite whose exit-2 path is LIVE, taken only when the pin forces it.',
    "const forced = process.env.FIXTURE_FORCE_SKIP === '1'",
    "console.log(forced ? '  SKIP  the fixture check' : '  PASS  the fixture check')",
    'process.exit(forced ? 2 : 0)',
    '',
  ].join('\n'),
  'fixture-decoy.mjs': [
    '// The shape a sibling suite carried in its working tree, verbatim in kind: a',
    "// ternary that computes a CHILD process's expected code, while this suite's OWN",
    '// exit code cannot be 2. A detector that searches the file for the shape declares',
    '// this suite able to skip; a detector that reads its exit expression cannot.',
    'const child = []',
    'const failures = 0',
    'const expectedCode = child.length > 0 ? 2 : 0',
    "console.log('  PASS  the fixture check', expectedCode)",
    'process.exitCode = failures === 0 ? 0 : 1',
    '',
  ].join('\n'),
  'fixture-hang.mjs': [
    '// A suite that never finishes: the aggregate must kill it at its ceiling and SAY so.',
    "console.log('  ... the fixture is hanging')",
    'setTimeout(() => {}, 60_000)',
    '',
  ].join('\n'),
  'fixture-wrapped.mjs': [
    '// The exit expression WRAPPED after its true branch: the shape a long line takes',
    '// when an editor breaks it, and the reader has to read it whole to see the 2 in it.',
    'const failures = 0',
    'const skipped = 1',
    "console.log('  SKIP  the fixture check — the wrapped spelling')",
    'process.exitCode = failures > 0 ? 1',
    '  : skipped > 0 ? 2 : 0',
    '',
  ].join('\n'),
  'fixture-suffixed.mjs': [
    '// The exit code comes from a NAME that ends in a digit. It is still a name, not a',
    '// number, and a rule that counts digits inside identifiers reads it as one.',
    'const exitCode2 = 0',
    "console.log('  PASS  the fixture check')",
    'process.exit(exitCode2)',
    '',
  ].join('\n'),
  'fixture-computed.mjs': [
    '// The exit code is computed away from the call, so no reader of the source can say',
    '// what it is: it must not be reported as a suite that cannot skip.',
    'const code = 0',
    "console.log('  PASS  the fixture check')",
    'process.exit(code)',
    '',
  ].join('\n'),
}
for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(scratch, name), source)
// The copies import it by that name, from their own directory (the scratch one).
writeFileSync(join(scratch, 'source-text.mjs'), sourceTextSource)

/** The aggregate's suite list, as one line-per-entry array literal. */
const STANDALONE_ANCHOR = /const STANDALONE = \[[\s\S]*?\n\]/
/** The aggregate's declaration table, same shape. */
const DECLARED_ANCHOR = /const DECLARED_SKIPS = \[[\s\S]*?\n\]/

const anchorsPresent = STANDALONE_ANCHOR.test(aggregateSource) && DECLARED_ANCHOR.test(aggregateSource)
check('the aggregate still spells the two tables this pin rewrites (STANDALONE and DECLARED_SKIPS)',
  anchorsPresent,
  'the copies below cannot carry their fixture declarations, so every "declared" assertion would be vacuous')

/**
 * Build one copy of the aggregate over a fixture suite list and a fixture table.
 *
 * Only these literals are rewritten; the copy is otherwise the real aggregate, so what
 * it does with a skip is what the aggregate does with a skip.
 * @param {string} name - the copy's file name in the scratch directory.
 * @param {{suites: string[], declarations: {suite: string, precondition: string}[], edits?: [string, string][]}} fixture - what to build.
 * @returns {string} the copy's file name in the scratch directory.
 */
function buildAggregate(name, { suites, declarations, edits = [] }) {
  const withSuites = aggregateSource.replace(STANDALONE_ANCHOR,
    `const STANDALONE = [\n${suites.map((suite) => `  '${suite}',`).join('\n')}\n]`)
  let next = withSuites.replace(DECLARED_ANCHOR,
    `const DECLARED_SKIPS = [\n${declarations.map((entry) => `  { suite: '${entry.suite}', branch: ${JSON.stringify(entry.branch ?? ['process.exit'])}, precondition: ${JSON.stringify(entry.precondition)} },`).join('\n')}\n]`)
  // Caller-supplied mutations of the copy. Each must CHANGE the text: a mutation whose
  // anchor moved is stale, and every assertion made against a stale mutant is vacuous, so
  // the sections below check the applied text back before they rely on it.
  for (const [from, to] of edits) next = next.replace(from, to)
  writeFileSync(join(scratch, name), next)
  return name
}

/**
 * Run one copy and return its exit code and its whole output.
 * @param {string} name - the copy's file name in the scratch directory.
 * @param {Record<string, string>} [env] - extra environment for the copy.
 * @returns {{code: number | null, out: string}} the run.
 */
function runAggregate(name, env = {}) {
  const run = spawnSync(process.execPath, [name], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  })
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

// ---------------------------------------------------------------------------
// A. An UNDECLARED skip fails the aggregate
//
// The mutation the owner's decision is about: a suite skips (exit 2), the
// declaration table does not name it. Before this change the aggregate printed SKIP,
// counted it, and exited 0 — so "one suite never ran" was indistinguishable from
// "every suite ran" to anything reading the exit code alone.
// ---------------------------------------------------------------------------
console.log('\n=== A. a suite that skips without a declaration ===')
{
  const copy = buildAggregate('A-undeclared.mjs', { suites: ['fixture-skip.mjs'], declarations: [] })
  const run = runAggregate(copy)
  check('undeclared skip: the aggregate exits 1 (the skip is not accepted)',
    run.code === 1, `exit ${String(run.code)}; the run ends:\n${run.out.slice(-1200)}`)
  check('undeclared skip: the summary marks the suite FAIL (undeclared skip), not PASS and not SKIP',
    /^\s*FAIL \(undeclared skip\)\s+fixture-skip\.mjs$/m.test(run.out),
    run.out.slice(-1200))
  check('undeclared skip: the message names the suite and says its skip is NOT DECLARED',
    run.out.includes('fixture-skip.mjs') && /IS NOT DECLARED|is NOT DECLARED|NOT DECLARED/.test(run.out),
    run.out.slice(-1200))
  check('undeclared skip: the message names DECLARED_SKIPS as what is missing, and where it lives',
    run.out.includes('DECLARED_SKIPS') && run.out.includes('scripts/verify-all.mjs'),
    run.out.slice(-1200))
  check('undeclared skip: the suite\'s own SKIP line is still shown (the output is not swallowed)',
    run.out.includes('the pin forced the skip'), run.out.slice(-1200))
  check('undeclared skip: the closing count does not report it as passed',
    /0\/1 suites passed/.test(run.out), run.out.slice(-1200))
}

// ---------------------------------------------------------------------------
// B. A DECLARED skip keeps the aggregate green, prints SKIP, and is not a pass
// ---------------------------------------------------------------------------
console.log('\n=== B. a suite that skips with a declaration ===')
{
  const declaration = { suite: 'fixture-skip.mjs', precondition: 'the pin declared the fixture skip' }
  const copy = buildAggregate('B-declared.mjs', { suites: ['fixture-skip.mjs', 'fixture-pass.mjs'], declarations: [declaration] })
  const run = runAggregate(copy)
  check('declared skip: the aggregate exits 0', run.code === 0, `exit ${String(run.code)}; the run ends:\n${run.out.slice(-1200)}`)
  check('declared skip: the summary prints SKIP for the suite, not PASS',
    /^\s*SKIP\s+fixture-skip\.mjs$/m.test(run.out), run.out.slice(-1200))
  check('declared skip: the summary names the precondition the declaration gives',
    run.out.includes(declaration.precondition), run.out.slice(-1200))
  check('declared skip: the closing count reports it as a declared skip, not as a pass',
    /1\/2 suites passed \(1 declared skip: fixture-skip\.mjs\)/.test(run.out), run.out.slice(-1200))
  check('declared skip: no FAIL and no undeclared-skip message is printed',
    !/FAIL/.test(run.out) && !/undeclared skip/i.test(run.out), run.out.slice(-1200))
}

// ---------------------------------------------------------------------------
// C. The existing paths are unchanged: a non-zero, non-2 exit still fails, and a
//    clean run still ends 0 with every suite counted as passed.
// ---------------------------------------------------------------------------
console.log('\n=== C. the existing failure and pass paths ===')
{
  const copy = buildAggregate('C-fail.mjs', { suites: ['fixture-fail.mjs', 'fixture-pass.mjs'], declarations: [] })
  const run = runAggregate(copy)
  check('exit 1: the aggregate exits 1', run.code === 1, `exit ${String(run.code)}; the run ends:\n${run.out.slice(-1200)}`)
  check('exit 1: the summary still reports the suite with its own exit code',
    /^\s*FAIL \(exit 1\)\s+fixture-fail\.mjs$/m.test(run.out), run.out.slice(-1200))
  const clean = runAggregate(buildAggregate('C-clean.mjs', { suites: ['fixture-pass.mjs'], declarations: [] }))
  check('clean run: the aggregate exits 0 and counts every suite passed',
    clean.code === 0 && /1\/1 suites passed/.test(clean.out), `exit ${String(clean.code)}; the run ends:\n${clean.out.slice(-800)}`)
}

// ---------------------------------------------------------------------------
// D. A declaration that does NOT occur
//
// Two classes, and they are not the same defect. A declaration whose suite can no
// longer skip at all (a renamed suite, a deleted skip branch) is dead on EVERY
// machine and the operator can act on it — the aggregate fails before any suite
// runs. A declaration that merely was not exercised HERE is dormant, not broken: it
// belongs to the machine class that has the precondition, and failing a healthy run
// for it would be a red nobody can clear.
// ---------------------------------------------------------------------------
console.log('\n=== D. a declaration the run does not exercise ===')
{
  const dead = buildAggregate('D-dead.mjs', {
    suites: ['fixture-pass.mjs'],
    declarations: [{ suite: 'fixture-pass.mjs', precondition: 'never: this fixture cannot skip' }],
  })
  const deadRun = runAggregate(dead)
  check('dead declaration: the aggregate exits 1 before running any suite',
    deadRun.code === 1 && !deadRun.out.includes('the fixture check'),
    `exit ${String(deadRun.code)}; the run ends:\n${deadRun.out.slice(-1200)}`)
  check('dead declaration: the message names the suite, says the declaration is stale, and names what the suite cannot do',
    deadRun.out.includes('fixture-pass.mjs') && /STALE|stale/.test(deadRun.out)
    && /no exit-code expression that can be 2/.test(deadRun.out),
    deadRun.out.slice(-1200))

  const dormant = buildAggregate('D-dormant.mjs', {
    suites: ['fixture-conditional.mjs'],
    declarations: [{ suite: 'fixture-conditional.mjs', precondition: 'the pin declared the fixture skip' }],
  })
  const ran = runAggregate(dormant)
  check('dormant declaration: the suite ran, the aggregate exits 0 (a healthy run is not reddened)',
    ran.code === 0, `exit ${String(ran.code)}; the run ends:\n${ran.out.slice(-1200)}`)
  check('dormant declaration: the summary says the declaration was not exercised here, naming the suite',
    /not exercised here/.test(ran.out) && new RegExp('not exercised here[^\\n]*fixture-conditional\\.mjs').test(ran.out),
    ran.out.slice(-1200))
  check('dormant declaration: the suite is NOT reported as a skip or a failure',
    !/^\s*SKIP\s/m.test(ran.out) && !/FAIL/.test(ran.out), ran.out.slice(-1200))
  const forced = runAggregate(dormant, { FIXTURE_FORCE_SKIP: '1' })
  check('dormant declaration, forced: the SAME declaration keeps the aggregate green and is reported as the declared skip',
    forced.code === 0 && /^\s*SKIP\s+fixture-conditional\.mjs$/m.test(forced.out)
    && /1 declared skip: fixture-conditional\.mjs/.test(forced.out),
    `exit ${String(forced.code)}; the run ends:\n${forced.out.slice(-1200)}`)
}

// ---------------------------------------------------------------------------
// E. The table in the repository itself
//
// STRUCTURE only, and deliberately so. This pin used to decide for itself whether a
// real suite "can skip", by searching the suite's source for an exit-2 shape — and a
// shape is not a rule: a sibling suite whose working tree carried
// `const expectedCode = ... ? 2 : 0` for a CHILD process's exit code, while its own
// tail was `process.exitCode = failures === 0 ? 0 : 1`, was declared able to skip, and
// this section demanded a declaration for a suite that cannot skip. Whether a real
// suite can skip is the aggregate's own question, asked of that suite's OWN exit-code
// expression on every run — before any suite starts, and again as it reports. What is
// left for this pin is the structure that scan cannot see, including when this file is
// run on its own. Section F pins the rule's decisions, on fixtures, through the
// aggregate's behaviour.
// ---------------------------------------------------------------------------
/**
 * The tokens a precondition and a suite can share: identifiers, paths, flags — not the
 * prose that every file in this directory carries.
 */
const STOPWORDS = new Set(['precondition', 'preconditions', 'declaration', 'declarations', 'suite', 'suites', 'skipped', 'cannot', 'because', 'otherwise'])

/**
 * What a table's own text names, one entry per token worth comparing.
 * @param {string} text - a precondition.
 * @returns {string[]} the tokens, in order, without duplicates.
 */
function tokensOf(text) {
  return [...new Set(text.match(/[A-Za-z0-9_./\\-]{6,}/g) ?? [])]
    .filter((token) => !STOPWORDS.has(token.toLowerCase()))
}

/**
 * Whether one branch citation still resolves in the suite it cites.
 *
 * Two arms, because a citation legitimately lives in either place: the BLANKED arm
 * compares code against code (a citation carrying a literal still matches, because both
 * sides blank the same way), and the RAW arm covers a citation that lives INSIDE a
 * literal — the command a suite runs, the marker it greps for. The raw arm can also be
 * satisfied by prose, which is the limit of a text citation: it proves the entry points
 * at text the file carries, not that the text is on the exit-2 path.
 * @param {string} source - the suite's source, raw.
 * @param {string} citation - the cited text.
 * @returns {boolean} whether it resolves.
 */
function citationResolves(source, citation) {
  return blankLiterals(source).includes(blankLiterals(citation)) || source.includes(citation)
}

/**
 * What is wrong with the declaration table.
 *
 * The table's promise is reviewability: an entry names a suite, cites the exit-2 branch
 * it comes from, and states the machine condition under which that branch may fire. A
 * static reader cannot judge whether the prose JUSTIFIES the skip — only a human reading
 * the branch can — so this checks the parts that are checkable, and every one of them can
 * fail: the entry exists, the suite is one this directory runs, the precondition is long
 * enough to name a condition and names something the suite itself carries (so a row
 * copy-pasted from another entry does not pass), no two entries share one text, and every
 * citation still resolves in the file it cites. The line numbers the table used to carry
 * were NOT checkable and rotted twice in one review range; the citations below replace
 * them for the same reason.
 * @param {string} standaloneBlock - the STANDALONE array literal's text.
 * @param {string} declaredBlock - the DECLARED_SKIPS array literal's text.
 * @param {(suite: string) => string | null} readSuite - a suite's source, or null when it cannot be read.
 * @returns {string[]} one message per problem; empty when the table is sound.
 */
function tableProblems(standaloneBlock, declaredBlock, readSuite) {
  const problems = []
  const suiteList = [...standaloneBlock.matchAll(/'([^']+\.mjs)'/g)].map((match) => match[1])
  // One literal matcher for every field, so a citation that carries the OTHER quote
  // character ("createRequire(join(checkout, 'package.json'))") is read whole.
  const literal = /(["'])((?:\\.|(?!\1)[^\\])*?)\1/g
  const declaredSuites = [...declaredBlock.matchAll(/suite:\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1/g)].map((match) => match[2])
  const preconditions = [...declaredBlock.matchAll(/precondition:\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1/g)].map((match) => match[2])
  const branches = [...declaredBlock.matchAll(/branch:\s*\[([\s\S]*?)\]/g)].map((match) => [...match[1].matchAll(literal)].map((entry) => entry[2]))
  if (declaredSuites.length === 0) return ['the table declares no suite, so no skip can ever be accepted']
  if (preconditions.length !== declaredSuites.length) problems.push(`${declaredSuites.length} suite(s) but ${preconditions.length} precondition(s)`)
  declaredSuites.forEach((suite, index) => {
    const precondition = (preconditions[index] ?? '').trim()
    if (precondition.length <= 30) problems.push(`${suite}: the precondition is too short to name a condition`)
    const source = readSuite(suite)
    if (source === null) { problems.push(`${suite}: not readable as a suite of this directory`); return }
    if (!suiteList.includes(suite)) problems.push(`${suite}: not in the suite list the aggregate runs`)
    // The precondition must name something THIS suite carries: a row copy-pasted from
    // another entry, or prose generic enough to fit any suite, is refused here. Length
    // alone was the old rule, and 31 characters of anything passed it.
    const tokens = tokensOf(precondition)
    if (tokens.length > 0 && !tokens.some((token) => source.toLowerCase().includes(token.toLowerCase()))) {
      problems.push(`${suite}: the precondition names nothing this suite carries (${tokens.slice(0, 4).join(', ')})`)
    }
    const citations = branches[index] ?? []
    if (citations.length === 0) problems.push(`${suite}: declares no branch citation, so the entry cannot be checked against the suite it declares`)
    for (const citation of citations) {
      if (citation.trim().length < 4) problems.push(`${suite}: cites ${JSON.stringify(citation)}, which is too short to be branch text`)
      else if (!citationResolves(source, citation)) problems.push(`${suite}: cites branch text it no longer carries (${citation})`)
    }
  })
  const duplicate = preconditions.find((text, index) => preconditions.indexOf(text) !== index)
  if (duplicate !== undefined) problems.push(`two entries share one precondition text (${duplicate.slice(0, 40)}…), so the second certifies the first one's condition`)
  return problems
}

console.log('\n=== E. the declarations in scripts/verify-all.mjs ===')
{
  const standaloneBlock = STANDALONE_ANCHOR.exec(aggregateSource)?.[0] ?? ''
  const declaredBlock = DECLARED_ANCHOR.exec(aggregateSource)?.[0] ?? ''
  const standaloneSuites = [...standaloneBlock.matchAll(/'([^']+\.mjs)'/g)].map((match) => match[1])
  const declaredSuites = [...declaredBlock.matchAll(/suite:\s*'([^']+)'/g)].map((match) => match[1])
  const preconditions = [...declaredBlock.matchAll(/precondition:\s*'([^']*)'/g)].map((match) => match[1])
  check('the table declares at least one suite (an empty table accepts no skip at all)',
    declaredSuites.length > 0, `declared: ${declaredSuites.join(', ') || '(none)'}`)
  check('every declared suite names a file of this directory',
    declaredSuites.every((suite) => existsSync(join(here, suite))),
    `missing: ${declaredSuites.filter((suite) => !existsSync(join(here, suite))).join(', ') || '(none)'}`)
  check('every declared suite is in the suite list the aggregate runs',
    declaredSuites.every((suite) => standaloneSuites.includes(suite)),
    `not in STANDALONE: ${declaredSuites.filter((suite) => !standaloneSuites.includes(suite)).join(', ') || '(none)'}`)
  // This row used to measure the precondition's LENGTH and say the skip was "justified".
  // A static reader cannot judge justification — only a human reading the branch can — so
  // the row now measures the part that is checkable (the entry is tied to its suite and to
  // branch text that file still carries), and E2 pins that each clause can be refused.
  const readSuiteOf = (suite) => {
    try { return readFileSync(join(here, suite), 'utf8') } catch { return null }
  }
  const tableIssues = tableProblems(standaloneBlock, declaredBlock, readSuiteOf)
  check('the declaration table is sound: every entry names a suite this directory runs, cites branch text that suite still carries, and carries its own precondition tied to that suite',
    tableIssues.length === 0, tableIssues.join('; '))
  console.log(`        ${standaloneSuites.length} standalone suite(s), ${declaredSuites.length} declared`)
}

// ---------------------------------------------------------------------------
// E2. The shapes the table check REFUSES, on tables built here
//
// E1's row is satisfied by the real table, and a checker that accepts everything would
// satisfy it too. Each case below builds one clause of the promise into a table, so the
// checker has to refuse it.
// ---------------------------------------------------------------------------
console.log('\n=== E2. what the table check refuses ===')
{
  const SUITE_NAME = 'fixture-table.mjs'
  const SOUND_SOURCE = ['const deps = process.env.DSH_WSL_DEPS', 'if (!existsSync(deps)) {', '  skipped += 1', '}', 'process.exitCode = skipped > 0 ? 2 : 0'].join('\n')
  const SOUND_PRECONDITION = 'the dependency directory DSH_WSL_DEPS names does not exist, so the import cannot run here'
  const SOUND_BRANCH = "['!existsSync(deps)']"
  const standalone = ['const STANDALONE = [', `  '${SUITE_NAME}',`, ']'].join('\n')
  const table = ({ suite = SUITE_NAME, branch = SOUND_BRANCH, precondition = SOUND_PRECONDITION } = {}) => [
    'const DECLARED_SKIPS = [',
    `  { suite: '${suite}',${branch === null ? '' : ` branch: ${branch},`} precondition: ${JSON.stringify(precondition)} },`,
    ']',
  ].join('\n')
  const read = (suite) => (suite === SUITE_NAME ? SOUND_SOURCE : null)
  const problemsOf = (block) => tableProblems(standalone, block, read)
  check('the checker accepts a sound table (so a refusal below is the clause, not the checker)',
    problemsOf(table()).length === 0, problemsOf(table()).join('; '))
  check('it refuses an entry with no branch citation',
    problemsOf(table({ branch: null })).some((problem) => problem.includes('declares no branch citation')),
    problemsOf(table({ branch: null })).join('; '))
  check('it refuses a citation the suite no longer carries',
    problemsOf(table({ branch: "['publicationCode === null']" })).some((problem) => problem.includes('no longer carries')),
    problemsOf(table({ branch: "['publicationCode === null']" })).join('; '))
  check('it refuses a precondition that names nothing the suite carries (length alone no longer passes)',
    problemsOf(table({ precondition: 'a condition this suite has never mentioned anywhere at all' })).some((problem) => problem.includes('names nothing this suite carries')),
    problemsOf(table({ precondition: 'a condition this suite has never mentioned anywhere at all' })).join('; '))
  check('it refuses a declaration for a file that is not one of this directory\'s suites',
    problemsOf(table({ suite: 'verify-nothing-here.mjs' })).some((problem) => problem.includes('not readable as a suite')),
    problemsOf(table({ suite: 'verify-nothing-here.mjs' })).join('; '))
  const duplicated = [
    'const DECLARED_SKIPS = [',
    `  { suite: '${SUITE_NAME}', branch: ${SOUND_BRANCH}, precondition: ${JSON.stringify(SOUND_PRECONDITION)} },`,
    `  { suite: '${SUITE_NAME}', branch: ${SOUND_BRANCH}, precondition: ${JSON.stringify(SOUND_PRECONDITION)} },`,
    ']',
  ].join('\n')
  check('it refuses one precondition text standing for two entries',
    problemsOf(duplicated).some((problem) => problem.includes('share one precondition text')), problemsOf(duplicated).join('; '))
}

// ---------------------------------------------------------------------------
// F. The rule behind "can this suite skip?"
//
// The rule reads the suite's OWN exit-code expression — the argument of
// process.exit(...), or the right-hand side of process.exitCode = ... — rather than a
// shape found anywhere in the file. These three fixtures pin the decisions that
// matter, through the aggregate's own behaviour: a declaration for a suite whose own
// exit code cannot be 2 must be reported STALE, and a declaration the rule cannot
// READ must not be.
// ---------------------------------------------------------------------------
console.log('\n=== F. the rule behind "can this suite skip?" ===')
{
  const decoy = buildAggregate('F-decoy.mjs', {
    suites: ['fixture-decoy.mjs'],
    declarations: [{ suite: 'fixture-decoy.mjs', precondition: 'the pin declared the decoy fixture' }],
  })
  const decoyRun = runAggregate(decoy)
  check('decoy: a ternary computing a CHILD code is not read as this suite\'s own exit code (the declaration is STALE)',
    decoyRun.code === 1 && /STALE/.test(decoyRun.out) && decoyRun.out.includes('fixture-decoy.mjs'),
    `exit ${String(decoyRun.code)}; the run ends:\n${decoyRun.out.slice(-1000)}`)

  const genuine = buildAggregate('F-genuine.mjs', {
    suites: ['fixture-conditional.mjs'],
    declarations: [{ suite: 'fixture-conditional.mjs', precondition: 'the pin declared the fixture skip' }],
  })
  const genuineRun = runAggregate(genuine)
  check('genuine: a suite whose OWN exit expression can be 2 is not called stale',
    genuineRun.code === 0 && !/STALE/.test(genuineRun.out),
    `exit ${String(genuineRun.code)}; the run ends:\n${genuineRun.out.slice(-1000)}`)

  const suffixed = buildAggregate('F-suffixed.mjs', {
    suites: ['fixture-suffixed.mjs'],
    declarations: [{ suite: 'fixture-suffixed.mjs', precondition: 'the pin declared the suffixed fixture' }],
  })
  const suffixedRun = runAggregate(suffixed)
  check('suffixed: a name that ENDS in a digit is still a name, not a number the rule can read',
    suffixedRun.code === 0 && !/STALE/.test(suffixedRun.out),
    `exit ${String(suffixedRun.code)}; the run ends:\n${suffixedRun.out.slice(-1000)}`)

  // The wrapped spelling, pinned because it is what a future editor writes when the line
  // grows: the reader must see the 2 in a branch the wrapping moved to its own line.
  const wrapped = buildAggregate('F-wrapped.mjs', {
    suites: ['fixture-wrapped.mjs'],
    declarations: [{ suite: 'fixture-wrapped.mjs', precondition: 'the pin declared the wrapped fixture' }],
  })
  const wrappedRun = runAggregate(wrapped)
  check('wrapped: a skip expression broken after its true branch is still read as this suite\'s own exit code (not STALE)',
    wrappedRun.code === 0 && !/STALE/.test(wrappedRun.out) && /^\s*SKIP\s+fixture-wrapped\.mjs$/m.test(wrappedRun.out),
    `exit ${String(wrappedRun.code)}; the run ends:\n${wrappedRun.out.slice(-1000)}`)

  const computed = buildAggregate('F-computed.mjs', {
    suites: ['fixture-computed.mjs'],
    declarations: [{ suite: 'fixture-computed.mjs', precondition: 'the pin declared the computed fixture' }],
  })
  const computedRun = runAggregate(computed)
  check('computed: an exit code the rule cannot read is not reported as a suite that cannot skip',
    computedRun.code === 0 && !/STALE/.test(computedRun.out),
    `exit ${String(computedRun.code)}; the run ends:\n${computedRun.out.slice(-1000)}`)
}

// ---------------------------------------------------------------------------
// G. A suite this aggregate stops itself
//
// spawnSync funnels several endings through one `status`, and `?? 1` reported all of them
// as "the suite exited 1" — so a suite killed at this aggregate's OWN ceiling read exactly
// like a suite whose checks failed (observed: verify-confinement.mjs and its pin printed
// FAIL (exit 1) in aggregate runs while each printed ALL CHECKS PASSED alone). The ceiling
// is shortened here so the ending is produced on purpose, and the spawn path is broken so
// the one that never started is produced too. The third ending — a child killed by a
// signal from somewhere else — is NOT producible: measured on this platform, a child that
// dies from a signal reports status 1 and signal null, exactly like a normal exit.
// ---------------------------------------------------------------------------
console.log('\n=== G. a suite the aggregate itself stops ===')
{
  const copy = buildAggregate('G-ceiling.mjs', {
    suites: ['fixture-hang.mjs'],
    declarations: [],
    edits: [['const SUITE_CEILING_MS = 300_000', 'const SUITE_CEILING_MS = 1_200']],
  })
  check('ceiling: the shortened ceiling was applied to the copy (a stale mutation must not pass silently)',
    readFileSync(join(scratch, copy), 'utf8').includes('const SUITE_CEILING_MS = 1_200'),
    'the anchor "const SUITE_CEILING_MS = 300_000" moved, so the run below used the real ceiling')
  const run = runAggregate(copy)
  check('ceiling: a suite killed at the ceiling is NOT reported as FAIL (exit 1)',
    run.code === 1 && !/FAIL \(exit 1\)/.test(run.out),
    `exit ${String(run.code)}; the run ends:\n${run.out.slice(-900)}`)
  check('ceiling: the summary names the ceiling it hit and says the suite did not finish',
    /killed at this aggregate's 1\.2s ceiling/.test(run.out) && /did not finish/.test(run.out),
    run.out.slice(-900))
  check('ceiling: it still FAILS the aggregate (a run that never finished established nothing)',
    run.code === 1 && /1 failed: fixture-hang\.mjs/.test(run.out),
    run.out.slice(-900))
}
{
  const copy = buildAggregate('G-unstarted.mjs', {
    suites: ['fixture-pass.mjs'],
    declarations: [],
    edits: [['spawnSync(process.execPath,', "spawnSync(join(here, 'no-such-node.exe'),"]],
  })
  check('unstarted: the broken spawn path was applied to the copy',
    readFileSync(join(scratch, copy), 'utf8').includes("spawnSync(join(here, 'no-such-node.exe'),"),
    'the anchor "spawnSync(process.execPath," moved, so the run below spawned a real Node')
  const run = runAggregate(copy)
  check('unstarted: a suite that could not be started is NOT reported as FAIL (exit 1), and says what stopped it',
    run.code === 1 && !/FAIL \(exit 1\)/.test(run.out) && /could not be started/.test(run.out) && /ENOENT/.test(run.out),
    `exit ${String(run.code)}; the run ends:\n${run.out.slice(-900)}`)
}

// ---------------------------------------------------------------------------
// H. No suite creates a FIXED machine-global scratch name
//
// Four separate fixes have now been needed for one class: a scratch name identical in
// every process (verify-9p's two probe trees, verify-confinement's five paths and three
// fixture trees, and verify-world's two directory probes). The failure mode is measured,
// not hypothetical — two runs overlapping in time destroy each other's fixture, because
// each run's opening `rm -rf` and each run's cleanup both act on the shared name — and
// the thing that keeps being missed is the NEXT name, so this section scans the directory
// for the shape instead of trusting the next author to remember it.
//
// The shape, precisely: a `dsh-` name that is (a) under a root (/tmp, /opt, /root, the
// session home or the host temp directory), (b) spelled WITHOUT a pid, a random component
// or an mkdtemp prefix, and (c) CREATED OR REMOVED within one line of where it is spelled.
// (c) is what separates a scratch fixture from a spelling a suite only compares:
// verify-fs-fence's /tmp/dsh-fence-probe.txt targets are never created, so no concurrent
// run can take one away. A name created far from its spelling is not caught; the KNOWN
// table is where such a case is recorded, and every entry in it must still be found.
//
// THE TABLE IS EMPTY ON PURPOSE: the three cases it recorded have been FIXED. verify-route's
// /tmp/dsh-wsl-fence-probe.txt, and verify-post-restart's `${home}/.dsh-wsl-selftest` and its
// host-temp `dsh-wsl-win-selftest` were recorded here because the pid suffix "cannot be
// verified without the host" — the suffixes and the missing cleanup owner have since been
// applied and verified against the running desktop, so keeping the entries would leave three
// names in the table that no longer exist. A name that REAPPEARS is caught by the row below
// the scan; an entry recorded here later is a dated last resort and must be removed when its
// case is fixed, which is what the "still in the tree" row exists to force.
// ---------------------------------------------------------------------------
console.log('\n=== H. fixed machine-global scratch names in scripts/ ===')
{
  const ROOT_MARKER = /\/tmp\/|\/opt\/|\/root\/|\$\{home\}\/|home \+ '|tmpdir\(\)|shareRoot/i
  const UNIQUE = /process\.pid|randomUUID|Math\.random|\bmkdtemp|no-such|[$]\{[^}]*(?:pid|random|token|Suffix|stamp|UUID)[^}]*\}/i
  const ACT = /\b(?:rm|rmdir|mkdir|mkdtemp|touch|cp|mv|install|rmSync|rmdirSync|mkdirSync|writeFile|writeFileSync|unlinkSync)\b/
  const NAME = /dsh-[A-Za-z0-9._-]+/
  /**
   * The fixed scratch names in one set of sources.
   * @param {Map<string, string>} sources - file name to its text.
   * @returns {{file: string, line: number, name: string}[]} one entry per name found.
   */
  const fixedScratchNames = (sources) => {
    const found = []
    for (const [file, text] of sources) {
      const lines = text.split('\n')
      for (const [index, line] of lines.entries()) {
        const trimmed = line.trim()
        // Prose cannot create anything, and the comment that DOCUMENTS a fixed name is
        // exactly where this scan's own subject is described.
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        if (!ROOT_MARKER.test(line) || UNIQUE.test(line)) continue
        const name = NAME.exec(line)?.[0]
        if (name === undefined) continue
        if (!ACT.test(lines.slice(index, index + 2).join('\n'))) continue
        found.push({ file, line: index + 1, name })
      }
    }
    return found
  }
  /**
   * The fixed scratch names this directory still carries, each with why it is allowed.
   * Every entry must still be FOUND: an entry whose name is gone is how a table like this
   * rots, and a name that is not here reddens the row above instead.
   */
  // EMPTY, and that is the point: every case it ever recorded has been fixed rather than
  // tolerated. The three names above now carry the process id in their spellings (and the
  // host-temp root is removed in a `finally`), so no fixed name remains to record — a literal
  // pid was never in this table, which is why the old prose's `-25684` grepped to nothing.
  // See section H's header for what each entry used to say.
  const KNOWN_FIXED_SCRATCH = []
  const sources = new Map(readdirSync(here)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => [name, readFileSync(join(here, name), 'utf8')]))
  const found = fixedScratchNames(sources)
  const declared = KNOWN_FIXED_SCRATCH.map((entry) => `${entry.file}:${entry.name}`)
  const undeclared = found.filter((entry) => !declared.includes(`${entry.file}:${entry.name}`))
  check('no suite creates or removes an UNDECLARED fixed machine-global scratch name (a concurrent run would destroy it)',
    undeclared.length === 0,
    undeclared.map((entry) => `${entry.file}:${entry.line} ${entry.name}`).join('; '))
  const stale = declared.filter((key) => !found.map((entry) => `${entry.file}:${entry.name}`).includes(key))
  // With nothing tolerated, the row below has nothing to check. Said out loud rather than left
  // as a green row a reader would take for coverage: this section's policing is done by the
  // scan row above, and the row below exists for whenever an entry is recorded again.
  if (declared.length === 0) {
    console.log('  DISCLOSED  the KNOWN table is EMPTY: no fixed scratch name is tolerated, so the "still in the tree" row is vacuous this run — the scan row above is the one policing the shape')
  }
  check('every KNOWN fixed scratch name is still in the tree (a table that outlives its entries certifies nothing)',
    stale.length === 0, stale.join('; '))
  check('the scan read the suites it polices',
    sources.size >= 20 && [...sources.keys()].includes('verify-world.mjs'),
    `${sources.size} .mjs file(s) scanned, ${found.length} fixed name(s) found`)
  // The scan's own decisions, on sources built here: the real directory being clean is
  // only evidence if this scan can find the shape at all. The names are assembled from a
  // variable so this file does not carry the literal it is looking for.
  const FIXTURE_NAME = 'dsh-wsl-' + 'scan-fixture'
  const built = (lines) => new Map([['fixture.mjs', lines.join('\n')]])
  const created = built([`const p = home + '/${FIXTURE_NAME}'`, 'await runWslShell({ command: `rm -rf ${p} && mkdir -p ${p}` })'])
  const perProcess = built([`const p = \`\${home}/${FIXTURE_NAME}-\${process.pid}\``, 'await runWslShell({ command: `rm -rf ${p} && mkdir -p ${p}` })'])
  const spellingOnly = built([`const foreignProbe = joinWslUnc(otherDistro, '/tmp/${FIXTURE_NAME}')`, 'check(\'a foreign target is not contained\', await isUnderHost(foreignProbe, root) === false)'])
  check('the scan FINDS a fixed scratch name that is created (the shape this section exists for)',
    fixedScratchNames(created).length === 1, JSON.stringify(fixedScratchNames(created)))
  check('the scan accepts the same name once it carries the process id',
    fixedScratchNames(perProcess).length === 0, JSON.stringify(fixedScratchNames(perProcess)))
  check('the scan accepts a name the suite only compares (never created)',
    fixedScratchNames(spellingOnly).length === 0, JSON.stringify(fixedScratchNames(spellingOnly)))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
