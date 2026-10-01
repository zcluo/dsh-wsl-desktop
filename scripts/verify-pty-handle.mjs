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

await terminal.write('sleep 60\n')
await until(() => false, 1500)
const signalled = await terminal.signalForeground('SIGINT')
check('signalling returns the group it reached', signalled > 0, signalled)
await terminal.write('echo ALIVE-$((5*5))\n')
check('the shell survives the interrupt', await until(() => output.includes('ALIVE-25')), JSON.stringify(output.slice(-200)))

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
