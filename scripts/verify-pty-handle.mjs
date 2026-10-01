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
import { planWsl } from '../lib/wsl/world.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { detailText } from './detail.mjs'
import { blankLiterals } from './source-text.mjs'

const distro = resolveDistro(process.argv[2])
const here = dirname(fileURLToPath(import.meta.url))
const bridgeSource = await readFile(join(here, '..', 'lib', 'wsl', 'terminal-bridge.py'), 'utf8')

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
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done: new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      child.on('error', () => resolve({ exitCode: null, signal: null }))
    }),
    terminate: () => { child.kill() },
    waitForExit: () => new Promise((resolve) => child.on('close', () => resolve(true))),
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
check('signalling returns the group it reached', signalled === jobPgrp, `signalled=${String(signalled)} jobPgrp=${String(jobPgrp)}`)
await terminal.write('echo ALIVE-$((5*5))\n')
check('the shell survives the interrupt', await until(() => output.includes('ALIVE-25')), JSON.stringify(output.slice(-200)))

// --- the pin: no timer may stand in for that condition again ---------------------
//
// The fixed wait was removed because it was MEASURED to fail; this rejects the idiom at
// the same site so it cannot return silently. The site is the span from the job's write
// to the signal call, read from this file's own text with the comment and string bodies
// blanked — so a comment naming the idiom neither satisfies nor trips the pin.
//
// What it does NOT establish: that no other duration-based wait exists anywhere (a poll
// gap inside ownsTerminal is a different thing and is not rejected), and it is
// spelling-bound — the region is delimited by two calls, so a rename has to move with it.
// The behavioural half is the check above: a fixed wait under load signals the shell's
// group, which `signalled === jobPgrp` now rejects.
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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
