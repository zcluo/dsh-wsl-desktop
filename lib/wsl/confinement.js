/**
 * Linux-side confinement for commands that run inside a WSL distribution.
 *
 * The host's `ctx.sandbox` provider cannot confine a `wsl.exe` process: its
 * children execute on the Linux kernel side. Confinement therefore happens
 * *inside* the distribution, by wrapping the inner shell command in a mount
 * namespace whose root is read-only and whose only writable paths are the
 * session workspace and a private `/tmp`.
 *
 * The runner needs root, because the WSL kernel refuses bind mounts inside a
 * user namespace (`unshare -Ur --mount` succeeds but `mount --bind` fails with
 * "wrong fs type"). `sudo -n unshare …` is used when the distribution's user
 * has passwordless sudo; otherwise the confined modes fail loud rather than
 * running unconfined.
 *
 * Entering the namespace through `sudo` changes the effective user, so the
 * command is dropped back to the original uid/gid with `setpriv`. Without that
 * step every file the command creates would be owned by root.
 * @module dsh-wsl-desktop/wsl/confinement
 */

import { shellQuote } from './paths.js'

/** The only runner this module implements. */
export const RUNNER_SUDO_UNSHARE = 'sudo-unshare'

/** stderr text the kernel produces for a write blocked by the read-only root. */
export const DENIAL_SIGNATURES = ['Read-only file system', 'read-only file system']

/** Cached probe results, keyed by distribution and user. */
const identityCache = new Map()
const runnerCache = new Map()

/** Cache key for one distribution/user pair. */
function keyFor(distro, username) {
  return `${distro}\u0000${username ?? ''}`
}

/**
 * Resolve the uid/gid a command must run as after the namespace is entered.
 * @param {object} options - probe inputs.
 * @param {string} options.distro - distribution name.
 * @param {string} [options.username] - Linux user; omitted uses the distribution default.
 * @param {(options: object) => Promise<{ stdout: string, exitCode: number | null }>} options.run - command runner.
 * @returns {Promise<{ uid: string, gid: string } | null>} the identity, or null when it cannot be read.
 */
export async function resolveIdentity({ distro, username, run }) {
  const key = keyFor(distro, username)
  if (identityCache.has(key)) return identityCache.get(key)
  const probe = () => run({
    distro,
    linuxCwd: '/',
    ...username !== undefined && username !== '' ? { username } : {},
    // The home directory is read before `sudo` runs, so it is the session
    // user's; a confined login shell started through `sudo` would otherwise
    // inherit HOME=/root and read the wrong profile.
    command: 'echo __DSH_IDENTITY__; id -u; id -g; printf "%s\\n" "$HOME"; id -un',
    // Non-login + sentinel on purpose: profile scripts must not be able to
    // print identity facts (a model-writable dotfile printing 0/0//root/root
    // would otherwise drop every confined command to root via setpriv) or
    // shift the positional parse. Exactly the marker plus four probe lines is
    // accepted; anything else fails closed for this command. The 60s ceiling
    // plus the one timed-out retry below covers the desktop's first wsl.exe
    // spawn after a restart, which can outlive a short ceiling on a cold VM.
    loginShell: false,
    timeoutMs: 60_000,
  })
  let result = await probe()
  if (result.timedOut) {
    // One transparent retry: the same probe. A second timeout surfaces as the
    // diagnosable parse failure below (timedOut included in the message).
    result = await probe()
  }
  const lines = result.stdout.trim().split('\n')
  const markerAt = lines.indexOf('__DSH_IDENTITY__')
  const [uid, gid, home, name] = markerAt >= 0 && lines.length - markerAt === 5
    ? lines.slice(markerAt + 1)
    : []
  const identity = uid !== undefined && gid !== undefined && home !== undefined
    && /^\d+$/.test(uid) && /^\d+$/.test(gid) && home.startsWith('/')
    ? { uid, gid, home, name: (name ?? '').trim() }
    : null
  // A failed parse is a diagnosable event, not a silent null: surface what the
  // probe actually saw so the caller's SandboxUnavailableError carries the
  // evidence (trimmed) instead of a bare "identity unresolvable".
  if (identity === null) {
    throw new Error(
      `身份探针输出无法解析（exit=${String(result.exitCode)} timedOut=${String(result.timedOut)}）：stdout=${JSON.stringify(result.stdout.slice(0, 400))} stderr=${JSON.stringify(result.stderr.slice(0, 200))}`,
    )
  }
  // Cache only a resolved identity, mirroring detectRunner: a transient
  // wsl.exe failure must not stick `null` for the process lifetime and deny
  // every later confined command after the distribution recovered. An
  // uncached failure still fails closed for THIS command; the next one
  // re-probes.
  if (identity !== null) identityCache.set(key, identity)
  return identity
}

/**
 * Detect whether the distribution can run the confinement runner.
 *
 * Probed once per distribution/user pair: the answer cannot change while the
 * process runs, and every confined command would otherwise pay a `sudo` round
 * trip.
 * @param {object} options - probe inputs.
 * @param {string} options.distro - distribution name.
 * @param {string} [options.username] - Linux user.
 * @param {(options: object) => Promise<{ stdout: string }>} options.run - command runner.
 * @returns {Promise<string | null>} the runner id, or null when unavailable.
 */
export async function detectRunner({ distro, username, run }) {
  const key = keyFor(distro, username)
  if (runnerCache.has(key)) return runnerCache.get(key)
  let runner = null
  try {
    const result = await run({
      distro,
      linuxCwd: '/',
      ...username !== undefined && username !== '' ? { username } : {},
      command: 'sudo -n true >/dev/null 2>&1 && command -v unshare >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1 && echo yes || echo no',
      // Non-login: with rc output excluded, the answer is exactly 'yes' or
      // 'no' and can be compared strictly instead of by substring. The 60s
      // ceiling matches the identity probe (cold VM first spawn).
      loginShell: false,
      timeoutMs: 60_000,
    })
    runner = result.stdout.trim() === 'yes' ? RUNNER_SUDO_UNSHARE : null
  } catch {
    // An unreachable distribution is reported by the caller's own failure path.
    runner = null
  }
  // Cache only a confirmed runner. Caching `null` would let one transient
  // wsl.exe failure deny every later confined command for the whole host
  // process lifetime, long after the distribution recovered. Leaving the
  // failure uncached keeps each command's fail-closed guarantee — detection
  // failing NOW still refuses THIS command — while the next command probes
  // again.
  if (runner !== null) runnerCache.set(key, runner)
  return runner
}

/**
 * Forget cached probe results. Used by tests and by a settings change.
 */
export function resetConfinementCache() {
  identityCache.clear()
  runnerCache.clear()
}

/**
 * Translate a session workspace root into a Linux path.
 * @param {string | undefined} workspaceRoot - the resolved policy's workspace root.
 * @param {string} linuxCwd - the command's Linux working directory.
 * @param {(path: string) => string | null} toLinux - host-to-Linux translator.
 * @returns {string | null} the Linux workspace root, or null when it is not addressable.
 */
export function workspaceRootInLinux(workspaceRoot, linuxCwd, toLinux) {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return linuxCwd
  const mapped = toLinux(workspaceRoot)
  return mapped === null || mapped === '' ? null : mapped
}

/**
 * Exit code the confinement script reserves for its own failure.
 *
 * A command that fails and a confinement that could not be established are
 * different outcomes: the caller must be able to tell them apart, because the
 * second one means the command ran under a weaker boundary than promised.
 */
export const SETUP_FAILURE_EXIT = 97

/** stderr marker identifying a confinement setup failure rather than a command failure. */
export const SETUP_FAILURE_MARKER = 'dsh-wsl-sandbox: setup failed'

/**
 * Mounts deliberately left writable: device nodes and kernel state.
 *
 * These are not file storage, so a read-only remount would break the process
 * (writing to `/dev/null` on a read-only devtmpfs fails with `EROFS`) without
 * protecting any file. Exact matches only — `/dev/shm` is a separate tmpfs and
 * IS file storage, so it is remounted read-only like everything else.
 */
export const KERNEL_SURFACES = new Set(['/dev', '/dev/pts', '/dev/mqueue', '/proc', '/sys'])

/**
 * Escape ERE metacharacters so a path can only ever match itself.
 * @param {string} text - a mount target or exempt path.
 * @returns {string} the regex-escaped text.
 */
function escapeEre(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The assembled grep -E pattern for one sweep/postcondition: regex-escaped
 * entries joined with alternation, anchored both ends.
 * @param {string[]} keep - mount targets that stay writable.
 * @returns {string} the pattern, as data (the caller quotes it for the shell).
 */
function exemptPattern(keep) {
  return `^(${[...new Set([...keep, ...KERNEL_SURFACES])].map(escapeEre).join('|')})$`
}

/**
 * The shell fragment that makes every remaining writable mount read-only.
 *
 * Enumerated at run time from `findmnt` rather than from a fixed list, because a
 * list is only ever as complete as the machine it was written on: a new drvfs
 * drive or a runtime tmpfs would reopen the hole silently.
 * @param {string[]} keep - mount targets that stay writable.
 * @returns {string} the fragment.
 */
function readOnlySweep(keep) {
  const pattern = exemptPattern(keep)
  return [
    // Line-driven, not word-split: `$(…)` in a for-loop would split a mount
    // target containing whitespace into two bogus targets. The pattern is ONE
    // shellQuoted word over regex-escaped entries, so shell/regex
    // metacharacters in a path stay inert data. A failing grep (invalid ERE,
    // unexpected errors) calls fail() — exit 97 inside the pipeline's subshell
    // reaches the script through `set -o pipefail` — never a vacuous pass.
    `findmnt -rno TARGET | { grep -Ev ${shellQuote(pattern)} || fail ${shellQuote('exemption grep failed')}; } | while IFS= read -r target; do`,
    '  mount -o remount,ro,bind "$target" >/dev/null 2>&1 || true;',
    'done',
  ].join('\n')
}

/**
 * The post-condition: the namespace must be what was asked for.
 *
 * Every step above tolerates its own failure so that one unmountable target does
 * not abort the rest, which means the only trustworthy statement about the
 * boundary is one read back from inside it. A target that is still writable
 * outside the allow-list is a setup failure, not a command failure.
 * @param {string[]} keep - mount targets that may stay writable.
 * @returns {string} the fragment.
 */
function postConditions(keep) {
  const pattern = exemptPattern(keep)
  return [
    'mountpoint -q /tmp || fail "/tmp is not a private tmpfs"',
    'findmnt -rno OPTIONS / | grep -q "^ro" || fail "/ is not read-only"',
    // Same line-driven loop and single-quoted pattern as the sweep (fail() is
    // defined in the setup steps). The trailing `true` matters: the while is
    // the LAST element of a pipeline, so a body that ends with a failing
    // `[ -w ]` (the normal case — every swept target IS read-only) would
    // otherwise fail the whole pipeline under `set -o pipefail` and abort the
    // script before the command runs. A real `fail` still exits 97 from inside
    // the loop, which pipefail turns into the script's own setup failure — the
    // marker and exit code still surface.
    `findmnt -rno TARGET | { grep -Ev ${shellQuote(pattern)} || fail ${shellQuote('exemption grep failed')}; } | while IFS= read -r target; do`,
    '  [ -w "$target" ] && fail "$target is still writable";',
    '  true;',
    'done',
    'true',
  ].join('\n')
}

/**
 * Build the inner script that establishes the confinement and runs the command.
 *
 * Order matters: the writable paths are bound *before* the root is remounted
 * read-only, because a bind created afterwards inherits the read-only state.
 *
 * The script fails closed. It runs under `set -euo pipefail`, every step is a
 * separate statement whose failure aborts it, and it ends by verifying the
 * boundary it just built — a failed `mount` used to leave the command running
 * with a writable root while the caller was told the sandbox was fully enforced.
 * @param {object} options - confinement plan inputs.
 * @param {string} options.command - the caller's shell source.
 * @param {string} options.linuxCwd - absolute Linux working directory.
 * @param {'read-only' | 'workspace-write'} options.mode - the confined mode.
 * @param {string | undefined} options.workspaceLinuxRoot - writable root for `workspace-write`.
 * @param {{ uid: string, gid: string }} options.identity - identity to drop back to.
 * @returns {string} the script to run inside the namespace.
 */
export function buildNamespaceScript({ command, linuxCwd, mode, workspaceLinuxRoot, identity }) {
  const keep = ['/tmp']
  const steps = ['set -euo pipefail']
  // The failure helper is defined before the sweep so BOTH the sweep and the
  // postcondition can fail closed through it.
  steps.push(`fail() { printf '%s: %s\\n' ${shellQuote(SETUP_FAILURE_MARKER)} "$1" >&2; exit ${SETUP_FAILURE_EXIT}; }`)
  if (mode === 'workspace-write') {
    if (workspaceLinuxRoot === undefined || workspaceLinuxRoot === '') {
      throw new Error('wsl-sandbox: workspace-write 需要一个工作区根目录')
    }
    // The workspace may not be a mount point, so the bind is its own source and
    // target; the following remount of `/` leaves this nested mount writable.
    steps.push(`mount --bind ${shellQuote(workspaceLinuxRoot)} ${shellQuote(workspaceLinuxRoot)}`)
    keep.push(workspaceLinuxRoot)
  }
  steps.push('mount -t tmpfs tmpfs /tmp')
  steps.push('mount -o remount,ro,bind /')
  steps.push(readOnlySweep(keep))
  steps.push(postConditions(keep))
  const inner = `cd ${shellQuote(linuxCwd)} && ${command}`
  // `sudo` leaves HOME pointing at root; without restoring it a login shell
  // reads the wrong profile and reports "Permission denied" on every command.
  const environment = [`HOME=${shellQuote(identity.home)}`]
  if (identity.name !== undefined && identity.name !== '') environment.push(`USER=${shellQuote(identity.name)}`, `LOGNAME=${shellQuote(identity.name)}`)
  const drop = `setpriv --reuid=${identity.uid} --regid=${identity.gid} --init-groups `
    + `env ${environment.join(' ')} bash -lc ${shellQuote(inner)}`
  steps.push(`exec ${drop}`)
  return steps.join('\n')
}

/**
 * Build the command the executor hands to the distribution's outer shell.
 * @param {object} options - confinement plan inputs.
 * @param {string} options.command - the caller's shell source.
 * @param {string} options.linuxCwd - absolute Linux working directory.
 * @param {'read-only' | 'workspace-write'} options.mode - the confined mode.
 * @param {string | undefined} options.workspaceLinuxRoot - writable root for `workspace-write`.
 * @param {{ uid: string, gid: string }} options.identity - identity to drop back to.
 * @param {boolean} [options.isolateProcesses] - add a PID namespace.
 * @returns {string} the outer shell command.
 */
export function buildConfinedCommand({ command, linuxCwd, mode, workspaceLinuxRoot, identity, isolateProcesses = true }) {
  const script = buildNamespaceScript({ command, linuxCwd, mode, workspaceLinuxRoot, identity })
  const flags = ['--mount', '--propagation', 'private']
  if (isolateProcesses) flags.push('--pid', '--fork')
  return `sudo -n unshare ${flags.join(' ')} bash -c ${shellQuote(script)}`
}
