/**
 * The argv a PTY-attached spawn gets when the realm's sandbox confines it.
 *
 * This module builds NO fence of its own. The fence — mount namespace, workspace bind,
 * private tmpfs, read-only sweep, postconditions, setpriv drop — is
 * `buildConfinedCommand` (`./confinement.js`), the ONE builder the realm's shell
 * executor also runs (`./shell.js`), and the runner it selects is the distribution's
 * own (`sudo -n <dsh-wsl-confine> …` or `sudo -n unshare …`). What is added here is the
 * presentation: the terminal spawn needs an ARGV, the builder produces the shell COMMAND
 * that establishes the fence, so the command is handed to `bash -lc` and the caller's own
 * program travels into the fence as `exec`'d argv.
 *
 * Why the caller's argv is re-quoted instead of passed through: both runners take the
 * command as ONE shell word and hand it to the distribution's shell after their own
 * privilege drop (`shell.js` passes its caller's shell source the same way). Re-quoting
 * each element with `shellQuote` and prefixing `exec` makes the distribution run exactly
 * the program and arguments the caller named — none of them can be re-split, globbed or
 * re-read as syntax by the intervening shells — and `exec` keeps the interactive process
 * as the PTY's direct child, so terminal signals and the foreground group reach it
 * instead of stopping at a wrapper shell.
 *
 * The login flag matches the shell executor's own translation of a confined command into
 * argv (`buildLinuxShellArgv` with `loginShell: true`). The inner command is `exec`'d, so
 * no SECOND login shell is started: profiles run once, for the fence wrapper.
 * @module dsh-wsl-desktop/wsl/confined-argv
 */

import { buildConfinedCommand } from './confinement.js'
import { shellQuote } from './paths.js'

/**
 * Wrap one terminal spawn's argv in the distribution's in-distro confinement.
 *
 * Pure: every policy fact it needs is an argument, and the fence text comes from
 * `buildConfinedCommand` unchanged. It refuses exactly what that builder refuses (a
 * `workspace-write` fence for a root under the private `/tmp`, a control character in the
 * workspace spelling) and throws its errors as they are — the caller classifies them, and
 * swallowing one would run a terminal that is not fenced while reporting a fence.
 * @param {object} options - the spawn's argv and its resolved confinement inputs.
 * @param {readonly string[]} options.argv - the program and arguments the terminal must run.
 * @param {string} options.linuxCwd - absolute Linux working directory for the fence.
 * @param {'read-only' | 'workspace-write'} options.mode - the confined mode.
 * @param {string | undefined} options.workspaceLinuxRoot - writable root for `workspace-write`.
 * @param {{ uid: string, gid: string, home: string, name?: string }} options.identity - the drop identity.
 * @param {boolean | undefined} options.noNewPrivs - whether the direct runner may set NO_NEW_PRIVS.
 * @param {'helper' | 'sudo-unshare'} options.runner - the resolved runner.
 * @param {boolean} [options.isolateProcesses] - add a PID namespace (never for an interactive PTY).
 * @returns {string[]} the argv to spawn on the PTY.
 * @throws Error when `argv` is empty, and whatever `buildConfinedCommand` refuses.
 */
export function buildConfinedTerminalArgv({ argv, linuxCwd, mode, workspaceLinuxRoot, identity, noNewPrivs, runner, isolateProcesses }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('wsl-sandbox: 需要一个非空的 argv')
  }
  const program = argv.map((element) => shellQuote(element)).join(' ')
  return [
    'bash',
    '-lc',
    buildConfinedCommand({ command: `exec ${program}`, linuxCwd, mode, workspaceLinuxRoot, identity, noNewPrivs, runner, isolateProcesses }),
  ]
}

export default buildConfinedTerminalArgv
