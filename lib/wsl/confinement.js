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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Shipped helper script, installed by the operator (see docs/CONFINEMENT.md). */
export const HELPER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'dsh-wsl-confine.sh')

/** The direct runner: sudo-wrapped unshare with the fence built in-process. */
export const RUNNER_SUDO_UNSHARE = 'sudo-unshare'

/** The hardened runner: a root-owned helper that always fences before exec. */
export const RUNNER_HELPER = 'helper'

/** Where the operator installs the confinement helper (see docs/CONFINEMENT.md). */
export const HELPER_PATH = '/usr/local/sbin/dsh-wsl-confine'

/**
 * Version the helper must report before it is selected.
 *
 * v1.2 is the first helper that ERE-escapes its exemption pattern. The pre-v1.2
 * helper built it unescaped, so a workspace path containing a metacharacter was
 * swept read-only and a path containing `|` could exempt /mnt/c — a live fence
 * bypass. The probe below therefore refuses anything older, and the direct
 * sudo-unshare runner is used instead: its in-process builder always escaped, so
 * a stale install degrades to a correct fence rather than a silent hole.
 */
export const HELPER_VERSION = 'v1.2'

/** stderr text the kernel produces for a write blocked by the read-only root. */
export const DENIAL_SIGNATURES = ['Read-only file system', 'read-only file system']

/** Cached probe results, keyed by distribution and user. */
const identityCache = new Map()
const runnerCache = new Map()
const noNewPrivsCache = new Map()

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
 * @returns {Promise<{ uid: string, gid: string, home: string, name: string }>} the identity.
 * @throws Error when the probe output cannot be parsed; the message carries the
 *   probe's own exit code, timeout flag, stdout and stderr as evidence.
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
  // Only a RESOLVED identity is cached: a failure throws above (never returns),
  // so a transient wsl.exe fault fails closed for THIS command and the next one
  // re-probes instead of sticking for the process lifetime.
  identityCache.set(key, identity)
  return identity
}

/**
 * The gate that decides whether a path may be used as the sudoers-named helper.
 *
 * Executability plus the version string is NOT enough to call a path "a
 * root-owned helper". The sudoers grant names a PATH, so whatever that path
 * holds at invocation time is what runs as root; a file the session user can
 * write is a file the session user can replace, and an ancestor they can write
 * lets the file itself be replaced (rename) or shadowed. Either way every later
 * confined command executes their content as root, outside any fence — the
 * opposite of what installing the helper is for. Measured on the pre-fix probe,
 * with a session-user-owned copy of the shipped helper at /tmp: the probe
 * answered yes, i.e. it would have selected a file the model owns.
 *
 * The gate therefore requires, before the version is even asked for:
 * - a REGULAR FILE at the path ('[ -f ]'), because 'test -x' alone also accepts
 *   a directory — measured: a drwxr-xr-x root:root directory satisfied every
 *   other test and the ownership predicate answered yes for it. Only the version
 *   half refused it, and only because sudo cannot exec a directory;
 * - NOT a SYMLINK ('[ -L ]' refuses; it is not resolved). Which tests resolve a
 *   link is not uniform, and that asymmetry is the reason for the explicit test:
 *   'test -x' and '[ -w ]' follow the link, while 'stat -c %u/%a' do NOT follow
 *   it. A link is therefore refused today as collateral (stat reports the link's
 *   own fixed 0777 mode, which fails the write-bit test) with nothing in the
 *   script stating that this is intended. Resolving instead would demand
 *   checking BOTH chains — the link's own directory is decisive, since
 *   re-pointing it at any root-owned binary gives the caller that binary as
 *   root under an argument-wildcarded grant — so refusal stays the choice;
 * - the INVOKING user's execute bit ('test -x'), so a 0700 root:root helper is
 *   not selected; that is fail-closed and deliberately unchanged here;
 * - owner uid 0 ('stat -c %u'), so a session-user-owned file can never be the
 *   grant's target;
 * - no group or other WRITE bit ('stat -c %a' & 022 == 0). The '-w' test alone
 *   would miss a mode a later group membership could widen; the mode bits alone
 *   would miss an ACL. Both are checked;
 * - not writable by the invoking user ('[ -w ]', which also sees ACLs);
 * - no writable ancestor up to '/'. Measured for the resolved case too: with the
 *   helper reached through a symlinked ANCESTOR (/opt/.../linkdir ->
 *   /home/<user>/...), '[ -w ]' follows that component and answers no, so the
 *   ancestor half has no lexical-vs-resolved gap — the walk tests each lexical
 *   component, and each test sees through it.
 *
 * Deliberately NOT a literal '0:755': a stricter mode must never be refused for
 * being stricter, and what has to be pinned is replaceability. The '-w' test
 * also refuses a helper under a world-writable directory such as /tmp even when
 * the file itself is root-owned — a fail-closed over-approximation whose price
 * is only that the direct sudo-unshare runner is used instead (subject to its
 * own NO_NEW_PRIVS measurement).
 *
 * Prints exactly one line, yes or no, when it runs at all — the same shape as
 * its sibling probes, so the answer is compared strictly rather than matched.
 * @param {string} helperPath - the path the sudoers grant names.
 * @returns {string} the gate script.
 */
function helperGateScript(helperPath) {
  const target = shellQuote(helperPath)
  return [
    'f=' + target,
    'ok=yes',
    // TYPE FIRST, and by an explicit test rather than by 'test -x': a root:root
    // 0755 DIRECTORY satisfies -x, uid 0, no write bits and every ancestor test,
    // so the ownership predicate answered yes for a directory — measured, as
    // zcluo, with /opt/.../dir-helper (drwxr-xr-x root root). Only the version
    // half refused it, and only because sudo cannot exec a directory. The gate
    // claims to require an executable FILE; this is where it measures that.
    '[ -f "$f" ] || ok=no',
    // A symlink is REFUSED, not resolved. The grant names a PATH, so the link
    // and its target are both part of the trust decision: resolving would have
    // to check the link's own directory too (re-pointing it at any other
    // root-owned binary such as /bin/bash is enough to run the caller's argv as
    // root under an argument-wildcarded grant), while the ancestor walk below
    // can only walk one of the two chains. Refusal is simpler, fail-closed, and
    // costs only the hardened runner: the probe falls back to the direct
    // sudo-unshare runner, and docs/CONFINEMENT.md's install is a real file copy.
    // Today such a path is refused already — but only as collateral, because
    // 'stat' does NOT follow a link and reports the link's own fixed 0777 mode,
    // which fails the write-bit test below. Nothing in the script says so, so
    // any later edit that made the stat calls follow (-L) would silently turn
    // that accident into an accepted, replaceable helper. This makes the
    // refusal the measured intent instead of a side effect.
    '[ -L "$f" ] && ok=no',
    // The invoking user's execute bit (this follows the link, hence the tests
    // above): a 0700 root:root helper is not selected — fail-closed, unchanged.
    'test -x "$f" || ok=no',
    'u=$(stat -c %u "$f" 2>/dev/null) || u=',
    'm=$(stat -c %a "$f" 2>/dev/null) || m=',
    '[ "$u" = 0 ] || ok=no',
    '[ -n "$m" ] || ok=no',
    // A mode stat cannot report (or one that is not octal) must refuse, not
    // error out silently: the arithmetic parse is guarded by the non-empty test.
    '[ -n "$m" ] && (( (8#$m & 022) == 0 )) || ok=no',
    '[ -w "$f" ] && ok=no',
    'd=$(dirname "$f")',
    'while [ "$ok" = yes ]; do',
    '  [ -w "$d" ] && ok=no',
    '  [ "$d" = / ] && break',
    '  p=$(dirname "$d")',
    '  [ "$p" = "$d" ] && break',
    '  d="$p"',
    'done',
  ].join('\n')
}

/**
 * The ownership/permission gate alone, as a runnable script (yes or no).
 * Exported so the predicate can be measured against real paths — the version
 * half needs a sudo round trip, which a non-canonical path may not have.
 * @param {string} [helperPath] - the path to judge; defaults to the install path.
 * @returns {string} the script.
 */
export function helperOwnershipScript(helperPath = HELPER_PATH) {
  return helperGateScript(helperPath) + '\n' + 'echo "$ok"'
}

/**
 * The complete helper-selection probe: the ownership gate, then the version pin.
 *
 * The order is load-bearing: a path the session user could have replaced must
 * never reach 'sudo', not even for '--version'.
 * @param {string} [helperPath] - the path to judge; defaults to the install path.
 * @returns {string} the script, printing yes or no.
 */
export function helperSelectionScript(helperPath = HELPER_PATH) {
  const pattern = shellQuote('^dsh-wsl-confine ' + HELPER_VERSION + '$')
  return [
    helperGateScript(helperPath),
    'if [ "$ok" = yes ]; then',
    '  sudo -n ' + shellQuote(helperPath) + ' --version 2>/dev/null | grep -q ' + pattern + ' || ok=no',
    'fi',
    'echo "$ok"',
  ].join('\n')
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
  const probeOnce = async () => {
    try {
      // Prefer the hardened helper when the operator installed it: the
      // sudoers grant is narrowed to the helper alone, which always applies
      // the fence before exec-ing — the retained-grant self-escape is closed.
      // Selection is gated on OWNERSHIP AND PERMISSIONS, not just on
      // executability and the version string: the grant names this path, so a
      // replaceable path would run the session user's file as root on every
      // later confined command. See helperSelectionScript.
      const helperProbe = await run({
        distro,
        linuxCwd: '/',
        ...username !== undefined && username !== '' ? { username } : {},
        command: helperSelectionScript(),
        loginShell: false,
        timeoutMs: 60_000,
      })
      if (helperProbe.stdout.trim() === 'yes') return RUNNER_HELPER
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
      return result.stdout.trim() === 'yes' ? RUNNER_SUDO_UNSHARE : null
    } catch {
      // An unreachable distribution is reported by the caller's own failure path.
      return null
    }
  }
  // One transparent retry: the desktop's first wsl.exe spawns after a restart
  // can fail inside the cold-start window (same rationale as the identity
  // probe's retry). The retry repeats the SAME probe; a persistent absence
  // still fails closed for THIS command, uncached.
  let runner = await probeOnce()
  if (runner === null) {
    await new Promise((resolve) => { setTimeout(resolve, 1_000) })
    runner = await probeOnce()
  }
  if (runner !== null) runnerCache.set(key, runner)
  return runner
}

/**
 * Forget cached probe results. Used by tests and by a settings change.
 */
export function resetConfinementCache() {
  identityCache.clear()
  runnerCache.clear()
  noNewPrivsCache.clear()
}

/**
 * Measure whether the distribution's `setpriv` supports `--no-new-privs`.
 *
 * When supported, the confined drop sets NO_NEW_PRIVS for the whole command
 * subtree: setuid/file-caps elevation fails loudly, which closes the
 * retained-sudo self-escape (the session user keeps a passwordless sudo grant
 * — the same primitive the runner itself uses — and without NNP that grant
 * voids the file fence at will). Probed once per distribution/user pair;
 * availability cannot change while the process runs.
 *
 * THREE outcomes, and the third is not a measurement:
 * - `true` — the probe ran and the flag is there; the drop may proceed;
 * - `false` — the probe RAN and answered no. That is a measured, documented
 *   limitation of this distribution (retained sudo can still void the file
 *   fence; the executor reports `enforcement: 'partial'`);
 * - `null` — the probe did not run, or ran and answered neither yes nor no.
 *   Nothing is known about this distribution's setpriv, which is NOT the same
 *   answer as `false`.
 *
 * Reporting the third state as `false` is what made the fail-closed claim
 * false: the caller could not tell "this setpriv cannot set NO_NEW_PRIVS" from
 * "I have no idea whether it can", and it then ran the command WITHOUT the flag
 * while the result still described a boundary that was never established. The
 * siblings do not conflate the two (detectRunner -> null -> SandboxUnavailableError;
 * resolveIdentity -> throw), and the caller now refuses the same way — see
 * {@link noNewPrivsRefusal}.
 *
 * A non-zero exit with an empty answer is that third state, not an answer: the
 * probe prints exactly one of yes/no whenever it runs at all, so anything else
 * (a cold-start timeout, an unregistered distribution whose wsl.exe failure
 * reports on stderr) means the measurement did not happen. Only a measured
 * answer is cached; an unanswered probe is retried once here and re-probed by
 * the next command.
 * @param {object} options - probe inputs.
 * @param {string} options.distro - distribution name.
 * @param {string} [options.username] - Linux user.
 * @param {(options: object) => Promise<{ stdout: string }>} options.run - command runner.
 * @returns {Promise<boolean | null>} whether the drop can set NO_NEW_PRIVS, or
 *   null when the probe could not measure it.
 */
export async function detectNoNewPrivs({ distro, username, run }) {
  const key = keyFor(distro, username)
  if (noNewPrivsCache.has(key)) return noNewPrivsCache.get(key)
  const probeOnce = async () => {
    let result
    try {
      result = await run({
        distro,
        linuxCwd: '/',
        ...username !== undefined && username !== '' ? { username } : {},
        command: 'setpriv --help 2>&1 | grep -q -- --no-new-privs && echo yes || echo no',
        loginShell: false,
        timeoutMs: 60_000,
      })
    } catch {
      // A probe that could not run is NOT an unsupported setpriv: reporting it as
      // one silently drops the NO_NEW_PRIVS hardening, and the caller then runs
      // the very command it should have refused.
      return null
    }
    const answer = typeof result?.stdout === 'string' ? result.stdout.trim() : ''
    if (answer === 'yes') return true
    if (answer === 'no') return false
    // Neither token is an answer, so nothing was measured. A distro-level
    // wsl.exe failure is exactly this shape: a non-zero exit, an empty stdout
    // and its reason on stderr.
    return null
  }
  // One transparent retry, for the same cold-start window the identity and
  // runner probes document: the desktop's first wsl.exe spawn after a restart can
  // fail inside a short ceiling.
  let measured = await probeOnce()
  if (measured === null) {
    await new Promise((resolve) => { setTimeout(resolve, 1_000) })
    measured = await probeOnce()
  }
  // Cache only an ANSWER. Caching a transient failure pinned the hardening off
  // for the whole process lifetime — detectRunner and resolveIdentity already
  // follow this rule; this probe did not. An unanswered probe is reported as
  // null (not measured), which the caller REFUSES, and the next command
  // re-probes instead of inheriting the outcome.
  if (measured !== null) noNewPrivsCache.set(key, measured)
  return measured
}

/**
 * Refusal text for a distribution whose setpriv cannot set NO_NEW_PRIVS —
 * a MEASURED limitation of that distribution.
 *
 * Names the consequence (the retained passwordless sudo grant voids the file
 * fence) and the ONE remedy that can work: a newer util-linux. The hardened
 * helper is NOT a way out and the text says so, because the helper's drop has
 * no pre-flight for the flag at all: it execs `setpriv --no-new-privs`
 * unconditionally (dsh-wsl-confine.sh), so on a setpriv without the flag setpriv
 * rejects the unknown option and exits 1 — the confined command simply does not
 * run, and that is an ordinary COMMAND failure, not the setup-failure marker
 * that reports an unavailable runner. docs/CONFINEMENT.md:33 records the measured exit 1;
 * this text previously contradicted it by recommending the helper as a remedy.
 *
 * The remedy names the PROBEABLE requirement, not a version: the util-linux release
 * that first carried the flag was an unsourced figure in operator-facing text, and
 * the operator's real question is answerable in one command on the machine in front
 * of them — the same `setpriv --help` probe {@link NO_NEW_PRIVS_UNMEASURED} already
 * hands out. A version number cannot answer it (distributions backport), and
 * docs/DISTRO-SUPPORT.md's row for this boundary now states the same criterion.
 */
export const NO_NEW_PRIVS_UNSUPPORTED = 'wsl-sandbox: 发行版的 setpriv 不支持 --no-new-privs，无法在降权时置位 NO_NEW_PRIVS：会话用户保留的免密 sudo 可借此重新逃出文件围栏。安装 dsh-wsl-confine helper 不是绕过：helper 的降权对同一个标志（--no-new-privs）没有预检，直接 exec setpriv --no-new-privs，在缺少该标志的 setpriv 上 setpriv 对未知选项报错并 exit 1、命令不会运行（这是一次普通的命令失败，不是 runner 不可用的 setup 失败标记）。唯一可行的修法是升级发行版的 util-linux——判据是可探测的、不要按版本号判断：在发行版里跑 `setpriv --help 2>&1 | grep -- --no-new-privs`，有输出才说明这个 setpriv 带着该标志。'

/**
 * Refusal text for a NO_NEW_PRIVS probe that did not measure anything.
 *
 * Distinct from {@link NO_NEW_PRIVS_UNSUPPORTED} on purpose: this one is not a
 * property of the distribution. It says the probe did not run (or answered
 * neither yes nor no), so the state is UNKNOWN — and an operator can tell the
 * two apart, which is what makes the refusal a diagnosis instead of a wall.
 * The helper is mentioned as a workaround for THIS probe only, with what it
 * actually does stated: it skips the probe but not the flag, so it is a gamble
 * on a setpriv that carries the flag — not a remedy for one that lacks it.
 */
export const NO_NEW_PRIVS_UNMEASURED = 'wsl-sandbox: 无法测量发行版的 setpriv 是否支持 --no-new-privs（探针未运行，或没有给出 yes/no 答案）：降权是否置位 NO_NEW_PRIVS 未知，因此不运行这条命令。请重试；若反复出现，先在发行版里手动确认该标志（setpriv --help 2>&1 | grep -- --no-new-privs）。dsh-wsl-confine helper 的降权不走这个探针、固定 exec setpriv --no-new-privs，但用的还是同一个标志：标志缺失时它同样以 exit 1 失败、命令不会运行，因此不能代替升级 util-linux。'

/**
 * The refusal a direct-runner confined command must be stopped with, given the
 * NO_NEW_PRIVS measurement.
 *
 * Split from the probe so the decision is a pure fact about the three states and
 * can be asserted without a distribution: only the measured `true` permits the
 * drop, `false` (measured unsupported) and `null` (not measured) both refuse —
 * with DIFFERENT text, because "no-new-privs is unavailable here" and "I could
 * not measure it" are different diagnoses and lead to different operator steps.
 * @param {boolean | null} measured - the value detectNoNewPrivs reported.
 * @returns {string | null} the refusal text, or null when the drop may proceed.
 */
export function noNewPrivsRefusal(measured) {
  if (measured === true) return null
  // Anything that is not the measured true refuses: false is the measured
  // limitation, null/undefined is the unmeasured state.
  return measured === false ? NO_NEW_PRIVS_UNSUPPORTED : NO_NEW_PRIVS_UNMEASURED
}

/**
 * Translate a session workspace root into a Linux path.
 * @param {string | undefined} workspaceRoot - the resolved policy's workspace root.
 * @param {string} linuxCwd - the command's Linux working directory.
 * @param {(path: string) => string | null} toLinux - host-to-Linux translator.
 * @returns {string | null} the Linux workspace root, or null when it is not addressable.
 * @throws Error when the mapped root carries a control character
 *   (assertWorkspaceSpelling): this value is the fence's workspace, and it is
 *   exemption-pattern data on both runners.
 */
export function workspaceRootInLinux(workspaceRoot, linuxCwd, toLinux) {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return linuxCwd
  const mapped = toLinux(workspaceRoot)
  if (mapped === null || mapped === '') return null
  // Judged HERE, where the value is derived, so no caller can hand a control
  // character to a fence builder. The cwd fallback above is not judged: it is
  // also the command's own working directory, and both builders judge the
  // workspace themselves when that cwd IS the workspace (workspace-write).
  assertWorkspaceSpelling(mapped)
  return mapped
}

/**
 * Whether the private `/tmp` tmpfs would cover this workspace root.
 *
 * The fence binds the workspace and THEN mounts a fresh tmpfs over `/tmp`, so a
 * workspace at or below `/tmp` is hidden by it — the bind disappears and `cd`
 * into it fails, while a workspace of exactly `/tmp` would silently BE the
 * ephemeral tmpfs while the 9P fs tool still sees the real directory. Both
 * runners refuse such a root instead of building a fence that lies.
 * @param {string | undefined} workspaceLinuxRoot - the workspace root in Linux terms.
 * @returns {boolean} true when the root cannot be fenced as a workspace.
 */
export function workspaceUnderPrivateTmp(workspaceLinuxRoot) {
  if (typeof workspaceLinuxRoot !== 'string' || workspaceLinuxRoot === '') return false
  const normalized = workspaceLinuxRoot.replace(/\/+$/, '')
  return normalized === '/tmp' || normalized.startsWith('/tmp/')
}

/**
 * Refuse a workspace spelling that carries control characters.
 *
 * The workspace value is DATA for the exemption pattern, and it is the only
 * caller-supplied entry in that pattern. A control character in it used to be
 * fence SYNTAX: the helper printed its entries one per line and converted every
 * LF to '|', so '/home/u/proj/x<LF>/mnt/c' was indistinguishable from two
 * entries — it exempted /mnt/c from BOTH the read-only sweep and the writability
 * postcondition, and the fence reported success while the Windows filesystem
 * stayed writable. The in-process builder never had that separator, but grep -E
 * splits a multi-line pattern on LF, so the same value reached it as pattern
 * syntax too (there it fails closed — the split leaves the opening group
 * unterminated and grep errors — but a fence that cannot be established for a
 * spelling no workspace can have is still the wrong answer).
 *
 * No real workspace path contains a control character, so refusing them costs
 * nothing and removes the syntax entirely, on both sides of the fence.
 * @param {string} value - the Linux workspace root.
 * @throws Error naming the offending code point.
 */
export function assertWorkspaceSpelling(value) {
  if (typeof value !== 'string') throw new Error('workspace root must be a string')
  const bad = /[\u0000-\u001f\u007f]/.exec(value)
  if (bad !== null) {
    const code = bad[0].codePointAt(0).toString(16).padStart(4, '0')
    throw new Error(`workspace root contains control character U+${code}`)
  }
}

/**
 * Exit code the confinement script reserves for its own failure.
 *
 * A command that fails and a confinement that could not be established are
 * different outcomes: the caller must be able to tell them apart, because the
 * second one means the command ran under a weaker boundary than promised. The
 * executor consumes both this code and {@link SETUP_FAILURE_MARKER} and reports
 * `runnerFailed` on the settled result.
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
    //
    // findmnt -r hex-escapes unsafe characters in TARGET (\x20 space, \x09
    // tab, \x0a newline, \x5c backslash) — a spaced target swept under its
    // escaped literal name would ENOENT the remount (swallowed below) and
    // stay WRITABLE while the postcondition tested the bogus name. Decode
    // before matching: findmnt only ever emits \xNN for literal characters
    // (literal backslash arrives as \x5c), so bash's %b is lossless here.
    `findmnt -rno TARGET | while IFS= read -r raw; do printf '%b\\n' "$raw"; done | { grep -Ev ${shellQuote(pattern)} || fail ${shellQuote('exemption grep failed')}; } | while IFS= read -r target; do`,
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
    // Same line-driven loop, decode-before-match, and single-quoted pattern
    // as the sweep (fail() is defined in the setup steps). The trailing
    // `true` matters: the while is the LAST element of a pipeline, so a body
    // that ends with a failing `[ -w ]` (the normal case — every swept target
    // IS read-only) would otherwise fail the whole pipeline under
    // `set -o pipefail` and abort the script before the command runs. A real
    // `fail` still exits 97 from inside the loop, which pipefail turns into
    // the script's own setup failure — the marker and exit code still
    // surface.
    `findmnt -rno TARGET | while IFS= read -r raw; do printf '%b\\n' "$raw"; done | { grep -Ev ${shellQuote(pattern)} || fail ${shellQuote('exemption grep failed')}; } | while IFS= read -r target; do`,
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
export function buildNamespaceScript({ command, linuxCwd, mode, workspaceLinuxRoot, identity, noNewPrivs }) {
  const keep = ['/tmp']
  const steps = ['set -euo pipefail']
  // The failure helper is defined before the sweep so BOTH the sweep and the
  // postcondition can fail closed through it.
  steps.push(`fail() { printf '%s: %s\\n' ${shellQuote(SETUP_FAILURE_MARKER)} "$1" >&2; exit ${SETUP_FAILURE_EXIT}; }`)
  if (mode === 'workspace-write') {
    if (workspaceLinuxRoot === undefined || workspaceLinuxRoot === '') {
      throw new Error('wsl-sandbox: workspace-write 需要一个工作区根目录')
    }
    // Guarded here too: this builder is exported and the fence-fixture generator
    // calls it directly, so it cannot rely on buildConfinedCommand having judged
    // the spelling. This is where the value enters the exemption pattern.
    assertWorkspaceSpelling(workspaceLinuxRoot)
    // The workspace is bound BEFORE the private tmpfs is mounted over /tmp, so a
    // workspace at or below /tmp would be covered by it: the bind disappears and
    // "cd /tmp/proj" fails, while a workspace of exactly /tmp would silently BE
    // the ephemeral tmpfs (writes reported as successful, then gone). Refuse
    // rather than build a fence that lies about the workspace.
    if (workspaceUnderPrivateTmp(workspaceLinuxRoot)) {
      throw new Error(`wsl-sandbox: 工作区根目录 ${workspaceLinuxRoot} 位于 /tmp 之下，会被私有 tmpfs 覆盖`)
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
  // NO_NEW_PRIVS on the drop (when the distro's setpriv supports it) blocks
  // setuid/file-caps elevation for the whole command subtree — without it the
  // session user's retained passwordless sudo grant re-invokes the very
  // privileged primitive this fence was built from (unfenced unshare, or
  // remount,rw inside the namespace), voiding the file fence at will.
  const nnp = noNewPrivs === true ? '--no-new-privs ' : ''
  const drop = `setpriv ${nnp}--reuid=${identity.uid} --regid=${identity.gid} --init-groups `
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
 * @param {boolean} [options.noNewPrivs] - set NO_NEW_PRIVS on the drop when the
 *   distro's setpriv supports it (blocks setuid elevation inside the fence).
 * @param {string} [options.runner] - the resolved runner: 'helper' routes the
 *   command through the root-owned dsh-wsl-confine helper (the hardened path);
 *   'sudo-unshare' (default) keeps the direct sudo-unshare runner.
 * @param {boolean} [options.isolateProcesses] - add a PID namespace.
 * @returns {string} the outer shell command.
 * @throws Error when a `workspace-write` root cannot be fenced at all: a root at
 *   or below the private `/tmp` is covered by the tmpfs this fence mounts over
 *   it, so the workspace would vanish (or become ephemeral) under the command.
 * @throws Error when the workspace spelling carries a control character
 *   (assertWorkspaceSpelling): the value is exemption-pattern data, and an LF in
 *   it used to be an entry separator on the helper side.
 */
export function buildConfinedCommand({ command, linuxCwd, mode, workspaceLinuxRoot, identity, noNewPrivs, runner, isolateProcesses = true }) {
  // A control character in the workspace value WAS fence syntax on the helper
  // side (see assertWorkspaceSpelling), so the producer refuses the spelling
  // before either branch builds a command. read-only carries no workspace, and
  // an omitted root is not a spelling to judge.
  if (typeof workspaceLinuxRoot === 'string') assertWorkspaceSpelling(workspaceLinuxRoot)
  // Guarded here too: the helper branch never reaches buildNamespaceScript, and
  // the helper refuses the same root on its own side.
  if (mode === 'workspace-write' && workspaceUnderPrivateTmp(workspaceLinuxRoot)) {
    throw new Error(`wsl-sandbox: 工作区根目录 ${String(workspaceLinuxRoot)} 位于 /tmp 之下，会被私有 tmpfs 覆盖`)
  }
  // The hardened helper path: the root-owned helper applies the identical
  // fence itself and setpriv-exec's the command with NO_NEW_PRIVS — the
  // command text travels as argv after `--` and is never evaluated as root.
  if (runner === RUNNER_HELPER) {
    // Mirrors the direct branch's mode guard: only workspace-write may hand
    // the helper a writable root. workspaceRootInLinux() returns the command's
    // cwd when the policy carries no root, so without this check a read-only
    // command would arrive with a bound, WRITABLE workspace.
    const flags = [
      `--uid ${identity.uid}`,
      `--gid ${identity.gid}`,
      `--home ${shellQuote(identity.home)}`,
      `--cwd ${shellQuote(linuxCwd)}`,
      ...(mode === 'workspace-write' && workspaceLinuxRoot !== undefined && workspaceLinuxRoot !== '' ? [`--workspace ${shellQuote(workspaceLinuxRoot)}`] : []),
      ...(isolateProcesses ? [] : ['--no-pidns']),
      '--',
      shellQuote(command),
    ]
    return `sudo -n ${shellQuote(HELPER_PATH)} ${flags.join(' ')}`
  }
  const script = buildNamespaceScript({ command, linuxCwd, mode, workspaceLinuxRoot, identity, noNewPrivs })
  const flags = ['--mount', '--propagation', 'private']
  if (isolateProcesses) flags.push('--pid', '--fork')
  return `sudo -n unshare ${flags.join(' ')} bash -c ${shellQuote(script)}`
}
