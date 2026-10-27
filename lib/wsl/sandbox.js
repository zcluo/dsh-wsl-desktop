/**
 * `ctx.sandbox` provider for a WSL distribution.
 *
 * Mounted inside a WSL agent preset's `isolate` realm, in the same group as the terminal
 * stack that resolves it, so `ctx.get('sandbox')` in that realm answers THIS provider
 * instead of the host's `@deepseek-ai/dsh-sandbox-local` (`preset.js` declares
 * `sandbox: true` in the group's isolation for exactly that reason).
 *
 * The host provider cannot confine this world: it wraps an argv in a Windows runner that
 * governs a Windows process tree, while the process a WSL realm spawns is `wsl.exe`, whose
 * children run on the Linux kernel side — and its workspace-write rung grants an ACL on the
 * policy's workspace root, which on a 9P UNC spelling fails before anything runs
 * (`sandbox-windows-acl` → `GetNamedSecurityInfoW`, Win32 1). Confinement therefore happens
 * INSIDE the distribution, through the same mechanism the realm's shell executor uses:
 * `./confinement.js` probes the distribution's identity and runner, `buildConfinedCommand`
 * builds the fence, and `dsh-wsl-confine` (or the direct `sudo -n unshare` runner) applies
 * it. `./confined-argv.js` presents that fence as the argv a PTY spawn needs.
 *
 * Deliberately NOT a silent passthrough: every confined mode either returns an enforcing
 * argv or throws {@link SandboxUnavailableError}, which is the seam's fail-closed contract
 * (`packages/sandbox/sandbox/src/index.ts`: "silent unconfined passthrough is forbidden").
 * @module dsh-wsl-desktop/wsl/sandbox
 */

import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { buildConfinedTerminalArgv } from './confined-argv.js'
import {
  DENIAL_SIGNATURES,
  RUNNER_HELPER,
  RUNNER_SUDO_UNSHARE,
  SETUP_FAILURE_EXIT,
  SETUP_FAILURE_MARKER,
  detectNoNewPrivs,
  detectRunner,
  noNewPrivsRefusal,
  resolveIdentity,
} from './confinement.js'
import { planWsl, runWslShell } from './world.js'

/** Plugin config: the distribution this realm's fence is built for. */
export const Config = z.object({
  /** Distribution the fence is established in. */
  distro: z.string(),
  /** Linux user to run as; omitted uses the distribution's default user. */
  username: z.string(),
  /** Path to `wsl.exe`. */
  wslPath: z.string().default('wsl.exe'),
  /** Linux working directory used when the policy names no workspace root. */
  cwd: z.string().default('/'),
  /**
   * Add a PID namespace to the fence. OFF for this provider's consumers on purpose: the
   * argv it wraps is an INTERACTIVE shell on a PTY, and a PID namespace re-parents that
   * shell to PID 1, which the PTY path cannot live with. Re-measured while closing the
   * /proc escape: `tcgetpgrp` alone DOES still resolve under `--pid --fork --mount-proc`
   * (TPGID names the shell's own pid), but driving the real `terminal-bridge.py` through
   * the same namespace HANGS — it never completes its start, so the terminal is dead.
   * The one-shot shell executor keeps the namespace (its own default); this is the
   * terminal path only.
   *
   * The /proc consequence is accepted HERE and closed on the one-shot path: with the
   * namespace off, a fresh procfs would still list the outer pids, so this arm carries no
   * `--mount-proc` either — mounting one would buy nothing. What the terminal path cannot
   * have, `shell.js` and the direct runner do have.
   */
  isolateProcesses: z.boolean().default(false),
})

/**
 * The denial dialect and the fence-failure rule this provider's runner produces.
 *
 * The SAME facts `shell.js` classifies its settled results with, read from the same
 * exports rather than restated: the kernel refuses a write with EROFS
 * (`DENIAL_SIGNATURES`), and the fence reports its own failure with exit
 * {@link SETUP_FAILURE_EXIT} plus {@link SETUP_FAILURE_MARKER} before it execs anything. A
 * consumer that sees the code without the marker is looking at a command that failed.
 */
const RUNNER_FAILURE_RULES = [{ allowedExitCodes: [SETUP_FAILURE_EXIT], fatalSignatures: [SETUP_FAILURE_MARKER] }]

/**
 * The WSL confinement provider.
 */
export class WslSandboxProvider extends SandboxProvider {
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
   * Wrap one argv so it runs confined inside the distribution.
   *
   * The policy arrives per call from the consumer (`terminal-bash` resolves it from the
   * session's logged mode), and its `workspaceRoot` is the session's own cwd — the UNC
   * spelling for a WSL session — so `planWsl` maps it to the Linux directory the fence
   * binds and the shell starts in. An unrepresentable root refuses the spawn instead of
   * faking a fence the command would escape.
   * @param {readonly string[]} argv - the exact argv the caller is about to spawn.
   * @param {object} policy - the resolved file-effect policy.
   * @param {AbortSignal} [signal] - cancellation while the probes run.
   * @returns {Promise<object>} the fenced argv plus this runner's enforcement facts.
   * @throws {SandboxUnavailableError} when a confined mode has no usable runner, when the
   *   distribution's setpriv cannot be measured, or when the workspace root cannot be
   *   mapped into the distribution.
   */
  async confine(argv, policy, signal) {
    signal?.throwIfAborted()
    const mode = policy.mode
    const root = policy.workspaceRoot
    let plan
    try {
      plan = planWsl(root === undefined || root === '' ? this.config.cwd ?? '/' : root, this.config.distro)
    } catch (error) {
      // The same class shell.js refuses an unmappable root with: this is a policy the
      // distribution cannot express, not a command that failed.
      throw new SandboxUnavailableError(mode, `wsl-sandbox: 工作区根目录无法映射到发行版内（${error.message}）`)
    }
    // Every probe spawns the CONFIGURED wsl.exe path, exactly as the shell executor's do:
    // a deployment that sets it because wsl.exe is not on PATH would otherwise get a
    // working spawn and a failing probe.
    const probeOptions = {
      distro: plan.distro,
      run: (options) => runWslShell({ ...options, wslPath: this.config.wslPath }),
      cacheKey: this.config.wslPath ?? '',
    }
    let identity
    try {
      identity = await resolveIdentity({
        ...probeOptions,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      })
    } catch (error) {
      // resolveIdentity throws with the probe's own output when its sentinel parse fails.
      throw new SandboxUnavailableError(mode, `wsl-sandbox: 无法解析发行版内的用户身份（${error.message}）`)
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
    // NO_NEW_PRIVS is needed only on the direct runner — the helper's own drop always sets
    // it — and the direct runner RUNS only when the flag was MEASURED present: an
    // unanswered probe is not an unsupported setpriv, and running anyway would report a
    // boundary that was never established (the refusal shell.js throws with too).
    let noNewPrivs = false
    if (runner === RUNNER_SUDO_UNSHARE) {
      const refusal = noNewPrivsRefusal(await detectNoNewPrivs({
        ...probeOptions,
        ...this.config.username !== undefined ? { username: this.config.username } : {},
      }))
      if (refusal !== null) throw new SandboxUnavailableError(mode, refusal)
      noNewPrivs = true
    }
    signal?.throwIfAborted()
    return {
      argv: buildConfinedTerminalArgv({
        argv,
        linuxCwd: plan.linuxCwd,
        mode,
        // The policy's root IS the mapped cwd (planWsl applied the same three spellings the
        // shell executor's own translation uses), and the builder judges the spelling again
        // before it becomes exemption-pattern data. read-only carries no writable root.
        workspaceLinuxRoot: mode === 'workspace-write' ? plan.linuxCwd : undefined,
        identity,
        noNewPrivs,
        runner,
        isolateProcesses: this.config.isolateProcesses,
      }),
      // `partial`, never `full` — the same boundary the shell executor reports, for the same
      // reasons (device and kernel surfaces stay writable; interop can still run a Windows
      // program; the session user keeps the passwordless grant the runner itself requires,
      // closed on both runners by NO_NEW_PRIVS).
      enforcement: 'partial',
      denialSignatures: DENIAL_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE_RULES,
    }
  }
}

export default WslSandboxProvider
