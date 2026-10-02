/**
 * `ctx.subprocess` provider for a WSL distribution.
 *
 * Mounted inside a WSL agent preset's `isolate` realm so pipe-based consumers —
 * language servers, and anything else that speaks JSON-RPC over stdio — run
 * inside the distribution rather than on the Windows host.
 *
 * The provider is deliberately thin. Starting `wsl.exe` is starting an ordinary
 * Windows process, so every spawn is delegated to the *host's* subprocess
 * provider (captured in `./host-refs.js`), which keeps managed-range
 * termination, output spill, reader offsets and disposal with their owner. What
 * this provider adds is the argv translation and the executable lookup.
 *
 * Two operations are refused rather than approximated:
 * - `stdio.control` is the file-descriptor channel PTC uses; `wsl.exe` cannot
 *   forward an arbitrary descriptor, so a spawn asking for it is rejected
 *   instead of silently handing back an unconnected duplex.
 * - `spawnTerminal` needs a PTY. `wsl.exe` pipes are not a terminal, and the
 *   repository's own subprocess provider documents terminal allocation as
 *   unsupported on win32; a caller is told so explicitly.
 * @module dsh-wsl-desktop/wsl/subprocess
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SubprocessExecutableNotFoundError, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { requireLocalSubprocess } from './host-refs.js'
import { shellQuote } from './paths.js'
import { spawnWslTerminal, termLog } from './pty.js'
import { WSL_CHILD_ENV, buildWslExecArgv, planWsl, resolveLoginShell, runWslShell, withWslEnvFlags } from './world.js'

/**
 * The executable lookup's ceiling, on the documented probe policy.
 *
 * Was 15s and the shortest ceiling in the plugin. README.md:132 / README.en.md:132 name
 * `resolveExecutable` in the same sentence as 探针超时 60s + 超时后一次透明重试, and it is an
 * output-parsed probe like the siblings that sentence lists (the comment on the probe below
 * says so), so it gets the same 60s as `listLinuxDir`/`checkLinuxPath`/`resolveDistroHome`
 * and the same single repeat. The ceiling is not a latency budget: it is the point past which
 * a probe that produced NO answer is reported instead of being believed.
 */
const LOOKUP_TIMEOUT_MS = 60_000

/** Windows shells whose names the terminal controller may probe inside the distribution. */
const WINDOWS_SHELLS = new Set(['powershell', 'pwsh', 'cmd'])

/** The PTY bridge shipped beside this module. */
const BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'terminal-bridge.py')

/** The bridge source, read once per process. */
let bridgeSource

/** Plugin config. */
export const Config = z.object({
  /** Default distribution for working directories that do not name one. */
  distro: z.string(),
  /** Baseline working directory in the distribution. */
  cwd: z.string().default('/'),
  /** Linux user to run as; omitted uses the distribution's default user. */
  username: z.string(),
  /** Path to `wsl.exe`. */
  wslPath: z.string().default('wsl.exe'),
  /** Shell the terminal consumer should prefer inside the distribution. */
  defaultShell: z.string().default('/bin/bash'),
})

/**
 * The WSL subprocess provider.
 */
export class WslSubprocessRuntime extends SubprocessRuntime {
  static Config = Config

  /** Validated config. */
  config

  /**
   * The distribution the most recent request named, when it named one.
   *
   * A realm serves one session, so this is that session's distribution. It
   * exists for the one lookup with no request context —
   * {@link WslSubprocessRuntime.resolveExecutable}, which the terminal
   * controller calls with a bare executable name and no directory.
   */
  activeDistro

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the preset realm context.
   * @param {object} config - resolved plugin config.
   */
  constructor(ctx, config) {
    super(ctx)
    this.config = config
  }

  /**
   * Resolve one request's execution plan.
   *
   * A request that names its distribution (`wslDistro`) wins over the
   * configured/default one. The shell executor hands over the LINUX `cwd`
   * alone, and a Linux path carries no distribution: deriving it from
   * `config.distro` or the Windows default silently ran a workspace's
   * commands in a different distribution whenever the two disagreed.
   * Pure by design — recording the name is {@link WslSubprocessRuntime.rememberDistro},
   * called separately, so this method does not hide a state change.
   * @param {string} cwd - the request's working directory.
   * @param {string | undefined} wslDistro - the distribution the caller named.
   * @returns {{ distro: string, linuxCwd: string, windowsCwd: string }} the plan.
   */
  planFor(cwd, wslDistro) {
    return planWsl(cwd, wslDistro ?? this.config.distro)
  }

  /**
   * Record the distribution a request named, for the one lookup that has no
   * request context of its own ({@link WslSubprocessRuntime.resolveExecutable}).
   * @param {string | undefined} wslDistro - the distribution the caller named.
   */
  rememberDistro(wslDistro) {
    if (typeof wslDistro === 'string' && wslDistro !== '') this.activeDistro = wslDistro
  }

  /**
   * Resolve one executable inside the distribution.
   * @param {string} command - absolute Linux path or bare `PATH` name.
   * @param {Record<string, string>} [env] - explicit environment for the lookup.
   * @param {AbortSignal} [signal] - lookup cancellation.
   * @returns {Promise<string>} the canonical executable path in the distribution.
   * @throws Error when no executable matches.
   */
  async resolveExecutable(command, env, signal) {
    const plan = planWsl(this.config.cwd ?? '/', this.activeDistro ?? this.config.distro)
    const probe = command.startsWith('/')
      ? `[ -x ${shellQuote(command)} ] && printf '%s\\n' ${shellQuote(command)}`
      : `command -v ${shellQuote(command)}`
    const request = {
      distro: plan.distro,
      linuxCwd: plan.linuxCwd,
      command: probe,
      // Output-parsed probe: non-login, so profile output can never become the
      // executable path that later gets spawned.
      loginShell: false,
      ...this.config.username !== undefined ? { username: this.config.username } : {},
      // The lookup is a wsl.exe spawn like any other: it must run the configured
      // executable, or a deployment whose wsl.exe is not on PATH resolves no
      // executable here while its real spawns keep working.
      wslPath: this.config.wslPath,
      ...env !== undefined ? { env } : {},
      timeoutMs: LOOKUP_TIMEOUT_MS,
      ...signal !== undefined ? { signal } : {},
    }
    const ask = () => runWslShell(request)
    // The SAME ruling as `resolveIdentity`/`detectRunner`/`detectNoNewPrivs` in
    // confinement.js, in the same shape (one repeat of the SAME probe, triggered by
    // `timedOut` alone — not a second convention): a timeout is NOT an answer, and the
    // guard below reads an empty answer as "the distribution has no such executable".
    // A retry cannot launder a miss: a command that is genuinely absent answers in one
    // attempt (a fast, non-zero `command -v`), which is why the trigger is the timeout
    // and not "any bad answer". An abort is not a timeout either — `runWslShell` leaves
    // `timedOut` false for it — so a cancelled lookup is never repeated.
    let result = await ask()
    if (result.timedOut === true) result = await ask()
    const found = result.stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
    if (found === undefined) {
      // The terminal controller resolves the deployment's configured default
      // shell (PowerShell on a Windows deployment) through THIS provider; in
      // the distribution that dialect-translates to the session user's login
      // shell. Absent any Windows shell, the login shell is the honest answer.
      const base = String(command).split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
      if (WINDOWS_SHELLS.has(base)) {
        return resolveLoginShell(plan.distro, this.config.username, { wslPath: this.config.wslPath })
      }
      // The structured class, not a plain Error: the terminal controller
      // catches exactly this type to SKIP a candidate and continue down its
      // shell list (zsh, fish, ... are commonly absent from a distribution).
      // A plain Error rejected the whole discovery instead, so the terminal
      // shell dropdown failed on every distro.
      throw new SubprocessExecutableNotFoundError(`wsl-subprocess: 在发行版 ${plan.distro} 里找不到可执行文件 ${command}`)
    }
    return found
  }

  /**
   * Report the distribution's shell-selection facts.
   * @returns {Promise<{ platform: 'posix', defaultShell: string }>} the terminal environment.
   */
  async terminalEnvironment() {
    return { platform: 'posix', defaultShell: this.config.defaultShell }
  }

  /**
   * Start one managed process inside the distribution.
   * @param {object} spec - argv, directory, stdio, grace, cancellation and environment.
   * @returns {object} the host provider's live process handle.
   * @throws Error when the spec asks for a descriptor channel the transport cannot carry.
   */
  spawn(spec) {
    if (spec.stdio?.control === 'pipe') {
      throw new Error('wsl-subprocess: wsl.exe 无法转发控制描述符，因此不支持 stdio.control')
    }
    // `wslDistro` is this plugin's own field on the spec the shell executor
    // hands over; it is not part of the seam's request shape, so it is
    // stripped before the host provider sees the request.
    const { wslDistro, ...request } = spec
    this.rememberDistro(wslDistro)
    const plan = this.planFor(request.cwd, wslDistro)
    return requireLocalSubprocess().spawn({
      ...request,
      argv: buildWslExecArgv(plan, request.argv, {
        wslPath: this.config.wslPath,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      }),
      cwd: plan.windowsCwd,
      env: withWslEnvFlags({ ...WSL_CHILD_ENV, ...request.env }),
    })
  }

  /**
   * Allocate a real PTY inside the distribution and run the program on it.
   *
   * `wsl.exe` pipes are not a terminal, so `terminal-bridge.py` allocates one on
   * the Linux side and this provider drives it: terminal bytes over the data
   * process, and resize, foreground inspection, signalling and termination over
   * a FIFO the second process holds open.
   * @param {object} spec - argv, directory, dimensions, environment and cancellation.
   * @returns {Promise<object>} the live terminal handle.
   */
  async spawnTerminal(spec) {
    try {
      bridgeSource ??= await readFile(BRIDGE_PATH, 'utf8')
      this.rememberDistro(spec.wslDistro)
      const plan = this.planFor(spec.cwd, spec.wslDistro)
      // The controller resolves the deployment's configured default shell
      // (PowerShell on Windows) through THIS provider; in the distribution
      // that dialect-translates to the session user's login shell — a lone
      // '-NoLogo' arg would kill bash, so the whole argv is translated.
      const base0 = String(spec.argv?.[0] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
      const terminalArgv = WINDOWS_SHELLS.has(base0)
        ? [await resolveLoginShell(plan.distro, this.config.username, { wslPath: this.config.wslPath })]
        : spec.argv
      termLog(`spawnTerminal: distro=${plan.distro} linuxCwd=${JSON.stringify(plan.linuxCwd)} terminalArgv=${JSON.stringify(terminalArgv)} terminalType=${String(spec.terminalType)} username=${JSON.stringify(this.config.username ?? null)}`)
      const handle = await spawnWslTerminal({
        local: requireLocalSubprocess(),
        plan,
        bridgeSource,
        argv: terminalArgv,
        cols: spec.cols,
        rows: spec.rows,
        graceMs: spec.graceMs,
        // The consumer names the terminal type; the distribution must see it.
        // Absent means "leave TERM alone", not "shadow it with nothing".
        // TERM is folded in BEFORE the flags are derived: withWslEnvFlags
        // builds the WSLENV list from the map it is handed, so adding TERM
        // afterwards left it out of that list and the variable never crossed
        // wsl.exe — the requested terminalType was silently ignored.
        env: withWslEnvFlags({ ...WSL_CHILD_ENV, ...spec.env, ...(spec.terminalType !== undefined ? { TERM: spec.terminalType } : {}) }),
        ...spec.signal !== undefined ? { signal: spec.signal } : {},
        wslPath: this.config.wslPath,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      })
      termLog('spawnTerminal: allocated')
      return handle
    } catch (error) {
      termLog(`spawnTerminal FAILED: ${error.message}`)
      throw error
    }
  }
}

export default WslSubprocessRuntime
