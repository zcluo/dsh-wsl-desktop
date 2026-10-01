/**
 * Pin the report `verify-9p.mjs` gives when there is no second share to measure.
 *
 * `verify-9p.mjs` measures the three cross-share identity facts by comparing the
 * selected distribution's share with ANOTHER distribution's. On a machine with one
 * distribution there is nothing to compare against, and the probe must say so
 * LOUDLY: it exits 2, which `verify-all.mjs` reports as SKIP rather than as a
 * pass, and the SKIP names the missing precondition, the three facts that
 * therefore went unmeasured, and the remedy.
 *
 * Why this is its own suite. That branch cannot run on a machine that HAS a second
 * distribution, and a check written inside `verify-9p.mjs` for the
 * one-distribution case would be a check that never runs here — the
 * unreachable-check class this plan removes. This suite FORCES the precondition
 * through the probe's own override (pointed at the selected distribution itself,
 * and at an empty value) and reads the real child's stdout and exit code, so every
 * assertion below runs on every machine. It is a CONTENT pin: "the child skipped"
 * would be unfalsifiable here, because this suite is what forces the skip.
 *
 * The two-distribution path is pinned as a CONTROL: a skip that fires
 * unconditionally, or one that also swallows the facts the share can still answer,
 * reddens it. The control classifies the machine from `wsl.exe -l -q` — never from
 * this process's `DSH_WSL_OTHER_DISTRO`, which every child strips — so an override
 * exported in the developer's shell cannot make the pin disagree with its own children.
 *
 * Run: node scripts/verify-9p-skip.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDistros, resolveDistro } from './env.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distro = resolveDistro()

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

/**
 * Run the probe in a child process with an explicit environment.
 *
 * `DSH_WSL_OTHER_DISTRO` is removed from the inherited environment first: a
 * developer's own override would otherwise decide which branch runs, and the
 * control below needs the machine's real answer.
 * @param {Record<string, string>} env - overrides applied after the removal.
 * @returns {{code: number, out: string}} the child's exit code and combined output.
 */
function runProbe(env) {
  const childEnv = { ...process.env }
  delete childEnv.DSH_WSL_OTHER_DISTRO
  Object.assign(childEnv, env)
  const run = spawnSync(process.execPath, [join(here, 'verify-9p.mjs'), distro], {
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
 * The whole SKIP block of a run: the `  SKIP  ` line and the 8-space-indented lines that
 * belong to it, ending at the first line that does not.
 *
 * The block is what a reader actually reads, and the checks below must be satisfied by
 * IT — the same words appearing on a FACT line elsewhere in the run are not the SKIP
 * naming them — so nothing here greps the run's whole output.
 * @param {string} out - the child's combined output.
 * @returns {string[]} the block's lines; empty when the run printed no SKIP.
 */
function skipBlockOf(out) {
  const lines = out.split('\n')
  const start = lines.findIndex((entry) => entry.startsWith('  SKIP  '))
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
 * @param {string[]} block - the block from skipBlockOf.
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
  const block = skipBlockOf(run.out)
  const blockText = block.join('\n')
  const { line, reason } = skipLineOf(block)
  check(`${where}: exit 2, so verify-all reports the probe as SKIP instead of as a pass`,
    run.code === 2,
    `exit ${run.code}; the run's FAIL/SKIP lines and its end:\n${failureLinesOf(run.out)}\n${tailOf(run.out)}`)
  check(`${where}: a SKIP line names the cross-share block`,
    line.includes('cross-share identity'), line || `(no "  SKIP  " line); the run ends:\n${tailOf(run.out)}`)
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
  check(`${where}: the tail counts the unmeasured facts instead of declaring a clean profile`,
    /\b3\b/.test(tail), tail || `(no line saying the facts were not measured); the run ends:\n${tailOf(run.out)}`)
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
  check('control: with a second share present the probe exits 0 (the skip is conditional)',
    control.code === 0, `exit ${control.code} with "${machineSecond.other}" installed; the run ends:\n${tailOf(control.out)}`)
  check('control: no SKIP is printed when the second share answered',
    skipBlockOf(control.out).length === 0,
    control.out.split('\n').filter((entry) => entry.includes('SKIP')).join('\n'))
  check('control: all three cross-share identity rows are MEASURED, not merely printed',
    CROSS_SHARE_LABELS.every((label) => measuredRow(control.out, label)),
    control.out.split('\n').filter((entry) => entry.includes('cross-share identity')).join('\n'))
} else {
  check(`control: this machine lists no second distribution beyond "${distro}", so the unforced run skips too`,
    control.code === 2 && skipBlockOf(control.out).length > 0, `exit ${control.code}; the run ends:\n${tailOf(control.out)}`)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
