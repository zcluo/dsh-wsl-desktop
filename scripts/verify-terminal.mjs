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

/** Wait until a predicate holds or the deadline passes. */
async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

console.log('bridge structural gates (offline)')
// A FIFO read end whose writer has CLOSED is always select-readable and returns
// b"", so leaving it in the watch set spun the pump loop at 100% CPU for the
// rest of the session — the state after the control process dies or a teardown
// closes it. (Measured: the latch does NOT fire before the FIRST writer
// attaches, because Linux suppresses the hangup until a writer has been seen;
// the post-writer state is the one that can persist.) The stdin branch already
// dropped its own fd on EOF; the control branch must do the same, and the watch
// set must honour the flag.
check('the bridge drops the control fd from its watch set on EOF',
  /self\.control_open\s*=\s*False/.test(bridgeSource)
    && /watched = \[self\.master\]\s*\n\s*if self\.control_open:\s*\n\s*watched\.append\(self\.control_fd\)/.test(bridgeSource),
  'once the writer has closed, select returns immediately on every iteration and the pump loop spins for the rest of the session')
check('the control read end starts open',
  /self\.control_open\s*=\s*True/.test(bridgeSource),
  'the flag must start True or the bridge would never read a control request at all')

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

// A request the dead bridge can never answer fails NOW, not after its whole
// timeout: the production handle settles its pending requests the same way when
// its bridge exits, and a suite that has just measured a fatal defect should not
// spend 15 seconds per line re-measuring it.
data.on('close', () => {
  for (const [id, waiter] of waiters) {
    waiters.delete(id)
    waiter(suiteFailure('the bridge exited before answering'))
  }
})

/**
 * The reply-shaped failure this suite reports when the bridge gave no answer.
 *
 * Marked as the SUITE's, not the bridge's, and that marker is load-bearing: the
 * timeout spelling below EMBEDS the stderr tail, which carries the bridge's own
 * reply lines verbatim — so a check matching that text alone can pass on a
 * demultiplexing failure, i.e. on the answer never arriving. Nothing the bridge
 * sends can carry this field.
 * @param {string} error - the failure text.
 * @returns {object} a reply-shaped object that cannot pass for the bridge's.
 */
function suiteFailure(error) {
  return { ok: false, error, synthesized: true }
}

/**
 * Send one RAW control line and await the bridge's answer to it.
 *
 * `controlRequest` frames a payload object; a malformed line has to be written
 * exactly as it is, because the whole point is a shape that is not an object at
 * all. A line that carries an id is answered by an id-matched reply; one that
 * cannot carry an id (a list, a scalar, a line that is not JSON) is answered by
 * an id-less reply, so that branch waits on the reply log instead.
 * @param {string} line - the exact line to write.
 * @param {string} [id] - the id the line carries, when it can carry one.
 * @returns {Promise<object>} the bridge's reply, or this suite's own failure text.
 */
async function controlRequestLine(line, id) {
  if (id !== undefined) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Removed before resolving: a late reply must find no waiter, or it
        // would be mispaired with a later request.
        waiters.delete(id)
        resolve(suiteFailure(`control timeout; stderr=${err.slice(-300)}`))
      }, 15_000)
      waiters.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      control.stdin.write(`${line}\n`)
    })
  }
  const before = replies.length
  control.stdin.write(`${line}\n`)
  const answered = await until(() => replies.length > before || data.exitCode !== null, 15_000)
  if (!answered) return suiteFailure(`control timeout; stderr=${err.slice(-300)}`)
  // A bridge that exited without answering leaves nothing at that index; the
  // failure text has to say so rather than pass for a reply.
  return replies[before] ?? suiteFailure('the bridge exited before answering')
}

/** Send one control request and await its id-matched reply. */
let requestSeq = 0
function controlRequest(payload) {
  const id = `ctl-${requestSeq += 1}`
  return controlRequestLine(JSON.stringify({ ...payload, id }), id)
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

// --- malformed control payloads: the bridge's own guarantee -----------------
//
// The audit REJECTED the injection candidate these cases come from. The escape
// mechanics are source-accurate line by line — struct.error out of struct.pack,
// OverflowError for a value Python decodes as infinity, TypeError out of
// SIGNALS.get — but NO LOWER-TRUST PRODUCER CAN SUPPLY THE VALUES: the harness
// terminal controller bounds dimensions with Number.isSafeInteger plus its
// configured limits at both create and resize, and exposes no signal method at
// all. None of this is a live vulnerability, and it must not be read as one.
//
// What that consumer guard does NOT cover is the claim in this bridge's own
// dispatcher comment: that a malformed payload must not kill the session. The
// bridge IS the terminal, so an exception escaping the dispatcher takes the PTY
// down with it — the guarantee was really being enforced by the consumer, not by
// the bridge. These cases pin the bridge's half, and they go over the raw control
// channel this suite already owns, because lib/wsl/pty.js can no longer FRAME one:
// it bounds the dimensions it writes (verify-pty-handle.mjs pins that side), its
// other ops write literals, and the one caller-supplied string it passes through
// — the signal name — is a value the bridge now rejects safely instead of dying on.
const malformed = [
  { what: 'a column count above what the ioctl can carry (struct.error)', line: '{"op":"resize","cols":70000,"rows":24}', echo: true },
  { what: 'a negative column count (struct.error)', line: '{"op":"resize","cols":-1,"rows":24}', echo: true },
  { what: 'a column count Python decodes as infinity (OverflowError)', line: '{"op":"resize","cols":1e400,"rows":24}', echo: true },
  { what: 'an unhashable signal name (TypeError)', line: '{"op":"signal","signal":[]}', echo: true },
  { what: 'a JSON list where the request object belongs (AttributeError)', line: '[]', echo: false, expect: /control payload must be an object/ },
  { what: 'a JSON scalar where the request object belongs (AttributeError)', line: '42', echo: false, expect: /control payload must be an object/ },
  { what: 'a line that is not JSON at all (ValueError)', line: 'not json at all', echo: false, expect: /control line is not JSON/ },
]

let malformedSeq = 0
for (const entry of malformed) {
  const id = `mal-${malformedSeq += 1}`
  // The id is spliced into the LINE, not added to a parsed object: a payload that
  // is not an object cannot be given one, and 1e400 must survive as written
  // (JSON.parse would read it as Infinity, JSON.stringify would write null).
  const line = entry.echo ? entry.line.replace('{"op"', `{"id":"${id}","op"`) : entry.line
  const reply = await controlRequestLine(line, entry.echo ? id : undefined)
  // The answer must be identifiable as the BRIDGE's, and `ok === false` alone is
  // not enough: this suite's own failure text is also ok:false, and its timeout
  // spelling embeds the stderr tail — which carries the bridge's replies verbatim
  // — so a regex over that text alone passes on a demultiplexing failure, i.e. on
  // the answer never arriving. `synthesized` is the field nothing the bridge sends
  // carries; the echoed id, or the bridge's own words, is the positive evidence.
  const answered = reply.ok === false && reply.synthesized === undefined
    && (entry.echo ? reply.id === id : entry.expect.test(String(reply.error)))
  check(`a malformed control line is answered, not fatal: ${entry.what}`, answered, reply)
  check(`the bridge survives it: ${entry.what}`, data.exitCode === null, `exit=${String(data.exitCode)}`)
}

data.stdin.write('echo SURVIVED-49\r')
check('the shell still answers after every malformed line', await until(() => out.includes('SURVIVED-49')), JSON.stringify(out.slice(-300)))

const afterMalformed = await controlRequest({ op: 'resize', cols: 100, rows: 30 })
check('a well-formed request still works after the malformed ones', afterMalformed.ok === true, afterMalformed)
data.stdin.write('stty size\r')
check('the PTY still takes a size after the malformed ones', await until(() => /\b30 100\b/.test(out)), JSON.stringify(out.slice(-160)))

// The bridge's stderr is the stream the host demultiplexes replies off, so a
// diagnostic written there has to be recognizable as NOT a reply: a line that
// began with the reply prefix would be parsed as a malformed reply and dropped,
// and a swallowed defect would leave the operator nothing to read.
const prefixed = err.split('\n').filter((line) => line.startsWith('#dsh-pty '))
check('every line the host demuxes as a reply really is one',
  prefixed.length > 0 && prefixed.every((line) => {
    try {
      JSON.parse(line.slice('#dsh-pty '.length))
      return true
    } catch {
      return false
    }
  }),
  prefixed.slice(-3))
// A blanket catch that only answered ok:false would hide a genuine defect inside
// a reply the host never surfaces — nothing in lib/wsl/pty.js reads `error` — so
// the failure has to reach the diagnostic stream as well.
check('an internal dispatcher failure is reported on the diagnostic channel',
  /bridge: control op 'resize' raised struct\.error/.test(err) && err.includes('Traceback'),
  err.split('\n').filter((line) => line.startsWith('bridge: ')).slice(-4))
// The two layers have to stay distinguishable, or the diagnostic channel stops
// meaning anything: an unhashable signal name is a payload the op guard can
// REJECT, so it belongs in the reply and not in the defect stream, while the
// resize failures that guard cannot express belong in both.
check('a payload the op guards reject is not reported as an internal defect',
  !/bridge: control op 'signal'/.test(err),
  err.split('\n').filter((line) => line.startsWith('bridge: ')).slice(-6))

const terminated = await controlRequest({ op: 'terminate' })
check('terminate is acknowledged and the session was signalled', terminated.ok === true && terminated.terminated === true, terminated)
const exited = await until(() => data.exitCode !== null, 8000)
check('the session settles after termination', exited, `exit=${String(data.exitCode)}`)
// The value, not merely that there is one: two paths wait on this child —
// `terminate()` reaps it to learn the group died, the pump loop reaps it to
// report a status — and whoever reaps second gets ChildProcessError. Measured
// with the status dropped on the reaping path: this read 0 on every run, so a
// session killed a moment earlier was indistinguishable from a clean exit, and
// the assertion above passed on it. 129 is 128+SIGHUP, the first signal sent.
// The exact value the comment names, not a range: a terminate path that dropped
// the SIGHUP grace would exit 143 (SIGTERM) or 137 (SIGKILL) and still satisfy
// `> 128`, so the documented contract had no pin at all. This branch is the one
// where the host never kills the bridge, so 129 is deterministic here (the
// documented race belongs to verify-pty-handle, which keeps its range).
check('a terminated session reports the signal, not a clean exit',
  data.exitCode === 129, `exit=${String(data.exitCode)}`)

control.stdin.end()
control.kill()
if (data.exitCode === null) data.kill()
await settled

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
