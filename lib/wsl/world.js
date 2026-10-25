/**
 * The WSL execution world: distribution discovery, command execution and
 * directory facts, all reached through `wsl.exe` from the Windows host.
 *
 * A distribution runs no agent and holds no installed helper, so every fact
 * crosses the `wsl.exe` boundary. Commands run as
 * `wsl.exe -d <distro> [-u <user>] --cd <linux> -e bash -lc "cd '<linux>' && <cmd>"`;
 * the explicit `cd` survives profile scripts that reset the working directory.
 * @module dsh-wsl-desktop/wsl/world
 */

import { execFileSync, spawn } from 'node:child_process'
import { isWindowsPathShaped, LINUX_USER, joinWslUnc, mntToWindowsPath, parseWslUnc, shellQuote, windowsToMntPath } from './paths.js'
import { WslDomainError } from './errors.js'
import { ENV_OVERRIDES, WSL_CHILD_ENV, assertDistroName, decodeWslOutput, execFileAsync } from './proc.js'
import { defaultDistro } from './distros.js'

// Two groups moved out of this module in C3, and both are re-exported here so its
// public surface is unchanged:
//   - the decoder and the child environment live in ./proc.js, because the
//     discovery half, the execution half, subprocess.js and shell.js all read them;
//   - distribution discovery lives in ./distros.js, which imports ./proc.js, so
//     neither half imports the other.
export { ENV_OVERRIDES, WSL_CHILD_ENV, decodeWslOutput } from './proc.js'
export { defaultDistro, defaultDistroSync, listDistros, parseWslVersionTable, wslMajorVersion } from './distros.js'


/**
 * Refuse usernames that cannot be safe single argv tokens for wsl.exe -u.
 * @param {string | undefined} username - the Linux user about to be spawned with.
 */
function assertUserName(username) {
  if (username !== undefined && username !== '' && !LINUX_USER.test(username)) {
    throw new Error(`wsl: 非法的用户名 ${JSON.stringify(username)}`)
  }
}

/** Per-stream capture ceiling; a runaway command must not buffer without bound. */
const MAX_STREAM_BYTES = 1024 * 1024

/**
 * Add `WSLENV` flags to an explicit environment map.
 *
 * The local subprocess provider already merged its own ambient environment, so
 * this only declares which of the caller's variables cross into the
 * distribution and which of them must be translated back to Linux paths.
 * @param {Record<string, string | undefined>} env - the environment to bridge.
 * @returns {Record<string, string | undefined>} the same map with `WSLENV` set.
 */
export function withWslEnvFlags(env) {
  const flags = []
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === 'WSLENV' || typeof value !== 'string') continue
    // Reject keys containing WSLENV metacharacters (':' splits entries,
    // '/' marks path translation) so a hostile key cannot craft flags.
    if (key.includes(':') || key.includes('/')) continue
    // `WSL_*` configures wsl.exe ITSELF and has no meaning on the Linux side:
    // forwarding it would export a Windows-side switch into every command's
    // environment (measured: `printenv WSL_UTF8` inside the distribution).
    if (/^WSL_/i.test(key)) continue
    flags.push(isWindowsPathShaped(value) ? `${key}/p` : key)
  }
  const ambient = process.env.WSLENV
  const merged = [ambient, flags.join(':')].filter((part) => part !== undefined && part !== '').join(':')
  // WSL_UTF8 is injected HERE rather than at the call sites. Every provider path
  // already funnels through this function, so the property is structural and a
  // spawn site added later cannot forget it — a source-text pin over the known
  // sites stayed green when a new one appeared. It is applied last on purpose:
  // the decoder's fallback exists only for builds that predate the switch, so a
  // caller must not be able to turn it off.
  const bridged = { ...env, ...WSL_CHILD_ENV }
  return merged === '' ? bridged : { ...bridged, WSLENV: merged }
}

/**
 * Locate a Windows system executable from inside a distribution.
 *
 * Interop is usually enabled, but a distribution with `appendWindowsPath =
 * false` (the default in several images) never puts `cmd.exe` on `PATH`, so a
 * host command has to be invoked by its absolute `/mnt/<drive>` path.
 * @param {string} name - bare executable name, e.g. `cmd.exe`.
 * @returns {string | null} the Linux path, or null when the system drive is unknown.
 */
export function hostExecutable(name) {
  const mount = windowsToMntPath(process.env.SystemRoot ?? 'C:\\Windows')
  return mount === null ? null : `${mount}/System32/${name}`
}

/**
 * Build the child environment, bridging every extra variable into the
 * distribution through `WSLENV` (with `/p` for values that must be translated
 * back to Linux paths).
 * @param {Record<string, string> | undefined} extra - variables to bridge.
 * @returns {NodeJS.ProcessEnv} the environment for the `wsl.exe` process.
 */
function bridgeEnv(extra) {
  // Flag-building is shared with withWslEnvFlags so the WSLENV metacharacter
  // filter cannot drift apart between the two call sites again (bridgeEnv
  // used to accept `:`/`/`-bearing keys that withWslEnvFlags rejects). env is
  // optional — the common probe path passes none.
  return { ...process.env, ...ENV_OVERRIDES, ...withWslEnvFlags(extra ?? {}) }
}

/**
 * Turn one working directory into a distribution plus Linux directory.
 *
 * Three spellings reach here: the UNC workspace path the session carries, an
 * absolute Linux path a consumer supplied, and a Windows drive path. All three
 * normalize to the same pair, and an unrepresentable directory fails loud
 * rather than running the work in the wrong world.
 * @param {string} workdir - the resolved working directory.
 * @param {string | undefined} fallbackDistro - distribution for non-UNC spellings.
 * @returns {{ distro: string, linuxCwd: string, windowsCwd: string }} the execution plan.
 * @throws Error when the directory belongs to neither world.
 */
/**
 * The distribution a plan runs in: the caller's fallback, else the machine default.
 * @param {string} workdir - the directory being planned, named in the failure.
 * @param {string|undefined} fallbackDistro - the configured distro, when there is one.
 * @returns {string} the distribution name.
 * @throws {Error} when neither source names one.
 */
function wslUserOption(username) {
  return username !== undefined && username !== '' ? ['-u', username] : []
}

function planDistro(workdir, fallbackDistro) {
  const distro = fallbackDistro ?? defaultDistroSync()
  if (distro === undefined) {
    throw new Error(`wsl: 无法确定 "${workdir}" 所属的发行版，请配置 distro`)
  }
  return distro
}

export function planWsl(workdir, fallbackDistro) {
  const windowsCwd = process.env.SystemRoot ?? process.cwd()
  const unc = parseWslUnc(workdir)
  if (unc !== null) return { distro: unc.distro, linuxCwd: unc.linuxPath, windowsCwd }
  if (workdir.startsWith('/')) {
    const distro = planDistro(workdir, fallbackDistro)
    // A drive mount is also addressable from the Windows side; keep that as the
    // spawn directory so a failure still names a real path.
    return { distro, linuxCwd: workdir, windowsCwd: mntToWindowsPath(workdir) ?? windowsCwd }
  }
  const mnt = windowsToMntPath(workdir)
  if (mnt === null) {
    throw new Error(`wsl: 工作目录 "${workdir}" 不在 WSL 执行世界里`)
  }
  const distro = planDistro(workdir, fallbackDistro)
  return { distro, linuxCwd: mnt, windowsCwd }
}

/**
 * Build the `wsl.exe` argv that runs one program inside a distribution.
 *
 * `-e` executes the argv directly rather than through a shell, so a bare name
 * is resolved against the distribution's own `PATH` and every element keeps its
 * identity instead of being re-parsed.
 * @param {{ distro: string, linuxCwd: string, windowsCwd: string }} plan - the execution plan.
 * @param {readonly string[]} argv - the program and its arguments, in Linux terms.
 * @param {{ wslPath?: string, username?: string }} [options] - distribution and user selection.
 * @returns {string[]} the argv handed to the host's subprocess provider.
 */
export function buildWslExecArgv(plan, argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('wsl-subprocess: 需要一个非空的 argv')
  }
  // Option values are validated against the repo's own grammars so exec-path
  // safety never depends on wsl.exe's external (undocumented) tokenization.
  assertDistroName(plan.distro)
  assertUserName(options.username)
  return [
    options.wslPath ?? 'wsl.exe',
    '-d', plan.distro,
    ...wslUserOption(options.username),
    '--cd', plan.linuxCwd,
    '-e',
    ...argv,
  ]
}

/** The most wsl.exe processes this module runs at once.
 *
 * Every spawn here lands on ONE shared WSL2 VM, and this file's own notes record it
 * stalling under load (a cold start clears a 30 s ceiling, and a busy sibling
 * distribution stalled probes past theirs). The HTTP route bounds its own methods
 * (lib/index.js `routeInFlight`), but one route call can fan out several wsl.exe
 * children — a command plus its confinement probes, executable lookup and
 * login-shell probe — so the route counter is not a spawn cap. This is.
 *
 * Deliberately a plain FIFO queue rather than a pool: no caller holds a slot while
 * awaiting another wsl.exe call, so a hand-off can never deadlock, and FIFO order
 * keeps an early caller from starving behind later ones.
 */
const MAX_CONCURRENT_SPAWNS = 8

/** Spawns currently in flight. */
let activeSpawns = 0

/** Callers waiting for a slot; each holds a resolve that hands the slot over. */
const spawnQueue = []

/**
 * Take one spawn slot, waiting for a release when the module is at its cap.
 *
 * DELIBERATELY NOT ABORT-AWARE (review finding N4, ruling R76 — do not "fix" this).
 * The wait this can impose is BOUNDED and deadlock-free by construction: at most
 * MAX_CONCURRENT_SPAWNS (8) spawns are ever in flight, each carries its own timeout, and no
 * caller holds a slot while it awaits another wsl.exe call — so every slot is released in
 * bounded time and the queue always drains. Making the wait abort-aware would trade that
 * proof for a partial-cancellation path whose slots are the thing being counted: a caller
 * that left the queue on abort still has to hand back a slot it may already hold, and the
 * counter would need the same accounting a correct pool has, for a bound that is already
 * small. The observable cost of the current shape is "a cancelled allocation may wait behind
 * at most eight bounded spawns", which is why it is the accepted one.
 * @returns {Promise<void>} settled once the caller may spawn.
 */
function acquireSpawnSlot() {
  if (activeSpawns < MAX_CONCURRENT_SPAWNS) {
    activeSpawns += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => { spawnQueue.push(resolve) })
}

/**
 * Give a spawn slot back — to the head of the queue when one waits (the count
 * stays at the cap), otherwise back to the pool.
 */
function releaseSpawnSlot() {
  const next = spawnQueue.shift()
  if (next !== undefined) {
    next()
    return
  }
  activeSpawns -= 1
}

/**
 * Run one command inside a distribution.
 *
 * The `wsl.exe` process itself is spawned from a Windows directory because a
 * UNC or Linux working directory is not a valid Win32 process cwd; the Linux
 * directory is selected with `--cd` and re-asserted inside the login shell.
 * @param {object} options - execution request.
 * @param {string} options.distro - distribution to run in.
 * @param {string} options.linuxCwd - absolute Linux working directory.
 * @param {string} options.command - shell source to run.
 * @param {string} [options.username] - Linux user; omitted uses the distribution default.
 * @param {boolean} [options.loginShell] - run `bash -lc` (default) instead of `bash -c`.
 * @param {Record<string, string>} [options.env] - extra variables bridged through `WSLENV`.
 * @param {number} [options.timeoutMs] - foreground timeout; 0 disables it.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {boolean} [options.raw] - resolve the captured streams as Buffers. A
 *   consumer whose protocol carries NUL bytes as DATA must use this: no text
 *   heuristic can separate a NUL-framed payload from UTF-16LE reliably.
 * @param {string} [options.wslPath] - the configured `wsl.exe` path. Every spawn
 *   site honours it, this one included: hardcoding the executable here made a
 *   deployment whose `wsl.exe` is not on PATH spawn working commands through its
 *   own path while every PROBE failed, so the confined modes ended in
 *   SandboxUnavailableError with a working distribution underneath.
 * @returns {Promise<{ argv: string[], exitCode: number | null, stdout: string | Buffer, stderr: string | Buffer, timedOut: boolean }>} the settled outcome.
 */
export function runWslShell({ distro, linuxCwd, command, username, loginShell = true, env, timeoutMs = 120_000, signal, raw = false, wslPath = 'wsl.exe' }) {
  // Option values are validated against the repo's own grammars so exec-path
  // safety never depends on wsl.exe's external (undocumented) tokenization:
  // a separator-bearing distro/username is refused before any process starts.
  assertDistroName(distro)
  assertUserName(username)
  const script = loginShell ? `cd ${shellQuote(linuxCwd)} && ${command}` : command
  const argv = [
    '-d', distro,
    ...wslUserOption(username),
    '--cd', linuxCwd,
    '-e', 'bash', loginShell ? '-lc' : '-c', script,
  ]
  // Validation stays SYNCHRONOUS: callers rely on a bad distro/username throwing
  // before anything is awaited. Only the spawn itself waits for a slot, so the cap
  // never turns a grammar rejection into a rejected promise.
  return acquireSpawnSlot()
    .then(() => new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(wslPath, argv, {
        cwd: process.env.SystemRoot ?? process.cwd(),
        env: bridgeEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // Keep the spawn code for the same reason as the async 'error' path: a
      // missing executable is wsl-not-available, not an internal plugin fault.
      const failure = new Error(`wsl.exe 启动失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
      if (typeof error?.code === 'string') failure.code = error.code
      reject(failure)
      return
    }
    const out = { timedOut: false }
    // Collected as BYTES and decoded at settlement, not here. wsl.exe is ASKED
    // for UTF-8 (WSL_UTF8, see ENV_OVERRIDES), but a build that ignores the switch
    // still emits its diagnostics as UTF-16LE, so the choice belongs to
    // decodeWslOutput, which owns the fallback. Decoding the streams as UTF-8 at
    // this point turned every wsl.exe-level failure message into mojibake: the
    // real cause ("no such distribution") was in the stream but unreadable.
    const buffers = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    const collect = (stream, key) => {
      stream.on('data', (chunk) => {
        if (sizes[key] >= MAX_STREAM_BYTES) return
        const slice = chunk.subarray(0, MAX_STREAM_BYTES - sizes[key])
        buffers[key].push(slice)
        sizes[key] += slice.length
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    let timer
    // An abort is not a timeout — but it must not CLEAR one either. The timer
    // can have fired before the caller's abort arrives during teardown, and this
    // listener stays attached until the process closes, so resetting the flag
    // here could report a timed-out run as a plain cancellation.
    const onAbort = () => {
      child.kill()
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        out.timedOut = true
        child.kill()
      }, timeoutMs)
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        child.kill()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    const settle = (exitCode, failure) => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (failure !== undefined) {
        reject(failure)
        return
      }
      resolve({
        argv: [wslPath, ...argv],
        exitCode,
        stdout: raw ? Buffer.concat(buffers.stdout) : decodeWslOutput(Buffer.concat(buffers.stdout)),
        stderr: raw ? Buffer.concat(buffers.stderr) : decodeWslOutput(Buffer.concat(buffers.stderr)),
        timedOut: out.timedOut,
      })
    }
    child.on('error', (error) => {
      // Same rule as discovery: keep the spawn code so the route can tell a
      // missing executable (ENOENT) from a plugin fault. The text stays host-side.
      const failure = new Error(`wsl.exe 执行失败：${error.message}`, { cause: error })
      if (typeof error?.code === 'string') failure.code = error.code
      settle(null, failure)
    })
    child.on('close', (code) => {
      settle(code, undefined)
    })
    }))
    .finally(releaseSpawnSlot)
}

/** The documented probe ceiling: 60s, because a cold VM's first spawn can exceed 30s. */
const PROBE_TIMEOUT_MS = 60_000

/**
 * Ceiling for one parsed-output probe, and the retry that goes with it.
 *
 * docs/CONFINEMENT.md states this policy for exactly these probes — 探针超时 60s + 超时后一次透明
 * 重试：桌面重启后的首个 wsl.exe 冷启动可以超过短上限 — and it names `listLinuxDir`,
 * `checkLinuxPath` and `resolveDistroHome` in the same sentence as the probes that
 * already had it (`resolveIdentity`, `detectRunner`, the NO_NEW_PRIVS probe, the PTY's
 * python3 probe). These three were the only parsed-output probes still on a 30s ceiling
 * with no retry, so a single wsl.exe stall longer than 30s threw straight out of
 * `checkLinuxPath` — and the stall is a property of the machine, not of the path: the
 * distribution shares one VM with every other one, and measured while that VM ran at
 * load ~11 with its swap 95% full, this probe answered in ~300ms and then timed out at
 * 30.4s and 30.5s on two consecutive calls. The retry is the same ruling the identity
 * probe follows: repeat the SAME probe once, immediately, and let a persistent stall
 * still fail loudly with the second attempt's evidence.
 *
 * Retrying is safe here because all FOUR probes are READS: the listing protocol frames
 * its own output and the check prints one of three tokens, so a repeat cannot duplicate
 * a side effect; `resolveLoginShell` runs a read-only `getent` and answers the same way.
 * (This comment said "three" while four probes already consumed the runner — scripts/
 * wsl-probe.mjs counts the same four.) The trigger is deliberately `timedOut` alone and
 * not "any bad answer": a non-zero exit from the listing script is the ordinary answer
 * for a directory that is not there, and doubling the latency of that case would slow
 * the interactive picker for no measured benefit.
 * @param {(request: object) => Promise<object>} run - the probe runner.
 * @param {object} request - the probe, without its ceiling.
 * @returns {Promise<object>} the first conclusive attempt, or the second after a timeout.
 */
async function probeWithRetry(run, request) {
  const first = await run({ ...request, timeoutMs: PROBE_TIMEOUT_MS })
  if (first.timedOut !== true) return first
  return await run({ ...request, timeoutMs: PROBE_TIMEOUT_MS })
}

/**
 * List one directory inside a distribution.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux directory.
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy above can be driven without a distribution — the same seam `resolveIdentity`/`detectRunner` expose).
 * @returns {Promise<{ path: string, parent: string | null, entries: Array<{ name: string, kind: 'directory' | 'file' }>, hidden: number }>} the listing.
 */
export async function listLinuxDir(distro, linuxPath, { wslPath, run = runWslShell } = {}) {
  const path = linuxPath.startsWith('/') ? linuxPath : `/${linuxPath}`
  // Entries are NUL-terminated so a filename containing a newline survives the
  // round trip; `..?*` covers names like `..keep` that `.[!.]*` misses.
  //
  // A missing directory is distinguishable from an unreachable distribution: the
  // `cd` failure prints ONE marker and exits 3, while any other failure keeps the
  // probe's own exit code. The route maps those to different browser codes, and it
  // must not read a message to do it.
  // A missing path, a non-directory and a permission failure are THREE different
  // facts; the old `cd ... || missing` collapsed all three into "does not exist".
  // The stderr of `cd` is kept (not redirected) for the host-side message, which
  // never crosses the wire. `-e`/`-d` follow symlinks, as `cd` does.
  const quoted = shellQuote(path)
  const script = `if [ ! -e ${quoted} ]; then printf '__DSH_LIST_MISSING__\\n'; exit 3; fi; `
    + `if [ ! -d ${quoted} ]; then printf '__DSH_LIST_NOT_DIR__\\n'; exit 4; fi; `
    + `cd ${quoted} || { printf '__DSH_LIST_DENIED__\\n'; exit 5; }; `
    + `for entry in * .[!.]* ..?*; do [ -e "$entry" ] || continue; `
    + `if [ -d "$entry" ]; then printf 'd\\t%s\\0' "$entry"; else printf 'f\\t%s\\0' "$entry"; fi; done`
  // `raw`: this protocol frames every entry with a NUL byte, so it decodes its
  // OWN stream. A text heuristic cannot separate a NUL-framed listing from
  // UTF-16LE — with one-character entry names every NUL lands on exactly the
  // byte positions UTF-16LE uses — and guessing wrong returned [] for a
  // directory that is not empty.
  const result = await probeWithRetry(run, { distro, linuxCwd: '/', command: script, loginShell: false, raw: true, wslPath })
  if (result.exitCode !== 0) {
    // The probe's own evidence goes into the message: a twice-retried cold-VM stall
    // (exit code null) must read as a timeout, not as "退出码 null" — the transient
    // failure a reader can act on by waking the distribution.
    const stderr = result.stderr.toString('utf8').trim()
    const stdout = result.stdout.toString('utf8')
    if (result.exitCode === 3 && stdout.includes('__DSH_LIST_MISSING__')) {
      throw new WslDomainError('path-not-found', `目录不存在：${path}`)
    }
    if (result.exitCode === 4 && stdout.includes('__DSH_LIST_NOT_DIR__')) {
      throw new WslDomainError('path-not-directory', `不是目录：${path}`)
    }
    if (result.exitCode === 5 && stdout.includes('__DSH_LIST_DENIED__')) {
      throw new WslDomainError('path-denied', `无法读取目录：${path}：${stderr || probeEvidence(result)}`)
    }
    throw new WslDomainError('distro-unreachable', `无法列出 ${path}：${stderr || probeEvidence(result)}`)
  }
  const parsed = result.stdout.toString('utf8')
    .split('\0')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [kind, ...rest] = line.split('\t')
      return { name: rest.join('\t'), kind: kind === 'd' ? 'directory' : 'file' }
    })
  // A name carrying a control character or a backslash cannot be spliced into
  // the Windows UNC workspace spelling; the picker would offer a row that every
  // later route call rejects as path-invalid. Hide it, but say how many.
  const entries = parsed.filter((entry) => !/[\x00-\x1F\x7F\\]/.test(entry.name))
  const hidden = parsed.length - entries.length
  const trimmed = path.replace(/\/+$/, '')
  const parent = trimmed === '' || trimmed === '/' ? null : trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
  return { path, parent, entries, hidden }
}

/**
 * Check whether one Linux path exists.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux path.
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy above can be driven without a distribution).
 * @returns {Promise<{ exists: boolean, isDirectory: boolean }>} existence facts.
 */
export async function checkLinuxPath(distro, linuxPath, { wslPath, run = runWslShell } = {}) {
  const script = `if [ -d ${shellQuote(linuxPath)} ]; then echo dir; `
    + `elif [ -e ${shellQuote(linuxPath)} ]; then echo other; else echo missing; fi`
  const result = await probeWithRetry(run, { distro, linuxCwd: '/', command: script, loginShell: false, wslPath })
  // A probe that could not RUN is not "the path is missing". When the script runs
  // at all it exits 0 and prints exactly one of its three answers, so a non-zero
  // code, a timeout, or an unreadable answer means the DISTRIBUTION failed
  // (unregistered distro, WSL not running, cold-start timeout). Reporting that as
  // `exists: false` told the operator a perfectly valid path does not exist —
  // a wrong diagnosis that sends them to retype it forever. listLinuxDir throws
  // for the same reason.
  const answer = result.stdout.trim()
  if (result.exitCode !== 0 || result.timedOut === true || !['dir', 'other', 'missing'].includes(answer)) {
    throw new WslDomainError('distro-unreachable', `无法检查 ${linuxPath}：${result.stderr.trim() || result.stdout.trim() || probeEvidence(result)}`)
  }
  return { exists: answer === 'dir' || answer === 'other', isDirectory: answer === 'dir' }
}

/**
 * Describe one probe's outcome for a failure message.
 *
 * The evidence is what makes the two causes of an empty answer tellable apart:
 * an exit code of 0 with empty stderr means the probe ran and found nothing
 * (there really is no such user), while a non-zero code, a timeout, or a missing
 * code means the probe itself failed — and a transient `wsl.exe` failure looks
 * exactly like an absent user without this. Pure, so it is testable without a
 * distribution.
 * @param {{ exitCode?: number | null, stderr?: string, timedOut?: boolean }} entry - one probe outcome.
 * @returns {string} the parenthesised evidence, e.g. `（探针退出码 0）`.
 */
export function probeEvidence(entry) {
  const stderr = typeof entry?.stderr === 'string' ? entry.stderr.trim() : ''
  // A killed probe reports no exit code at all, so the timeout has to be named:
  // "null" is not something a reader can act on, and a timeout is the transient
  // failure this evidence exists to separate from an absent user.
  let detail = `探针退出码 ${String(entry?.exitCode)}`
  if (entry?.timedOut === true) detail = '探针超时'
  else if (entry?.exitCode === null || entry?.exitCode === undefined) detail = '探针未正常退出'
  if (stderr !== '') detail += `，stderr: ${stderr}`
  return `（${detail}）`
}

/**
 * Resolve a user's home directory inside a distribution.
 *
 * The workspace dialog prefills its path with the answer, so the picker opens
 * in the operator's own files instead of the filesystem root. The home comes
 * from the distribution's own user database (`getent`), so it answers for any
 * user that exists there, not just the default one. Non-login shells on
 * purpose: a login shell's rc could print anything, and this must return
 * exactly one path.
 * @param {string} distro - distribution name.
 * @param {string} [username] - user to resolve; absent resolves the default user.
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy above can be driven without a distribution).
 * @returns {Promise<{ user: string, home: string }>} the user and their home.
 * @throws Error when the user or a usable home cannot be resolved.
 */
export async function resolveDistroHome(distro, username, { wslPath, run = runWslShell } = {}) {
  let user = typeof username === 'string' ? username.trim() : ''
  const suppliedUser = user !== ''
  if (user === '') {
    // Non-login + trimmed on purpose: the parsed answer must be provably this
    // probe's output (the login name), never profile scripts'.
    const who = await probeWithRetry(run, { distro, linuxCwd: '/', command: 'id -un', loginShell: false, wslPath })
    user = who.stdout.trim()
    if (user === '' || user.includes('\n')) {
      // probeEvidence, not a bare exit code: a twice-retried stall reports
      // exitCode null, and "null" is not something a reader can act on. The
      // sibling home probe below already does this for the same reason.
      throw new WslDomainError('distro-unreachable', `无法确定发行版 ${distro} 的默认用户：${who.stderr.trim() || probeEvidence(who)}`)
    }
  }
  // `getent` reads the distro's own NSS user database. The pipeline's exit
  // code belongs to `cut` (always 0), so an unknown user is detected by the
  // output, not by the exit code. Exactly one passwd line is the only
  // unambiguous answer: a name getent misparses can dump the whole database,
  // and a multi-line "home" would only fail later and confusingly at listDir.
  const entry = await probeWithRetry(run, {
    distro,
    linuxCwd: '/',
    command: `getent passwd ${shellQuote(user)} | cut -d: -f6`,
    loginShell: false,
    wslPath,
  })
  const lines = entry.stdout.trim().split('\n')
  const home = lines.length === 1 ? lines[0].trim() : ''
  if (home === '' || !home.startsWith('/')) {
    // The probe's own evidence goes into the message: without it a transient
    // `wsl.exe` failure is indistinguishable from a user who really is absent.
    // A USER the caller named is a user error; the resolved default user failing
    // getent is a distribution/NSS fault, and the browser codes differ.
    const code = suppliedUser ? 'user-unknown' : 'distro-unreachable'
    throw new WslDomainError(code, `发行版 ${distro} 里没有用户 ${user}，或该用户没有主目录${probeEvidence(entry)}`)
  }
  return { user, home }
}

/**
 * The workspace a caller uses when it names no directory: the DEFAULT
 * distribution's home, in the UNC spelling a Windows-side session requires.
 *
 * Three steps, in this order, because each feeds the next: the distribution is
 * resolved FIRST (there is no way to express "the default distribution" to
 * wsl.exe, and resolveDistroHome validates the name it is given), then that
 * distribution's home is read from its own user database, then the home is
 * spelled as the UNC path a Windows-side session can carry.
 *
 * That order is the fix for a default that could never run. The self-test used
 * resolveDistroHome(undefined, undefined), which throws
 * "wsl: 非法的发行版名 null" before any probe, and the {user, home} object it
 * would have returned is not a path either (resolveLocation requires a non-empty
 * string). Every acceptance path passed cwd explicitly, so nothing reddened.
 * Exported and standalone so the DEFAULT path itself can be exercised without
 * the running host.
 * @param {{ wslPath?: string }} [options] - the configured `wsl.exe` path.
 * @returns {Promise<{ distro: string, linuxPath: string, uncPath: string }>} the default workspace, in the shape resolveLocation returns.
 * @throws Error when the machine has no default distribution.
 */
export async function defaultWorkspaceUnc({ wslPath } = {}) {
  const distro = await defaultDistro()
  if (distro === undefined) {
    throw new Error('wsl: 找不到默认发行版（Lxss 注册表里没有 DefaultDistribution）：请显式传入 cwd，或把某个发行版设为默认')
  }
  const { home } = await resolveDistroHome(distro, undefined, { wslPath })
  return { distro, linuxPath: home, uncPath: joinWslUnc(distro, home) }
}

/**
 * The login-shell probe did not answer, so no login shell could be determined.
 *
 * A structured class, not a plain Error, because the two failures are not the
 * same failure to the CALLER. The round-4 defect was a VALUE that looked like an
 * answer; this is the other half of that ruling — the value is gone, but a plain
 * Error cannot be told from a failure of the caller's own. `subprocess.js` is
 * the caller that has to act: `resolveExecutable` turns this class into
 * `SubprocessExecutableNotFoundError`, which the terminal controller catches to
 * SKIP a candidate and continue down its shell list (zsh, fish, ... are commonly
 * absent from a distribution), and `spawnTerminal` reports it as the failure of
 * the one program it was asked to run. The controller's default candidates
 * include three Windows shell names (`pwsh`, `powershell`, `cmd` —
 * packages/api/terminal-controller/src/index.ts shellCandidates), and EVERY one of
 * them asks this question, so a stall that survived this probe's own repeat
 * reached the candidate loop three times: as a plain Error the first one aborted
 * the whole discovery, and the shell dropdown failed on every distro instead of
 * losing three entries from it.
 */
export class LoginShellUnresolvedError extends Error {
  /**
   * @param {string} message - the probe's own evidence, never a guess about the shell.
   */
  constructor(message) {
    super(message)
    this.name = 'LoginShellUnresolvedError'
  }
}

/**
 * The session user's login shell inside the distribution — the Linux
 * equivalent of a deployment-configured Windows terminal shell. Read from the
 * user database (`getent`, field 7), falling back to `/bin/bash` only when the
 * probe RAN and `getent` itself ANSWERED with field 7 EMPTY (passwd(5)'s "no shell
 * configured": the absence of a value, not a value to overrule). Anything the probe
 * printed is returned as measured, path-shaped or not — `nologin` is a deliberate
 * "this account has no interactive shell" marker, and both callers SPAWN this value,
 * so replacing it with a shell the distribution never measured is the silent wrong
 * answer `spawnTerminal` refuses by name. A probe that did not run never reaches
 * this fallback; it throws.
 *
 * `getent`'s own status is what makes that answer provable, and the command
 * carries it (`entry=$(getent passwd …) || exit $?`). The obvious spelling does
 * not: `getent passwd … | cut -d: -f7` exits with `cut`'s status and `cut`
 * exits 0 on empty input, so a `getent` that could not run was read as "this
 * user has no login shell". Measured in a distribution with `getent` shadowed by
 * a function returning 127: the masked pipeline exited 0 with empty output and
 * the fallback answered `/bin/bash` — the silent-wrong-answer class this probe
 * exists to refuse, one layer below the stall, which is why it is refused rather
 * than documented. `resolveDistroHome` already rules the same way for the same
 * masking (see the comment on its own `getent` probe): the pipeline's exit code
 * proves nothing, so the answer is detected by its OUTPUT. A user the
 * distribution does not have answers exit 2 and is refused too: that is not an
 * empty field, it is no answer.
 *
 * A probe that did not complete is NOT the empty-field case either. It used to
 * return `/bin/bash` like a real answer, so a stalled relay — the machine
 * transient docs/CONFINEMENT.md's probe policy exists for — silently pinned the session's
 * shell with a value the caller could not tell from the distribution's own. The
 * ceiling and the repeat are `probeWithRetry`'s (探针超时 60s + 超时后一次透明重试),
 * the same ruling `listLinuxDir`/`checkLinuxPath`/`resolveDistroHome` follow, and a
 * second stall fails with {@link LoginShellUnresolvedError} carrying the probe's
 * own evidence instead of answering.
 * @param {string} distro - distribution name.
 * @param {string} [username] - Linux user; omitted uses the distribution default.
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy above can be driven without a distribution — the same seam the sibling probes expose).
 * @returns {Promise<string>} the login shell path.
 * @throws {LoginShellUnresolvedError} when the probe timed out twice, could not
 *   run, or `getent` did not answer. The one value returned without the probe (an
 *   EMPTY field 7) is the documented fallback and is deliberately NOT refused;
 *   every other returned value is one `getent` printed — including a marker such
 *   as `nologin`, which is an answer and not a missing value.
 */
export async function resolveLoginShell(distro, username, { wslPath, run = runWslShell } = {}) {
  // The username must reach BOTH layers: `-u` runs the probe as that user, and
  // the getent query names that user — `$(id -un)` alone would always answer
  // for the distribution DEFAULT user even when the session is pinned to
  // another one.
  const named = typeof username === 'string' && username !== ''
  // Quoted even though runWslShell validates the same value before spawning: a
  // safety property that two layers each assume the OTHER one enforces is one
  // edit away from disappearing. resolveDistroHome already quotes its user.
  const who = named ? shellQuote(username) : '"$(id -un)"'
  const shell = await probeWithRetry(run, {
    distro,
    linuxCwd: '/',
    // `getent`'s OWN status reaches the caller: the pipeline's status belongs to
    // `cut`, which exits 0 on empty input, so the mask made "getent could not run"
    // indistinguishable from "field 7 is empty" — and the fallback below converts
    // the first into a /bin/bash the caller cannot tell from a measured answer.
    command: `entry=$(getent passwd ${who}) || exit $?; printf '%s\\n' "$entry" | cut -d: -f7`,
    loginShell: false,
    ...(named ? { username } : {}),
    wslPath,
  })
  // A probe that did not COMPLETE is not an answer, even when its truncated stream
  // happens to look path-shaped: a killed process is cut mid-write, and a truncated
  // '/bin/bash' still starts with '/'. `checkLinuxPath` refuses a timed-out probe for
  // the same reason. Only a probe that ran and exited 0 may say "no login shell".
  if (shell.timedOut === true || shell.exitCode !== 0) {
    const stderr = typeof shell.stderr === 'string' ? shell.stderr.trim() : ''
    throw new LoginShellUnresolvedError(`无法确定发行版 ${distro} 的登录 shell：${stderr || probeEvidence(shell)}`)
  }
  // A MULTI-LINE answer is refused, not truncated to line 1: resolveDistroHome runs
  // the same getent-passwd shape and refuses it because a name getent misparses can
  // dump the whole database — taking line 1 would silently elect the FIRST entry's
  // shell for whichever user the caller asked about. Exactly one line is the only
  // unambiguous answer, and an unresolvable login shell is a SKIP for the terminal
  // controller, while a wrong shell is a session that does not work. The refusal is
  // on the LINE COUNT: a single line that trims to empty is NOT this case — that is
  // the documented /bin/bash fallback below.
  const lines = shell.stdout.trim().split('\n')
  if (lines.length > 1) {
    throw new LoginShellUnresolvedError(
      `无法确定发行版 ${distro} 的登录 shell：getent 返回了 ${lines.length} 行，唯一一行才是无歧义答案`,
    )
  }
  const resolved = lines[0].trim()
  // EMPTY is the fallback (the only way `resolved` is empty past the refusal above
  // is a single line that trims to nothing); an ANSWERED value is returned as
  // measured, so the test is deliberately `=== ''` and not `startsWith('/')`. A
  // non-path answer such as `nologin` is the distribution's own ruling that this
  // account has no interactive shell, and both callers SPAWN the value
  // (subprocess.js hands it back as the resolved executable, and uses it as
  // spawnTerminal's whole argv), so swapping in an unmeasured /bin/bash would open
  // exactly the shell the account's passwd entry refuses — a value the caller
  // cannot tell from one the probe measured.
  return resolved === '' ? '/bin/bash' : resolved
}
