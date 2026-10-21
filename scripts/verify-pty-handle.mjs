/**
 * Verify the terminal handle the WSL provider will hand to the harness.
 *
 * Runs the real `lib/wsl/pty.js` against a `local` subprocess adapter backed by
 * `node:child_process`, so the handle logic — control round trips, output
 * plumbing, signalling and termination — is exercised exactly as the provider
 * will run it, without needing the harness.
 *
 * Run: node scripts/verify-pty-handle.mjs [distro]
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnWslTerminal } from '../lib/wsl/pty.js'
import { planWsl, runWslShell } from '../lib/wsl/world.js'
import { shellQuote } from '../lib/wsl/paths.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { makeChecker } from './suite-shell.mjs'
// Still needed: the probe loop's catch reports `probe failed: ${detailText(error)}`. The
// suite-wide check() no longer renders detail itself (the factory owns that), but this
// one call site does, and losing this import would turn a reported probe failure into a
// ReferenceError on the very path that exists to report it.
import { detailText } from './detail.mjs'
import { blankLiterals } from './source-text.mjs'

const distro = resolveDistro(process.argv[2])
const here = dirname(fileURLToPath(import.meta.url))
const bridgeSource = await readFile(join(here, '..', 'lib', 'wsl', 'terminal-bridge.py'), 'utf8')

const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

/**
 * A minimal stand-in for the host subprocess provider, shaped like the seam.
 * @param {object} spec - argv, cwd, stdio.
 * @returns {object} a subprocess handle.
 */
function localAdapter(spec) {
  const stdio = [
    spec.stdio?.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio?.stdout === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio?.stderr === 'ignore' ? 'ignore' : 'pipe',
  ]
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio,
    windowsHide: true,
    ...spec.env !== undefined ? { env: { ...process.env, ...spec.env } } : {},
  })
  // The close outcome is REMEMBERED, for the same reason fifoAdapter below records
  // it: a process that has already exited must settle immediately, because a
  // re-armed 'close' listener never fires for a dead child. pty.js's terminate()
  // awaits the data handle's waitForExit(), so a bridge that died mid-suite used to
  // hang the teardown — and a suite that hangs reports no verdict at all.
  let settled = null
  const waiters = []
  const settle = (outcome) => {
    if (settled !== null) return
    settled = outcome
    for (const waiter of waiters.splice(0)) waiter()
  }
  child.on('close', (code, signal) => { settle({ exitCode: code, signal }) })
  child.on('error', () => { settle({ exitCode: null, signal: null }) })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done: settled !== null ? Promise.resolve(settled) : new Promise((resolve) => child.on('close', () => resolve(settled))),
    terminate: () => { child.kill() },
    waitForExit: () => settled !== null ? Promise.resolve(true) : new Promise((resolve) => waiters.push(() => resolve(true))),
  }
}

/** Wait until a predicate holds or the deadline passes. */
async function until(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * Wait until the PTY reports the process group the interrupt job announced.
 *
 * The state the interrupt needs is not elapsed time but ownership: signalForeground
 * signals whatever the PTY reports as its foreground group, and a group id is not proof
 * of life — a previous job's group stays recorded until the shell takes the terminal
 * back. The job's OWN announced group is the condition a stale group cannot satisfy.
 * @param {object} terminal - the terminal handle.
 * @param {number} jobPgrp - the group the job announced, 0 if it never did.
 * @param {number} ceilingMs - how long to keep asking.
 * @returns {Promise<{ owned: boolean, last: string|number }>} the outcome and last reading.
 */
async function ownsTerminal(terminal, jobPgrp, ceilingMs) {
  const deadline = Date.now() + ceilingMs
  let last = 'no reading'
  while (jobPgrp > 0 && Date.now() < deadline) {
    try {
      const seen = (await terminal.inspectForeground())?.processGroupId
      last = typeof seen === 'number' ? seen : 'no group'
      if (seen === jobPgrp) return { owned: true, last }
    } catch (error) {
      // A control round trip that failed is not an answer: the bridge can be busy, and
      // the terminal can still be handed over inside the ceiling.
      last = `probe failed: ${detailText(error)}`
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { owned: false, last }
}

const plan = planWsl(resolveLinuxHome(distro), distro)
console.log(`driving the terminal handle in ${distro}\n`)

const terminal = await spawnWslTerminal({
  local: { spawn: localAdapter },
  plan,
  bridgeSource,
  argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
  cols: 80,
  rows: 24,
  graceMs: 3000,
})

let output = ''
terminal.output.setEncoding('utf8')
terminal.output.on('data', (chunk) => { output += chunk })

check('the handle reports the session pid', typeof terminal.pid === 'number' && terminal.pid > 0, terminal.pid)

await terminal.write('echo MARK-$((6*7))\n')
check('a command runs through the handle', await until(() => output.includes('MARK-42')), JSON.stringify(output.slice(-200)))

await terminal.resize(120, 40)
await terminal.write('stty size\n')
check('resize reaches the PTY', await until(() => /\b40 120\b/.test(output)), JSON.stringify(output.slice(-160)))

const foreground = await terminal.inspectForeground()
check('foreground inspection returns a process group', typeof foreground?.processGroupId === 'number', foreground)

const activity = await terminal.inspectActivity()
check('activity inspection returns a known state', ['idle', 'busy', 'unknown'].includes(activity.state), activity)

// --- the interrupt: the job must own the terminal before it is signalled --------
//
// What used to sit between the write and the signal was `until(() => false, 1500)` — a
// fixed 1500 ms wait, not a condition. The transition it stood in for is the interactive
// shell reading the line, forking the job and calling tcsetpgrp, and under CPU contention
// each of those wakeups can take seconds. Measured (the run under 384 in-distribution
// busy loops plus 8 on the host, whose worst wakeup latency for a nominal 20 ms sleep was
// 1012 ms): one run failed here with the shell still holding the line 1.5 s after the
// write — readline echoed its ^C, discarded what it had consumed, and the shell ran
// `leep 60` ("command not found"), so ALIVE-25 never appeared. The signalling check
// PASSED in that same run, because the SIGINT had reached the SHELL's live group:
// `signalled > 0` cannot tell the job's group from the shell's.
//
// The wait is now the condition the signal actually needs — the PTY reporting the group
// the JOB announced — and the signalling check asserts the group it reached. A stale
// group left by an earlier job cannot satisfy the condition: it differs from the shell's
// group too, but it is not the job's, and killpg on it raises ESRCH — one of the two ways
// this op can answer 0 (measured: a dead foreground group is observable for < 2 ms
// unloaded, and the other way is a session leader that is gone, where the PTY reports no
// group at all and the bridge's own killpg(0) signals itself).
/** The process group the interrupt job announced on the PTY, or 0 before it has. */
function announcedPgrp() {
  const match = /JOBPGRP-(\d+)/.exec(output)
  return match === null ? 0 : Number(match[1])
}

await terminal.write("sh -c 'echo JOBPGRP-$$; exec sleep 60'\n")
const announced = await until(() => announcedPgrp() > 0, 30_000)
const jobPgrp = announcedPgrp()
const owned = await ownsTerminal(terminal, jobPgrp, 30_000)
check('the job owns the terminal before the interrupt',
  announced && owned.owned,
  `announced=${String(announced)} jobPgrp=${String(jobPgrp)} idlePgrp=${String(foreground?.processGroupId)} lastForeground=${String(owned.last)}`)
const signalled = await terminal.signalForeground('SIGINT')
// The row requires the group the JOB ANNOUNCED, so a job that never announced one
// cannot satisfy it. Without that half the row measured nothing: pty.js answers 0 when
// the bridge's reply carries no pgrp (a dead or absent foreground group, or a signal
// name its table rejects), and 0 is also what `announcedPgrp()` returns before the job
// has spoken — so `signalled === jobPgrp` read `0 === 0` and printed PASS. Measured
// through the production handle: signalForeground on a name the bridge does not carry
// returns 0, and the pair satisfies the unguarded form.
check('signalling returns the group the job announced',
  jobPgrp > 0 && signalled === jobPgrp, `signalled=${String(signalled)} jobPgrp=${String(jobPgrp)}`)
await terminal.write('echo ALIVE-$((5*5))\n')
check('the shell survives the interrupt', await until(() => output.includes('ALIVE-25')), JSON.stringify(output.slice(-200)))

// --- the pin: a TRIPWIRE against the idiom that was removed, not the property -----
//
// The fixed wait was removed because it was MEASURED to fail, and this pin is the ONLY
// guard against its return: with the fixed wait restored at this site and everything else
// kept (mutation M1, on an idle machine), every behavioural check above still PASSED — the
// ALIVE check included — so nothing else here backstops it.
//
// What it catches, exactly: two spellings inside the span from the job's write to the
// signal call — `until(() => false, <ms>)` and `setTimeout(` — read from this file's own
// text with comment and string bodies blanked, so a comment naming the idiom neither
// satisfies nor trips it.
//
// What it does NOT establish, stated because a pin that implies completeness is worse than
// one that admits its scope: this is a TRIPWIRE, not the property. A local `pause(1500)`
// helper, a busy-wait, an indirection (`until(() => neverTrue(), 1500)`), a re-anchored
// span (an extra `terminal.write('')` before the condition call, or `ownsTerminal(..., 1)`)
// all leave it green while the wait is a duration again. It is also spelling-bound: the
// span is delimited by two calls, so a rename has to move with it, and a poll gap inside
// ownsTerminal is deliberately not that idiom.
//
// What WOULD establish the property is the behavioural half above, and only under load:
// the signal reaches the job's own group BECAUSE the suite waited for that group, so
// `signalled === jobPgrp` reddens when the wait is a guess on a busy machine — and stays
// green on an idle one either way, which is exactly why M1 needs this tripwire. An editor
// who wants a real guard has to make the condition itself the assertion, not extend the
// regex.
{
  const blanked = blankLiterals(await readFile(fileURLToPath(import.meta.url), 'utf8'))
  const signalAt = blanked.indexOf('terminal.signalForeground(')
  const writeAt = signalAt > -1 ? blanked.lastIndexOf('terminal.write(', signalAt) : -1
  const site = writeAt > -1 && writeAt < signalAt ? blanked.slice(writeAt, signalAt) : ''
  const conditionInSite = site.includes('await ownsTerminal(')
  const timerInSite = /until\(\s*\(\s*\)\s*=>\s*false\s*,|setTimeout\(/.test(site)
  check('the interrupt waits on the job owning the terminal, and no timer stands in for it',
    site !== '' && conditionInSite && !timerInSite,
    `siteLength=${String(site.length)} condition=${String(conditionInSite)} timer=${String(timerInSite)}`)
}

// --- the plugin's own edge: a dimension the PTY cannot carry ---------------
//
// The harness terminal controller bounds dimensions before it ever calls this
// provider (Number.isSafeInteger plus its configured limits, at both create and
// resize), which is why the audit REJECTED the injection candidate: no
// lower-trust producer can supply an impossible dimension. A consumer's guard is
// not the plugin's guarantee, though, and it cannot cover the one path where a
// dimension is fatal before the bridge's dispatcher exists — the spawn path below
// — so the plugin bounds the value it frames.
//
// A row count of zero is the case the PTY can actually SHOW: the ioctl carries it
// (measured: `stty size` then reports `0 120`), so a plugin that forwarded it
// would move the terminal to a size no caller can have meant. An over-range value
// is deliberately NOT used here: the bridge's own backstop rejects it and the PTY
// keeps its size either way, so a check on it could not fail.
const beforeFloor = output.length
await terminal.resize(120, 0)
await terminal.write('stty size\n')
check('a dimension below the PTY floor is bounded, not forwarded',
  await until(() => /\b40 120\b/.test(output.slice(beforeFloor))), JSON.stringify(output.slice(beforeFloor).slice(-200)))

const beforeAccepted = output.length
await terminal.resize(100, 30)
await terminal.write('stty size\n')
check('a legitimate resize still reaches the PTY',
  await until(() => /\b30 100\b/.test(output.slice(beforeAccepted))), JSON.stringify(output.slice(beforeAccepted).slice(-200)))

await terminal.terminate()
const settled = await Promise.race([
  terminal.done.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
])
check('the session process settles after termination', settled === true)

// The bridge's own `terminate` reaps the child, so the pump loop's waitpid
// raises ChildProcessError — and a session that was killed must not report the
// clean-exit code. That carry-over is verified where the bridge's OWN status is
// observable (`verify-terminal.mjs`, which never kills the bridge); this handle
// races it, so what this asserts is the outcome of that race.
const outcome = await terminal.done
// Printed on every run, because either side can win it: the bridge answers the
// terminate and then exits with its own status, while the handle kills the
// bridge process right after that answer. Either the killed bridge (no code) or
// the bridge's own 128+signal may land here — a clean 0 may not.
console.log(`        terminated outcome: exitCode=${String(outcome.exitCode)} signal=${String(outcome.signal)}`)
check('termination leaves the bridge signalled, not exited cleanly',
  outcome.exitCode === null || outcome.exitCode > 128, `exitCode=${String(outcome.exitCode)}`)

// --- the spawn path: the dimension framed before the dispatcher exists ------
//
// `main()` hands argv[2]/argv[3] straight to the FIRST resize, which runs inside
// `Bridge.__init__` — before `run()` can read a single control line, so a
// dimension the ioctl cannot carry there is fatal with no guard able to answer
// it — and it is fatal AFTER the bridge has already announced the session, so the
// allocation still returns a handle and the failure only shows up as a terminal
// that never answers. That is what makes the spawn path the one the plugin MUST
// bound itself.
let bounded = null
let boundedFailure = null
try {
  bounded = await spawnWslTerminal({
    local: { spawn: localAdapter },
    plan,
    bridgeSource,
    argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
    cols: 70_000,
    rows: 0,
    graceMs: 3000,
  })
} catch (error) {
  boundedFailure = error
}
let boundedOutput = ''
if (bounded !== null) {
  bounded.output.setEncoding('utf8')
  bounded.output.on('data', (chunk) => { boundedOutput += chunk })
  await bounded.write('stty size\n')
}
// The size the shell reports IS the evidence, and the two checks are one claim:
// pre-fix the bridge exited inside Bridge.__init__ — AFTER it had announced the
// session, which is why the allocation still returned a handle and why the
// failure is not the allocation throwing but the answer never coming.
const boundedAnswered = await until(() => /\b24 80\b/.test(boundedOutput))
const boundedOutcome = !boundedAnswered && bounded !== null
  ? await Promise.race([bounded.done, new Promise((resolve) => setTimeout(() => resolve('still running'), 2000))])
  : undefined
check('an allocation whose dimensions the PTY cannot carry falls back to 80x24',
  boundedAnswered, boundedFailure ?? `output=${JSON.stringify(boundedOutput.slice(-200))} done=${JSON.stringify(boundedOutcome)}`)
if (bounded !== null) {
  // Bounded: a session that cannot be reached (the pre-fix state) must fail this
  // suite, not leave it waiting on a process the bridge no longer answers.
  await Promise.race([bounded.terminate(), new Promise((resolve) => setTimeout(() => resolve(false), 8000))])
}

// --- the control FIFO, and the teardown paths that must not leave one behind ----
//
// Finding 7. terminal-bridge.py unlinks /tmp/dsh-pty-<uuid>.fifo in its `finally`,
// which does NOT run when the bridge is killed — and the host kills it on teardown:
// terminate() calls data.terminate() right after the bridge's own terminate reply,
// racing that clean exit. The name carries a fresh uuid per allocation, so nothing
// else ever removes the orphan. A host-side `rm -f` on every path that ends a session
// is the only cleanup that survives a SIGKILL, and it is what these rows measure.
//
// Scenario A reproduces the SIGKILL shape deterministically (the data process is
// hard-killed while the session is live, so the bridge's finally cannot run), scenario
// B is the ordinary close, and scenario C is an allocation that fails AFTER the bridge
// announced the session — the shape every post-announce failure takes.
const fifoChildren = []
/**
 * The subprocess adapter this section uses: the suite's own shape, plus a record of
 * every child it started and the SIGKILL the first scenario needs. The close outcome
 * is REMEMBERED, because a process that has already exited must settle immediately —
 * the suite's adapter re-arms a 'close' listener, which never fires for a dead child.
 * @param {object} spec - argv, cwd, stdio.
 * @returns {object} a subprocess handle.
 */
function fifoAdapter(spec) {
  const stdio = [
    spec.stdio?.stdin === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio?.stdout === 'ignore' ? 'ignore' : 'pipe',
    spec.stdio?.stderr === 'ignore' ? 'ignore' : 'pipe',
  ]
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    stdio,
    windowsHide: true,
    ...spec.env !== undefined ? { env: { ...process.env, ...spec.env } } : {},
  })
  fifoChildren.push({ child, argv: spec.argv, stderr: '' })
  const record = fifoChildren[fifoChildren.length - 1]
  child.stderr?.on('data', (chunk) => { record.stderr += String(chunk) })
  let settled = null
  const waiters = []
  const settle = (outcome) => {
    if (settled !== null) return
    settled = outcome
    for (const waiter of waiters.splice(0)) waiter()
  }
  child.on('close', (code, signal) => { settle({ exitCode: code, signal }) })
  child.on('error', () => { settle({ exitCode: null, signal: null }) })
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done: settled !== null ? Promise.resolve(settled) : new Promise((resolve) => child.on('close', () => resolve(settled))),
    terminate: () => { child.kill() },
    waitForExit: () => settled !== null ? Promise.resolve(true) : new Promise((resolve) => waiters.push(() => resolve(true))),
  }
}
/** Every /tmp/dsh-pty-*.fifo currently inside the distribution. */
async function fifos() {
  const result = await runWslShell({ distro, linuxCwd: '/', command: 'ls /tmp/dsh-pty-*.fifo 2>/dev/null; echo END', loginShell: false, timeoutMs: 60_000 })
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/tmp/dsh-pty-'))
}
// The suite's own `until` takes a synchronous predicate; these rows ask the
// distribution, so the poll has to await.
/** Poll until an async predicate holds or the ceiling passes. */
async function untilAsync(predicate, ceilingMs) {
  const deadline = Date.now() + ceilingMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return await predicate()
}
/**
 * Whether one set of recorded children carries the bridge's announcement of its session.
 * @param {{stderr: string}[]} records - the recorded children.
 * @returns {boolean} whether one of them announced.
 */
const announcedBy = (records) => records.some((entry) => entry.stderr.includes('"event": "started"') || entry.stderr.includes('"event":"started"'))
/**
 * The children an allocation started, from a spawn count taken before it.
 *
 * The guard below has to be scoped this way: `fifoChildren` accumulates every child the
 * SECTION spawned, and by the time scenario C runs, scenarios A and B have each announced
 * on stderr — so a search over the whole list is satisfied by their records whatever C's
 * own bridge did, and the row it guards ("a FAILED allocation leaves no FIFO behind")
 * could pass while the FIFO never existed. The old row measured exactly that.
 * @param {{stderr: string}[]} records - every recorded child.
 * @param {number} base - the record count taken before this allocation.
 * @returns {{stderr: string}[]} this allocation's records.
 */
const spawnsSince = (records, base) => records.slice(base)
/** Allocate one terminal on a fresh interactive shell, through the recording adapter. */
function allocateFifoTerminal(spawnImpl = fifoAdapter) {
  return spawnWslTerminal({
    local: { spawn: spawnImpl },
    plan,
    bridgeSource,
    argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
    cols: 80,
    rows: 24,
    graceMs: 500,
    controlTimeoutMs: 30_000,
  })
}
console.log('\nscenario A: the data process is KILLED (the bridge finally cannot run)')
const fifoBaseline = await fifos()
const terminalA = await allocateFifoTerminal()
// THIS SESSION'S OWN name, not "exactly one new name". A delta of one is only true when nothing
// else on the machine is allocating at the same time: a second run of this suite overlaps, its
// live FIFO lands in the delta, and both rows used to redden with `live.length === 2` while this
// session's own FIFO was perfectly healthy (measured — two concurrent runs reproduce it, one run
// alone does not). The name carries this process's pid and the session's own uuid
// (`/tmp/dsh-pty-<pid>-<uuid>.fifo`, lib/wsl/pty.js), so the honest selection is "the new name
// whose pid is MINE", and the rows below assert on THAT name. Anything else new is reported, not
// treated as this session's.
const newFifosA = (await fifos()).filter((path) => fifoBaseline.includes(path) === false)
const ownFifo = (path) => path.includes(`-${process.pid}-`)
const fifoLiveA = newFifosA.filter(ownFifo).slice(0, 1)
check('the live session created its FIFO (so the row below cannot pass vacuously)',
  fifoLiveA.length === 1, { live: fifoLiveA, newSinceBaseline: newFifosA, baseline: fifoBaseline, ownPid: process.pid })
const dataChild = fifoChildren.find((entry) => entry.argv.some((arg) => arg === 'python3'))
check('the data process is a python3 bridge',
  dataChild !== undefined, { spawns: fifoChildren.map((entry) => entry.argv[0] + ' ' + entry.argv[1]) })
if (dataChild !== undefined) dataChild.child.kill('SIGKILL')
await Promise.race([terminalA.done, new Promise((resolve) => setTimeout(resolve, 20_000))])
const fifoGoneA = await untilAsync(async () => (await fifos()).includes(fifoLiveA[0] ?? '/nonexistent') === false, 15_000)
check('after a KILLED bridge the session FIFO is gone',
  fifoLiveA.length === 1 && fifoGoneA === true,
  { fifo: fifoLiveA[0], stillThere: (await fifos()).filter((path) => fifoLiveA.includes(path)) })
try { await terminalA.terminate() } catch { /* the session is already over */ }

console.log('scenario B: the ordinary close')
const fifoBeforeB = await fifos()
const terminalB = await allocateFifoTerminal()
// Same selection as scenario A, for the same measured reason: pick the name that carries THIS
// process's pid, so a concurrent run's FIFO cannot make the delta look wrong.
const newFifosB = (await fifos()).filter((path) => fifoBeforeB.includes(path) === false)
const fifoLiveB = newFifosB.filter(ownFifo).slice(0, 1)
check('the second session created its FIFO (so the row below cannot pass vacuously)',
  fifoLiveB.length === 1, { live: fifoLiveB, newSinceBaseline: newFifosB, ownPid: process.pid })
await Promise.race([terminalB.terminate(), new Promise((resolve) => setTimeout(resolve, 20_000))])
const fifoGoneB = await untilAsync(async () => (await fifos()).includes(fifoLiveB[0] ?? '/nonexistent') === false, 15_000)
check('after terminate() the session FIFO is gone',
  fifoLiveB.length === 1 && fifoGoneB === true,
  { fifo: fifoLiveB[0], stillThere: (await fifos()).filter((path) => fifoLiveB.includes(path)) })

console.log('scenario C: the allocation fails AFTER the bridge made its FIFO')
// The control writer is the second spawn; making it throw exercises the failed-
// allocation path with a LIVE bridge, which that path's own teardown then kills.
const fifoBeforeC = await fifos()
const injected = []
let terminalC = null
let failureC = null
/** Where scenario C's own children start in the section-wide record. */
const spawnsBeforeC = fifoChildren.length
try {
  terminalC = await allocateFifoTerminal((spec) => {
    if (spec.argv.some((arg) => String(arg).includes('exec 3>'))) {
      injected.push(spec.argv)
      throw new Error('the control writer could not be started (injected)')
    }
    return fifoAdapter(spec)
  })
} catch (error) {
  failureC = error instanceof Error ? error.message : String(error)
}
const controlSpawn = injected[0]
const fifoC = controlSpawn === undefined ? null : controlSpawn[controlSpawn.length - 1]
check('the failed allocation is reported as a failure', failureC !== null, { failureC })
check('the control spawn was attempted with the session FIFO as its argument',
  fifoC !== null && fifoC.startsWith('/tmp/dsh-pty-'), { fifoC })
// json.dumps writes {"event": "started", ...} with a space after the colon. Read from
// C's OWN children: the whole-section search this row used to make is satisfied by A and
// B, which have already announced, so it could not fail and certified nothing. The
// whole-section value is kept in the evidence, to show what the old form would have said.
const cSpawns = spawnsSince(fifoChildren, spawnsBeforeC)
const announcedC = announcedBy(cSpawns)
check('the bridge C started announced the session, so that FIFO existed (read from C\'s own children, not from A and B)',
  announcedC === true, { scoped: announcedC, wholeSection: announcedBy(fifoChildren), spawns: cSpawns.length })
// The scoping rule itself, on records built here, so it is pinned without a distribution:
// the row above has to be false when the ONLY silent record is this allocation's own.
{
  const records = [
    { stderr: '{"event": "started", "pid": 1}' },
    { stderr: '{"event": "started", "pid": 2}' },
    { stderr: 'the bridge said nothing' },
  ]
  check('the announcement is read from this allocation\'s children (the whole-section read is satisfied by A and B)',
    announcedBy(spawnsSince(records, 2)) === false && announcedBy(spawnsSince(records, 0)) === true,
    { scoped: announcedBy(spawnsSince(records, 2)), wholeSection: announcedBy(spawnsSince(records, 0)) })
}
const fifoGoneC = await untilAsync(async () => (await fifos()).includes(fifoC ?? '/nonexistent') === false, 15_000)
check('a FAILED allocation leaves no FIFO behind',
  fifoC !== null && fifoGoneC === true,
  { fifo: fifoC, stillThere: (await fifos()).filter((path) => path === fifoC), before: fifoBeforeC })
if (terminalC !== null) { try { await terminalC.terminate() } catch { /* already gone */ } }

// --- scenario D: an orphan from a PREVIOUS host generation -------------------------
//
// A host restart is not a teardown: the session's bridge dies with the host, so its own
// `finally` (terminal-bridge.py) never runs and nobody calls removeFifo. Measured on this
// machine after a restart: two 0-byte /tmp/dsh-pty-*.fifo files, ONE PER PROBE RUN, still
// held open by that generation's bridges (reparented to /init, alive an hour later).
//
// The sweep's rule is a GENERATION rule, and this scenario pins all four of its branches
// because three of them are refusals — a sweep that removed everything would satisfy the
// orphan row alone, and a sweep that removed nothing would satisfy the refusals alone:
//
//   · a LEGACY name (no pid, written by a version that recorded no generation) that is OLD
//     is removed, and a legacy name that is YOUNG is kept — age is the only protection a name
//     with no owner field can have, and the young one stands for the window between a
//     bridge's mkfifo and the control writer's open;
//   · a name whose OWNER PID IS DEAD is removed — that is the previous-generation orphan, and
//     its owner's liveness is the fact that condemns it;
//   · a name whose owner pid is ALIVE (here: a real helper process) is kept — a previous
//     generation's bridges are alive too, so nothing about "a live process holds this" may
//     be read as evidence either way;
//   · a LIVE session of THIS generation, whose FIFO has been backdated past any age
//     threshold, is kept. This is the row the age rule could not pass: a FIFO's mtime never
//     advances after mkfifo, so "older than two minutes" is the NORMAL state of a long-lived
//     session, and an age-keyed sweep unlinks live sessions' names.
//
// The fixtures are MADE, not waited for, so every input is a fact of the run rather than of
// whatever the operator's distribution happened to hold. Each name carries this process's pid:
// a FIXED name under /tmp is one a concurrent run of this suite would delete out from under
// this one (`verify-all-skip.mjs` section H polices exactly that), and the LEGACY ones stay
// legacy by keeping a word where the generation field would be.
const ORPHAN_LEGACY = `/tmp/dsh-pty-legacy-previous-${String(process.pid)}.fifo`
const FRESH_LEGACY = `/tmp/dsh-pty-legacy-just-created-${String(process.pid)}.fifo`
// A pid that is really dead: this suite's own child, reaped. Reuse is possible in principle,
// so the pid is CHECKED before it is used — a fixture whose owner is alive would invert the
// meaning of the row it feeds.
function reapedPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
  return new Promise((resolve) => child.on('close', () => resolve(child.pid)))
}
/**
 * Whether a host pid is alive, by the same signal-0 probe pty.js uses.
 * @param {number} pid - candidate pid.
 * @returns {boolean} whether it is running.
 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}
const deadPid = await reapedPid()
const deadOwnerName = `/tmp/dsh-pty-${String(deadPid)}-deadbeef0001.fifo`
// A LIVE foreign owner: a helper that outlives the sweep. Its name must survive.
const liveOwner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true })
const liveOwnerName = `/tmp/dsh-pty-${String(liveOwner.pid)}-cafebabe0002.fifo`
const fixturesD = [ORPHAN_LEGACY, FRESH_LEGACY, deadOwnerName, liveOwnerName]
const fixturePresent = (entries, name) => entries.includes(name)
const orphansBefore = await fifos()
check('no fixture of this scenario survives from an earlier run of it (every row below would pass vacuously)',
  fixturesD.every((name) => !fixturePresent(orphansBefore, name)) && pidAlive(deadPid) === false,
  { present: orphansBefore.filter((name) => fixturesD.includes(name)), deadPid, deadAlive: pidAlive(deadPid) })
await runWslShell({ distro, linuxCwd: '/', command: `rm -f ${fixturesD.map((name) => shellQuote(name)).join(' ')}`, loginShell: false, timeoutMs: 30_000 })
// The session whose FIFO is backdated: allocated FIRST, so its bridge makes the name, and
// only then is the mtime moved into the past. `touch -m -t` is what makes the input exact
// instead of a two-minute sleep.
const terminalD = await allocateFifoTerminal()
const fifoLiveD = (await fifos()).filter((path) => !orphansBefore.includes(path))
const liveSessionFifo = fifoLiveD.find((path) => path.startsWith(`/tmp/dsh-pty-${String(process.pid)}-`))
await runWslShell({ distro, linuxCwd: '/', command: `mkfifo ${shellQuote(ORPHAN_LEGACY)} ${shellQuote(FRESH_LEGACY)} ${shellQuote(deadOwnerName)} ${shellQuote(liveOwnerName)} && touch -m -t 202401010000 ${shellQuote(ORPHAN_LEGACY)} ${shellQuote(deadOwnerName)} && touch -m -t 202401010000 ${shellQuote(liveSessionFifo ?? '/nonexistent')}`, loginShell: false, timeoutMs: 30_000 })
const madeAll = await fifos()
check('every scenario-D fixture exists before the next allocation, including a LIVE session backdated past any age threshold',
  fixturesD.every((name) => fixturePresent(madeAll, name)) && liveSessionFifo !== undefined && fixturePresent(madeAll, liveSessionFifo),
  { fixtures: madeAll.filter((name) => fixturesD.includes(name)), liveSessionFifo, livePresent: fixturePresent(madeAll, liveSessionFifo ?? '') })
const terminalE = await allocateFifoTerminal()
const afterSweep = await fifos()
check('allocating a session sweeps the LEGACY FIFO a previous host generation left behind',
  fixturePresent(madeAll, ORPHAN_LEGACY) && !fixturePresent(afterSweep, ORPHAN_LEGACY),
  { orphan: ORPHAN_LEGACY, swept: !fixturePresent(afterSweep, ORPHAN_LEGACY) })
check('allocating a session sweeps a FIFO whose OWNER PID is dead',
  fixturePresent(madeAll, deadOwnerName) && !fixturePresent(afterSweep, deadOwnerName),
  { orphan: deadOwnerName, swept: !fixturePresent(afterSweep, deadOwnerName) })
// The three refusals. Each stands for a case the removal side above cannot distinguish.
check('the sweep leaves a LEGACY name younger than the creation window alone',
  fixturePresent(madeAll, FRESH_LEGACY) && fixturePresent(afterSweep, FRESH_LEGACY),
  { fresh: FRESH_LEGACY, kept: fixturePresent(afterSweep, FRESH_LEGACY) })
check('the sweep leaves a name whose OWNER PID is alive alone',
  fixturePresent(madeAll, liveOwnerName) && fixturePresent(afterSweep, liveOwnerName),
  { name: liveOwnerName, kept: fixturePresent(afterSweep, liveOwnerName), ownerAlive: pidAlive(liveOwner.pid) })
// The R31 row: a live session of THIS generation, older than any age rule would tolerate.
check('a LIVE session’s FIFO older than any age threshold is not swept',
  liveSessionFifo !== undefined && fixturePresent(madeAll, liveSessionFifo) && fixturePresent(afterSweep, liveSessionFifo),
  { fifo: liveSessionFifo, present: fixturePresent(afterSweep, liveSessionFifo ?? ''), ageNote: 'mtime backdated to 2024-01-01, as an old live session’s mtime really is' })
try { await terminalE.terminate() } catch { /* already over */ }
try { await terminalD.terminate() } catch { /* already over */ }
try { liveOwner.kill() } catch { /* already gone */ }

// --- the sweep is CANCELLED with the allocation (blocker 3 of the Task 2 review) ------
//
// The sweep is AWAITED before the spawn, and it used to make 1–2 bound (10 s) wsl.exe calls
// with no way to interrupt them: an allocation whose signal aborted during that window still
// waited out the sweep. The pin is behavioural and allocation-level, because that is where the
// cost is paid: with an ALREADY-ABORTED signal, a real previous-generation orphan must survive
// the allocation. Pre-fix the sweep ran regardless of the signal and deleted it.
const CANCEL_ORPHAN = `/tmp/dsh-pty-legacy-cancelled-${String(process.pid)}.fifo`
await runWslShell({ distro, linuxCwd: '/', command: `rm -f ${shellQuote(CANCEL_ORPHAN)} && mkfifo ${shellQuote(CANCEL_ORPHAN)} && touch -m -t 202401010000 ${shellQuote(CANCEL_ORPHAN)}`, loginShell: false, timeoutMs: 30_000 })
const cancelPresent = (await fifos()).includes(CANCEL_ORPHAN)
const preAborted = new AbortController()
preAborted.abort()
let cancelledHandle = null
let cancelledFailure = null
try {
  cancelledHandle = await Promise.race([
    spawnWslTerminal({
      local: { spawn: fifoAdapter },
      plan,
      bridgeSource,
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      cols: 80,
      rows: 24,
      graceMs: 500,
      controlTimeoutMs: 5_000,
      signal: preAborted.signal,
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 60_000)),
  ])
} catch (error) {
  cancelledFailure = error instanceof Error ? error.message : String(error)
}
const cancelSurvived = (await fifos()).includes(CANCEL_ORPHAN)
check('a cancelled allocation does not sweep (the sweep is handed the allocation’s own signal)',
  cancelPresent && cancelSurvived,
  { orphan: CANCEL_ORPHAN, presentBefore: cancelPresent, survived: cancelSurvived, failure: cancelledFailure, allocated: cancelledHandle !== null })
if (cancelledHandle !== null) { try { await cancelledHandle.terminate() } catch { /* already over */ } }
await runWslShell({ distro, linuxCwd: '/', command: `rm -f ${shellQuote(CANCEL_ORPHAN)}`, loginShell: false, timeoutMs: 30_000 })

// --- the sweep's AGE DECISION lives in the distribution's clock (ruling R37) -----------
//
// The defect this replaces was a CROSS-CLOCK comparison: the distro's mtimes came back as
// `%T@` and were subtracted from the HOST's `Date.now()`. A distribution whose clock lags the
// host by more than the legacy window then made a name that was still inside its own
// mkfifo→open creation window look old, and the sweep removed it.
//
// It cannot be pinned with a FIXTURE, and this row is structured the way it is because of
// that: every fixture below sets its timestamp with `touch -t`, which fixes the mtime no
// matter what either clock says, so no arrangement of fixtures makes the two clocks disagree.
// A skew is the whole trigger, and a test cannot create one without setting the distro clock
// (which needs privileges this suite must not want). What IS observable is the shape that
// removes the class of bug: the age question is asked and answered inside ONE command, in the
// distro's own clock domain. So this row reads the sweep's COMMAND TEXT.
//
// Comments are stripped, string bodies KEPT — the inverse of `blankLiterals`, whose blanking
// would erase exactly the tokens under test. The file carries `-printf` and `Date.now` inside
// the doc comment that explains their removal, and a raw read would be satisfied by prose.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
{
  const ptySource = withoutComments(await readFile(join(here, '..', 'lib', 'wsl', 'pty.js'), 'utf8'))
  const sweepStart = ptySource.indexOf('export async function sweepOrphanFifos')
  const sweepEnd = ptySource.indexOf('export async function spawnWslTerminal')
  const sweepBody = sweepStart > -1 && sweepEnd > sweepStart ? ptySource.slice(sweepStart, sweepEnd) : ''
  check('the sweep asks the distribution whether a legacy name is old, instead of comparing its mtime to this host’s clock',
    sweepBody !== ''
    && /-mmin \+/.test(sweepBody)
    // `\b` matters: `-printf` CONTAINS the substring `-print`, so a plain `/-print/` would be
    // satisfied by the very predicate the next arm refuses.
    && /-print\b/.test(sweepBody)
    // A GNU-only predicate is not merely unportable: with stderr discarded its refusal is
    // SILENT, so the sweep collects nothing and a busybox `find` reads as a clean distro.
    && !/-printf/.test(sweepBody)
    && !/%T@/.test(sweepBody)
    // The host's clock must not appear in the sweep at all: any use of it here is the other
    // half of a two-clock comparison.
    && !/Date\.now/.test(sweepBody)
    && !/new Date\(/.test(sweepBody),
    {
      mmin: /-mmin \+/.test(sweepBody),
      print: /-print\b/.test(sweepBody),
      gnuPrintf: /-printf/.test(sweepBody),
      mtimeToken: /%T@/.test(sweepBody),
      hostClock: /Date\.now|new Date\(/.test(sweepBody),
      length: sweepBody.length,
    })
}

// --- the live set is registered after the probe that can refuse the allocation (R39) ----
//
// `liveFifoNames.add(fifo)` used to stand BEFORE `await requireBridgeRuntime(...)`, so a probe
// that threw (no python3, or a probe that could not run at all) left a permanent entry for a
// FIFO that was never created — and no `cleanupFifo()` ever exists to remove it, because no
// session did. The set is module-private, so the ORDER is what a suite can observe.
{
  const ptySource = withoutComments(await readFile(join(here, '..', 'lib', 'wsl', 'pty.js'), 'utf8'))
  const allocateStart = ptySource.indexOf('export async function spawnWslTerminal')
  const allocateBody = allocateStart > -1 ? ptySource.slice(allocateStart) : ''
  const probeAt = allocateBody.indexOf('await requireBridgeRuntime(')
  const sweepAt = allocateBody.indexOf('await sweepOrphanFifos(')
  // The registration is the CLAIM, which owns both halves of the live state (membership and the
  // registration time the age bound reads). Asking for `liveFifoNames.add(` here would now be
  // satisfied by nothing — the claim helper is the only writer, deliberately, so the two pieces
  // of state cannot drift apart. The property is unchanged: the claim is taken after the probe
  // and the sweep that can refuse or reclassify this name.
  const addAt = allocateBody.indexOf('claimFifoName(fifo)')
  check('the session name joins the live set only after the probe and the sweep that can refuse or reclassify it',
    allocateBody !== '' && probeAt > -1 && sweepAt > probeAt && addAt > sweepAt,
    { probeAt, sweepAt, addAt })
  // The two writers of the live state must be the claim helper and its release — a stray
  // `liveFifoNames.add(`/`.delete(` anywhere ELSE is how the membership and its timestamp drift
  // apart, which reads as "expired" for a live session (the unsafe direction). Scoped to the
  // allocate body on purpose: the helper itself lives above it, and counting its own three writes
  // would redden this row for the code that makes the pairing correct in the first place.
  const liveWritesInAllocate = (allocateBody.match(/liveFifoNames\.(?:add|delete)\(/g) ?? []).length
  check('membership and its age are written only through the claim helper, so they cannot drift apart',
    liveWritesInAllocate === 0,
    { liveWritesInAllocate, note: 'every write belongs to claimFifoName / its release, which own both maps' })
}

// --- scenario E: the read point the live gate uses (root cause A of the 2026-10-19 red row) ---
//
// THE LIVE GATE READ OF THE SESSION'S OWN FIFO WAS TAKEN AT THE WRONG MOMENT. Measured on the
// 17:23 run: `bridgesAfter` was `["64751"]` and `fifosAfter` held
// `/tmp/dsh-pty-45580-dbab20de-63d.fifo` — read immediately after the selftest returned, while the
// session's own teardown was still in flight. That read point can NEVER be green for a session
// this run created, so the row was structurally unable to pass: it reported a leak that was a
// timing artefact. What the row must read instead is the moment the session is KNOWN to be torn
// down, and the DELTA must still be zero there. This scenario pins the distinction the suite has
// to respect, with the production handle and no polling:
//
//   read the instant `terminate()` settles → the FIFO must already be gone, with NO grace;
//   read the instant `done` settles after a killed bridge → same.
//
// A row that has to POLL to see the FIFO go away is a row that would pass a leak that never
// fully clears; `terminate()` is the promise the harness awaits (`terminal-bash/src/session.ts:781`
// in `closeOnce`), so by its settlement the session's own cleanup has to be finished, not started.
console.log('\nscenario E: the read point the live gate uses (a torn-down session reads zero, with no grace)')
{
  // E1: the ordinary close. `terminate()` is awaited and the FIFO is read with NO `untilAsync`.
  const beforeE1 = await fifos()
  const terminalE1 = await allocateFifoTerminal()
  // Same selection rule as A, B, E2 and F (measured: a concurrent run's live FIFO lands in a plain
  // delta and reddens this row while this session's own FIFO is healthy). Pick the new name that
  // carries THIS process's pid.
  const newFifosE1 = (await fifos()).filter((path) => !beforeE1.includes(path))
  const liveE1 = newFifosE1.filter(ownFifo).slice(0, 1)
  check('E1: the session created its FIFO (so the row below cannot pass vacuously)',
    liveE1.length === 1, { live: liveE1, newSinceBaseline: newFifosE1, baseline: beforeE1, ownPid: process.pid })
  await Promise.race([terminalE1.terminate(), new Promise((resolve) => setTimeout(() => resolve(null), 20_000))])
  const instantE1 = await fifos()
  const stillE1 = liveE1.filter((path) => instantE1.includes(path))
  check('E1: the FIFO of a torn-down session is gone the instant terminate() settles (no polling)',
    liveE1.length === 1 && stillE1.length === 0,
    {
      fifo: liveE1,
      stillThere: stillE1,
      note: 'the live reclaim row reads here. A FIFO that needs a poll to disappear is the residue this row exists to refuse',
    })
  const afterGraceE1 = await untilAsync(async () => (await fifos()).every((path) => !liveE1.includes(path)), 10_000)
  check('E1: and it does not come back later (the instant read was removal, not a race that lost)',
    afterGraceE1 === true, { stillThere: (await fifos()).filter((path) => liveE1.includes(path)) })

  // E2 was written first as "the FIFO is gone the instant `done` settles", and MEASURED as RACY:
  // 0/5 red in a standalone driver (archived as artifacts/t3fix4-done-race-rerun.txt, EXIT=0 — a
  // later re-run; the ORIGINAL run was never archived, and this comment says so rather than
  // implying evidence it does not have), and in this suite one run red and the next green with no
  // code change between them. That one-red-one-green pair WAS written to %TEMP%\t3fix3\ (green3.txt
  // is red on exactly the row later retracted, alongside redB-2.txt and green4.txt), but it was
  // never COPIED INTO artifacts/ and none of those files carries a captured exit code, so it is a
  // logged observation with no archived run behind it — not evidence this suite can cite. It is
  // recorded here because it is why the row went. It is NOT kept, because a
  // row whose verdict depends on which side of a race the cleanup lands on is worse than a red row
  // — it reports a leak on some runs and certifies the same code on others. What replaces it is the
  // claim that is actually TRUE and actually load-bearing:
  //
  //   · the `data.done` handlers cannot await (they are `.then` callbacks nobody settles), so the
  //     removal they start is a BACKSTOP, not an owner. It must still finish.
  //   · the session has a SECOND owner for the ordinary-close case, and it is not this suite's
  //     host-side removal: the bridge's own `finally` (terminal-bridge.py) unlinks the FIFO. So
  //     on the ordinary-close path the host-side `rm -f` is a backstop as well.
  //
  // WHAT E1 PROVES, AND WHAT IT DOES NOT (R62). E1 is an honest behavioural row: a session closed
  // through `terminate()` has no FIFO left AT THE INSTANT IT SETTLES. It is NOT a discriminating
  // pin for the `terminate()` await, and the earlier version of this comment claimed it was
  // ("if that await is dropped … E1 reddens deterministically (that is its red variant)"). That
  // claim was measured and is FALSE:
  //   · deleting the `await cleanupFifo()` from `terminate()` left the whole suite GREEN, 47 PASS,
  //     EXIT=0 (`artifacts/t3fix3-red-E1.txt`), and the saved mutant was byte-identical to the
  //     then-HEAD `c7f75c0` (`ABC001F4…` = `c7f75c0:lib/wsl/pty.js`), so that archive proves the
  //     GREEN, not the mutation. That digest describes `c7f75c0`'s file, and it must not be
  //     described with the word "HEAD", which moves: the blob was `5B821CAB…` from `aa0ad6d` until
  //     `3f561bf`, whose comment-only edit left the committed blob at `572EE75A…` (56855 B).
  //     The same class of error was reintroduced once already by the round that fixed debt 1, so
  //     every digest here is named with the commit it belonged to;
  //   · neutralising `cleanupFifo` entirely also left E1 green; what reddened was scenario A,
  //     scenario C's failed-allocation row and E2 (`artifacts/t3fix3-red-E1-noremoval.txt`, EXIT=1)
  //     — the killed-bridge paths, where the bridge's finally cannot run.
  // The reason is above: on the ordinary-close path the bridge's own `finally` removes the name,
  // so E1 cannot observe whether the host-side removal ran, or whether it was awaited. NO
  // DISCRIMINATING MUTATION FOR THAT AWAIT HAS BEEN FOUND, and none is implied here: making the
  // bridge's finally and the host-side removal both no-ops would redden E1, but that mutation
  // removes both owners at once and therefore proves nothing about the `terminate()` await
  // specifically. What actually pins the host-side removal's behaviour is scenario G below
  // (a removal that does not land must be reported, and must not fail the teardown); what pins
  // the fire-and-forget the WARNING was about is E2, on the path where no other owner exists.
  const beforeE2 = await fifos()
  const recordsBeforeE2 = fifoChildren.length
  const terminalE2 = await allocateFifoTerminal()
  // Same selection rule as A, B and F (measured: a concurrent run's live FIFO lands in a plain
  // delta and reddens this row while this session's own FIFO is healthy). Pick the new name that
  // carries THIS process's pid.
  const newFifosE2 = (await fifos()).filter((path) => !beforeE2.includes(path))
  const liveE2 = newFifosE2.filter(ownFifo).slice(0, 1)
  check('E2: the killed-bridge session created its FIFO (so the row below cannot pass vacuously)',
    liveE2.length === 1, { live: liveE2, newSinceBaseline: newFifosE2, baseline: beforeE2, ownPid: process.pid })
  const killerE2 = fifoChildren.slice(recordsBeforeE2).find((entry) => entry.argv.some((arg) => arg === 'python3'))
  check('E2: the data process is the python3 bridge', killerE2 !== undefined,
    { spawns: fifoChildren.slice(recordsBeforeE2).map((entry) => entry.argv[0] + ' ' + entry.argv[1]) })
  if (killerE2 !== undefined) killerE2.child.kill('SIGKILL')
  await Promise.race([terminalE2.done, new Promise((resolve) => setTimeout(() => resolve(null), 20_000))])
  // The backstop is ALLOWED to be late here — that is the honest shape of a fire-and-forget path.
  // What it may not be is absent.
  const backstopE2 = await untilAsync(async () => (await fifos()).every((path) => !liveE2.includes(path)), 15_000)
  check('E2: the `done` handler’s backstop still settles a killed bridge’s FIFO (it is late by construction, never absent)',
    liveE2.length === 1 && backstopE2 === true,
    {
      fifo: liveE2,
      stillThere: (await fifos()).filter((path) => liveE2.includes(path)),
      note: 'the handler cannot await, so this removal is a backstop; terminate() owns the prompt removal (E1). If this row reddens the backstop is gone and a session nobody terminates leaks',
    })
  try { await terminalE2.terminate() } catch { /* the session is already over */ }
  for (const path of [...liveE1, ...liveE2]) {
    await runWslShell({ distro, linuxCwd: '/', command: 'rm -f ' + shellQuote(path), loginShell: false, timeoutMs: 30_000 })
  }
}

// --- scenario F: the uncollectable name must be able to recover (root cause C, ruling R58) ----
//
// Root cause B leaks a FIFO. Before this scenario existed, that leak was PERMANENT in a way
// nothing could repair: the name stayed in `liveFifoNames` because only `cleanupFifo().finally`
// ever removed it, and the sweep's branch 2 asks that set whether a name of THIS generation is
// live. A name whose cleanup never ran therefore answered "live" for the rest of the process's
// life, so the sweep that exists to collect orphans skipped it on every later allocation. One
// missed cleanup became a FIFO that outlives everything short of a host restart.
//
// The fix is a bound on how long an entry may make that claim, and this is its behaviour: a
// session left live (never terminated), with the host clock moved past the bound, must have its
// name COLLECTED by the next allocation — and the session itself must still be usable, because
// unlinking a name does not disturb descriptors.
//
// `Date.now` is patched here, so this is a SHARED-INPUT MUTATION and is declared as one: it is
// process-global, the window holds exactly one allocation (whose sweep is the subject) and one
// listing, and it is restored in `finally` on every path. Nothing else in this suite reads the
// clock inside the window.
console.log('\nscenario F: a live claim whose cleanup never ran becomes collectable (R58)')
{
  const beforeF = await fifos()
  const recordsBeforeF = fifoChildren.length
  const terminalF = await allocateFifoTerminal()
  // Same selection rule as scenarios A and B, for the same measured reason: this session's own
  // name carries THIS process's pid, so a concurrent run's live FIFO cannot make the delta wrong.
  const newFifosF = (await fifos()).filter((path) => !beforeF.includes(path))
  const liveF = newFifosF.filter(ownFifo).slice(0, 1)
  check('F: the stale-claim session created its FIFO (so the row below cannot pass vacuously)',
    liveF.length === 1, { live: liveF, newSinceBaseline: newFifosF, baseline: beforeF, ownPid: process.pid })
  // The claim this session holds is the one that goes stale. `terminalF` is deliberately NOT
  // terminated before the next allocation: a session whose claim was released by its own teardown
  // would prove nothing about a claim that was never released.
  const realNow = Date.now
  const CLAIM_BOUND_MS = 12 * 60 * 60 * 1000
  let collected = false
  try {
    // Past the bound, plus a margin: the claim must be read as EXPIRED, not merely old.
    Date.now = () => realNow() + CLAIM_BOUND_MS + 60 * 60 * 1000
    const recordsBeforeSweep = fifoChildren.length
    const terminalG = await allocateFifoTerminal()
    const afterSweep = await fifos()
    collected = liveF.filter((path) => !afterSweep.includes(path)).length === 1
    check('F: an allocation collects the FIFO of a prior session whose cleanup never ran',
      liveF.length === 1 && collected === true,
      {
        fifo: liveF,
        stillThere: liveF.filter((path) => afterSweep.includes(path)),
        note: 'pre-fix the name stayed in the live set forever, so branch 2 skipped it on every sweep and the leak was uncollectable',
      })
    // The session behind the collected name must still be alive: the removal is of the NAME only.
    //
    // REWRITTEN (review finding N7, ruling R62). This row used to read
    // `collected === true && terminalF.pid > 0`, and the second conjunct was near-vacuous: the
    // bridge announces `pid` for a session it has only just forked, so on any successful
    // allocation that number is positive by construction and carries no evidence about what the
    // sweep did to the session afterwards. A row that cannot fail for the reason it names is a
    // claim wearing evidence's clothes.
    //
    // What replaces it is the fact that identifies WHICH branch removed the name: the collected
    // name's generation field. Branch 2 (this generation, not live) is the only branch that can
    // collect a name carrying THIS process's pid, so requiring it is what separates the recovery
    // this scenario exists for from "some name went missing for another reason". Measured against
    // the collected name itself, not against a fixture.
    //
    // The grammar is spelled HERE rather than imported: `GENERATION_NAME` is a module-private
    // constant of pty.js, and reaching for it is what turned the first draft of this row into a
    // `ReferenceError` that killed the suite instead of reddening a row (the same defect class as
    // R27). A local literal can only be wrong about THIS name, which is visible in the evidence.
    const GENERATION_NAME_LOCAL = /^\/tmp\/dsh-pty-(\d+)-[0-9a-f-]{12}\.fifo$/u
    const collectedGeneration = liveF.length === 1 ? GENERATION_NAME_LOCAL.exec(liveF[0]) : null
    const collectedIsThisGeneration = collectedGeneration !== null && Number(collectedGeneration[1]) === process.pid
    check('F: collecting a stale claim does not kill the session that held it',
      collected === true && collectedIsThisGeneration,
      {
        pid: terminalF.pid,
        collected: liveF,
        generationPid: collectedGeneration === null ? '(the name does not carry a generation)' : Number(collectedGeneration[1]),
        thisProcess: process.pid,
        note: 'only branch 2 (this generation, not live) can collect a name carrying THIS process pid; the announced pid itself is positive by construction and proves nothing',
      })
    // ...and the session has to be USABLE afterwards, which is the half the old conjunct pretended
    // to cover. Unlinking a name does not disturb a session that already opened it: the bridge and
    // its control writer hold FILE DESCRIPTORS, and the inode outlives the directory entry. A
    // control round trip is the direct measurement of that claim — it goes through the FIFO's
    // writer, so a sweep that had closed or stolen the session's descriptors would fail it here.
    let stillUsable = false
    let usabilityProblem = ''
    try {
      const activity = await terminalF.inspectActivity()
      stillUsable = activity?.state === 'idle' || activity?.state === 'busy'
      if (!stillUsable) usabilityProblem = `inspectActivity answered ${JSON.stringify(activity)}`
    } catch (error) {
      usabilityProblem = detailText(error)
    }
    check('F: the session still answers a control round trip after its FIFO name was collected',
      collected === true && stillUsable,
      { collected, stillUsable, problem: usabilityProblem, note: 'the descriptors outlive the directory entry, which is the whole reason a name-only removal is safe' })
    void recordsBeforeSweep
    try { await terminalG.terminate() } catch { /* already over */ }
  } finally {
    Date.now = realNow
  }
  try { await terminalF.terminate() } catch { /* already over */ }
  for (const path of liveF) {
    await runWslShell({ distro, linuxCwd: '/', command: 'rm -f ' + shellQuote(path), loginShell: false, timeoutMs: 30_000 })
  }
  const leftoversF = (await fifos()).filter((path) => liveF.includes(path))
  check('F: no FIFO of this scenario is left behind', leftoversF.length === 0, { liveF, leftoversF })
  void recordsBeforeF
}

// --- scenario G: a removal that did not land must be REPORTED, not assumed (R57) --------
//
// The live gate's 17:23 residue was one FIFO on disk with nothing, anywhere, saying the `rm -f`
// had not landed. Two defects allowed that, and both are pinned below:
//
//   · `removeFifo` answered "success" for ANY spawn that resolved. `runWslShell` resolves for
//     every exit code (`world.js:611-613`), so a stopped distribution, a permission failure, or
//     an `rm` that simply failed all read as a successful removal — and the failure log was
//     suppressed by that false success.
//   · the diagnostic that did exist went through `termLog`, which is opt-in
//     (WSL_DESKTOP_TERMINAL_DEBUG), so in the default configuration it was silent.
//
// THIS IS A SOURCE-SHAPE PIN, AND ITS LIMITATION IS STATED RATHER THAN HIDDEN (R62). The
// behaviour — a removal that does not land answers false and reports it — cannot be driven
// offline on this machine: producing it needs a distribution that will list /tmp but refuse
// `rm` (a permission failure or a read-only /tmp), which an unprivileged suite cannot construct
// and which a stub `wsl.exe` cannot fake either, because `runWslShell` spawns ONE executable for
// both the listing and the removal. So what is pinned is the shape that makes the failure
// observable, and each row's red variant is a mutation of THIS source, restored byte-exactly
// from a %TEMP% backup and archived in the report. It is not a behavioural observation of a
// refused `rm`, and no row here claims to be one.
console.log('\nscenario G: a removal reports what it did, and reports it without the debug log')
{
  const ptySource = withoutComments(await readFile(join(here, '..', 'lib', 'wsl', 'pty.js'), 'utf8'))
  const fnStart = ptySource.indexOf('async function removeFifo')
  const fnEnd = ptySource.indexOf('export async function sweepOrphanFifos')
  const removeBody = fnStart > -1 && fnEnd > fnStart ? ptySource.slice(fnStart, fnEnd) : ''
  // The postcondition rides with the command in ONE spawn: `rm -f` alone cannot report a partial
  // success, and `test ! -e` is the distribution's own answer about the directory entry.
  check('G: the removal command carries its own postcondition, so one spawn answers "is the name gone"',
    removeBody !== ''
    && /&& test ! -e /.test(removeBody),
    { hasPostcondition: /&& test ! -e /.test(removeBody), length: removeBody.length })
  // The exit code is the half that was missing: resolving is not removing. `=== 0` is the ONLY
  // path that answers true, so every other ending (non-zero, killed, timed out) reports failure.
  check('G: removeFifo answers true only for exitCode 0, and its failure line names the outcome',
    removeBody !== ''
    && /result\.exitCode === 0\)\s*return true/.test(removeBody)
    && /reportAlways\(`removeFifo FAILED[^`]*exit=\$\{String\(result\.exitCode\)\}/.test(removeBody)
    && /timedOut=\$\{String\(result\.timedOut\)\}/.test(removeBody),
    {
      successArm: /result\.exitCode === 0\)\s*return true/.test(removeBody),
      reportsExit: /reportAlways\(`removeFifo FAILED[^`]*exit=\$\{String\(result\.exitCode\)\}/.test(removeBody),
      reportsTimeout: /timedOut=\$\{String\(result\.timedOut\)\}/.test(removeBody),
    })
  // The diagnostic must not depend on the opt-in log. `reportAlways` writes to the host's stderr
  // as well, and is defined WITHOUT the environment gate that `termLog` carries.
  const reportStart = ptySource.indexOf('function reportAlways')
  const reportClose = reportStart > -1 ? ptySource.indexOf('\n}\n', reportStart) : -1
  const reportBody = reportStart > -1 && reportClose > reportStart ? ptySource.slice(reportStart, reportClose) : ''
  check('G: the failure diagnostic is unconditional (stderr), not gated on the debug log',
    reportBody !== ''
    && /process\.stderr\.write\(/.test(reportBody)
    && !/WSL_DESKTOP_TERMINAL_DEBUG/.test(reportBody)
    && /reportAlways\(`removeFifo FAILED/.test(removeBody),
    { writesStderr: /process\.stderr\.write\(/.test(reportBody), envGated: /WSL_DESKTOP_TERMINAL_DEBUG/.test(reportBody), usedInRemove: /reportAlways\(`removeFifo FAILED/.test(removeBody), length: reportBody.length })
  // The failure path must stay FAIL-SAFE: reported, never thrown. A teardown that throws because
  // the distribution is going down is the regression this whole shape is arranged to avoid.
  //
  // Scoped to the region that STARTS at the CATCH block on purpose: `! /throw/` over the whole
  // function was satisfied by other code, which is how the first version of this row stayed
  // GREEN when the catch was mutated to `throw error` (measured). The fail-safe claim is about
  // what happens when the spawn itself rejects.
  //
  // WHAT THE REGION ACTUALLY IS (debt 8, corrected from measurement): `catchBody` is
  // `removeBody.slice(catchAt)`, and `removeBody` ends at the NEXT exported function
  // (`sweepOrphanFifos`), so the slice is NOT the catch block alone — it runs from
  // `} catch (error) {` to the end of the declaration run that follows `removeFifo`
  // (FIFO_PREFIX / FIFO_GLOB / LEGACY_CUT_MARKER / isPluginFifoName / fifoNameFor /
  // GENERATION_NAME / the live-set helpers / LIVE_FIFO_CLAIM_MS / LEGACY_PROTECTION_MINUTES).
  // Measured with this file's own `withoutComments`, so the numbers describe the text the row
  // really examines: removeBody 2248 bytes, catchAt 615, catchBody
  // 1633 — i.e. the examined slice is 2.7x the part before the catch. The row is still sound
  // TODAY because none of those declarations contains `throw` (verified on the same slice), and
  // the earlier sentence ("that is the only region examined") was the over-claim, not the
  // assertion: a future `throw` in any later helper would redden this row without the catch
  // having changed. Stated rather than tightened, because narrowing the slice would change an
  // assertion this documentation round must not change.
  const catchAt = removeBody.indexOf('} catch (error) {')
  const catchBody = catchAt > -1 ? removeBody.slice(catchAt) : ''
  check('G: the removal still answers instead of throwing, so a teardown cannot fail on it',
    catchBody !== ''
    && /return false/.test(catchBody)
    && !/\bthrow\b/.test(catchBody),
    { returnsFalse: /return false/.test(catchBody), throws: /\bthrow\b/.test(catchBody), catchAt })
  // The SAME blindness at the sweep's own `rm -f`: `runWslShell` resolves for any exit code
  // there too, so returning the name list after a failed `rm` would report removals that never
  // happened. It is fixed here (answering [] and reporting), and this row is what says so.
  const sweepStart = ptySource.indexOf('export async function sweepOrphanFifos')
  const sweepEnd = ptySource.indexOf('export async function spawnWslTerminal')
  const sweepBody = sweepStart > -1 && sweepEnd > sweepStart ? ptySource.slice(sweepStart, sweepEnd) : ''
  check('G: the sweep inspects its own rm exit code too, and answers [] when the removal did not land',
    sweepBody !== ''
    && /const removed = await runWslShell\(\{/.test(sweepBody)
    && /removed\.exitCode !== 0\) \{/.test(sweepBody)
    && /reportAlways\(`sweepOrphanFifos: removal FAILED[^`]*exit=\$\{String\(removed\.exitCode\)\}/.test(sweepBody)
    && /return \[\]/.test(sweepBody.slice(sweepBody.indexOf('removed.exitCode !== 0'))),
    {
      capturedOutcome: /const removed = await runWslShell\(\{/.test(sweepBody),
      inspects: /removed\.exitCode !== 0\) \{/.test(sweepBody),
      reportsExit: /reportAlways\(`sweepOrphanFifos: removal FAILED[^`]*exit=\$\{String\(removed\.exitCode\)\}/.test(sweepBody),
      answersEmpty: /return \[\]/.test(sweepBody.slice(sweepBody.indexOf('removed.exitCode !== 0'))),
    })
}

// Cleanup is scoped to what THIS section created: an unconditional
// `rm -f /tmp/dsh-pty-*.fifo` would also unlink the control channel of a terminal a
// running desktop owns, which is a side effect on the operator's machine, not a fixture.
const createdFifos = [...fifoLiveA, ...fifoLiveB, ...(fifoC === null ? [] : [fifoC]), ...(liveSessionFifo === undefined ? [] : [liveSessionFifo])]
const leftoverFifos = (await fifos()).filter((path) => createdFifos.includes(path))
check('no FIFO of these sessions is left behind', leftoverFifos.length === 0, { createdFifos, leftoverFifos })
for (const path of [...leftoverFifos, ...fixturesD]) {
  await runWslShell({ distro, linuxCwd: '/', command: 'rm -f ' + shellQuote(path), loginShell: false, timeoutMs: 30_000 })
}
const fixturesLeft = (await fifos()).filter((path) => fixturesD.includes(path))
check('the scenario D fixtures are removed by this suite', fixturesLeft.length === 0, { fixturesLeft })
for (const entry of fifoChildren) { try { entry.child.kill() } catch { /* already gone */ } }
console.log(`\n${checker.failures === 0 ? 'ALL CHECKS PASSED' : `${checker.failures} CHECK(S) FAILED`}`)
process.exitCode = checker.failures === 0 ? 0 : 1
