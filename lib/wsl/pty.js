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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWslExecArgv, runWslShell } from './world.js'

/** How long a control round trip may take before it is reported as failed. */
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000

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
  const fifo = `/tmp/dsh-pty-${randomUUID().slice(0, 12)}.fifo`
  const select = { ...(wslPath !== undefined ? { wslPath } : {}), ...(username !== undefined ? { username } : {}) }
  termLog(`allocate: distro=${plan.distro} linuxCwd=${JSON.stringify(plan.linuxCwd)} windowsCwd=${JSON.stringify(plan.windowsCwd)} argv0=${JSON.stringify(argv[0])} cols=${String(size.cols)} rows=${String(size.rows)} fifo=${fifo}`)
  await requireBridgeRuntime(plan, select)
  termLog('allocate: bridge runtime ok')

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
  if (stderr === undefined) throw new Error('wsl-pty: 数据进程没有 stderr，无法承载控制应答')
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
    },
    (error) => {
      bridgeDown = true
      termLog(`data failed: ${String(error)}`)
      started.reject(error instanceof Error ? error : new Error(String(error)))
      failPending(`wsl-pty: 桥进程失败：${String(error)}`)
      control?.terminate()
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
        await Promise.allSettled([data.waitForExit?.() ?? waitForHandle(data), waitForHandle(control)])
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
