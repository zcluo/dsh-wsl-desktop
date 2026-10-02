/**
 * Pin the two reports `verify-9p.mjs` gives when it cannot establish something, in both
 * machine classes, and the control that keeps them conditional.
 *
 * FAMILY 1 — the cross-share identity facts (3). They compare the selected distribution's
 * share with ANOTHER distribution's, so a machine with one distribution cannot measure
 * them: the probe must say so LOUDLY (a SKIP naming the missing precondition, the three
 * facts and the remedy) and exit 2, which `verify-all.mjs` reports as SKIP rather than as
 * a pass. Sections A and B force that precondition through the probe's own override —
 * pointed at the selected distribution itself, and at an empty value.
 *
 * FAMILY 2 — the link fixture (3 facts + 4 checks). When the fixture cannot be built
 * (wsl.exe fails, or a cold VM start exceeds the probe's own ceiling) the probe loses the
 * assertion the whole HAZARD-to-assertion conversion produced, so that branch must also be
 * a counted SKIP and exit 2. The precondition cannot be produced on demand, so section D
 * runs a COPY of the probe whose own `wsl.exe` calls fail.
 *
 * THE CONTROL (section C) pins that neither skip fires unconditionally: on a machine that
 * has a second distribution the probe must still measure all three cross-share rows and
 * exit 0. It classifies the machine from `wsl.exe -l -q` — never from this process's
 * `DSH_WSL_OTHER_DISTRO`, which every child strips — so an override exported in the
 * developer's shell cannot make the pin disagree with its own children. Section E then
 * proves the OTHER class: on a machine with a second distribution it re-runs this whole
 * suite against a copy whose `listDistros()` reports the selected distribution alone, so
 * the pin is shown to pass with a second distribution present AND simulated absent.
 *
 * Why this is its own suite. Neither branch can run on a machine that HAS a second
 * distribution (well, on a machine that has one), and a check written inside `verify-9p.mjs`
 * for them would be a check that never runs here — the unreachable-check class this plan
 * removes. Every assertion below reads a real child's stdout and exit code, so it runs on
 * every machine. It is a CONTENT pin: "the child skipped" would be unfalsifiable here,
 * because this suite is what forces the skips.
 *
 * Run: node scripts/verify-9p-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDistros, resolveDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distro = resolveDistro()
const probePath = join(here, 'verify-9p.mjs')

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

/** The three fact labels the cross-share block records; the SKIP must name them. */
const CROSS_SHARE_LABELS = [
  'cross-share identity <share root>',
  'cross-share identity /tmp',
  'cross-share identity /home',
]

/** The facts the link fixture records; each is lost when the fixture cannot be built. */
const LINK_FIXTURE_FACTS = [
  'realpath / read of the link (the file behind it exists)',
  'a rename whose destination traverses the link',
  'mkdir through the link, at a spelling the share resolves elsewhere',
]

/** The assertion the link fixture exists for: the HAZARD-to-assertion conversion. */
const LINK_FIXTURE_ASSERTION = 'the fence refuses the target its own canonicalization produces for that spelling'

/**
 * The subjects the two SKIP families name before the em dash — the key every lookup in
 * this file binds on.
 *
 * A run can carry BOTH families at once and the probe prints the fixture's block first,
 * so "the run's SKIP block" is not a single thing. Each name below is already required on
 * its family's SKIP line by a check in this file, so a rename reddens a check instead of
 * quietly re-pointing a lookup at the other family's block.
 */
const CROSS_SHARE_SKIP_SUBJECT = 'cross-share identity'
const FIXTURE_SKIP_SUBJECT = 'the link fixture'

/**
 * Run the probe in a child process with an explicit environment.
 *
 * `DSH_WSL_OTHER_DISTRO` is removed from the inherited environment first: a
 * developer's own override would otherwise decide which branch runs, and the
 * control below needs the machine's real answer.
 * @param {Record<string, string>} env - overrides applied after the removal.
 * @param {string} [probe] - the probe to run; the fixture mutant below points this at a copy.
 * @returns {{code: number, out: string}} the child's exit code and combined output.
 */
function runProbe(env, probe = probePath) {
  const childEnv = { ...process.env }
  delete childEnv.DSH_WSL_OTHER_DISTRO
  Object.assign(childEnv, env)
  const run = spawnSync(process.execPath, [probe, distro], {
    encoding: 'utf8',
    timeout: 300_000,
    killSignal: 'SIGKILL',
    env: childEnv,
  })
  // A killed run settles as a null status; report it as a failure rather than as
  // an absent code.
  return { code: run.status ?? 1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * The SUBJECT a SKIP line names — the family the SKIP belongs to — read from the text
 * before the em dash.
 *
 * This is the key every lookup below binds on, and it is CONTENT rather than position:
 * the probe prints the link-fixture SKIP (verify-9p.mjs:556) BEFORE the cross-share SKIP
 * (:721), so a lookup that took "the run's first SKIP block" read the fixture's block
 * whenever the fixture could not be built and judged every cross-share assertion against
 * it — measured, against a copy whose fixture always fails: 5 cross-share rows red while
 * `exit 2` and the no-early-skip row stayed green, which only the fixture SKIP firing
 * can produce. "The last block" would be the same fragility one step over (any third
 * family, in any order, moves it again), so the lookup is keyed on the family's own name.
 * That name cannot drift silently: this file already requires it on the SKIP line
 * (`a SKIP line names the cross-share block`, and the fixture rows below), so a rename
 * reddens a check instead of quietly re-pointing a lookup at another family's block.
 * @param {string} line - a SKIP line.
 * @returns {string} the subject, or '' when the line is not a SKIP line or carries no em dash.
 */
function skipSubjectOf(line) {
  const marker = '  SKIP  '
  if (!line.startsWith(marker)) return ''
  const rest = line.slice(marker.length)
  return rest.includes('—') ? rest.slice(0, rest.indexOf('—')).trim() : ''
}

/**
 * Every SKIP block of a run: each `  SKIP  ` line and the 8-space-indented lines that
 * belong to it, ending at the first line that does not.
 *
 * The block is what a reader actually reads, and the checks below must be satisfied by
 * IT — the same words appearing on a FACT line elsewhere in the run are not the SKIP
 * naming them — so nothing here greps the run's whole output.
 * @param {string} out - the child's combined output.
 * @returns {string[][]} one block per SKIP line, in the order the run printed them.
 */
function skipBlocksOf(out) {
  const lines = out.split('\n')
  const blocks = []
  for (const [index, entry] of lines.entries()) {
    if (!entry.startsWith('  SKIP  ')) continue
    const block = [entry]
    for (const next of lines.slice(index + 1)) {
      if (!/^ {8}\S/.test(next)) break
      block.push(next)
    }
    blocks.push(block)
  }
  return blocks
}

/**
 * The SKIP block of ONE family, chosen by the subject its SKIP line names.
 *
 * A run carries several families at once whenever more than one precondition is missing
 * — the link fixture and the cross-share rows are independent and either can fire alone
 * — so "the run's SKIP block" is not a single thing, and this is the only lookup the
 * checks may use.
 * @param {string} out - the child's combined output.
 * @param {string} subject - the family's own name, as its SKIP line spells it.
 * @returns {string[]} that family's block, or [] when the run printed no SKIP for it.
 */
function skipBlockNaming(out, subject) {
  return skipBlocksOf(out).find((block) => skipSubjectOf(block[0]) === subject) ?? []
}

/**
 * The SKIP line of a block, and the precondition it names after the em dash.
 * @param {string[]} block - a block from skipBlockNaming.
 * @returns {{line: string, reason: string}} the SKIP line and its reason (both empty when absent).
 */
function skipLineOf(block) {
  const line = block[0] ?? ''
  const reason = line.includes('—') ? line.slice(line.indexOf('—') + 1).trim() : ''
  return { line, reason }
}

/**
 * Whether one cross-share row was MEASURED rather than merely printed: a row whose stat
 * failed is recorded as `UNMEASURED - <code>`, and a control that accepted that would
 * pass while the fact was not established.
 * @param {string} out - the child's combined output.
 * @param {string} label - the row's FACT label.
 * @returns {boolean} true when the row is present and not UNMEASURED.
 */
function measuredRow(out, label) {
  const line = out.split('\n').find((entry) => entry.startsWith(`  FACT    ${label} —`)) ?? ''
  return line !== '' && !line.includes('UNMEASURED')
}

/**
 * The child's own FAIL lines (and any probe SKIP lines), so a failure detail says
 * WHICH check inside the probe answered wrongly instead of only how it ended.
 * @param {string} out - the child's combined output.
 * @returns {string} the matching lines, or a note when there are none.
 */
function failureLinesOf(out) {
  const lines = []
  for (const [index, entry] of out.split('\n').entries()) {
    if (!/^\s*(FAIL|SKIP)\b/.test(entry)) continue
    lines.push(entry)
    // The probe indents its evidence under the line it belongs to (the read-back
    // value, the error code); without it a non-skip exit says only "exit 1".
    for (const next of out.split('\n').slice(index + 1)) {
      if (!/^ {8}\S/.test(next)) break
      lines.push(next)
    }
  }
  return lines.length === 0 ? '(the probe printed no FAIL or SKIP line of its own)' : lines.join('\n')
}

/**
 * Whether the MACHINE has a second distribution, and which — classified from `wsl.exe`'s
 * own list, NEVER from this process's environment.
 *
 * `runProbe` strips `DSH_WSL_OTHER_DISTRO` from every child, so classifying from the
 * inherited override makes the parent's view and the children's reality disagree: an empty
 * (or self-pointed) override exported in the developer's shell classified the machine as
 * having no second share while the children found one, and the control then reported a
 * healthy machine red. `listDistros()` is the same answer the child's own
 * `resolveOtherDistro` reaches once the override is gone.
 * @returns {{hasSecond: boolean, other: string}} the classification, and the name when there is one.
 */
function machineSecondDistro() {
  try {
    const other = listDistros().find((name) => name.toLowerCase() !== distro.toLowerCase()) ?? ''
    return { hasSecond: other !== '', other }
  } catch {
    // A list that cannot be read is also what makes the CHILD skip (its resolveOtherDistro
    // throws and the probe reports the missing precondition), so this machine offers no
    // second share for this run.
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
 * Assert the content every SKIP of this block must carry, whatever forced it.
 * @param {string} where - which run this is, for the labels.
 * @param {{code: number, out: string}} run - the child's result.
 * @param {string} reasonMustName - a token the named precondition must contain.
 */
function assertSkipContent(where, run, reasonMustName) {
  // The CROSS-SHARE family's own block, by its subject — never the run's first block.
  const block = skipBlockNaming(run.out, CROSS_SHARE_SKIP_SUBJECT)
  const blockText = block.join('\n')
  const { line, reason } = skipLineOf(block)
  check(`${where}: exit 2, so verify-all reports the probe as SKIP instead of as a pass`,
    run.code === 2,
    `exit ${run.code}; the run's FAIL/SKIP lines and its end:\n${failureLinesOf(run.out)}\n${tailOf(run.out)}`)
  // This row shares its predicate with the lookup above ON PURPOSE: it is what NAMES the
  // failure when the run printed no cross-share SKIP at all — a probe that crashed in its
  // own cleanup (measured: ENOTEMPTY, exit 1, no report), or one that measured the second
  // share instead of skipping — and every row below then reads an empty block. It can
  // fail: measured red against exactly that crashed probe, green against the fixture-only
  // SKIP whose block this lookup is bound to.
  check(`${where}: a SKIP line names the cross-share block`,
    block.length > 0,
    line || `(no "  SKIP  " line whose subject is "${CROSS_SHARE_SKIP_SUBJECT}"); the run ends:\n${tailOf(run.out)}`)
  check(`${where}: the SKIP names the missing precondition ("${reasonMustName}"), never a bare reason`,
    reason.length > 0 && reason.includes(reasonMustName),
    line || `(no "  SKIP  " line); the run ends:\n${tailOf(run.out)}`)
  check(`${where}: the SKIP names the three facts that went unmeasured`,
    CROSS_SHARE_LABELS.every((label) => blockText.includes(label)),
    `the SKIP block:\n${blockText || '(none)'}\n${CROSS_SHARE_LABELS.map((label) => `${label}: ${blockText.includes(label)}`).join('; ')}`)
  check(`${where}: the SKIP names the remedy`,
    blockText.includes('DSH_WSL_OTHER_DISTRO') && blockText.includes('install a second WSL distribution'),
    blockText || `(the run printed no SKIP block); the run ends:\n${tailOf(run.out)}`)
  const tail = run.out.split('\n').find((entry) => entry.includes('WERE NOT MEASURED')) ?? ''
  // The tail's count is the RUN's total of skipped share facts, so the expectation is the
  // cross-share family PLUS the fixture family when that family skipped too — read from
  // the run's own SKIP blocks, never assumed from the machine class. The fixture fails on
  // its own (measured under concurrent runs: `ETIMEDOUT: spawnSync wsl.exe ETIMEDOUT`),
  // and a hardcoded 3 then reddened a correct run: measured, the tail printed "6 SHARE
  // FACT(S) WERE NOT MEASURED AND 4 CHECK(S) WERE NOT EVALUATED" while the fixture's own
  // rows in section D stayed green.
  //
  // The count is DERIVED from the lists that own it and BOUND to the phrase it counts.
  // The hardcoded `/\b3\b/` was satisfied by a 3 anywhere in the line — this tail also
  // carries a CHECK count — so a tail whose share count no longer matched
  // CROSS_SHARE_LABELS kept the row green: measured, with the tail printing "2 SHARE
  // FACT(S) ... AND 3 CHECK(S) ...", the old boolean was TRUE. The fixture family below
  // was already fixed for exactly this (a hardcoded count reddened it on the
  // one-distribution class); this is the same defect one family over.
  const fixtureBlock = skipBlockNaming(run.out, FIXTURE_SKIP_SUBJECT)
  const expectedSkipped = CROSS_SHARE_LABELS.length + (fixtureBlock.length > 0 ? LINK_FIXTURE_FACTS.length : 0)
  check(`${where}: the tail counts the ${expectedSkipped} unmeasured fact(s)${fixtureBlock.length > 0 ? ' (the fixture family skipped too)' : ''} instead of declaring a clean profile`,
    new RegExp(`(^| )${expectedSkipped} SHARE FACT\\(S\\) WERE NOT MEASURED`).test(tail),
    tail || `(no line saying the facts were not measured); the run ends:\n${tailOf(run.out)}`)
  // The skip is NOT an early exit: the probe still runs, and the facts that need no
  // second share are still measured and printed, so a reader loses exactly the three
  // named rows. The two FACT lines asserted here are the ones no other precondition
  // can suppress (neither the link fixture nor the second distribution feeds them);
  // the fixture-dependent facts are deliberately NOT required, because a fixture
  // failure is a probe-side problem this pin must not misreport as an early skip.
  const factLines = run.out.split('\n').filter((entry) => entry.startsWith('  FACT    '))
  check(`${where}: the facts that need no second share are still recorded (no early skip)`,
    factLines.some((entry) => entry.includes('case-variant path /TMP'))
      && factLines.some((entry) => entry.includes('realpath(/lib)'))
      && run.out.includes('OK    realpath resolves on the share')
      && run.out.includes('OK    hard link (create-if-absent publication)'),
    `${factLines.length} FACT line(s):\n${factLines.join('\n')}`)
}

/**
 * A copy of the probe whose own `wsl.exe` calls FAIL, so the branch that runs when the
 * link fixture cannot be built is reachable on a healthy machine.
 *
 * That branch holds the assertion the whole file's HAZARD-to-assertion conversion
 * produced — the fence's refusal of the escaping spelling — and the precondition that
 * triggers it (a hung or failing wsl.exe, which the probe's own comment calls
 * hang-prone) cannot be produced on demand. The mutation is applied to a COPY in a
 * throwaway tree that also carries the probe's imports, so the real scripts are never
 * touched. ONLY the probe's own child_process import is shadowed: env.mjs keeps its own,
 * so the second distribution still resolves and the cross-share rows are still measured
 * — which is what isolates the fixture branch in this run.
 * @returns {{path: string, tree: string, mutated: boolean}} the copy's path, its tree, and
 *   whether the mutation applied (a stale mutation must redden, never pass silently).
 */
function buildFixtureFailedCopy() {
  const tree = mkdtempSync(join(tmpdir(), 'dsh-9p-skip-pin-'))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'lib', 'wsl'), { recursive: true })
  for (const [from, to] of [
    [join(here, 'env.mjs'), join(tree, 'scripts', 'env.mjs')],
    [join(here, 'detail.mjs'), join(tree, 'scripts', 'detail.mjs')],
    [join(here, '..', 'lib', 'wsl', 'fence.js'), join(tree, 'lib', 'wsl', 'fence.js')],
    [join(here, '..', 'lib', 'wsl', 'paths.js'), join(tree, 'lib', 'wsl', 'paths.js')],
    [join(here, '..', 'lib', 'wsl', 'publish.js'), join(tree, 'lib', 'wsl', 'publish.js')],
  ]) copyFileSync(from, to)
  const source = readFileSync(probePath, 'utf8')
  const importLine = "import { execFileSync } from 'node:child_process'"
  const mutated = source.includes(importLine)
  writeFileSync(join(tree, 'scripts', 'verify-9p.mjs'), source.replace(importLine, [
    "import { execFileSync as realExecFileSync } from 'node:child_process'",
    '// PIN MUTANT: every wsl.exe call from THIS file fails (the fixture build and its',
    '// cleanup); env.mjs keeps its own import, so the machine still offers a second share.',
    'const execFileSync = (file, args, options) => {',
    "  if (file === 'wsl.exe') throw new Error('pin mutant: wsl.exe forced to fail, so the fixture cannot be built')",
    '  return realExecFileSync(file, args, options)',
    '}',
  ].join('\n')), 'utf8')
  return { path: join(tree, 'scripts', 'verify-9p.mjs'), tree, mutated }
}

/**
 * Assert the content the fixture-failure SKIP must carry.
 *
 * The expected FACT count is derived from the machine class, not hardcoded: the mutant
 * child's classification is this pin's own (both read `wsl.exe -l -q`, and runProbe strips
 * the override), so on a machine with ONE distribution the child's cross-share family
 * skips too — three more facts, no more checks. Hardcoding 3 reddened the pin on exactly
 * the machine class the owner ruled must SKIP rather than fail (measured: 1 CHECK(S)
 * FAILED, exit 1, aggregate FAIL).
 * @param {{code: number, out: string}} run - the mutant child's result.
 * @param {{hasSecond: boolean}} machineSecond - the machine's class, as the control classified it.
 */
function assertFixtureSkipContent(run, machineSecond) {
  const expectedFacts = LINK_FIXTURE_FACTS.length + (machineSecond.hasSecond ? 0 : CROSS_SHARE_LABELS.length)
  // The FIXTURE family's own block, by its subject — the same binding the cross-share rows
  // use, and for the same reason: on a one-distribution machine this run skips BOTH
  // families, and a lookup that took the first block would be right only by the accident
  // that the fixture happens to print first.
  const block = skipBlockNaming(run.out, FIXTURE_SKIP_SUBJECT)
  const blockText = block.join('\n')
  const { line, reason } = skipLineOf(block)
  check('fixture skip: exit 2, so verify-all reports the probe as SKIP instead of as a pass',
    run.code === 2,
    `exit ${run.code}; the run's FAIL/SKIP lines and its end:\n${failureLinesOf(run.out)}\n${tailOf(run.out)}`)
  check('fixture skip: the SKIP names the fixture and the precondition that failed',
    line.includes('the link fixture') && reason.includes('pin mutant'),
    line || `(no "  SKIP  " line); the run ends:\n${tailOf(run.out)}`)
  check('fixture skip: the SKIP names the three facts that went unmeasured',
    LINK_FIXTURE_FACTS.every((label) => blockText.includes(label)),
    `the SKIP block:\n${blockText || '(none)'}\n${LINK_FIXTURE_FACTS.map((label) => `${label}: ${blockText.includes(label)}`).join('; ')}`)
  check('fixture skip: the SKIP names the fence assertion the fixture exists for',
    blockText.includes(LINK_FIXTURE_ASSERTION), blockText || '(the run printed no SKIP block)')
  check('fixture skip: the SKIP names the remedy',
    blockText.includes('wsl.exe') && /wake the distribution/.test(blockText),
    blockText || '(the run printed no SKIP block)')
  const tail = run.out.split('\n').find((entry) => entry.includes('WERE NOT MEASURED')) ?? ''
  check(`fixture skip: the tail counts the unmeasured facts (${expectedFacts} on this ${machineSecond.hasSecond ? 'two-distribution' : 'one-distribution'} machine) AND the four unevaluated checks`,
    new RegExp(`(^| )${expectedFacts} SHARE FACT\\(S\\) WERE NOT MEASURED`).test(tail) && /4 CHECK\(S\) WERE NOT EVALUATED/.test(tail),
    tail || `(no line saying the facts were not measured); the run ends:\n${tailOf(run.out)}`)
  const factLines = run.out.split('\n').filter((entry) => entry.startsWith('  FACT    '))
  check('fixture skip: the UNMEASURED fixture row is NOT counted among the recorded facts',
    !factLines.some((entry) => entry.includes('a Linux symlink inside a fixture root'))
      && run.out.includes('NOT measured (named in the SKIP above)'),
    `${factLines.length} FACT line(s):\n${factLines.join('\n')}`)
}

// A: the machine's second distribution exists but the operator pointed the probe
// at the selected one, so there is no second share to compare against — the branch
// a one-distribution machine takes.
console.log('the probe with no second share to compare against (override pointed at the selected distribution)')
const forced = runProbe({ DSH_WSL_OTHER_DISTRO: distro })
assertSkipContent('no second share', forced, 'second')

// B: the override set to an EMPTY value. Same branch, and the precondition must
// still be named: a SKIP whose reason is empty tells a reader nothing.
console.log('\nthe probe with the override set to an empty value')
const emptyOverride = runProbe({ DSH_WSL_OTHER_DISTRO: '' })
assertSkipContent('empty override', emptyOverride, 'DSH_WSL_OTHER_DISTRO')

// C: the control. On a machine WITH a second distribution the probe must still
// measure all three rows and exit 0 — the skip is conditional on the precondition,
// not unconditional. On a machine with one distribution the control is the same
// branch as A, and says so rather than asserting a pass that cannot happen here.
console.log('\nthe control: the machine\'s own answer')
const machineSecond = machineSecondDistro()
const control = runProbe({})
if (machineSecond.hasSecond) {
  // The control is about the CROSS-SHARE family: with a second share present that family
  // must measure its rows and print no SKIP. The run's exit code is not that family's own
  // verdict — the fixture family forces a legitimate 2 on its own (section D pins that
  // branch, and it was measured firing here as `ETIMEDOUT`) — so the code is asserted
  // against the families that actually skipped, and the cross-share family's absence is
  // asserted on its own. Demanding 0 unconditionally reddened a correct run: measured
  // against a copy whose fixture always fails, `exit 2 with "debian-dev" installed`.
  const controlCross = skipBlockNaming(control.out, CROSS_SHARE_SKIP_SUBJECT)
  const controlFixture = skipBlockNaming(control.out, FIXTURE_SKIP_SUBJECT)
  const expectedCode = controlFixture.length > 0 ? 2 : 0
  check(`control: with a second share present the probe exits ${expectedCode} (the skip is conditional)`,
    control.code === expectedCode, `exit ${control.code} with "${machineSecond.other}" installed; the run ends:\n${tailOf(control.out)}`)
  check('control: the cross-share family prints no SKIP when the second share answered',
    controlCross.length === 0,
    controlCross.join('\n') || control.out.split('\n').filter((entry) => entry.includes('SKIP')).join('\n'))
  check('control: all three cross-share identity rows are MEASURED, not merely printed',
    CROSS_SHARE_LABELS.every((label) => measuredRow(control.out, label)),
    control.out.split('\n').filter((entry) => entry.includes('cross-share identity')).join('\n'))
} else {
  check(`control: this machine lists no second distribution beyond "${distro}", so the unforced run skips too`,
    control.code === 2 && skipBlockNaming(control.out, CROSS_SHARE_SKIP_SUBJECT).length > 0,
    `exit ${control.code}; the run ends:\n${tailOf(control.out)}`)
}

// D: the probe's OTHER skip. When wsl.exe fails or a cold VM start exceeds its ceiling
// the link fixture cannot be built, and that branch holds the assertion the
// HAZARD-to-assertion conversion produced. A green run there would report the fence's
// rule as established without ever evaluating it, so the branch must be a counted SKIP
// — the same convention A and B pin for the cross-share family.
console.log('\nthe probe whose link fixture could not be built (wsl.exe forced to fail in a copy)')
const fixtureCopy = buildFixtureFailedCopy()
check('fixture skip: the mutation applied to the copy (a stale mutation must not pass silently)',
  fixtureCopy.mutated, `the copy at ${fixtureCopy.path} still imports node:child_process unshadowed`)
assertFixtureSkipContent(runProbe({}, fixtureCopy.path), machineSecond)
rmSync(fixtureCopy.tree, { recursive: true, force: true })

/**
 * A copy of THIS WHOLE PIN whose `listDistros()` reports the selected distribution alone —
 * the owner's machine class, produced on a machine that has a second distribution.
 *
 * Section D's expected fact count depends on the machine class, so the class itself has
 * to be exercised, not reasoned about: this copy is where the pin is shown to pass with a
 * second distribution present AND absent. It carries the whole pinned tree (its own probe,
 * its own env.mjs, the fence), so the copy's children are copies too and the simulation
 * cannot leak into the real run. It is only built on a machine that HAS a second
 * distribution — on a one-distribution machine this suite is already that class, and
 * re-entering the simulation there would recurse.
 * @returns {{path: string, tree: string, mutated: boolean}} the copy's pin, its tree, and
 *   whether the one-distribution patch applied.
 */
function buildOneDistributionCopy() {
  const tree = mkdtempSync(join(tmpdir(), 'dsh-9p-skip-one-'))
  mkdirSync(join(tree, 'scripts'), { recursive: true })
  mkdirSync(join(tree, 'lib', 'wsl'), { recursive: true })
  for (const name of ['env.mjs', 'detail.mjs', 'verify-9p.mjs', 'verify-9p-skip.mjs']) {
    copyFileSync(join(here, name), join(tree, 'scripts', name))
  }
  for (const name of ['fence.js', 'paths.js', 'publish.js']) {
    copyFileSync(join(here, '..', 'lib', 'wsl', name), join(tree, 'lib', 'wsl', name))
  }
  const envPath = join(tree, 'scripts', 'env.mjs')
  const source = readFileSync(envPath, 'utf8')
  const filter = 'filter((name) => name.length > 0)'
  const mutated = source.includes(filter)
  writeFileSync(envPath, source.replace(filter,
    `filter((name) => name.length > 0 && name.toLowerCase() === resolveDistro().toLowerCase()) /* PIN: one distribution */`), 'utf8')
  return { path: join(tree, 'scripts', 'verify-9p-skip.mjs'), tree, mutated }
}

// E: the OTHER machine class. A count derived from the class is only as good as the class
// being exercised, so this re-runs the whole pin against a copy that reports the selected
// distribution alone and asserts the child pin is green AND really classified the machine
// as one-distribution (a patch that silently stopped applying would pass an "it exited 0"
// check on a two-distribution machine).
if (machineSecond.hasSecond) {
  console.log('\nthe whole pin, re-run on a copy that reports ONE distribution')
  const oneDistro = buildOneDistributionCopy()
  const childPin = runProbe({}, oneDistro.path)
  rmSync(oneDistro.tree, { recursive: true, force: true })
  check('one-distribution class: the simulation applied to the copy',
    oneDistro.mutated, `the copy at ${oneDistro.path} still lists every distribution`)
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
