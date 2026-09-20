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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${String(detail)}`}`)
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

const plan = planWsl(resolveLinuxHome(), distro)
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

await terminal.terminate()
const settled = await Promise.race([
  terminal.done.then(() => true),
  new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
])
check('the session process settles after termination', settled === true)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1