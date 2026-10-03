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
import { DISTRO_NAME, isWindowsPathShaped, LINUX_USER, joinWslUnc, mntToWindowsPath, parseWslUnc, shellQuote, windowsToMntPath } from './paths.js'

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

/**
 * The environment every `wsl.exe` child must be started with, wherever it is
 * spawned from.
 *
 * `WSL_UTF8` is load-bearing, not cosmetic: wsl.exe reads it from its OWN
 * environment to decide the encoding of its diagnostics. Without it a missing
 * distribution emits 258 bytes of UTF-16LE, which is what forced the decoder to
 * guess between encodings — and every guess traded one failure class for another.
 * With it the same message arrives as 223 bytes of UTF-8.
 *
 * It lives here, as one exported constant, because there are four spawn sites
 * (the probe path, the shell executor, the subprocess provider's spawn and its
 * terminal allocation) and a site that forgets it silently gets unreadable
 * messages again. Linux-side output is unaffected; only wsl.exe's own text changes.
 */
export const WSL_CHILD_ENV = { WSL_UTF8: '1' }

/** Environment overrides that keep command output model-readable. */
const ENV_OVERRIDES = { ...WSL_CHILD_ENV, NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' }

/**
 * Decode `wsl.exe` output.
 *
 * Every `wsl.exe` this plugin spawns is asked for UTF-8 (`WSL_UTF8`, see
 * {@link ENV_OVERRIDES}), so this is normally a plain UTF-8 decode — including the
 * diagnostics wsl.exe prints for its OWN failures, which are UTF-16LE without that
 * variable and were the whole reason this decoder used to guess between encodings.
 *
 * The fallback covers two things a WSL build that ignores the variable can send:
 * an explicit UTF-16LE BOM, and UTF-16LE whose code units are below U+0100 (their
 * high bytes are NUL — Latin-1 counts, not only ASCII).
 *
 * NUL-framed DATA is the awkward case, and a RATIO alone cannot settle it:
 * measured, `find . -print0` scores 0.500, the real Chinese diagnostic 0.636, and
 * `ls --zero` with single-character names reaches 1.000 — where the bytes ARE
 * `Buffer.from('abc', 'utf16le')`, byte for byte. Hence the layering above: a
 * partial interleave must also fail UTF-8 validity, which drops the framing
 * payloads (valid UTF-8) and keeps the diagnostic (invalid); an all-odd
 * interleave is honoured regardless, because that is the shape `listDistros`
 * depends on when a build ignores the switch.
 *
 * The irreducible residue is exactly that byte-identical pair: no test can
 * separate two readings of the same bytes. A consumer whose protocol frames with
 * NUL must therefore opt out with `raw` — `listLinuxDir` does, and `execInWsl`,
 * the only consumer of ARBITRARY command output, takes `raw` for the same reason.
 *
 * Three attempts at a smarter heuristic (interleave ratios, replacement-character
 * densities, UTF-8 validity) each traded one failure class for another: every
 * listing empty, then a >1 MiB CJK stream mojibake, then valid buffers flipped.
 * Guessing between encodings was the wrong shape; asking for UTF-8 removed the
 * need to guess, and this fallback covers the builds that predate the variable.
 * @param {Buffer} buffer - raw captured stream.
 * @returns {string} the decoded text.
 */
export function decodeWslOutput(buffer) {
  return looksUtf16le(buffer) ? buffer.toString('utf16le') : buffer.toString('utf8')
}

/**
 * Whether a buffer is UTF-16LE whose code units are mostly below U+0100 — the
 * fallback shape.
 *
 * The class counted is NOT "ASCII": the pick is `oddNuls * 2 >= pairs`, i.e. at
 * least half the CODE UNITS must have a NUL high byte, and EVERY code unit below
 * U+0100 encodes with one — Latin-1 included. Measured: a UTF-16LE buffer of
 * U+00E9 and U+00FF (e-acute, y-diaeresis) is counted exactly like ASCII and
 * decodes as UTF-16LE. For a pure-ASCII text the two readings coincide, which is
 * why this used to be described as an "ASCII share"; for a Latin-1 text they do
 * not, and the rate below is the binomial tail of the share of code units BELOW
 * U+0100 — 100% for a text entirely below it, about 60% at half, about 8% at 35%
 * (two independent generators measured 62.2%/52.8% and 8.0%/6.8% on those same
 * anchors, which is the point: quote the mechanism, not a rate). The real wsl.exe
 * diagnostics captured here happen to be majority-ASCII (0.636-0.662) and are
 * caught; a message that is mostly CJK is not, and no threshold fixes that
 * without also admitting NUL-framed data. That is why the switch is requested at
 * the source instead.
 *
 * The test is the INTERLEAVED NUL pattern, not "contains a NUL": a Linux-side
 * producer may emit NUL bytes as DATA (`printf 'a\\0b'`), and a bare NUL test
 * decoded that as UTF-16LE and silently dropped the byte after it. Three code
 * units minimum, or the pattern is a coincidence — `'a\\0b'` is one pair and
 * satisfies any ratio.
 *
 * This deliberately does NOT try to recognise UTF-16LE whose code units are
 * ABOVE U+00FF (there the high byte is not NUL, so nothing distinguishes it from
 * text) — with ONE exception, the explicit BOM below, which is a declaration
 * rather than a statistic. Everything else is handled at the SOURCE instead: every spawn asks
 * wsl.exe for UTF-8 (WSL_UTF8), so a Chinese-locale diagnostic arrives as UTF-8
 * rather than as UTF-16LE whose only distinguishing feature is a
 * replacement-character count. Three heuristics were written for that case and
 * each traded one failure class for another.
 * @param {Buffer} buffer - raw captured stream.
 * @returns {boolean} true when the buffer looks like ASCII-heavy UTF-16LE.
 */
function looksUtf16le(buffer) {
  // An explicit BOM is a DECLARATION, not a guess: a file saved by a Windows
  // editor starts FF FE, and decoding it as UTF-8 is mojibake for certain. It is
  // checked BEFORE the parity guard on purpose, so a truncated BOM'd buffer
  // (FF FE 41) is still read as UTF-16LE and loses its trailing byte, rather than
  // being read as UTF-8 — the declaration wins over the shape.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true
  // A UTF-16LE stream is always an EVEN number of bytes, so an odd-length buffer
  // cannot be one — and `toString('utf16le')` would silently DROP the trailing byte
  // (measured: `printf 'a\\0b\\0c\\0d'` is 7 bytes and decoded to "abc").
  if (buffer.length % 2 !== 0) return false
  const pairs = Math.floor(buffer.length / 2)
  if (pairs < 3) return false
  let oddNuls = 0
  let evenNuls = 0
  for (let index = 0; index < pairs * 2; index += 2) {
    if (buffer[index] === 0) evenNuls += 1
    if (buffer[index + 1] === 0) oddNuls += 1
  }
  // The predicate is EXACTLY `oddNuls > evenNuls && oddNuls * 2 >= pairs`. An
  // earlier version of this comment called it "a majority of the odd positions and
  // nothing else", which was wrong twice: the first conjunct is real — a buffer
  // whose code units are mostly U+xx00 has as many even NULs as odd ones and is
  // rejected, e.g. Buffer.from([0,0,0,0,0,1,0,2,0x61,0,0x62,0]) — and where
  // evenNuls is 0 it fires at EXACTLY one half, not a majority.
  //
  // The populations OVERLAP, so this is a heuristic and not a proof — measured:
  //   real UTF-16LE diagnostics              0.636 - 0.662   -> fires, correctly
  //   real 'wsl.exe -l -q' UTF-16LE          1.000           -> fires (listDistros needs it)
  //   real 'find . -print0', long names      0.026 - 0.415   -> does not fire, correctly
  //   one-char entries './a\0./b\0./c\0'   0.500 EXACTLY   -> FIRES, WRONGLY
  //   'ls --zero', one-char names            1.000           -> fires; byte-identical
  //                                                             to UTF-16LE, inherent
  // (A real capture scored 0.529 on that one-char shape only because UTF-16LE text
  // was mixed into the stream; the pure listing is 0.5000 and still fires.)
  // That shape is the one that breaks: it puts a NUL on most odd byte positions, and
  // no threshold separates it from a diagnostic at 0.636 without dropping the
  // diagnostics that score below it. Three refinements
  // were tried and ALL were falsified, so none is kept:
  //   - a 0.75 threshold excluded the real diagnostics themselves;
  //   - "a partial interleave must also fail UTF-8 validity" excluded UTF-16LE whose
  //     bytes ARE valid UTF-8 (Buffer.from('abc不','utf16le')) while still admitting
  //     NUL-framed bytes that are not (printf 'a\\0b\\0c\\xff');
  //   - a 0.6 threshold fits exactly the sample above — which is the sample it was
  //     measured on, while a diagnostic that is mostly non-ASCII scores lower.
  // A ratio cannot prove an encoding. The OPT-OUTS can, and they are the answer:
  // listLinuxDir and execInWsl(raw:true) never reach this test at all.
  return oddNuls > evenNuls && oddNuls * 2 >= pairs
}

/**
 * List the installed WSL distributions.
 *
 * The configured path is spawned here too: this call is a probe like any other,
 * and a deployment that set the path because `wsl.exe` is not on PATH would get
 * an empty discovery while its real spawns worked.
 * @param {{ wslPath?: string }} [options] - the configured `wsl.exe` path.
 * @returns {Promise<string[]>} distribution names in `wsl.exe` order.
 */
export async function listDistros({ wslPath = 'wsl.exe' } = {}) {
  let stdout
  try {
    ({ stdout } = await execFileAsync(wslPath, ['-l', '-q'], {
      encoding: 'buffer',
      timeout: DISCOVERY_TIMEOUT_MS,
      // The discovery call is a wsl.exe spawn like any other: without this its
      // output is UTF-16LE and only the fallback probe reads it.
      env: { ...process.env, ...WSL_CHILD_ENV },
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
    ...(username !== undefined && username !== '' ? ['-u', username] : []),
    '--cd', linuxCwd,
    '-e', 'bash', loginShell ? '-lc' : '-c', script,
  ]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(wslPath, argv, {
        cwd: process.env.SystemRoot ?? process.cwd(),
        env: bridgeEnv(env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`wsl.exe 启动失败：${error instanceof Error ? error.message : String(error)}`))
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
      settle(null, new Error(`wsl.exe 执行失败：${error.message}`))
    })
    child.on('close', (code) => {
      settle(code, undefined)
    })
  })
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
 * Retrying is safe here because all three probes are READS: the listing protocol frames
 * its own output and the check prints one of three tokens, so a repeat cannot duplicate
 * a side effect. The trigger is deliberately `timedOut` alone and not "any bad answer":
 * a non-zero exit from the listing script is the ordinary answer for a directory that is
 * not there, and doubling the latency of that case would slow the interactive picker for
 * no measured benefit.
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
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy below can be driven without a distribution — the same seam `resolveIdentity`/`detectRunner` expose).
 * @returns {Promise<{ path: string, parent: string | null, entries: Array<{ name: string, kind: 'directory' | 'file' }> }>} the listing.
 */
export async function listLinuxDir(distro, linuxPath, { wslPath, run = runWslShell } = {}) {
  const path = linuxPath.startsWith('/') ? linuxPath : `/${linuxPath}`
  // Entries are NUL-terminated so a filename containing a newline survives the
  // round trip; `..?*` covers names like `..keep` that `.[!.]*` misses.
  const script = `cd ${shellQuote(path)} && for entry in * .[!.]* ..?*; do [ -e "$entry" ] || continue; `
    + `if [ -d "$entry" ]; then printf 'd\\t%s\\0' "$entry"; else printf 'f\\t%s\\0' "$entry"; fi; done`
  // `raw`: this protocol frames every entry with a NUL byte, so it decodes its
  // OWN stream. A text heuristic cannot separate a NUL-framed listing from
  // UTF-16LE — with one-character entry names every NUL lands on exactly the
  // byte positions UTF-16LE uses — and guessing wrong returned [] for a
  // directory that is not empty.
  const result = await probeWithRetry(run, { distro, linuxCwd: '/', command: script, loginShell: false, raw: true, wslPath })
  if (result.exitCode !== 0) {
    throw new Error(`无法列出 ${path}：${result.stderr.toString('utf8').trim() || `退出码 ${String(result.exitCode)}`}`)
  }
  const entries = result.stdout.toString('utf8')
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
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy below can be driven without a distribution).
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
    throw new Error(`无法检查 ${linuxPath}：${result.stderr.trim() || result.stdout.trim() || probeEvidence(result)}`)
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
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy below can be driven without a distribution).
 * @returns {Promise<{ user: string, home: string }>} the user and their home.
 * @throws Error when the user or a usable home cannot be resolved.
 */
export async function resolveDistroHome(distro, username, { wslPath, run = runWslShell } = {}) {
  let user = typeof username === 'string' ? username.trim() : ''
  if (user === '') {
    // Non-login + trimmed on purpose: the parsed answer must be provably this
    // probe's output (the login name), never profile scripts'.
    const who = await probeWithRetry(run, { distro, linuxCwd: '/', command: 'id -un', loginShell: false, wslPath })
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
    throw new Error(`发行版 ${distro} 里没有用户 ${user}，或该用户没有主目录${probeEvidence(entry)}`)
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
 * @param {{ wslPath?: string, run?: (options: object) => Promise<object> }} [options] - the configured `wsl.exe` path, and the probe runner (injectable so the retry policy below can be driven without a distribution — the same seam the sibling probes expose).
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
  const resolved = shell.stdout.trim().split('\n')[0]?.trim() ?? ''
  // EMPTY is the fallback; an ANSWERED value is returned as measured, so the test is
  // deliberately `=== ''` and not `startsWith('/')`. A non-path answer such as
  // `nologin` is the distribution's own ruling that this account has no interactive
  // shell, and both callers SPAWN the value (subprocess.js hands it back as the
  // resolved executable, and uses it as spawnTerminal's whole argv), so swapping in an
  // unmeasured /bin/bash would open exactly the shell the account's passwd entry
  // refuses — a value the caller cannot tell from one the probe measured.
  return resolved === '' ? '/bin/bash' : resolved
}
