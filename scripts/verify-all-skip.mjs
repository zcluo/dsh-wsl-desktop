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
 * Run: node scripts/verify-all-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detailText } from './detail.mjs'
import { blankLiterals } from './source-text.mjs'

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
}
for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(scratch, name), source)
// The copies import it by that name, from their own directory (the scratch one).
writeFileSync(join(scratch, 'source-text.mjs'), sourceTextSource)

/** The aggregate's suite list, as one line-per-entry array literal. */
const STANDALONE_ANCHOR = /const STANDALONE = \[[\s\S]*?\n\]/
/** The aggregate's declaration table, same shape. */
const DECLARED_ANCHOR = /const DECLARED_SKIPS = \[[\s\S]*?\n\]/
/** A suite's exit-2 path: the tail's ternary, or an outright process.exit(2). */
const EXIT_2_PATH = /process\.exit\(\s*2\s*\)|\?\s*2\s*:\s*0/

const anchorsPresent = STANDALONE_ANCHOR.test(aggregateSource) && DECLARED_ANCHOR.test(aggregateSource)
check('the aggregate still spells the two tables this pin rewrites (STANDALONE and DECLARED_SKIPS)',
  anchorsPresent,
  'the copies below cannot carry their fixture declarations, so every "declared" assertion would be vacuous')

/**
 * Build one copy of the aggregate over a fixture suite list and a fixture table.
 *
 * Only these two literals are rewritten; the copy is otherwise the real aggregate,
 * so what it does with a skip is what the aggregate does with a skip.
 * @param {string} name - the copy's file name in the scratch directory.
 * @param {{suites: string[], declarations: {suite: string, precondition: string}[]}} fixture - what to build.
 * @returns {string} the copy's path.
 */
function buildAggregate(name, { suites, declarations }) {
  const withSuites = aggregateSource.replace(STANDALONE_ANCHOR,
    `const STANDALONE = [\n${suites.map((suite) => `  '${suite}',`).join('\n')}\n]`)
  const next = withSuites.replace(DECLARED_ANCHOR,
    `const DECLARED_SKIPS = [\n${declarations.map((entry) => `  { suite: '${entry.suite}', precondition: ${JSON.stringify(entry.precondition)} },`).join('\n')}\n]`)
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
  check('dead declaration: the message names the suite and says the declaration is stale, with the remedy',
    deadRun.out.includes('fixture-pass.mjs') && /STALE|stale/.test(deadRun.out) && /no exit-2 path/.test(deadRun.out),
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
// The declaration table is derived by reading the suites' exit-2 paths, so the two
// directions that keep it honest are pinned here against the real file: a suite that
// CAN skip without a declaration is a skip that will one day arrive undeclared, and a
// declaration for a suite that cannot skip is stale. The aggregate checks the second
// direction itself, before any suite runs; this covers both, on the real table.
// ---------------------------------------------------------------------------
console.log('\n=== E. the declarations in scripts/verify-all.mjs ===')
{
  const standaloneBlock = STANDALONE_ANCHOR.exec(aggregateSource)?.[0] ?? ''
  const declaredBlock = DECLARED_ANCHOR.exec(aggregateSource)?.[0] ?? ''
  const standaloneSuites = [...standaloneBlock.matchAll(/'([^']+\.mjs)'/g)].map((match) => match[1])
  const declaredSuites = [...declaredBlock.matchAll(/suite:\s*'([^']+)'/g)].map((match) => match[1])
  /**
   * Whether one suite's own source carries an exit-2 path.
   *
   * Read as SHAPE, not as spelling: this pin's own fixture sources SPELL the exit-2
   * call inside string literals, and so do suites that merely document the convention
   * — a raw search would call every one of them able to skip.
   * @param {string} suite - the suite's file name.
   * @returns {boolean} whether its code can exit 2.
   */
  const canSkip = (suite) => {
    try {
      return EXIT_2_PATH.test(blankLiterals(readFileSync(join(here, suite), 'utf8')))
    } catch {
      return false
    }
  }
  const undeclared = standaloneSuites.filter((suite) => canSkip(suite) && !declaredSuites.includes(suite))
  check('every suite that CAN skip is declared (an undeclared skip would fail the aggregate the day it happens)',
    undeclared.length === 0, `not declared: ${undeclared.join(', ') || '(none)'}`)
  const stale = declaredSuites.filter((suite) => !standaloneSuites.includes(suite) || !canSkip(suite))
  check('every declared suite is in STANDALONE and carries an exit-2 path',
    stale.length === 0, `stale: ${stale.join(', ') || '(none)'}`)
  console.log(`        ${standaloneSuites.length} standalone suite(s), ${standaloneSuites.filter(canSkip).length} with an exit-2 path, ${declaredSuites.length} declared`)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
