/**
 * `ctx.shell` provider for a WSL distribution.
 *
 * Mounted inside a WSL agent preset's `isolate` realm, so the realm's
 * `tool-bash` resolves this executor instead of the host's PowerShell one. The
 * `wsl.exe` process itself is an ordinary Windows process, so it is started
 * through the *inherited* `ctx.subprocess` — the realm isolates `shell` and
 * `fs`, not `subprocess` — which keeps managed-range termination, output spill
 * and disposal with the local provider.
 *
 * Confinement is applied inside the distribution rather than through the host's
 * `ctx.sandbox`: a `wsl.exe` process has no meaningful Windows-side wrapper,
 * because its children run on the Linux kernel side. The confined modes wrap
 * the inner command in a mount namespace (see `./confinement.js`) and report
 * the seam's sandbox facts on the result.
 *
 * Deliberately extends `ShellExecutor` rather than `LocalBashExecutor`: the
 * local executor installs the `shell` settings section in its constructor, and
 * a second provider of that section for the same realm would collide.
 * @module dsh-wsl-desktop/wsl/shell
 */

import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
import {
  DENIAL_SIGNATURES,
  RUNNER_HELPER,
  RUNNER_SUDO_UNSHARE,
  buildConfinedCommand,
  detectNoNewPrivs,
  detectRunner,
  resolveIdentity,
  workspaceRootInLinux,
} from './confinement.js'
import { parseWslUnc, shellQuote, windowsToMntPath } from './paths.js'
import { planWsl, runWslShell, withWslEnvFlags } from './world.js'

/** Model-readable environment overrides applied to every command. */
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }

/** Default foreground timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Upper bound for a per-call timeout override. */
const DEFAULT_MAX_TIMEOUT_MS = 600_000

/** Per-stream in-memory output cap. */
const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/** Per-stream spill-file cap. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** SIGTERM→SIGKILL grace for the managed process range. */
const DEFAULT_GRACE_MS = 3_000

/** Plugin config: the local executor's shape plus the distribution choice. */
export const Config = z.object({
  cwd: z.string(),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxTimeoutMs: z.number().default(DEFAULT_MAX_TIMEOUT_MS),
  maxOutputBytes: z.number().default(DEFAULT_MAX_OUTPUT_BYTES),
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
  /** Distribution used when a working directory does not already name one. */
  distro: z.string(),
  /** Linux user to run as; omitted uses the distribution's default user. */
  username: z.string(),
  /** Path to `wsl.exe`. */
  wslPath: z.string().default('wsl.exe'),
  /** Run `bash -lc` instead of `bash -c`. */
  loginShell: z.boolean().default(true),
  /** Add a PID namespace to confined commands. */
  isolateProcesses: z.boolean().default(true),
})

/**
 * Translate a host spelling into the Linux dialect.
 * @param {string} value - UNC, drive, or Linux path.
 * @returns {string | null} the Linux path, or null when the value names no world.
 */
function toLinux(value) {
  const unc = parseWslUnc(value)
  if (unc !== null) return unc.linuxPath
  if (value.startsWith('/')) return value
  return windowsToMntPath(value)
}

/**
 * Build the Linux argv this executor hands to `ctx.subprocess`.
 *
 * The realm's `ctx.subprocess` is the WSL provider, so this stays in the
 * distribution's terms: a `bash` invocation with a Linux working directory. The
 * `wsl.exe` wrapper belongs to that provider, not here.
 *
 * A login shell may run profile scripts that reset the working directory, so
 * the requested directory is re-asserted inside the script.
 * @param {{ linuxCwd: string }} plan - the execution plan.
 * @param {string} command - shell source from the caller.
 * @param {{ loginShell?: boolean }} options - executor settings.
 * @returns {string[]} the Linux argv.
 */
export function buildLinuxShellArgv(plan, command, options) {
  const login = options.loginShell !== false
  const script = login ? `cd ${shellQuote(plan.linuxCwd)} && ${command}` : command
  return ['bash', login ? '-lc' : '-c', script]
}

/**
 * The WSL bash executor.
 */
export class WslShellExecutor extends ShellExecutor {
  static inject = ['subprocess', 'sandboxPolicy']

  static Config = Config

  /** Validated config. */
  config

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the preset realm context.
   * @param {object} config - resolved plugin config.
   */
  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  /**
   * The default mode this executor enforces — the capability fact the tool layer reads.
   * @returns {string} the deployment default mode.
   */
  get sandboxMode() {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /**
   * Fill the caller's request with this executor's defaults, the plan and the policy.
   * @param {object} request - the caller's request.
   * @returns {object} the fully-specified spec, carrying a private `wslPlan`.
   */
  resolve(request) {
    const timeoutMs = Math.min(request.timeoutMs ?? this.config.timeoutMs, this.config.maxTimeoutMs)
    const workdir = request.workdir ?? this.config.cwd ?? process.cwd()
    return {
      command: request.command,
      workdir,
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.config.maxOutputBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
      wslPlan: planWsl(workdir, this.config.distro),
    }
  }

  /**
   * Wrap the caller's command in the distribution's confinement when the policy
   * requires it, or return it unchanged for full access.
   * @param {object} spec - a resolved spec.
   * @returns {Promise<{ command: string, sandbox: object }>} the command to run and its facts.
   * @throws {SandboxUnavailableError} when a confined mode has no usable runner.
   */
  async confinementFor(spec) {
    const mode = spec.sandboxPolicy?.mode ?? this.ctx.sandboxPolicy.defaultMode
    if (mode === 'danger-full-access') {
      return { command: spec.command, sandbox: { mode, denied: false } }
    }
    const plan = spec.wslPlan ?? planWsl(spec.workdir, this.config.distro)
    const probeOptions = { distro: plan.distro, run: runWslShell }
    let identity
    try {
      identity = await resolveIdentity({
        ...probeOptions,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      })
    } catch (error) {
      // resolveIdentity throws with the probe's actual output when its
      // sentinel parse fails — keep that evidence on the fail-closed error.
      throw new SandboxUnavailableError(mode, `wsl-sandbox: 无法解析发行版内的用户身份（${error.message}）`)
    }
    if (identity === null) {
      throw new SandboxUnavailableError(mode, 'wsl-sandbox: 无法解析发行版内的用户身份')
    }
    const runner = await detectRunner({
      ...probeOptions,
      ...this.config.username !== undefined ? { username: this.config.username } : {},
    })
    if (runner !== RUNNER_HELPER && runner !== RUNNER_SUDO_UNSHARE) {
      throw new SandboxUnavailableError(
        mode,
        'wsl-sandbox: 发行版内没有可用的约束运行器（需要免密 sudo、unshare 与 setpriv，或已安装 dsh-wsl-confine helper）',
      )
    }
    // NO_NEW_PRIVS hardening is needed only on the direct sudo-unshare path —
    // the helper's own drop always sets it. Without either mechanism the
    // session user's retained sudo grant can re-fence-defeat at will.
    let noNewPrivs = false
    if (runner === RUNNER_SUDO_UNSHARE) {
      noNewPrivs = await detectNoNewPrivs({
        ...probeOptions,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      })
    }
    const workspaceLinuxRoot = workspaceRootInLinux(spec.sandboxPolicy?.workspaceRoot, plan.linuxCwd, toLinux)
    if (workspaceLinuxRoot === null) {
      throw new SandboxUnavailableError(mode, 'wsl-sandbox: 工作区根目录无法映射到发行版内')
    }
    return {
      command: buildConfinedCommand({
        command: spec.command,
        linuxCwd: plan.linuxCwd,
        mode,
        runner,
        workspaceLinuxRoot: workspaceLinuxRoot ?? undefined,
        identity,
        noNewPrivs,
        isolateProcesses: this.config.isolateProcesses,
      }),
      // `partial`, never `full`. The mount namespace governs the file-storage
      // mounts (verified inside it, and a failure exits with the setup-failure
      // code rather than running anyway), but it cannot govern things the
      // seam's `full` promises: device and kernel surfaces (`/dev`, `/proc`,
      // `/sys` stay writable, because a read-only devtmpfs breaks the process);
      // interop — a confined command may still ask `wsl.exe` to run a Windows
      // program that writes files; and privilege re-escalation — the session
      // user keeps the passwordless sudo grant the confinement runner itself
      // requires. When the distro's setpriv supports NO_NEW_PRIVS the drop
      // sets it and sudo inside the fence fails loudly; on distros without
      // that flag a deliberately non-compliant command can void the file
      // fence via retained sudo (see README). Reporting `full` here was wrong.
      sandbox: { mode, denied: false, enforcement: 'partial', noNewPrivs },
    }
  }

  /**
   * Build the subprocess spawn the executor hands to `ctx.subprocess`.
   * @param {object} spec - a resolved spec.
   * @param {number} stdoutMaxBytes - stdout capture cap.
   * @param {AbortSignal | undefined} signal - cancellation for the spawn.
   * @param {string | undefined} command - the command to run, already confined.
   * @returns {object} the spawn spec, in the distribution's own terms.
   */
  spawnSpec(spec, stdoutMaxBytes, signal, command) {
    const plan = spec.wslPlan ?? planWsl(spec.workdir, this.config.distro)
    const collect = (maxBytes) => ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: buildLinuxShellArgv(plan, command ?? spec.command, { loginShell: this.config.loginShell }),
      cwd: plan.linuxCwd,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      env: withWslEnvFlags({ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }),
    }
  }

  /**
   * Reader pair the executor itself requested.
   * @param {object} handle - the live subprocess handle.
   * @returns {{ stdout: object, stderr: object }} the collect readers.
   */
  static readers(handle) {
    const { stdout, stderr } = handle.collected
    if (stdout === undefined || stderr === undefined) {
      throw new Error('wsl-shell: subprocess provider dropped a requested collect stream')
    }
    return { stdout, stderr }
  }

  /**
   * Read one settled collect reader into the seam's output shape.
   * @param {object} reader - the collect reader.
   * @returns {{ text: string, truncated: boolean, spillPath?: string }} the collected output.
   */
  static settled(reader) {
    const read = reader.readFrom(0)
    return {
      text: read.text,
      truncated: read.lossy,
      ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
    }
  }

  /**
   * Decide whether a settled result was refused by the confinement.
   * @param {{ exitCode: number | null }} result - the settled result.
   * @param {string} stderr - retained stderr text.
   * @returns {boolean} true when the kernel refused a write.
   */
  static wasDenied(result, stderr) {
    return result.exitCode !== 0 && DENIAL_SIGNATURES.some((signature) => stderr.includes(signature))
  }

  /**
   * Run one foreground command.
   *
   * 0.1.7 contract: `execute` resolves with a live ShellExecution handle —
   * `{ status, exitCode, signal, done, sandbox?, readOutput(), result() }` —
   * whose memoized `result()` projection settles with the seam's run result
   * (first-cause timedOut/aborted, split collected streams). `run` is kept as
   * an alias returning the same handle for pre-0.1.7 callers.
   * @param {object} spec - a resolved spec.
   * @returns {Promise<object>} the live execution handle.
   */
  async execute(spec) {
    const { command, sandbox } = await this.confinementFor(spec)
    const deadline = this.deadlineFor(spec)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, deadline.signal, command))
    // Async EPIPE guard on the spawned stdin (same as the pty transport).
    handle.stdin?.on?.('error', () => {})
    const { stdout, stderr } = WslShellExecutor.readers(handle)
    const state = { status: 'running', exitCode: null, signal: null }
    const settledRef = { current: null }
    let readOffset = 0
    const done = handle.done.then((outcome) => {
      const timedOut = deadline.timedOut()
      const aborted = spec.signal?.aborted === true && !timedOut
      const settledErr = WslShellExecutor.settled(stderr)
      settledRef.current = {
        ...outcome,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: WslShellExecutor.settled(stdout),
        stderr: settledErr,
        sandbox: { ...sandbox, denied: WslShellExecutor.wasDenied(outcome, settledErr.text) },
      }
      state.status = aborted ? 'aborted' : timedOut ? 'timedOut' : 'completed'
      state.exitCode = outcome.exitCode
      state.signal = outcome.signal
      deadline.dispose()
    })
    return {
      get status() { return state.status },
      get exitCode() { return state.exitCode },
      get signal() { return state.signal },
      done,
      sandbox: { ...sandbox },
      readOutput() {
        const stdoutRead = stdout.readFrom(readOffset)
        // Resume from the reader's own nextOffset, not `text.length`: the
        // collect contract is BYTE-offset based (SubprocessOutputRead), and
        // a UTF-16 code-unit count diverges from it for any non-ASCII
        // output — the second read would resume mid-stream and duplicate or
        // garble text. start() already advanced this way.
        readOffset = stdoutRead.nextOffset
        const stderrRead = stderr.readFrom(0)
        return {
          delta: stderrRead.text !== '' ? `${stdoutRead.text}\n[stderr]\n${stderrRead.text}` : stdoutRead.text,
          lossy: stdoutRead.lossy || stderrRead.lossy,
          ...(stdoutRead.spillPath !== undefined ? { stdoutSpillPath: stdoutRead.spillPath } : {}),
          ...(stderrRead.spillPath !== undefined ? { stderrSpillPath: stderrRead.spillPath } : {}),
        }
      },
      result() {
        if (settledRef.current !== null) return Promise.resolve(settledRef.current)
        return done.then(() => {
          if (settledRef.current === null) {
            throw new Error('wsl-shell: 进程已关闭但没有可用的结果投影')
          }
          return settledRef.current
        })
      },
    }
  }

  /** Pre-0.1.7 spelling of {@link WslShellExecutor.execute}; kept as an alias. */
  run(spec) {
    return this.execute(spec)
  }

  /**
   * Start one background command.
   * @param {object} spec - a resolved spec.
   * @returns {Promise<object>} the live shell process handle.
   */
  async start(spec) {
    spec.signal?.throwIfAborted()
    const { command, sandbox } = await this.confinementFor(spec)
    const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal, command))
    const { stdout, stderr } = WslShellExecutor.readers(running)
    let stdoutOffset = 0
    let stderrOffset = 0
    let stderrTail
    let observed = ''
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        proc.sandbox = { ...sandbox, denied: WslShellExecutor.wasDenied(outcome, observed) }
      }, (error) => {
        // A background provider failure settles as killed and surfaces on read.
        proc.status = 'killed'
        proc.exitCode = null
        proc.signal = null
        stderrTail = `subprocess failed before reporting an outcome: ${String(error)}`
      }),
      readOutput: () => {
        const out = stdout.readFrom(stdoutOffset)
        const err = stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset
        const errText = err.text + (stderrTail === undefined ? '' : `\n${stderrTail}`)
        stderrTail = undefined
        // Retained tail for the denial classification, which runs after the last read.
        observed = (observed + errText).slice(-4096)
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        return {
          delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: () => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }

  /**
   * Arm this executor's timeout around the caller's own signal.
   * @param {object} spec - a resolved spec.
   * @returns {{ signal: AbortSignal, timedOut: () => boolean, dispose: () => void }} the deadline.
   */
  deadlineFor(spec) {
    const controller = new AbortController()
    let expired = false
    const timer = spec.timeoutMs > 0
      ? setTimeout(() => {
        expired = true
        controller.abort(new Error('WSL_BASH_TIMEOUT'))
      }, spec.timeoutMs)
      : undefined
    const relay = () => controller.abort(spec.signal?.reason)
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) relay()
      else spec.signal.addEventListener('abort', relay, { once: true })
    }
    return {
      signal: controller.signal,
      timedOut: () => expired,
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer)
        spec.signal?.removeEventListener('abort', relay)
      },
    }
  }
}

export default WslShellExecutor