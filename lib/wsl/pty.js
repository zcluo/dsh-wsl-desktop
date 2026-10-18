/**
 * Terminal transport for the WSL execution world.
 *
 * A `wsl.exe` pipe is not a terminal, so a real PTY is allocated inside the
 * distribution by `terminal-bridge.py`. This module owns the two host-side
 * processes that drive it and assembles the seam's terminal handle:
 *
 * - the **data** process runs the bridge; its stdin/stdout carry terminal bytes
 *   and its stderr carries one JSON control reply per line;
 * - the **control** process holds the bridge's FIFO open so resize, foreground
 *   inspection, signalling and termination can be requested at any time.
 *
 * Byte-level transport stays with the host subprocess provider, so managed
 * termination and disposal keep their owner.
 * @module dsh-wsl-desktop/wsl/pty
 */

import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from './paths.js'
import { buildWslExecArgv, runWslShell } from './world.js'

/** How long a control round trip may take before it is reported as failed. */
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000

/** Ceiling for the host-side FIFO cleanup: a teardown must not hang on it. */
const DEFAULT_FIFO_UNLINK_TIMEOUT_MS = 10_000

/** Prefix the bridge puts on every control reply line. */
const REPLY_PREFIX = '#dsh-pty '

/**
 * Largest terminal dimension the bridge can carry.
 *
 * `struct.pack('HHHH', ...)` in `terminal-bridge.py` holds an unsigned short, so
 * this is the wire format's own ceiling — not a second opinion on how large a
 * terminal may be.
 */
const MAX_DIMENSION = 65_535

/** Size framed when a caller supplies no dimension the PTY can carry at all. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** Distributions already confirmed to carry the bridge's runtime. */
const verifiedDistros = new Set()

/**
 * Append one diagnostic line to the terminal debug log (bounded). Temporary
 * instrumentation for the live GUI-path terminal failure; harmless if the
 * file cannot be written.
 * @param {string} message - the diagnostic line.
 */
export function termLog(message) {
  // Debug instrumentation: opt-in via env, because an always-on log grows
  // without bound on every terminal allocation.
  if (process.env.WSL_DESKTOP_TERMINAL_DEBUG !== '1') return
  try {
    appendFileSync(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wsl-desktop-terminal-debug.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never break allocation.
  }
}

/**
 * Bound one terminal dimension to what the bridge can carry.
 *
 * The harness terminal controller already validates dimensions before it calls
 * this provider (`Number.isSafeInteger` plus its configured limits, at both create
 * and resize), so a value outside 1..65535 is a caller bug rather than a value to
 * guess at. It is bounded here anyway, for two reasons that guard cannot cover.
 *
 * The bound is the WIRE FORMAT's — the widest range the PTY ioctl can carry at
 * all — and not a second opinion on the deployment's size policy. It sits above
 * every limit the controller applies by default, so no dimension a working
 * deployment uses is rewritten by it; a deployment that configured a limit past
 * 65535 would be asking for a size the ioctl cannot carry, and it gets the
 * fallback rather than a bridge that dies at spawn.
 *
 * The spawn path is the one that makes this mandatory rather than tidy: it frames
 * a dimension into the bridge's argv, and the first resize runs inside
 * `Bridge.__init__` BEFORE its control dispatcher exists — so a value the ioctl
 * cannot carry there is fatal with no guard able to answer it.
 * @param {number} value - the requested dimension.
 * @param {number} fallback - the dimension to keep when this one cannot be carried.
 * @returns {number} a dimension the bridge can carry.
 */
function clampDimension(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION ? value : fallback
}

/**
 * Bound a requested size, reporting every value that had to be replaced.
 *
 * `fallback` is the size this handle last had accepted, so a value that cannot be
 * carried leaves the terminal where it is instead of inventing one.
 * @param {number} cols - requested columns.
 * @param {number} rows - requested rows.
 * @param {{ cols: number, rows: number }} fallback - the size to keep.
 * @returns {{ cols: number, rows: number }} the size to frame.
 */
function boundSize(cols, rows, fallback) {
  const bounded = { cols: clampDimension(cols, fallback.cols), rows: clampDimension(rows, fallback.rows) }
  if (bounded.cols !== cols || bounded.rows !== rows) {
    // Not silent: a dimension the PTY cannot carry means the caller's own guard
    // was bypassed, and this log is the only place that can be seen.
    termLog(`size bounded: cols=${String(cols)}->${String(bounded.cols)} rows=${String(rows)}->${String(bounded.rows)}`)
  }
  return bounded
}

/**
 * Confirm the distribution can run the bridge before allocating anything.
 *
 * The bridge is Python standard library only, so the runtime is the one real
 * dependency. Checking once per distribution turns a confusing mid-spawn
 * failure into a clear message.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {object} options - probe inputs.
 * @param {string} [options.username] - Linux user for the probe.
 * @param {string} [options.wslPath] - the configured `wsl.exe` path; this probe
 *   spawns it like every other site, or a deployment without wsl.exe on PATH
 *   would allocate through one path and probe through another.
 * @returns {Promise<void>} settlement.
 * @throws Error naming the missing runtime.
 */
async function requireBridgeRuntime(plan, options) {
  if (verifiedDistros.has(plan.distro)) return
  const failures = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const probe = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      ...options.username !== undefined && options.username !== '' ? { username: options.username } : {},
      ...options.wslPath !== undefined && options.wslPath !== '' ? { wslPath: options.wslPath } : {},
      command: 'command -v python3 >/dev/null 2>&1 && echo yes || echo no',
      // Non-login + strict equality: profile output can neither skew the answer
      // nor get substring-matched into a false positive. The 60s ceiling matches
      // the confinement identity probe: the desktop's first wsl.exe spawn after
      // a restart can outlive a short ceiling on a cold VM.
      loginShell: false,
      timeoutMs: 60_000,
    })
    const answer = probe.stdout.trim()
    if (answer === 'yes') {
      verifiedDistros.add(plan.distro)
      termLog(`requireBridgeRuntime: distro=${plan.distro} python3 ok`)
      return
    }
    // 'no' is an ANSWER — the interpreter really is absent. Anything else is a
    // probe that could not RUN, and reporting that as "no python3" sends the
    // reader after the wrong thing entirely. This conflation is the same defect
    // checkLinuxPath had (a failed probe read as "the path is missing"); it was
    // measured here as a whole suite dying under load, with the distro's python3
    // present the entire time.
    if (answer === 'no') {
      throw new Error(`wsl-pty: 发行版 ${plan.distro} 里没有 python3，无法分配终端`)
    }
    failures.push(`退出码 ${String(probe.exitCode)}${probe.timedOut ? '（超时）' : ''} stderr=${JSON.stringify(probe.stderr.trim().slice(0, 120))}`)
    termLog(`requireBridgeRuntime: distro=${plan.distro} probe did not run: ${failures[failures.length - 1]}`)
  }
  throw new Error(`wsl-pty: python3 探针在发行版 ${plan.distro} 里无法运行（${failures.join('；')}）——这是发行版级别的失败，不是缺少解释器`)
}

/**
 * Unlink one session's control FIFO from the HOST side.
 *
 * The bridge's own finally (terminal-bridge.py) unlinks it, but that block does
 * not run when the bridge is KILLED — and the host kills it: terminate() calls
 * data.terminate() straight after the bridge's own terminate reply, racing its
 * clean exit, and the provider's grace escalates to a kill. A killed bridge
 * leaves a 0-byte /tmp/dsh-pty-<uuid>.fifo inside the distribution, and nothing
 * else ever removes it: the name carries a fresh uuid per allocation, so no later
 * allocation reuses or sweeps it. Measured: hard-killing the data process of a
 * live session left the FIFO behind on every run.
 *
 * Hence a host-side rm -f, which is the only cleanup that survives a SIGKILL.
 * Best effort and bounded (a distribution that is going down must not hang a
 * teardown) and idempotent (safe on every path that ends a session). The cost is
 * one wsl.exe spawn per closed session, memoized in cleanupFifo() so the two end
 * paths cannot each pay it; the alternative — inferring from
 * the session outcome whether the bridge's finally ran — is not portable: on
 * Windows a killed process reports no signal, and a non-zero exit code is also
 * the ordinary shape of a session whose command failed.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {string} fifo - the FIFO path inside the distribution.
 * @param {{ wslPath?: string, username?: string }} select - distribution/user selection.
 * @param {number} [timeoutMs] - ceiling for the cleanup.
 * @returns {Promise<void>} settlement.
 */
async function removeFifo(plan, fifo, select, timeoutMs = DEFAULT_FIFO_UNLINK_TIMEOUT_MS) {
  try {
    await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: 'rm -f ' + shellQuote(fifo),
      loginShell: false,
      timeoutMs,
      ...select,
    })
  } catch {
    // The session is over and the distribution may be unreachable; there is
    // nothing better to do than leave it, and this must not fail a teardown.
  }
}

/**
 * The FIFO name pattern every session of this plugin uses, as a full path.
 *
 * The name carries a fresh uuid per allocation (`randomUUID().slice(0, 12)`), so a
 * surviving file under it is always an orphan rather than a live session's channel — no
 * later allocation reuses a name. That is what makes a SWEEP possible at all, and it is
 * also why the sweep must match this plugin's own prefix rather than all of `/tmp`.
 *
 * Kept as one literal beside the allocation below: a second spelling of the pattern is how
 * a sweep comes to delete the names it does not own, or to miss the ones it does.
 */
const FIFO_PREFIX = '/tmp/dsh-pty-'

/** The glob the sweep uses — the same prefix, widened to any session name and the .fifo suffix. */
const FIFO_GLOB = `${FIFO_PREFIX}*.fifo`

/**
 * The prefix one session's name must carry for the sweep to consider it this plugin's.
 * @param {string} name - a FIFO path.
 * @returns {boolean} whether the path is a name this plugin allocates.
 */
function isPluginFifoName(name) {
  return name.startsWith(FIFO_PREFIX) && name.endsWith('.fifo')
}

/**
 * The shortest age, in minutes, at which a name under this plugin's prefix is sweepable.
 *
 * Not a lifetime, and not a guess about sessions: it is the width of the one WINDOW that
 * makes a name safe to remove. A session's FIFO is created by its bridge (`mkfifo`) and
 * opened by the control writer a moment later; between those two events the NAME is the only
 * thing connecting them, so a sweep inside that window would delete a name a session is
 * about to open. The window is a few hundred milliseconds of local work and two minutes is
 * two orders of magnitude above it.
 *
 * The cost is stated rather than hidden: an orphan younger than this survives one sweep and
 * is collected by a later allocation. That is decay with a two-minute grain, not growth.
 */
const SWEEP_MIN_AGE_MINUTES = 2

/**
 * Remove the FIFOs a PREVIOUS host generation left in this distribution.
 *
 * `removeFifo()` covers every session THIS host ends, on every path it can take, and the
 * live suites prove it. The gap it cannot cover is the host that never got to end a
 * session: a restart is not a teardown, so a session's bridge dies with the host and its
 * own `finally` (terminal-bridge.py) never runs. Measured on this machine after a restart:
 * two 0-byte `/tmp/dsh-pty-*.fifo` files from the previous generation, nothing responsible
 * for them — and, measured while this sweep was being written, the bridges that still held
 * them open inside the distribution outlived the host as well (their Windows parent was
 * gone, `/init` had reparented them).
 *
 * That second measurement is what rules out the obvious ownership test. "A FIFO no process
 * holds open is an orphan" sounds safe and collects NOTHING here: the previous generation's
 * bridge is still alive holding its read end, so every real orphan looks live. Age is the
 * discriminator that actually separates the two generations.
 *
 * Unlinking a name does NOT disturb a session that has already opened it: the bridge and its
 * control writer hold FILE DESCRIPTORS, and a FIFO's inode outlives its directory entry for
 * as long as any descriptor refers to it. That is why a name is safe to remove at all, and
 * why the age rule above is the whole safety argument this sweep needs.
 *
 * Fail-safe by construction, in `removeFifo()`'s own style — a sweep must never fail a
 * session that otherwise works:
 *   - BEST EFFORT: the whole probe is wrapped, and a throw is swallowed;
 *   - BOUNDED: both wsl.exe spawns it makes carry a ceiling, so a distribution that is going
 *     down cannot hang an allocation;
 *   - CONSERVATIVE: the rule is `find -mmin` over this plugin's own prefix and nothing else,
 *     so a name outside it is never addressed;
 *   - IDEMPOTENT: `rm -f` on a name a concurrent sweep already removed is a no-op.
 *
 * The name list comes back to THIS process, which decides what to remove: a glob handed to
 * a shell would delete whatever matched at the moment it ran.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {{ wslPath?: string, username?: string }} select - distribution/user selection.
 * @param {number} [timeoutMs] - ceiling for the whole sweep.
 * @returns {Promise<string[]>} the orphan names it removed (empty when there were none).
 */
export async function sweepOrphanFifos(plan, select, timeoutMs = DEFAULT_FIFO_UNLINK_TIMEOUT_MS) {
  const pattern = FIFO_GLOB.slice(FIFO_GLOB.lastIndexOf('/') + 1)
  try {
    const listing = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: `find /tmp -maxdepth 1 -name ${shellQuote(pattern)} -mmin +${String(SWEEP_MIN_AGE_MINUTES)} -print 2>/dev/null`,
      loginShell: false,
      timeoutMs,
      ...select,
    })
    const names = String(listing.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && isPluginFifoName(line))
    if (names.length === 0) return []
    // One rm for the whole set, each name QUOTED: a uuid name cannot carry a separator, but
    // the quoting keeps that a property of the command rather than of the name generator.
    await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: `rm -f ${names.map((name) => shellQuote(name)).join(' ')}`,
      loginShell: false,
      timeoutMs,
      ...select,
    })
    termLog(`sweepOrphanFifos: removed ${String(names.length)} orphan(s) in ${plan.distro}: ${names.join(' ')}`)
    return names
  } catch (error) {
    // A distribution that refuses the probe is not a reason to refuse the session: the
    // sweep's subject is housekeeping from a previous generation.
    termLog(`sweepOrphanFifos: skipped in ${plan.distro}: ${String(error?.message ?? error)}`)
    return []
  }
}

/**
 * Start one PTY session inside a distribution.
 * @param {object} options - spawn inputs.
 * @param {object} options.local - the host subprocess provider.
 * @param {{ distro: string, linuxCwd: string, windowsCwd: string }} options.plan - the execution plan.
 * @param {string} options.bridgeSource - the bridge program's source text.
 * @param {readonly string[]} options.argv - the program to run on the PTY.
 * @param {number} options.cols - initial columns, bounded to what the bridge can carry.
 * @param {number} options.rows - initial rows, bounded to what the bridge can carry.
 * @param {number} options.graceMs - kill escalation grace.
 * @param {Record<string, string>} [options.env] - environment for the spawn.
 * @param {AbortSignal} [options.signal] - allocation cancellation.
 * @param {string} [options.wslPath] - `wsl.exe` path.
 * @param {string} [options.username] - Linux user.
 * @param {number} [options.controlTimeoutMs] - control round-trip bound.
 * @returns {Promise<object>} the terminal handle.
 */
export async function spawnWslTerminal({
  local,
  plan,
  bridgeSource,
  argv,
  cols,
  rows,
  graceMs,
  env,
  signal,
  wslPath,
  username,
  controlTimeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
}) {
  // The size this handle frames, and the fallback every later request falls back
  // to: the last size the PTY was actually asked to take.
  let size = boundSize(cols, rows, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  const fifo = `${FIFO_PREFIX}${randomUUID().slice(0, 12)}.fifo`
  const select = { ...(wslPath !== undefined ? { wslPath } : {}), ...(username !== undefined ? { username } : {}) }
  /**
   * The session's ONE host-side FIFO removal, shared by every path that can end it.
   *
   * Both end paths reach here — the data-done handler (a bridge that exited or
   * was killed) and terminate()/the failed-allocation catch — and each used to
   * call removeFifo itself. Measured with a call counter across a full
   * verify-pty-handle run: EVERY one of the five sessions it drives called
   * removeFifo exactly TWICE, so "one extra wsl.exe spawn per closed session"
   * was wrong by a factor of two, on the killed and failed paths as much as on
   * terminate. Memoizing the promise makes the first caller the owner and every
   * other caller await the same settlement: one rm per session, no end path left
   * uncovered, and a path that throws before its own call still gets the
   * handler's.
   * @returns {Promise<void>} settlement of the single removal.
   */
  let fifoCleanup
  const cleanupFifo = () => (fifoCleanup ??= removeFifo(plan, fifo, select))
  termLog(`allocate: distro=${plan.distro} linuxCwd=${JSON.stringify(plan.linuxCwd)} windowsCwd=${JSON.stringify(plan.windowsCwd)} argv0=${JSON.stringify(argv[0])} cols=${String(size.cols)} rows=${String(size.rows)} fifo=${fifo}`)
  await requireBridgeRuntime(plan, select)
  termLog('allocate: bridge runtime ok')
  // The other generation's orphans, swept at the one moment this process can tell them
  // from its own: before it has allocated anything, so every name under this plugin's
  // prefix in this distribution belongs to a host that is gone. AWAITED, so an allocation
  // never races its own sweep — and it cannot fail the allocation: sweepOrphanFifos
  // swallows every failure and answers the names it removed.
  await sweepOrphanFifos(plan, select)

  const pending = new Map()
  let requestSeq = 0
  let replyBuffer = ''
  /** Last stderr lines from the data process — diagnostics for a dead bridge. */
  const stderrLines = []
  /** Set once the data process (the bridge) has settled; further requests fail fast. */
  let bridgeDown = false
  let started
  const startedPromise = new Promise((resolve, reject) => { started = { resolve, reject } })

  /**
   * Settle every outstanding control request with a failure. Used when the
   * bridge exits, so a pending request fails with the real cause instead of
   * burning its whole timeout, and after termination.
   * @param {string} message - the failure text.
   */
  function failPending(message) {
    const waiters = [...pending.values()]
    pending.clear()
    for (const waiter of waiters) waiter.reject(new Error(message))
  }

  const dataSpec = {
    argv: buildWslExecArgv(plan, ['python3', '-c', bridgeSource, fifo, String(size.cols), String(size.rows), ...argv], select),
    cwd: plan.windowsCwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    ...signal !== undefined ? { signal } : {},
    ...env !== undefined ? { env } : {},
  }
  const data = local.spawn(dataSpec)
  // EPIPE arrives as an ASYNC 'error' event on the stdin stream, not as a
  // synchronous throw — swallow it so a dead bridge's late write cannot become
  // an unhandled error event on the host process.
  data.stdin?.on?.('error', () => {})

  /**
   * Hand one parsed reply to its request, matched by the id the request wrote.
   * A reply whose request already timed out — or one the host never sent —
   * finds no entry and is dropped: id pairing is what keeps a late reply from
   * being consumed by the NEXT request and desyncing every later control op.
   * @param {object} reply - the decoded reply.
   */
  function deliver(reply) {
    if (reply.event === 'started') {
      started.resolve(reply)
      return
    }
    const waiter = typeof reply.id === 'string' ? pending.get(reply.id) : undefined
    if (waiter === undefined) return
    pending.delete(reply.id)
    waiter.resolve(reply)
  }

  const stderr = data.stderr
  if (stderr === undefined) {
    // This guard throws BEFORE the allocation try below, so it used to escape with
    // the data process still running — the very leak that try's catch exists to
    // prevent. Same cleanup, minus `control`: it is not spawned yet at this point,
    // and `control` is not even in scope here.
    try {
      data.terminate()
    } catch {
      // Already gone.
    }
    await Promise.allSettled([waitForHandle(data)])
    // The bridge may already have created its FIFO before this check; rm -f is a
    // no-op when it did not.
    await cleanupFifo()
    throw new Error('wsl-pty: 数据进程没有 stderr，无法承载控制应答')
  }
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk) => {
    replyBuffer += chunk
    while (replyBuffer.includes('\n')) {
      const index = replyBuffer.indexOf('\n')
      const line = replyBuffer.slice(0, index)
      replyBuffer = replyBuffer.slice(index + 1)
      // Bounded diagnostics: keep every data-process stderr line (bridge
      // tracebacks included), not only the prefixed control replies.
      const trimmed = line.trim()
      if (trimmed !== '') stderrLines.push(trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed)
      if (stderrLines.length > 40) stderrLines.shift()
      if (!line.startsWith(REPLY_PREFIX)) continue
      try {
        deliver(JSON.parse(line.slice(REPLY_PREFIX.length)))
      } catch {
        // A malformed reply is dropped; the pending request times out instead.
      }
    }
  })

  // Declared before the settlement handler below, which terminates it: the
  // control writer must not outlive the bridge that answers its requests.
  let control = null

  data.done.then(
    (outcome) => {
      bridgeDown = true
      termLog(`data done: exit=${String(outcome.exitCode)} timedOut=${String(outcome.timedOut)} stderrTail=${JSON.stringify(stderrLines.slice(-8).join(' | ').slice(0, 600))}`)
      started.reject(new Error(`wsl-pty: 桥在报告会话之前退出（exit=${String(outcome.exitCode)}）`))
      failPending(`wsl-pty: 桥已退出（exit=${String(outcome.exitCode)}），控制请求不再有应答`)
      // Nothing can answer control requests any more, and the control writer
      // blocks on `read` with a host pipe that only terminate() closes — so
      // without this every finished terminal leaked one wsl.exe plus its
      // distribution-side bash, holding the FIFO.
      control?.terminate()
      // The bridge is gone, so its own finally either ran or was preempted by a
      // kill — and only this side can answer that by looking. Reaches the shared
      // removal on every session end, which is what covers the killed case.
      void cleanupFifo()
    },
    (error) => {
      bridgeDown = true
      termLog(`data failed: ${String(error)}`)
      started.reject(error instanceof Error ? error : new Error(String(error)))
      failPending(`wsl-pty: 桥进程失败：${String(error)}`)
      control?.terminate()
      // Same host-side cleanup as the exited-bridge branch above: a FAILED data
      // process is the case where the bridge's own finally is least likely to
      // have run.
      void cleanupFifo()
    },
  )

  try {
    // The bridge creates the FIFO before announcing the session, so the control
    // writer can safely be started only after that announcement.
    const announce = await withTimeout(startedPromise, controlTimeoutMs, 'wsl-pty: 桥没有报告会话')
    termLog(`announce ok: pid=${String(announce.pid)} pgrp=${String(announce.pgrp)} fifo=${fifo}`)

    control = local.spawn({
      argv: buildWslExecArgv(plan, [
        'bash', '-c',
        'exec 3>"$1" || exit 1; while IFS= read -r line; do printf \'%s\\n\' "$line" >&3; done',
        'bash', fifo,
      ], select),
      cwd: plan.windowsCwd,
      stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
      graceMs,
      // Wire the allocation signal to the control writer too: an abort after
      // the announce would otherwise leak the control process blocked on FIFO.
      ...signal !== undefined ? { signal } : {},
      ...env !== undefined ? { env } : {},
    })
    // Same async-EPIPE guard as the data process's stdin.
    control.stdin?.on?.('error', () => {})
    termLog('control spawned')

    /**
     * Send one control request and await its id-matched reply.
     * @param {object} payload - the control request.
     * @returns {Promise<object>} the bridge's reply.
     */
    function request(payload) {
      // A dead bridge can never answer: fail now instead of burning the whole
      // control timeout (the pre-fix symptom was a ~15s stall per op).
      if (bridgeDown) return Promise.reject(new Error(`wsl-pty: 桥已退出，${String(payload.op)} 无法执行`))
      return new Promise((resolve, reject) => {
        const id = `ctl-${requestSeq += 1}`
        const waiter = {
          resolve: (reply) => { clearTimeout(timer); resolve(reply) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        }
        const timer = setTimeout(() => {
          // Removed before rejecting: a late reply must find no entry, or it
          // would be mispaired with a later request.
          if (pending.delete(id)) waiter.reject(new Error(`wsl-pty: 控制请求超时（${String(payload.op)}）`))
        }, controlTimeoutMs)
        pending.set(id, waiter)
        try {
          control.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`)
        } catch (error) {
          // The control writer died (EPIPE): fail this request now instead of
          // leaving it to the timeout.
          if (pending.delete(id)) waiter.reject(error)
        }
      })
    }

    return {
      pid: typeof announce.pid === 'number' ? announce.pid : 0,
      output: data.stdout,
      done: data.done,
      write: async (chunk) => {
        // A dead bridge's stdin pipe throws EPIPE on write — the caller
        // should see the rejection, not an unhandled error event.
        try {
          data.stdin?.write(chunk)
        } catch {
          // The bridge is gone; the terminal is already flagged disconnected.
        }
      },
      resize: async (nextCols, nextRows) => {
        const next = boundSize(nextCols, nextRows, size)
        const reply = await request({ op: 'resize', cols: next.cols, rows: next.rows })
        // Only a size the bridge accepted becomes the fallback: a rejected or
        // timed-out request must not rewrite what a later impossible value falls
        // back to.
        if (reply.ok === true) size = next
      },
      inspectForeground: async () => {
        const reply = await request({ op: 'foreground' })
        if (typeof reply.pgrp !== 'number') return undefined
        // A pipe gives no input-waiting signal; the group is reported as not waiting.
        return { processGroupId: reply.pgrp, inputWaiting: false }
      },
      inspectActivity: async () => {
        // 'dead' is outside the seam's union ('idle' | 'busy' | 'unknown'), and
        // the retention policy acts only on 'idle' — so an exited terminal was
        // never reclaimed: its record, xterm screen and control process stayed
        // for the host lifetime. The reference provider reports a finished
        // terminal as idle, and this one now says the same.
        if (bridgeDown) return { state: 'idle', revision: 0 }
        const reply = await request({ op: 'activity' })
        return {
          state: reply.state === 'idle' || reply.state === 'busy' ? reply.state : 'unknown',
          revision: typeof reply.revision === 'number' ? reply.revision : 0,
        }
      },
      signalForeground: async (name) => {
        const reply = await request({ op: 'signal', signal: name })
        return typeof reply.pgrp === 'number' ? reply.pgrp : 0
      },
      terminate: async () => {
        try {
          await request({ op: 'terminate' })
        } catch {
          // A bridge that already died needs no termination request.
        }
        control.terminate()
        data.terminate()
        failPending('wsl-pty: 会话已终止')
        await Promise.allSettled([waitForHandle(data), waitForHandle(control)])
        // AFTER both processes have settled, from the host side: the bridge's
        // own finally lost this race often enough to leave orphans behind.
        await cleanupFifo()
      },
    }
  } catch (error) {
    termLog(`allocate failed: ${error.message} stderrTail=${JSON.stringify(stderrLines.slice(-8).join(' | ').slice(0, 600))}`)
    // A failed allocation must not leak the processes it already started: an
    // abandoned bridge would sit on its PTY until wsl.exe tears the whole
    // session down, and repeated failures would accumulate such processes.
    try {
      control?.terminate()
    } catch {
      // Already gone.
    }
    try {
      data.terminate()
    } catch {
      // Already gone.
    }
    await Promise.allSettled([
      waitForHandle(data),
      control !== null ? waitForHandle(control) : Promise.resolve(),
    ])
    // A session that never came up can still have created its FIFO (the bridge
    // makes it before it announces), so the failed-allocation path cleans up too:
    // rm -f is a no-op when it was never created.
    await cleanupFifo()
    throw error
  }
}

/**
 * Bound one promise, reporting a named failure on expiry.
 * @param {Promise<any>} promise - the work to bound.
 * @param {number} timeoutMs - the bound.
 * @param {string} message - failure text.
 * @returns {Promise<any>} the result, or a rejection naming the timeout.
 */
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Await a subprocess handle's exit, tolerating providers without the method.
 * @param {object} handle - a host subprocess handle.
 * @returns {Promise<void>} settlement.
 */
async function waitForHandle(handle) {
  if (typeof handle.waitForExit === 'function') {
    await handle.waitForExit()
    return
  }
  await handle.done.catch(() => undefined)
}
