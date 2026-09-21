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

import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { DISTRO_NAME, isWindowsPathShaped, LINUX_USER, mntToWindowsPath, parseWslUnc, shellQuote, windowsToMntPath } from './paths.js'

const execFileAsync = promisify(execFile)

/**
 * Refuse option values that cannot be safe single argv tokens for wsl.exe
 * (-d/-u), independent of wsl.exe's external tokenization rules.
 * @param {string} distro - the distribution name about to be spawned with.
 */
function assertDistroName(distro) {
  if (typeof distro !== 'string' || !DISTRO_NAME.test(distro)) {
    throw new Error(`wsl: 非法的发行版名 ${JSON.stringify(distro ?? null)}`)
  }
}

/**
 * Refuse usernames that cannot be safe single argv tokens for wsl.exe -u.
 * @param {string | undefined} username - the Linux user about to be spawned with.
 */
function assertUserName(username) {
  if (username !== undefined && username !== '' && !LINUX_USER.test(username)) {
    throw new Error(`wsl: 非法的用户名 ${JSON.stringify(username)}`)
  }
}

/** Short ceiling for the registry and `wsl.exe` discovery calls. */
const DISCOVERY_TIMEOUT_MS = 10_000

/** Per-stream capture ceiling; a runaway command must not buffer without bound. */
const MAX_STREAM_BYTES = 1024 * 1024

/** Windows registry key holding the WSL distribution registrations. */
const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

/** Environment overrides that keep command output model-readable. */
const ENV_OVERRIDES = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }

/**
 * Decode `wsl.exe` output. Most builds emit UTF-16LE with interleaved NUL
 * bytes while newer ones emit UTF-8, so the NUL probe picks the decoder.
 * @param {Buffer} buffer - raw captured stdout.
 * @returns {string} the decoded text.
 */
export function decodeWslOutput(buffer) {
  return buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
}

/**
 * List the installed WSL distributions.
 * @returns {Promise<string[]>} distribution names in `wsl.exe` order.
 */
export async function listDistros() {
  let stdout
  try {
    ({ stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      timeout: DISCOVERY_TIMEOUT_MS,
    }))
  } catch (error) {
    throw new Error(`无法列出 WSL 发行版：${error instanceof Error ? error.message : String(error)}`)
  }
  return decodeWslOutput(stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0)
}

/**
 * Read the user's default distribution from the Lxss registry. Non-fatal:
 * `undefined` when the value is absent or unreadable.
 * @returns {Promise<string | undefined>} the default distribution name.
 */
export async function defaultDistro() {
  try {
    const value = await execFileAsync('reg.exe', ['query', LXSS_KEY, '/v', 'DefaultDistribution'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(String(value.stdout))?.[1]
    if (guid === undefined) return undefined
    const name = await execFileAsync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(String(name.stdout))?.[1]?.trim()
    return distro === undefined || distro === '' ? undefined : distro
  } catch {
    // A missing or unreadable registry value leaves the caller its own fallback.
    return undefined
  }
}

/**
 * Synchronous default-distribution read for plan steps that cannot await.
 *
 * Cached after the first read: a shell plan is built synchronously, and the
 * registry does not change while the process runs.
 * @returns {string | undefined} the default distribution name.
 */
let syncDefaultResolved = false
let syncDefault
export function defaultDistroSync() {
  if (syncDefaultResolved) return syncDefault
  syncDefaultResolved = true
  try {
    const value = execFileSync('reg.exe', ['query', LXSS_KEY, '/v', 'DefaultDistribution'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const guid = /DefaultDistribution\s+REG_SZ\s+(\{[0-9a-fA-F-]+\})/i.exec(String(value))?.[1]
    if (guid === undefined) return undefined
    const name = execFileSync('reg.exe', ['query', `${LXSS_KEY}\\${guid}`, '/v', 'DistributionName'], {
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    const distro = /DistributionName\s+REG_SZ\s+(.+)/i.exec(String(name))?.[1]?.trim()
    syncDefault = distro === undefined || distro === '' ? undefined : distro
  } catch {
    // An unreadable registry leaves the caller its own fail-loud path.
    syncDefault = undefined
  }
  return syncDefault
}

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
    flags.push(isWindowsPathShaped(value) ? `${key}/p` : key)
  }
  const ambient = process.env.WSLENV
  const merged = [ambient, flags.join(':')].filter((part) => part !== undefined && part !== '').join(':')
  return merged === '' ? { ...env } : { ...env, WSLENV: merged }
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
  const env = { ...process.env, ...ENV_OVERRIDES, ...extra }
  const flags = []
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (key.toUpperCase() === 'WSLENV') continue
    flags.push(isWindowsPathShaped(value) ? `${key}/p` : key)
  }
  const ambient = process.env.WSLENV
  const merged = [ambient, flags.join(':')].filter((part) => part !== undefined && part !== '').join(':')
  if (merged !== '') env.WSLENV = merged
  return env
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
export function planWsl(workdir, fallbackDistro) {
  const windowsCwd = process.env.SystemRoot ?? process.cwd()
  const unc = parseWslUnc(workdir)
  if (unc !== null) return { distro: unc.distro, linuxCwd: unc.linuxPath, windowsCwd }
  if (workdir.startsWith('/')) {
    const distro = fallbackDistro ?? defaultDistroSync()
    if (distro === undefined) {
      throw new Error(`wsl: 无法确定 "${workdir}" 所属的发行版，请配置 distro`)
    }
    // A drive mount is also addressable from the Windows side; keep that as the
    // spawn directory so a failure still names a real path.
    return { distro, linuxCwd: workdir, windowsCwd: mntToWindowsPath(workdir) ?? windowsCwd }
  }
  const mnt = windowsToMntPath(workdir)
  if (mnt === null) {
    throw new Error(`wsl: 工作目录 "${workdir}" 不在 WSL 执行世界里`)
  }
  const distro = fallbackDistro ?? defaultDistroSync()
  if (distro === undefined) {
    throw new Error(`wsl: 无法确定 "${workdir}" 所属的发行版，请配置 distro`)
  }
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
    ...(options.username !== undefined && options.username !== '' ? ['-u', options.username] : []),
    '--cd', plan.linuxCwd,
    '-e',
    ...argv,
  ]
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
 * @returns {Promise<{ argv: string[], exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }>} the settled outcome.
 */
export function runWslShell({ distro, linuxCwd, command, username, loginShell = true, env, timeoutMs = 120_000, signal }) {
  // Option values are validated against the repo's own grammars so exec-path
  // safety never depends on wsl.exe's external (undocumented) tokenization:
  // a separator-bearing distro/username is refused before any process starts.
  assertDistroName(distro)
  assertUserName(username)
  const script = loginShell ? `cd ${shellQuote(linuxCwd)} && ${command}` : command
  const argv = [
    '-d', distro,
    ...(username !== undefined && username !== '' ? ['-u', username] : []),
    '--cd', linuxCwd,
    '-e', 'bash', loginShell ? '-lc' : '-c', script,
  ]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('wsl.exe', argv, {
        cwd: process.env.SystemRoot ?? process.cwd(),
        env: bridgeEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`wsl.exe 启动失败：${error instanceof Error ? error.message : String(error)}`))
      return
    }
    const out = { stdout: '', stderr: '', timedOut: false }
    const collect = (stream, key) => {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        if (out[key].length >= MAX_STREAM_BYTES) return
        out[key] += chunk.slice(0, MAX_STREAM_BYTES - out[key].length)
      })
    }
    collect(child.stdout, 'stdout')
    collect(child.stderr, 'stderr')

    let timer
    const onAbort = () => {
      out.timedOut = false
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
      resolve({ argv: ['wsl.exe', ...argv], exitCode, stdout: out.stdout, stderr: out.stderr, timedOut: out.timedOut })
    }
    child.on('error', (error) => {
      settle(null, new Error(`wsl.exe 执行失败：${error.message}`))
    })
    child.on('close', (code) => {
      settle(code, undefined)
    })
  })
}

/**
 * List one directory inside a distribution.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux directory.
 * @returns {Promise<{ path: string, parent: string | null, entries: Array<{ name: string, kind: 'directory' | 'file' }> }>} the listing.
 */
export async function listLinuxDir(distro, linuxPath) {
  const path = linuxPath.startsWith('/') ? linuxPath : `/${linuxPath}`
  // Entries are NUL-terminated so a filename containing a newline survives the
  // round trip; `..?*` covers names like `..keep` that `.[!.]*` misses.
  const script = `cd ${shellQuote(path)} && for entry in * .[!.]* ..?*; do [ -e "$entry" ] || continue; `
    + `if [ -d "$entry" ]; then printf 'd\\t%s\\0' "$entry"; else printf 'f\\t%s\\0' "$entry"; fi; done`
  const result = await runWslShell({ distro, linuxCwd: '/', command: script, loginShell: false, timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    throw new Error(`无法列出 ${path}：${result.stderr.trim() || `退出码 ${String(result.exitCode)}`}`)
  }
  const entries = result.stdout
    .split('\0')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [kind, ...rest] = line.split('\t')
      return { name: rest.join('\t'), kind: kind === 'd' ? 'directory' : 'file' }
    })
  const trimmed = path.replace(/\/+$/, '')
  const parent = trimmed === '' || trimmed === '/' ? null : trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'
  return { path, parent, entries }
}

/**
 * Check whether one Linux path exists.
 * @param {string} distro - distribution name.
 * @param {string} linuxPath - absolute Linux path.
 * @returns {Promise<{ exists: boolean, isDirectory: boolean }>} existence facts.
 */
export async function checkLinuxPath(distro, linuxPath) {
  const script = `if [ -d ${shellQuote(linuxPath)} ]; then echo dir; `
    + `elif [ -e ${shellQuote(linuxPath)} ]; then echo other; else echo missing; fi`
  const result = await runWslShell({ distro, linuxCwd: '/', command: script, loginShell: false, timeoutMs: 30_000 })
  const answer = result.stdout.trim()
  return { exists: answer === 'dir' || answer === 'other', isDirectory: answer === 'dir' }
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
 * @returns {Promise<{ user: string, home: string }>} the user and their home.
 * @throws Error when the user or a usable home cannot be resolved.
 */
export async function resolveDistroHome(distro, username) {
  let user = typeof username === 'string' ? username.trim() : ''
  if (user === '') {
    // Non-login + trimmed on purpose: the parsed answer must be provably this
    // probe's output ('zcluo'), never profile scripts'.
    const who = await runWslShell({ distro, linuxCwd: '/', command: 'id -un', loginShell: false, timeoutMs: 30_000 })
    user = who.stdout.trim()
    if (user === '' || user.includes('\n')) {
      throw new Error(`无法确定发行版 ${distro} 的默认用户：${who.stderr.trim() || `退出码 ${String(who.exitCode)}`}`)
    }
  }
  // `getent` reads the distro's own NSS user database. The pipeline's exit
  // code belongs to `cut` (always 0), so an unknown user is detected by the
  // output, not by the exit code. Exactly one passwd line is the only
  // unambiguous answer: a name getent misparses can dump the whole database,
  // and a multi-line "home" would only fail later and confusingly at listDir.
  const entry = await runWslShell({
    distro,
    linuxCwd: '/',
    command: `getent passwd ${shellQuote(user)} | cut -d: -f6`,
    loginShell: false,
    timeoutMs: 30_000,
  })
  const lines = entry.stdout.trim().split('\n')
  const home = lines.length === 1 ? lines[0].trim() : ''
  if (home === '' || !home.startsWith('/')) {
    throw new Error(`发行版 ${distro} 里没有用户 ${user}，或该用户没有主目录`)
  }
  return { user, home }
}

/**
 * The session user's login shell inside the distribution — the Linux
 * equivalent of a deployment-configured Windows terminal shell. Read from the
 * user database (`getent`, field 7), falling back to `/bin/bash`.
 * @param {string} distro - distribution name.
 * @param {string} [username] - Linux user; omitted uses the distribution default.
 * @returns {Promise<string>} the login shell path.
 */
export async function resolveLoginShell(distro, username) {
  const shell = await runWslShell({
    distro,
    linuxCwd: '/',
    command: 'getent passwd "$(id -un)" | cut -d: -f7',
    loginShell: false,
    timeoutMs: 60_000,
  })
  const resolved = shell.stdout.trim().split('\n')[0]?.trim() ?? ''
  return resolved.startsWith('/') ? resolved : '/bin/bash'
}
