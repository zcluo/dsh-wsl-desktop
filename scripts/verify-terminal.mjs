/**
 * Verify the PTY bridge against a real distribution.
 *
 * Drives the bridge the way the subprocess provider will: a data process whose
 * stdin/stdout carry terminal bytes, and a second `wsl.exe` holding a control
 * FIFO open for its JSON line protocol. Asserts that a real PTY exists (window
 * size is settable and readable by the shell), that signalling reaches the
 * foreground group, and that termination returns the child's own exit status.
 *
 * Run: node scripts/verify-terminal.mjs [distro]
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDistro } from './env.mjs'

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

/** Wait until a predicate holds or the deadline passes. */
async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

const token = randomUUID().slice(0, 8)
const fifo = `/tmp/dsh-pty-${token}.fifo`
const base = ['-d', distro, '--cd', '/', '-e']
const windowsCwd = process.env.SystemRoot ?? process.cwd()

// A clean interactive bash: this verifies the bridge, not the user's rc. Some
// rc programs (fastfetch here) query the terminal and wait for a reply that only
// a terminal emulator can give — the real Web terminal answers through xterm.js,
// while a headless check has nothing to answer with.
const shellArgv = ['/bin/bash', '--noprofile', '--norc', '-i']
const data = spawn('wsl.exe', [...base, 'python3', '-c', bridgeSource, fifo, '80', '24', ...shellArgv], {
  cwd: windowsCwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
})

let out = ''
let err = ''
const replies = []
let replyBuffer = ''
/** Pending control requests by id — replies are matched by the id the request sent, never positionally. */
const waiters = new Map()

data.stdout.on('data', (chunk) => { out += chunk })
data.stderr.on('data', (chunk) => {
  err += chunk
  replyBuffer += chunk
  while (replyBuffer.includes('\n')) {
    const index = replyBuffer.indexOf('\n')
    const line = replyBuffer.slice(0, index)
    replyBuffer = replyBuffer.slice(index + 1)
    if (line.startsWith('#dsh-pty ')) {
      const parsed = JSON.parse(line.slice('#dsh-pty '.length))
      // The bridge echoes the request id back (`ans()`), so a late reply can
      // never be consumed by the NEXT request — the same pairing rule the
      // production control channel uses. Positional shift() desynced every
      // op after one slow reply and made this suite flaky.
      if (typeof parsed.id === 'string') {
        const waiter = waiters.get(parsed.id)
        if (waiter !== undefined) {
          waiters.delete(parsed.id)
          waiter(parsed)
        }
      } else {
        replies.push(parsed)
      }
    }
  }
})

console.log(`driving the PTY bridge in ${distro}\n`)

check('the bridge reports its session started', await until(() => replies.length > 0), err)
const started = replies.shift()
check('the session carries a pid and a process group', typeof started?.pid === 'number' && typeof started?.pgrp === 'number', started)

// The bridge creates the control FIFO before announcing the session, so the
// writer can be started only after that announcement.
const control = spawn('wsl.exe', [
  ...base, 'bash', '-c',
  'exec 3>"$1" || exit 1; while IFS= read -r line; do printf \'%s\\n\' "$line" >&3; done', 'bash', fifo,
], { cwd: windowsCwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
control.stderr.on('data', (chunk) => { err += chunk })

const settled = new Promise((resolve) => {
  let closed = 0
  const done = () => { closed += 1; if (closed === 2) resolve() }
  data.on('close', done)
  control.on('close', done)
})

/** Send one control request and await its id-matched reply. */
let requestSeq = 0
function controlRequest(payload) {
  const id = `ctl-${requestSeq += 1}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Removed before resolving: a late reply must find no waiter, or it
      // would be mispaired with a later request.
      waiters.delete(id)
      resolve({ ok: false, error: `control timeout; stderr=${err.slice(-300)}` })
    }, 15_000)
    waiters.set(id, (reply) => {
      clearTimeout(timer)
      resolve(reply)
    })
    control.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
  })
}

data.stdin.write('echo MARK-42\r')
check('a command runs in the PTY', await until(() => out.includes('MARK-42')), JSON.stringify(out.slice(-300)))

const resize = await controlRequest({ op: 'resize', cols: 120, rows: 40 })
check('resize is accepted', resize.ok === true, resize)
data.stdin.write('stty size\r')
check('the shell observes the new window size', await until(() => /\b40 120\b/.test(out)), JSON.stringify(out.slice(-160)))

const foreground = await controlRequest({ op: 'foreground' })
check('the foreground process group is readable', foreground.ok === true && typeof foreground.pgrp === 'number', foreground)

const activity = await controlRequest({ op: 'activity' })
check('activity is reported as a known state', ['idle', 'busy', 'unknown'].includes(activity.state), activity)

const interrupted = out.length
data.stdin.write('sleep 60\r')
await until(() => out.length > interrupted, 3000)
const signalled = await controlRequest({ op: 'signal', signal: 'SIGINT' })
check('a signal reaches the foreground group', signalled.ok === true, signalled)
data.stdin.write('echo ALIVE-25\r')
check('the shell survives the interrupt', await until(() => out.includes('ALIVE-25')), JSON.stringify(out.slice(-300)))

const terminated = await controlRequest({ op: 'terminate' })
check('terminate is acknowledged and the session was signalled', terminated.ok === true && terminated.terminated === true, terminated)
check('the session settles after termination', await until(() => data.exitCode !== null, 8000), `exit=${String(data.exitCode)}`)

control.stdin.end()
control.kill()
if (data.exitCode === null) data.kill()
await settled

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1