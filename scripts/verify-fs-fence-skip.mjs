/**
 * Pin the report `verify-fs-fence.mjs` gives when this machine has no second share to
 * compare against, in both machine classes, and the controls that keep it honest.
 *
 * THE FAMILY — the cross-distribution assertions (4). They compare a path of the selected
 * distribution's share with ANOTHER distribution's, so a machine with one distribution
 * cannot evaluate any of them: the suite must say so LOUDLY (a SKIP naming the missing
 * precondition, every unevaluated assertion by its own label and the remedy) and exit 2,
 * which `verify-all.mjs` reports as SKIP rather than as a pass. That is the owner's ruling —
 * the same one `verify-9p.mjs` already implements, and the shape this file copies, because a
 * SKIP is QUIETER than the FAIL it replaces: a green aggregate must not be able to imply the
 * fence's cross-distribution coverage was established. Before this change the same machine
 * exited 1 at the precondition, so the class is a missing precondition, not a defect.
 *
 * Sections A and B force that precondition through the suite's OWN override — pointed at the
 * selected distribution itself, and at an empty value — so they run on every machine, and the
 * empty value is pinned separately because it used to produce a failure whose detail named
 * nothing. THE CONTROL (section C) pins that the skip is conditional: with a second share
 * present the suite must exit 0, print no SKIP of this family, and RUN all four assertions.
 *
 * Section D proves those assertions are not constants: it removes the fence's distribution
 * binding in a COPY of the tree and requires the binding-dependent assertion to FAIL there —
 * the owner's second trap, that on a machine WITH a second distribution nothing may change.
 * If a mutation stripped the family down to passing constants, this section is what reddens.
 * Section E then proves the other class: the whole pin is re-run against a copy whose
 * `listDistros()` reports the selected distribution alone, so the pin is shown green with the
 * machine class SIMULATED rather than merely reasoned about.
 *
 * Why this is its own suite. The one-distribution branch cannot be produced by a real run on a
 * machine that HAS a second distribution, and a check written inside `verify-fs-fence.mjs` for
 * it would be a check that never runs here — the unreachable-check class this plan removes.
 * Every assertion below reads a real child's stdout and exit code, so it runs on every machine.
 * It is a CONTENT pin: "the child skipped" would be unfalsifiable here, because this suite is
 * what forces the skip.
 *
 * Run: node scripts/verify-fs-fence-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDistros, resolveDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
/** The harness checkout the suite's structural section reads, resolved exactly as the suite resolves it; passed to every copy, whose own sibling path is the throwaway tree. */
const checkout = process.env.DSH_CHECKOUT ?? join(pluginRoot, '..', 'deepseek-harness')
const distro = resolveDistro()
const suitePath = join(here, 'verify-fs-fence.mjs')

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

/** The token every SKIP of the pinned family carries on its own line. */
const CROSS_DISTRO_FAMILY = 'cross-distribution'

/**
 * The four assertions the cross-distribution family evaluates, under the labels the suite
 * prints — the same four the SKIP must name.
 *
 * They are duplicated HERE on purpose: the pin holds the expected content independently, so a
 * reworded label in the suite reddens this file instead of following the suite wherever it
 * goes. (`verify-9p-skip.mjs` does the same with its fact labels.) The suite keeps its own
 * list as the single source of truth for the labels it PRINTS and the checks it RUNS, so its
 * prose cannot drift from what did not run.
 */
const CROSS_DISTRO_LABELS = {
  lexical: 'a same-spelled path of ANOTHER distribution is lexically outside',
  fullCheck: 'the cross-distribution target is denied by the full check too',
  sharedIdentity: 'a cross-distribution target is refused under a root whose identity it SHARES',
  sameDistroControl: 'a case-variant spelling of the SAME distribution is still contained',
}

/**
 * Run the suite in a child process with an explicit environment.
 *
 * `DSH_WSL_OTHER_DISTRO` is removed from the inherited environment first: a developer's own
 * override would otherwise decide which branch runs, and the control below needs the
 * machine's real answer. `DSH_CHECKOUT` is set to the checkout the suite resolves by default,
 * so a COPY (whose sibling path is a throwaway tree) runs the same sections as the real file.
 * @param {Record<string, string>} env - overrides applied after the removal.
 * @param {string} [suite] - the suite to run; the mutant and copy sections point this elsewhere.
 * @returns {{code: number, out: string}} the child's exit code and combined output.
 */
function runSuite(env, suite = suitePath) {
  const childEnv = { ...process.env, DSH_CHECKOUT: checkout }
  delete childEnv.DSH_WSL_OTHER_DISTRO
  Object.assign(childEnv, env)
  const run = spawnSync(process.execPath, [suite], {
    encoding: 'utf8',
    timeout: 300_000,
    killSignal: 'SIGKILL',
    env: childEnv,
  })
  // A killed run settles as a null status; report it as a failure rather than as an absent code.
  return { code: run.status ?? 1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * The whole SKIP block of the pinned family: its `  SKIP  ` line and the 8-space-indented lines
 * that belong to it, ending at the first line that does not.
 *
 * The block is what a reader actually reads, and the checks below must be satisfied by IT — the
 * same words appearing on a PASS line elsewhere in the run are not the SKIP naming them — so
 * nothing here greps the run's whole output for the labels. The SUITE prints other SKIP blocks
 * (the traversal fixture, the publication sequence), so the block is selected by its family
 * token rather than as "the first one".
 * @param {string} out - the child's combined output.
 * @returns {string[]} the block's lines; empty when the run printed no SKIP of this family.
 */
function skipBlockMatching(out) {
  const lines = out.split('\n')
  const start = lines.findIndex((entry) => entry.startsWith('  SKIP  ') && entry.includes(CROSS_DISTRO_FAMILY))
  if (start === -1) return []
  const block = [lines[start]]
  for (const next of lines.slice(start + 1)) {
    if (!/^ {8}\S/.test(next)) break
    block.push(next)
  }
  return block
}

/**
 * The SKIP line of a block, and the precondition it names after the em dash.
 * @param {string[]} block - the block from skipBlockMatching.
 * @returns {{line: string, reason: string}} the SKIP line and its reason (both empty when absent).
 */
function skipLineOf(block) {
  const line = block[0] ?? ''
  const reason = line.includes('—') ? line.slice(line.indexOf('—') + 1).trim() : ''
  return { line, reason }
}

/**
 * How many checks the child's tail must report as skipped.
 *
 * The family contributes four. Every OTHER skip the same run printed contributes exactly one
 * (the traversal fixture and the publication sequence each increment the suite's counter once),
 * and WHICH of them fired is a property of the machine — a missing harness checkout adds the
 * publication one — so the expectation is derived from the run instead of hardcoded. A
 * hardcoded count is what reddened the 9P pin on the owner's machine class.
 * @param {string} out - the child's combined output.
 * @returns {number} the count the tail must name.
 */
function expectedSkippedChecks(out) {
  const otherSkips = out.split('\n').filter((entry) => entry.startsWith('  SKIP  ')
    && !entry.includes(CROSS_DISTRO_FAMILY)).length
  return Object.keys(CROSS_DISTRO_LABELS).length + otherSkips
}

/**
 * The child's own FAIL lines, so a failure detail says WHICH check inside the suite answered
 * wrongly instead of only how it ended.
 * @param {string} out - the child's combined output.
 * @returns {string} the matching lines, or a note when there are none.
 */
function failureLinesOf(out) {
  const lines = out.split('\n').filter((entry) => entry.startsWith('  FAIL'))
  return lines.length === 0 ? '(the suite printed no FAIL line of its own)' : lines.join('\n')
}

/**
 * Whether the MACHINE has a second distribution, and which — classified from `wsl.exe`'s own
 * list, NEVER from this process's environment.
 *
 * `runSuite` strips `DSH_WSL_OTHER_DISTRO` from every child, so classifying from the inherited
 * override makes the parent's view and the children's reality disagree. `listDistros()` is the
 * same answer the child's own `resolveOtherDistro` reaches once the override is gone.
 * @returns {{hasSecond: boolean, other: string}} the classification, and the name when there is one.
 */
function machineSecondDistro() {
  try {
    const other = listDistros().find((name) => name.toLowerCase() !== distro.toLowerCase()) ?? ''
    return { hasSecond: other !== '', other }
  } catch {
    // A list that cannot be read is also what makes the CHILD skip (its resolveOtherDistro
    // throws and the suite reports the missing precondition), so this machine offers no second
    // share for this run.
    return { hasSecond: false, other: '' }
  }
}

/**
 * The last few lines of a child's output, for a failure detail that stays readable.
 * @param {string} out - the child's combined output.
 * @param {number} [lines] - how many trailing lines to keep.
 * @returns {string} the trailing lines.
 */
function tailOf(out, lines = 3) {
  return out.trimEnd().split('\n').slice(-lines).join('\n')
}

/**
 * Assert the content every SKIP of the pinned family must carry, whatever forced it.
 * @param {string} where - which run this is, for the labels.
 * @param {{code: number, out: string}} run - the child's result.
 * @param {string} reasonMustName - a token the named precondition must contain.
 */
function assertSkipContent(where, run, reasonMustName) {
  const block = skipBlockMatching(run.out)
  const blockText = block.join('\n')
  const { line, reason } = skipLineOf(block)
  const failLines = run.out.split('\n').filter((entry) => entry.startsWith('  FAIL'))
  check(`${where}: exit 2, so verify-all reports the suite as SKIP instead of as a pass`,
    run.code === 2,
    `exit ${run.code}; the run's FAIL lines and its end:\n${failureLinesOf(run.out)}\n${tailOf(run.out)}`)
  check(`${where}: NO check FAILS — the missing precondition is not a defect`,
    failLines.length === 0,
    failLines.join('\n') || `exit ${run.code}; the run ends:\n${tailOf(run.out)}`)
  check(`${where}: a SKIP line names the family and the missing precondition ("${reasonMustName}")`,
    line.includes(CROSS_DISTRO_FAMILY) && reason.length > 0 && reason.includes(reasonMustName),
    line || `(no "  SKIP  " line naming ${CROSS_DISTRO_FAMILY}); the run ends:\n${tailOf(run.out)}`)
  check(`${where}: the SKIP names all four assertions that were not evaluated`,
    Object.values(CROSS_DISTRO_LABELS).every((label) => blockText.includes(`"${label}"`)),
    `the SKIP block:\n${blockText || '(none)'}\n`
      + Object.values(CROSS_DISTRO_LABELS).map((label) => `${label}: ${blockText.includes(`"${label}"`)}`).join('; '))
  check(`${where}: the SKIP names the remedy`,
    blockText.includes('install a second WSL distribution') && blockText.includes('DSH_WSL_OTHER_DISTRO'),
    blockText || '(the run printed no SKIP block of this family)')
  const expected = expectedSkippedChecks(run.out)
  const tail = run.out.split('\n').find((entry) => entry.includes('CHECK(S) SKIPPED')) ?? ''
  check(`${where}: the tail counts the ${expected} skipped checks and says exit 2`,
    new RegExp(`(^| )EVERY CHECK THAT COULD RUN PASSED, ${expected} CHECK\\(S\\) SKIPPED — exit 2,`).test(tail),
    tail || `(no counted tail); the run ends:\n${tailOf(run.out)}`)
  const passLines = run.out.split('\n').filter((entry) => entry.startsWith('  PASS  '))
  check(`${where}: the assertions that need no second share still ran (no early skip)`,
    passLines.some((entry) => entry.includes('the identity walk contains the same object under its wsl$ alias'))
      && passLines.some((entry) => entry.includes('a drive root is not contained by a WSL workspace')),
    `${passLines.length} PASS line(s); the run ends:\n${tailOf(run.out)}`)
}

/**
 * A copy of the tree the SUITE runs from: the suite, its imports and the fence.
 * @param {string} prefix - the mkdtemp prefix, so a leaked tree names its section.
 * @returns {string} the copy's root.
 */
function copySuiteTree(prefix) {
  const tree = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'lib', 'wsl'), { recursive: true })
  for (const [dir, name] of [
    ['scripts', 'verify-fs-fence.mjs'],
    ['scripts', 'env.mjs'],
    ['scripts', 'detail.mjs'],
    ['scripts', 'source-text.mjs'],
    ['lib/wsl', 'fence.js'],
    ['lib/wsl', 'paths.js'],
  ]) copyFileSync(join(pluginRoot, dir, name), join(tree, dir, name))
  return tree
}

/**
 * A copy of the suite whose `lib/wsl/fence.js` has the distribution binding REMOVED — the
 * pre-binding behaviour, and the mutation the family's flagship assertion exists to catch.
 * @returns {{path: string, tree: string, mutated: boolean}} the copy's suite, its tree, and
 *   whether the mutation applied (a stale mutation must redden, never pass silently).
 */
function buildBindingRemovedCopy() {
  const tree = copySuiteTree('dsh-fence-skip-binding-')
  const fencePath = join(tree, 'lib', 'wsl', 'fence.js')
  const source = readFileSync(fencePath, 'utf8')
  const binding = [
    '  const targetUnc = parseWslUnc(targetKey)',
    '  const rootUnc = parseWslUnc(root)',
    '  if (targetUnc !== null && rootUnc !== null',
    "    && targetUnc.distro.toLowerCase() !== rootUnc.distro.toLowerCase()) return false",
  ].join('\n')
  const mutated = source.includes(binding)
  writeFileSync(fencePath, source.replace(binding, [
    '  // PIN MUTANT: the distribution binding is REMOVED, so the identity walk below answers',
    '  // a foreign target exactly as it did before the binding existed.',
  ].join('\n')), 'utf8')
  return { path: join(tree, 'scripts', 'verify-fs-fence.mjs'), tree, mutated }
}

/**
 * Whether the two shares report the SAME (dev,ino) for /tmp — the collision the distribution
 * binding was added for, and the reason removing it reddens the shared-identity assertion.
 * On a host whose shares report distinct inodes the walk denies a foreign target with or
 * without the binding, so the mutation cannot redden anything: that is a property of the
 * machine, measured here rather than assumed, and the same one the suite prints in its own
 * failure detail.
 * @param {string} other - the second distribution's name.
 * @returns {boolean} true when the shares collide.
 */
function sharesShareTmpIdentity(other) {
  try {
    const localTmp = statSync(`\\\\wsl.localhost\\${distro}\\tmp`, { bigint: true })
    const otherTmp = statSync(`\\\\wsl.localhost\\${other}\\tmp`, { bigint: true })
    return localTmp.dev === otherTmp.dev && localTmp.ino === otherTmp.ino
  } catch {
    return false
  }
}

/**
 * A copy of THIS WHOLE PIN whose `listDistros()` reports the selected distribution alone —
 * the owner's machine class, produced on a machine that has a second distribution.
 *
 * Section D's mutant and the control both depend on the machine class, so the class itself has
 * to be exercised, not reasoned about: this copy is where the pin is shown to pass with a
 * second distribution present AND absent. It carries the whole pinned tree (its own suite, its
 * own env.mjs, the fence), so the copy's children are copies too and the simulation cannot leak
 * into the real run. It is only built on a machine that HAS a second distribution — on a
 * one-distribution machine this suite is already that class, and re-entering the simulation
 * there would recurse.
 * @returns {{path: string, tree: string, mutated: boolean}} the copy's pin, its tree, and
 *   whether the one-distribution patch applied.
 */
function buildOneDistributionCopy() {
  const tree = copySuiteTree('dsh-fence-skip-one-')
  copyFileSync(join(here, 'verify-fs-fence-skip.mjs'), join(tree, 'scripts', 'verify-fs-fence-skip.mjs'))
  const envPath = join(tree, 'scripts', 'env.mjs')
  const source = readFileSync(envPath, 'utf8')
  const filter = 'filter((name) => name.length > 0)'
  const mutated = source.includes(filter)
  writeFileSync(envPath, source.replace(filter,
    `filter((name) => name.length > 0 && name.toLowerCase() === resolveDistro().toLowerCase()) /* PIN: one distribution */`), 'utf8')
  return { path: join(tree, 'scripts', 'verify-fs-fence-skip.mjs'), tree, mutated }
}

// A: the machine's second distribution exists but the operator pointed the suite at the
// selected one, so there is no second share to compare against — the branch a one-distribution
// machine takes.
console.log('the suite with no second share to compare against (override pointed at the selected distribution)')
assertSkipContent('no second share', runSuite({ DSH_WSL_OTHER_DISTRO: distro }), distro)

// B: the override set to an EMPTY value. Same branch, and the precondition must still be named:
// an empty value used to fail a check whose detail named nothing at all.
console.log('\nthe suite with the override set to an empty value')
assertSkipContent('empty override', runSuite({ DSH_WSL_OTHER_DISTRO: '' }), 'DSH_WSL_OTHER_DISTRO')

// B2: a name that resolves but whose share does not answer. The same branch, and the reason
// is the OTHER half of the precondition — the share itself rather than the resolver — so the
// SKIP cannot borrow the resolver's message for it: it names the path that did not answer.
console.log('\nthe suite pointed at a distribution whose share does not answer')
assertSkipContent('unanswered share', runSuite({ DSH_WSL_OTHER_DISTRO: 'dsh-wsl-no-such-distro' }), 'does not exist')
// C: the control. On a machine WITH a second distribution the suite must still exit 0, print no
// SKIP of this family and RUN all four assertions — the skip is conditional on the missing
// precondition, not an unconditional escape. On a machine with one distribution the control is
// the same branch as A, and says so rather than asserting a pass that cannot happen here.
console.log("\nthe control: the machine's own answer")
const machineSecond = machineSecondDistro()
const control = runSuite({})
if (machineSecond.hasSecond) {
  check('control: with a second share present the suite exits 0 (the skip is conditional)',
    control.code === 0,
    `exit ${control.code} with "${machineSecond.other}" installed; the run's FAIL lines and its end:\n${failureLinesOf(control.out)}\n${tailOf(control.out)}`)
  check('control: no SKIP of the cross-distribution family is printed when the second share answered',
    !control.out.split('\n').some((entry) => entry.startsWith('  SKIP  ') && entry.includes(CROSS_DISTRO_FAMILY)),
    control.out.split('\n').filter((entry) => entry.includes('SKIP')).join('\n') || '(no SKIP line at all)')
  check('control: all four assertions RAN — every label printed as PASS',
    Object.values(CROSS_DISTRO_LABELS).every((label) => control.out.includes(`  PASS  ${label}`)),
    Object.values(CROSS_DISTRO_LABELS).map((label) => `${label}: ${control.out.includes(`  PASS  ${label}`)}`).join('; '))
} else {
  check(`control: this machine lists no second distribution beyond "${distro}", so the unforced run skips too`,
    control.code === 2 && skipBlockMatching(control.out).length > 0,
    `exit ${control.code}; the run ends:\n${tailOf(control.out)}`)
}

// D: the second trap. With a second share present nothing may change, so this runs the family
// against a fence whose distribution binding has been REMOVED: the shared-identity assertion
// must FAIL, and the other three must still pass (a broad crash would say nothing about the
// family). The mutation is what proves the four are not constants — a check() call that prints
// PASS proves only that it ran.
console.log('\nthe suite against a fence whose distribution binding is REMOVED (in a copy)')
if (machineSecond.hasSecond && sharesShareTmpIdentity(machineSecond.other)) {
  const bindingCopy = buildBindingRemovedCopy()
  check('binding mutant: the mutation applied to the copy (a stale mutation must not pass silently)',
    bindingCopy.mutated, `the copy at ${bindingCopy.path} still carries its distribution binding`)
  const bindingRun = runSuite({}, bindingCopy.path)
  rmSync(bindingCopy.tree, { recursive: true, force: true })
  check('binding mutant: exit 1 — the family still FAILS when the fence stops refusing a foreign target',
    bindingRun.code === 1,
    `exit ${bindingRun.code}; the run's FAIL lines and its end:\n${failureLinesOf(bindingRun.out)}\n${tailOf(bindingRun.out)}`)
  check('binding mutant: the binding-dependent assertion is printed as FAIL (it is not a constant)',
    bindingRun.out.includes(`  FAIL  ${CROSS_DISTRO_LABELS.sharedIdentity}`),
    failureLinesOf(bindingRun.out))
  check('binding mutant: the other three are still printed as PASS, so the reddening is the binding\'s',
    [CROSS_DISTRO_LABELS.lexical, CROSS_DISTRO_LABELS.fullCheck, CROSS_DISTRO_LABELS.sameDistroControl]
      .every((label) => bindingRun.out.includes(`  PASS  ${label}`)),
    bindingRun.out.split('\n').filter((entry) => Object.values(CROSS_DISTRO_LABELS).some((label) => entry.includes(label))).join('\n'))
  check('binding mutant: no SKIP of this family is printed — a second share DID answer, so the defect is the fence',
    !bindingRun.out.split('\n').some((entry) => entry.startsWith('  SKIP  ') && entry.includes(CROSS_DISTRO_FAMILY)),
    bindingRun.out.split('\n').filter((entry) => entry.includes('SKIP')).join('\n') || '(no SKIP line at all)')
} else if (machineSecond.hasSecond) {
  console.log(`  DISCLOSED  the two shares report distinct (dev,ino) for /tmp on this host, so the identity walk denies a foreign target with or without the binding: removing the binding cannot redden this family here.`)
} else {
  console.log(`\nthis machine ALREADY is the one-distribution class, so section D has no second share to mutate against`)
}

// E: the OTHER machine class. A count derived from the class is only as good as the class being
// exercised, so this re-runs the whole pin against a copy that reports the selected distribution
// alone: the copy's SUITE must skip with the genuine reason (not the override's), and the child
// pin must be green there (a patch that silently stopped applying would pass an "it exited 0"
// check on a two-distribution machine).
if (machineSecond.hasSecond) {
  console.log('\nthe whole pin, re-run on a copy that reports ONE distribution')
  const oneDistro = buildOneDistributionCopy()
  check('one-distribution class: the simulation applied to the copy',
    oneDistro.mutated, `the copy at ${oneDistro.path} still lists every distribution`)
  assertSkipContent('one-distribution copy', runSuite({}, join(oneDistro.tree, 'scripts', 'verify-fs-fence.mjs')), 'no distribution other than')
  const childPin = runSuite({}, oneDistro.path)
  rmSync(oneDistro.tree, { recursive: true, force: true })
  check('one-distribution class: the pin is GREEN there too (exit 0, ALL CHECKS PASSED)',
    childPin.code === 0 && childPin.out.includes('ALL CHECKS PASSED'),
    `exit ${childPin.code}; the child pin's FAIL lines and its end:\n${failureLinesOf(childPin.out)}\n${tailOf(childPin.out)}`)
  check('one-distribution class: the child pin really classified the copy as one-distribution',
    childPin.out.includes('this machine lists no second distribution beyond'),
    tailOf(childPin.out, 6))
} else {
  console.log('\nthis machine ALREADY is the one-distribution class, so section E has nothing to simulate')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
