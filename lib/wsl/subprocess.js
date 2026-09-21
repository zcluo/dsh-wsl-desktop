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
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { requireLocalSubprocess } from './host-refs.js'
import { shellQuote } from './paths.js'
import { spawnWslTerminal, termLog } from './pty.js'
import { buildWslExecArgv, planWsl, resolveLoginShell, runWslShell, withWslEnvFlags } from './world.js'

/** Executable lookup is a short probe, not a run. */
const LOOKUP_TIMEOUT_MS = 15_000

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
   * @param {import('@deepseek-ai/cordis').Context} ctx - the preset realm context.
   * @param {object} config - resolved plugin config.
   */
  constructor(ctx, config) {
    super(ctx)
    this.config = config
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
    const plan = planWsl(this.config.cwd ?? '/', this.config.distro)
    const probe = command.startsWith('/')
      ? `[ -x ${shellQuote(command)} ] && printf '%s\\n' ${shellQuote(command)}`
      : `command -v ${shellQuote(command)}`
    const result = await runWslShell({
      distro: plan.distro,
      linuxCwd: plan.linuxCwd,
      command: probe,
      // Output-parsed probe: non-login, so profile output can never become the
      // executable path that later gets spawned.
      loginShell: false,
      ...this.config.username !== undefined ? { username: this.config.username } : {},
      ...env !== undefined ? { env } : {},
      timeoutMs: LOOKUP_TIMEOUT_MS,
      ...signal !== undefined ? { signal } : {},
    })
    const found = result.stdout.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
    if (found === undefined) {
      // The terminal controller resolves the deployment's configured default
      // shell (PowerShell on a Windows deployment) through THIS provider; in
      // the distribution that dialect-translates to the session user's login
      // shell. Absent any Windows shell, the login shell is the honest answer.
      const base = String(command).split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
      if (WINDOWS_SHELLS.has(base)) {
        return resolveLoginShell(plan.distro, this.config.username)
      }
      throw new Error(`wsl-subprocess: 在发行版 ${plan.distro} 里找不到可执行文件 ${command}`)
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
    const plan = planWsl(spec.cwd, this.config.distro)
    return requireLocalSubprocess().spawn({
      ...spec,
      argv: buildWslExecArgv(plan, spec.argv, {
        wslPath: this.config.wslPath,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      }),
      cwd: plan.windowsCwd,
      env: withWslEnvFlags(spec.env ?? {}),
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
      const plan = planWsl(spec.cwd, this.config.distro)
      // The controller resolves the deployment's configured default shell
      // (PowerShell on Windows) through THIS provider; in the distribution
      // that dialect-translates to the session user's login shell — a lone
      // '-NoLogo' arg would kill bash, so the whole argv is translated.
      const base0 = String(spec.argv?.[0] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
      const terminalArgv = WINDOWS_SHELLS.has(base0)
        ? [await resolveLoginShell(plan.distro, this.config.username)]
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
        env: { ...withWslEnvFlags(spec.env ?? {}), ...(spec.terminalType !== undefined ? { TERM: spec.terminalType } : {}) },
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
