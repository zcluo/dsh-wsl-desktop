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

import { randomUUID } from 'node:crypto'
import { buildWslExecArgv, runWslShell } from './world.js'

/** How long a control round trip may take before it is reported as failed. */
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000

/** Prefix the bridge puts on every control reply line. */
const REPLY_PREFIX = '#dsh-pty '

/** Distributions already confirmed to carry the bridge's runtime. */
const verifiedDistros = new Set()

/**
 * Confirm the distribution can run the bridge before allocating anything.
 *
 * The bridge is Python standard library only, so the runtime is the one real
 * dependency. Checking once per distribution turns a confusing mid-spawn
 * failure into a clear message.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {object} options - probe inputs.
 * @param {string} [options.username] - Linux user for the probe.
 * @returns {Promise<void>} settlement.
 * @throws Error naming the missing runtime.
 */
async function requireBridgeRuntime(plan, options) {
  if (verifiedDistros.has(plan.distro)) return
  const probe = await runWslShell({
    distro: plan.distro,
    linuxCwd: '/',
    ...options.username !== undefined && options.username !== '' ? { username: options.username } : {},
    command: 'command -v python3 >/dev/null 2>&1 && echo yes || echo no',
    timeoutMs: 15_000,
  })
  if (!probe.stdout.includes('yes')) {
    throw new Error(`wsl-pty: 发行版 ${plan.distro} 里没有 python3，无法分配终端`)
  }
  verifiedDistros.add(plan.distro)
}

/**
 * Start one PTY session inside a distribution.
 * @param {object} options - spawn inputs.
 * @param {object} options.local - the host subprocess provider.
 * @param {{ distro: string, linuxCwd: string, windowsCwd: string }} options.plan - the execution plan.
 * @param {string} options.bridgeSource - the bridge program's source text.
 * @param {readonly string[]} options.argv - the program to run on the PTY.
 * @param {number} options.cols - initial columns.
 * @param {number} options.rows - initial rows.
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
  const fifo = `/tmp/dsh-pty-${randomUUID().slice(0, 12)}.fifo`
  const select = { ...(wslPath !== undefined ? { wslPath } : {}), ...(username !== undefined ? { username } : {}) }
  await requireBridgeRuntime(plan, select)

  const replies = []
  const waiters = []
  let replyBuffer = ''
  let started
  const startedPromise = new Promise((resolve, reject) => { started = { resolve, reject } })

  const dataSpec = {
    argv: buildWslExecArgv(plan, ['python3', '-c', bridgeSource, fifo, String(cols), String(rows), ...argv], select),
    cwd: plan.windowsCwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    ...signal !== undefined ? { signal } : {},
    ...env !== undefined ? { env } : {},
  }
  const data = local.spawn(dataSpec)

  /**
   * Hand one parsed reply to the pending request, or queue it.
   * @param {object} reply - the decoded reply.
   */
  function deliver(reply) {
    if (reply.event === 'started') {
      started.resolve(reply)
      return
    }
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(reply)
    else replies.push(reply)
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
      if (!line.startsWith(REPLY_PREFIX)) continue
      try {
        deliver(JSON.parse(line.slice(REPLY_PREFIX.length)))
      } catch {
        // A malformed reply is dropped; the pending request times out instead.
      }
    }
  })

  data.done.then(
    (outcome) => started.reject(new Error(`wsl-pty: 桥在报告会话之前退出（exit=${String(outcome.exitCode)}）`)),
    (error) => started.reject(error),
  )

  // The bridge creates the FIFO before announcing the session, so the control
  // writer can safely be started only after that announcement.
  const announce = await withTimeout(startedPromise, controlTimeoutMs, 'wsl-pty: 桥没有报告会话')

  const control = local.spawn({
    argv: buildWslExecArgv(plan, [
      'bash', '-c',
      'exec 3>"$1" || exit 1; while IFS= read -r line; do printf \'%s\\n\' "$line" >&3; done',
      'bash', fifo,
    ], select),
    cwd: plan.windowsCwd,
    stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
    graceMs,
    ...env !== undefined ? { env } : {},
  })

  /** Send one control request and await its reply. */
  function request(payload) {
    const queued = replies.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    const answer = new Promise((resolve) => waiters.push(resolve))
    control.stdin?.write(`${JSON.stringify(payload)}\n`)
    return withTimeout(answer, controlTimeoutMs, `wsl-pty: 控制请求超时（${String(payload.op)}）`)
  }

  return {
    pid: typeof announce.pid === 'number' ? announce.pid : 0,
    output: data.stdout,
    done: data.done,
    write: async (chunk) => {
      data.stdin?.write(chunk)
    },
    resize: async (nextCols, nextRows) => {
      await request({ op: 'resize', cols: nextCols, rows: nextRows })
    },
    inspectForeground: async () => {
      const reply = await request({ op: 'foreground' })
      if (typeof reply.pgrp !== 'number') return undefined
      // A pipe gives no input-waiting signal; the group is reported as not waiting.
      return { processGroupId: reply.pgrp, inputWaiting: false }
    },
    inspectActivity: async () => {
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
      await Promise.allSettled([data.waitForExit?.(), waitForHandle(control)])
    },
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
