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

/**
 * Wait until the PTY reports that the SHELL owns the terminal, or that it does not.
 *
 * Ownership is the condition, never a duration: `sleep 60` prints nothing of its own and
 * the marker the suite waits for is satisfied by the terminal's own ECHO of the typed
 * line, so neither is evidence that a job took the terminal. `foreground` asks the PTY
 * (tcgetpgrp) which group holds it — the same reading `activity` compares against — so
 * the condition and the observation are the same fact.
 * @param {number} shellPgrp - the group the PTY reported for the idle shell.
 * @param {boolean} owned - true to wait for the shell to hold the terminal, false for a job.
 * @param {number} timeoutMs - how long to keep asking.
 * @returns {Promise<{settled: boolean, last: unknown}>} the outcome and the last reading.
 */
async function untilOwnership(shellPgrp, owned, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no reading'
  for (;;) {
    const reading = await controlRequest({ op: 'foreground' })
    last = typeof reading.pgrp === 'number' ? reading.pgrp : reading
    if (typeof reading.pgrp === 'number' && (reading.pgrp === shellPgrp) === owned) return { settled: true, last }
    if (Date.now() >= deadline) return { settled: false, last }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
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

// --- the dose: one session cannot pin a race ----------------------------------------
//
// The session rows below exist for one defect: the group recorded at spawn was READ from
// the OS, which raced the child's own `setsid()` and recorded the group the child had
// INHERITED — this bridge's own — whenever the parent got there first. One session meets
// that race only sometimes: measured on this code path, 51/300 (17.0%), 142/600 (23.7%)
// and 39/600 (6.5%) under CPU load, and 10/300 interleaved against 3/400 on an idle
// machine, while the same read 1 ms later never lost it (250/250). A single session is
// therefore a pin a regression can sit behind, so DOSE short sessions are opened and EVERY
// one must announce its own group — compared against the pid the bridge itself reported,
// which needs no shell to be running.
//
// Each session runs `/bin/true` and ends on its own: the bridge reaps it, exits and
// unlinks its own FIFO, so nothing has to be killed or cleaned up. The program does not
// change the race — measured interleaved in ONE process, an interactive bash and `/bin/true`
// lost it 10/300 times each.
const SPAWN_DOSE = 6

/**
 * Open one short session and report what the bridge announced at spawn.
 * @param {string[]} [prefix] - command the bridge is launched through (the starvation tool).
 * @returns {Promise<{announce: object|undefined, exit: number|null, diagnostics: string[]}>} the announce reply, the session's exit code, and its own stderr.
 */
async function announceOnce(prefix = []) {
  const fifo = `/tmp/dsh-pty-${randomUUID().slice(0, 8)}.fifo`
  const child = spawn('wsl.exe', [...base, ...prefix, 'python3', '-c', bridgeSource, fifo, '80', '24', '/bin/true'], {
    cwd: windowsCwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  })
  let announce
  let buffer = ''
  const diagnostics = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('#dsh-pty ')) {
        // The session's own diagnostics: what a missing starvation tool or a python3 that
        // cannot run the source looks like, and what the rows below report.
        if (line.trim() !== '') diagnostics.push(line.trim().slice(0, 200))
        if (diagnostics.length > 6) diagnostics.shift()
        continue
      }
      try {
        const parsed = JSON.parse(line.slice('#dsh-pty '.length))
        if (parsed.event === 'started') announce = parsed
      } catch {
        // A reply this suite cannot read is not this row's subject: the row below reports
        // a session that announced nothing as a failure instead of passing vacuously.
      }
    }
  })
  const exit = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(null))
  })
  return { announce, exit, diagnostics }
}

const dose = []
for (let opened = 0; opened < SPAWN_DOSE; opened += 1) dose.push(await announceOnce())
const wrongGroups = dose.filter((entry) => typeof entry.announce?.pgrp !== 'number' || entry.announce.pgrp !== entry.announce.pid)
check(`every one of ${SPAWN_DOSE} extra sessions announces its OWN process group`,
  wrongGroups.length === 0,
  `${wrongGroups.length} of ${SPAWN_DOSE} did not: ${JSON.stringify(wrongGroups.slice(0, 3))} (exit codes ${JSON.stringify(dose.map((entry) => entry.exit))})`)

// --- the starved spawn: the race, held still ----------------------------------------
//
// On ONE CPU the parent keeps the processor after `fork()`, so the child is not scheduled
// at all before the parent reads — the losing side of the race, made a property instead of
// left to the machine's mood. Measured with the racy read (the mutation that reddens this
// row): 294/300 and 299/300 spawns recorded the group the child had INHERITED with the
// bridge pinned to one CPU (`taskset -c 0`, and `-c 0` plus two busy loops on that CPU),
// against 11/300 and 45/300 unpinned in the same session. It is what makes the row below
// fail on EVERY run rather than one run in five, which the unpinned dose cannot promise.
//
// `taskset` is util-linux (a busybox applet too), so its absence is reported as its own
// row: the property row below must fail because a WRONG GROUP was announced, never because
// this machine could not starve the session.
const STARVED_PREFIX = ['taskset', '-c', '0']
const starved = await announceOnce(STARVED_PREFIX)
check('the starved session runs, so the row below is about the group it announced',
  starved.announce !== undefined && starved.exit === 0,
  `exit=${String(starved.exit)} announce=${JSON.stringify(starved.announce)} stderr=${JSON.stringify(starved.diagnostics)}`)
check('a session starved onto ONE CPU still announces its OWN process group',
  typeof starved.announce?.pgrp === 'number' && starved.announce.pgrp === starved.announce.pid,
  `announced=${String(starved.announce?.pgrp)} pid=${String(starved.announce?.pid)} — with one CPU the racy read recorded the group the child had INHERITED, which is this bridge's own`)

// --- the two long-lived children, and the ONE place that reaps them --------------
//
// The bridge (data) holds the session's PTY and the control process holds the FIFO's
// write end. They used to be killed only AFTER the final check, so any path that left
// the suite before it — the unguarded parse in the reply demux below, a check that
// throws, an interrupt — skipped the cleanup entirely. reap() is the single owner of
// the kill instead: it is idempotent and it runs on every exit Node can still act on
// (a normal exit, process.exit, and an uncaught exception, which Node reports before
// running 'exit' listeners). verify-all's SIGKILL after its ceiling is the one path
// nothing inside this process can intercept.
let data = null
let control = null

/** Whether a child is still running: an exited child has an exitCode, a signalled one a signalCode. */
function isAlive(child) {
  return child !== null && child.exitCode === null && child.signalCode === null
}

/** Kill both long-lived children. Idempotent, and safe at any point after this line. */
function reap() {
  // `isAlive`, not `exitCode === null`: a child this suite killed itself has a null
  // exitCode and a signalCode, and the exit hook below runs after the tail's own reap()
  // — liveness is the property that makes a second call a no-op instead of a second
  // signal at a dead pid.
  if (isAlive(control)) {
    // Ending the control process's stdin is what lets its read loop finish; the kill
    // releases the FIFO. Both can fail when the child is already gone, which is not an
    // error here — the cleanup's subject is "no child left running".
    try { control.stdin.end() } catch { /* the pipe is already gone */ }
    try { control.kill() } catch { /* already dead */ }
  }
  if (isAlive(data)) {
    try { data.kill() } catch { /* already dead */ }
  }
}
process.on('exit', reap)
for (const signal of ['SIGINT', 'SIGTERM']) {
  // Reaped, then exited non-zero: an interrupted suite must still report as interrupted
  // (the default disposition would have killed the process outright).
  process.on(signal, () => { reap(); process.exit(1) })
}

data = spawn('wsl.exe', [...base, 'python3', '-c', bridgeSource, fifo, '80', '24', ...shellArgv], {
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
control = spawn('wsl.exe', [
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

// The PTY is the reference for the rows below: `foreground` asks the terminal itself
// (tcgetpgrp) while `started.pgrp` is what the bridge RECORDED at spawn, so comparing
// them compares a reading against a record rather than a value against itself.
//
// Reading that record raced the child's own `setsid()`: measured on this production code
// path in this distribution, 51/300 (17.0%), 142/600 (23.7%) and 39/600 (6.5%) of spawns
// recorded the group the child INHERITED — the bridge's own — while a fresh read of the
// same child 1 ms later answered with its own group 250/250 times. A group recorded that
// way never corrects itself, so `activity` compared the PTY's answer against a group the
// session was never in and reported an IDLE shell BUSY for the life of the session; the
// retention policy that reclaims an unattended terminal acts only on `idle`, so such a
// session was never reclaimed.
const idlePgrp = typeof foreground.pgrp === 'number' ? foreground.pgrp : -1
check('the group announced at spawn is the group the PTY reports for the idle shell',
  typeof started?.pgrp === 'number' && started.pgrp === idlePgrp,
  `announced=${String(started?.pgrp)} pid=${String(started?.pid)} pty=${String(foreground.pgrp)}`)

const activity = await controlRequest({ op: 'activity' })
check('an idle shell is reported idle, not busy',
  activity.state === 'idle',
  `state=${String(activity.state)} announced=${String(started?.pgrp)} pid=${String(started?.pid)} pty=${String(foreground.pgrp)} revision=${String(activity.revision)}`)

const interrupted = out.length
data.stdin.write('sleep 60\r')
await until(() => out.length > interrupted, 3000)
// The other half of the same property: a bridge that answered `idle` unconditionally
// would satisfy the rows above while telling the retention policy to reclaim a session
// that is still running a job, so the busy state is asserted where it is observable.
const jobOwns = await untilOwnership(idlePgrp, false, 20_000)
const busy = await controlRequest({ op: 'activity' })
check('a foreground job is reported busy, so idle is not answered unconditionally',
  jobOwns.settled && busy.state === 'busy',
  `the job owns the terminal=${String(jobOwns.settled)} lastForeground=${JSON.stringify(jobOwns.last)} state=${String(busy.state)} shellPgrp=${String(idlePgrp)}`)
const signalled = await controlRequest({ op: 'signal', signal: 'SIGINT' })
check('a signal reaches the foreground group', signalled.ok === true, signalled)
data.stdin.write('echo ALIVE-25\r')
check('the shell survives the interrupt', await until(() => out.includes('ALIVE-25')), JSON.stringify(out.slice(-300)))
const shellOwns = await untilOwnership(idlePgrp, true, 10_000)
const idleAgain = await controlRequest({ op: 'activity' })
check('the session reports idle again once the shell owns the terminal',
  shellOwns.settled && idleAgain.state === 'idle',
  `the shell owns the terminal=${String(shellOwns.settled)} lastForeground=${JSON.stringify(shellOwns.last)} state=${String(idleAgain.state)}`)

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

// The same single owner as every other exit path, so this line is not the only reaper.
reap()
await settled

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
