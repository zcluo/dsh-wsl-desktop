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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    `const DECLARED_SKIPS = [\n${declarations.map((entry) => `  { suite: '${entry.suite}', precondition: ${JSON.stringify(entry.precondition)} },`).join('\n')}\n]`)
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
  check('every entry carries a precondition, so the skip is justified rather than merely allowed',
    preconditions.length === declaredSuites.length && preconditions.every((text) => text.trim().length > 30),
    `${preconditions.length} precondition(s) for ${declaredSuites.length} suite(s); shortest: ${[...preconditions].sort((a, b) => a.length - b.length)[0] ?? '(none)'}`)
  console.log(`        ${standaloneSuites.length} standalone suite(s), ${declaredSuites.length} declared`)
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
    `exit ${String(suffixedRun.code)}; the run ends:\\n${suffixedRun.out.slice(-1000)}`)

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
