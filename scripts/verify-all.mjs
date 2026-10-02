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
 * branch it comes from; a suite whose skip cannot be justified by such a branch is
 * not declared, and its skip fails the run. Adding an entry is a claim about the
 * machine class the suite may skip on, and a suite that CAN skip without an entry is
 * a skip that will one day arrive undeclared (pinned by scripts/verify-all-skip.mjs).
 *
 * A suite with more than one exit-2 branch lists all of them: the aggregate sees one
 * exit code and cannot tell which branch produced it, so an entry that named only
 * one of them would cover a skip it does not describe.
 */
const DECLARED_SKIPS = [
  {
    // verify-modules.mjs:95 — no dependencies at `DSH_WSL_DEPS ?? <plugin root>/node_modules`,
    // so lib/index.js cannot be imported. That import is the suite's motivating check.
    suite: 'verify-modules.mjs',
    precondition: 'the plugin root has no host node_modules (and DSH_WSL_DEPS names none), so lib/index.js cannot be imported here',
  },
  {
    // verify-package.mjs:184 — `npm --version` could not run, so the packed artifact
    // cannot be produced or inspected at all.
    suite: 'verify-package.mjs',
    precondition: 'npm is not usable here (npm --version cannot run, or exits non-zero)',
  },
  {
    // verify-fs-fence.mjs:562 — the checkout's packages/fs/fs-local/src/fsio.ts is not
    // readable; verify-fs-fence.mjs:690 — no second distribution's share answers.
    // (Its third exit-2 print, at :452, sits behind a FAIL, so a run that reaches it
    // exits 1: it is not a skip-only branch and is not declared here.)
    suite: 'verify-fs-fence.mjs',
    precondition: 'the harness checkout is absent (the publication pin has no source to read), or no second WSL distribution share answers',
  },
  {
    // verify-9p.mjs:556 — the probe could not build its own symlink fixture through
    // wsl.exe (a cold VM start, a timeout); verify-9p.mjs:721 — no second
    // distribution to compare shares against.
    suite: 'verify-9p.mjs',
    precondition: 'the probe could not build its own symlink fixture through wsl.exe, or no second WSL distribution exists to compare shares against',
  },
  {
    // verify-confinement.mjs:454/482/545/560/699/981 — the checkout (or the host temp
    // directory) is not on a drive path, so the distribution has no /mnt spelling of
    // it; :990 — the fixtures could not be built in the distribution; :1041 — the
    // sudoers grant does not cover the fixture tree.
    suite: 'verify-confinement.mjs',
    precondition: 'the checkout is not on a mountable drive path, or the fixtures could not be built in the distribution, or the sudoers grant does not cover them',
  },
  {
    // verify-client-ui.mjs:146 — the shipped icon source is not readable, so the
    // trigger geometry cannot be checked against the artwork.
    suite: 'verify-client-ui.mjs',
    precondition: 'the harness checkout is absent, so the shipped icon source cannot be compared against the trigger geometry',
  },
  {
    // verify-client-dom.mjs:56 — jsdom is not resolvable from the checkout, so the
    // factory cannot be run against a real DOM.
    suite: 'verify-client-dom.mjs',
    precondition: 'jsdom is not resolvable from the harness checkout, so the browser half cannot be run in a real DOM',
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

// Every declaration must still be LIVE. A declared suite whose source carries no
// exit-2 path can never skip anywhere, so the entry has rotted — a renamed suite, a
// deleted skip branch — and the skip it was written for would arrive undeclared the
// moment it came back. That is a property of the REPOSITORY rather than of this
// machine, and it is the stale-declaration class an operator can always clear
// (remove the entry, or restore the branch), so it fails here, before any suite runs.
//
// The other class — a declaration whose precondition simply does not hold on this
// machine — is NOT a defect and does not fail the run: it is dormant, and the summary
// reports it (see below).
{
  /** A suite's exit-2 path: the tail's ternary, or an outright process.exit(2). */
  const EXIT_2_PATH = /process\.exit\(\s*2\s*\)|\?\s*2\s*:\s*0/
  const stale = []
  for (const { suite } of DECLARED_SKIPS) {
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
    // Read as SHAPE, not as spelling: a suite that merely NAMES the convention in a
    // comment or a string (several do) has no exit-2 path, and only blanked text can
    // tell the two apart. blankLiterals is this repository's one owner for that pass.
    if (source === null) stale.push(`${suite} is not readable as a suite of this directory`)
    else if (!EXIT_2_PATH.test(blankLiterals(source))) stale.push(`${suite} has no exit-2 path, so it cannot skip`)
  }
  if (stale.length > 0) {
    console.log(`\nFAIL  a declared skip is STALE — the suite it names cannot skip any more: ${stale.join('; ')}`)
    console.log('      A declaration is honest only while the skip it describes is possible. Remove the entry,')
    console.log('      or restore the exit-2 branch of the suite it names.')
    process.exit(1)
  }
  console.log(`declared-skip table clean across ${DECLARED_SKIPS.length} suite(s)`)
}

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  // A hard ceiling per suite: every suite bounds its own external calls, but
  // a hung fs-on-UNC or jsdom run must fail the aggregator, not hang it.
  // A killed run settles as a null status, which `?? 1` reports as FAIL.
  const run = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit', timeout: 300_000, killSignal: 'SIGKILL' })
  results.push({ suite, code: run.status ?? 1 })
}

console.log('\n=== summary ===')
// Exit code 2 is a suite's own SKIP (a check that could not run here, e.g.
// `verify-client-ui` without the harness checkout). It is shown, it is never a pass,
// and it is accepted ONLY from a suite DECLARED_SKIPS names together with the
// precondition that justifies it: an undeclared skip is a suite that never ran and
// nobody said so, which is the one thing this aggregate must not report green.
for (const { suite, code } of results) {
  if (code === 0) console.log(`  PASS  ${suite}`)
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
