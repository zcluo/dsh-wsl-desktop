/**
 * Import smoke test for the host half.
 *
 * A missing import is invisible to `node --check` (which only parses) and to
 * every suite that exercises the pure WSL modules: the module throws a
 * ReferenceError when the *row* loads it, and the only symptom inside the host is
 * a row that "never started" — which reads like a service-visibility problem
 * rather than a missing line. That exact shape cost a debugging round.
 *
 * The pure modules are really imported. The harness-importing modules cannot be
 * imported here (a plain Node process does not carry the host's resolution for
 * `@deepseek-ai/*`), so their base classes are checked structurally instead:
 * every `extends X` must name something the file imports.
 *
 * Run: node scripts/verify-modules.mjs
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = process.env.DSH_WSL_ROOT ?? join(here, '..')

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

/** Modules that import nothing from the harness, so the source tree can load them. */
const PURE = ['lib/wsl/paths.js', 'lib/wsl/preset.js', 'lib/wsl/fence.js', 'lib/wsl/publish.js', 'lib/http-admission.js']

/** Every module the host half loads, including the ones that need the host's resolution. */
const ALL = [
  'lib/index.js',
  'lib/wsl/paths.js',
  'lib/wsl/preset.js',
  'lib/wsl/fence.js',
  'lib/wsl/world.js',
  'lib/wsl/confinement.js',
  'lib/wsl/shell.js',
  'lib/wsl/fs.js',
  'lib/wsl/publish.js',
  'lib/wsl/subprocess.js',
  'lib/wsl/pty.js',
  'lib/wsl/host-refs.js',
  'lib/http-admission.js',
]

console.log('pure modules load')
for (const relative of PURE) {
  try {
    const module = await import(pathToFileURL(join(pluginRoot, relative)).href)
    check(`${relative} loads`, Object.keys(module).length > 0, Object.keys(module))
  } catch (error) {
    check(`${relative} loads`, false, error)
  }
}

// The header above explains why the harness-importing half is only checked
// STRUCTURALLY here. That misses a module which RESOLVES its imports but throws
// while EVALUATING — and inside the host that surfaces the same way, as a row that
// never started. So when the host's dependencies are reachable, import the real
// entry and assert the contract it must expose.
{
  const deps = process.env.DSH_WSL_DEPS ?? join(pluginRoot, 'node_modules')
  if (!existsSync(deps)) {
    console.log(`  SKIP  host-half import (no dependencies at ${deps} — link the host node_modules there, or set DSH_WSL_DEPS)`)
  } else {
    try {
      const host = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)
      check('lib/index.js loads against the real host dependencies', true)
      check('the plugin exposes the host contract',
        typeof host.name === 'string' && host.name.length > 0
          && typeof host.apply === 'function'
          && host.Config !== undefined,
        { name: host.name, apply: typeof host.apply, hasConfig: host.Config !== undefined })
    } catch (error) {
      check('lib/index.js loads against the real host dependencies', false, error)
    }
  }
}

console.log('\nbase classes are imported')
for (const relative of ALL) {
  const source = await readFile(join(pluginRoot, relative), 'utf8')
  const imported = new Set()
  for (const match of source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from/gm)) {
    for (const name of match[1].split(',')) imported.add(name.trim().split(/\s+as\s+/).pop().trim())
  }
  const bases = [...source.matchAll(/\bextends\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1])
  const missing = bases.filter((name) => !imported.has(name) && name !== 'Error')
  check(`${relative}: every base class is imported`, missing.length === 0, missing)
}

// The fs fence is REQUIRED: `lib/wsl/fs.js` must advertise `sandboxMode` (the
// capability fact that makes `tool-fs` resolve a per-call policy at all), route
// both mutation entry points through `checkedTarget`, deny with the structured
// `FS_SANDBOX_DENIED` code, and compare containment with a separator boundary.
// This pins the fence in place so it cannot disappear quietly again; when it
// changes, this check and the README move together.
{
  const source = await readFile(join(pluginRoot, 'lib/wsl/fs.js'), 'utf8')
  const fence = await readFile(join(pluginRoot, 'lib/wsl/fence.js'), 'utf8')
  const readme = await readFile(join(pluginRoot, 'README.md'), 'utf8')
  check('the fs fence is recorded in the README', readme.includes('fs 工具的围栏'))
  check('lib/wsl/fs.js declares a sandboxMode', /\bget sandboxMode\s*\(/.test(source))
  check('both mutation entry points route through checkedTarget',
    (source.match(/checkedTarget\(/g) ?? []).length >= 3,
    (source.match(/checkedTarget\(/g) ?? []).length)
  // Comments are blanked before counting: the file's own doc comment names the
  // code, so a raw count of 2 was satisfied by the comment plus ONE throw —
  // dropping the code from either mutation entry point still passed.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  check('refusals throw the structured FS_SANDBOX_DENIED from both mutation entry points',
    (codeOnly.match(/FS_SANDBOX_DENIED/g) ?? []).length >= 2,
    (codeOnly.match(/FS_SANDBOX_DENIED/g) ?? []).length)
  check('containment compares with a separator boundary',
    /isLexicallyUnderHost/.test(fence) && /startsWith\(bounded\)/.test(fence))
}

// The transport fence binds EVERY caller. `connection.requestRejection` returns
// one of exactly two arms from a single call — 403 when the Host/Origin is not
// trusted (the DNS-rebinding defence) and 401 when the browser session is not
// authenticated — and the route applied it only when `!developer`, so a
// development token skipped BOTH. A local script can always present a trusted
// Host, so the token only ever needed to replace the 401 arm.
//
// BOUNDARY — every label below says which of the two it is. The five
// `fenceRejection` checks EXECUTE the rule, so they name the rule. The two
// SOURCE-TEXT pins read lib/index.js and pin the call's SHAPE: the result bound
// to `rejection`, gated on it, and sent. The shape form replaced a blacklist of
// one spelling, which a renamed variable evaded (found in review, fix round
// R=1). Reproduce both verdicts: copy the tree, rewrite the fence block to
// `if (rejection !== undefined && !developer)` — or to a variant that calls
// fenceRejection and ignores the result — and run this suite with DSH_WSL_ROOT
// pointed at the copy; the shape pin goes red either way. Text still cannot
// prove the call site is right in every future shape, so the BEHAVIOURAL cover
// for this seam is the LIVE probe in verify-route.mjs ("a token holder with a
// foreign Host is still refused"); it needs the running host and is not part of
// this offline run.
{
  const admission = await import(pathToFileURL(join(pluginRoot, 'lib/http-admission.js')).href)
  const entry = await readFile(join(pluginRoot, 'lib/index.js'), 'utf8')
  // A missing export must FAIL the checks below with that reason instead of
  // throwing out of the suite: a crash reports nothing about the rule, and the
  // rule is the whole subject here.
  const fenceRejection = typeof admission.fenceRejection === 'function'
    ? admission.fenceRejection
    : () => 'lib/http-admission.js exports no fenceRejection'
  check('fenceRejection admits a developer caller past the browser-authentication arm (401)',
    fenceRejection({ rejection: 401, developer: true }) === undefined,
    fenceRejection({ rejection: 401, developer: true }))
  check('fenceRejection keeps the Host/Origin arm (403) for a developer caller',
    fenceRejection({ rejection: 403, developer: true }) === 403,
    fenceRejection({ rejection: 403, developer: true }))
  check('fenceRejection keeps both arms for a caller without the token',
    fenceRejection({ rejection: 401, developer: false }) === 401
      && fenceRejection({ rejection: 403, developer: false }) === 403)
  check('fenceRejection leaves a request the fence admitted unchanged',
    fenceRejection({ rejection: undefined, developer: false }) === undefined
      && fenceRejection({ rejection: undefined, developer: true }) === undefined)
  check('fenceRejection refuses to let a token replace an arm it does not know (429)',
    fenceRejection({ rejection: 429, developer: true }) === 429,
    'the token may replace exactly one arm; anything else fails closed for every caller')
  // Comments are blanked first, so the pins test CODE and never the rationale
  // written beside it.
  const code = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '')
  check('SOURCE-TEXT: lib/index.js imports the fence rule it applies',
    /import \{[^}]*\bfenceRejection\b[^}]*\} from '\.\/http-admission\.js'/.test(code),
    'a missing import is invisible to node --check and surfaces inside the host as a row that never started')
  check('SOURCE-TEXT: the handler calls fenceRejection, gates on its answer, and sends that value',
    /const rejection = fenceRejection\(\{/.test(code)
      && /if \(rejection !== undefined\) \{/.test(code)
      && /res\.writeHead\(rejection,/.test(code),
    'text cannot prove the call site is right in every shape; verify-route.mjs covers this seam behaviourally')
}

// The distribution a session runs in must survive the shell→subprocess seam.
// The shell executor hands the subprocess provider a LINUX `cwd`, and a Linux
// path carries no distribution: the provider re-derived it from `config.distro`
// or the Windows default, so a workspace in another distribution ran its
// commands — and its confinement probes — in the wrong one. The live suite saw
// it as `sudo: /usr/local/sbin/dsh-wsl-confine: command not found` whenever the
// default distribution had no helper installed. Pin both halves of the seam.
{
  const shell = await readFile(join(pluginRoot, 'lib/wsl/shell.js'), 'utf8')
  const subprocess = await readFile(join(pluginRoot, 'lib/wsl/subprocess.js'), 'utf8')
  check('the shell executor names the distribution on its spawn spec',
    /wslDistro:\s*plan\.distro/.test(shell))
  check('the provider strips the private field before delegating',
    /const\s*\{\s*wslDistro,\s*\.\.\.request\s*\}\s*=\s*spec/.test(subprocess))
  check('spawn resolves the plan from the named distribution',
    /this\.planFor\(request\.cwd,\s*wslDistro\)/.test(subprocess))
  check('spawnTerminal resolves the plan from the named distribution',
    /this\.planFor\(spec\.cwd,\s*spec\.wslDistro\)/.test(subprocess))
  check('the context-free executable lookup prefers the session distribution',
    /this\.activeDistro\s*\?\?\s*this\.config\.distro/.test(subprocess))
}

// The seam shapes these providers must satisfy are not enforced by a compiler
// here — the harness types live in another package — so a wrong shape fails at
// runtime, inside the harness, far from the plugin. Every pin below was a real
// defect found by review; the failure text says what breaks without it.
{
  const shell = await readFile(join(pluginRoot, 'lib/wsl/shell.js'), 'utf8')
  const subprocess = await readFile(join(pluginRoot, 'lib/wsl/subprocess.js'), 'utf8')
  const pty = await readFile(join(pluginRoot, 'lib/wsl/pty.js'), 'utf8')
  const world = await readFile(join(pluginRoot, 'lib/wsl/world.js'), 'utf8')
  const entry = await readFile(join(pluginRoot, 'lib/index.js'), 'utf8')
  // The bridge probe used to treat ANY answer other than 'yes' as "python3 is
  // missing", so a probe that could not run (cold VM, timeout, distro-level
  // failure) sent the reader after an interpreter that was there all along —
  // measured as a whole suite dying under load. Same conflation checkLinuxPath had.
  check('a bridge probe that could not run is not reported as a missing interpreter',
    /answer === 'no'/.test(pty)
      && /无法运行/.test(pty)
      && !/if \(probe\.stdout\.trim\(\) !== 'yes'\)/.test(pty),
    'the probe must distinguish an ANSWER ("no") from a failure to run (empty stdout, non-zero exit, timeout)')
  /** Source with comments blanked, so a pin tests CODE and never its own rationale. */
  const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  // Anchored INSIDE execute(), not counted file-wide: a bare count is satisfied by
  // start()'s site alone, so deleting the LIVE handle's readers would still pass.
  // start() is deliberately not required (no caller reaches it; the seam declares
  // only resolve/execute), so this must not fail when it is removed either.
  const executeBody = /async execute\(spec\) \{([\s\S]*?)\n  \}\n/.exec(shell)?.[1] ?? ''
  check('the execution handle exposes the observed readers',
    /observed:\s*\{\s*stdout,\s*stderr\s*\}/.test(executeBody),
    "ShellProcess.observed is required, and tool-bash reads live.observed[channel] for every job; without it the output source throws and a background job's stream stays empty forever")
  check('the execution handle exposes kill()',
    /kill\(\)\s*\{/.test(shell),
    'ShellProcess.kill is required and tool-bash calls process.kill() to cancel a job; without it kill_job throws a TypeError and the job record stays running')
  check('BOTH settled paths report a ShellProcessStatus value',
    // TWO sites, not one: a single ternary is satisfied by start() alone, so a
    // wrong state.status inside execute() would pass.
    (shell.match(/\?\s*'killed'\s*:\s*'completed'/g) ?? []).length >= 2
      && !/\.status\s*=\s*[^\n]*'timedOut'/.test(codeOf(shell)),
    "the union is 'running'|'completed'|'killed', and tool-bash maps anything that is not 'killed' to { status: 'completed', detail: 'exit code: 0' } — so reporting 'timedOut' recorded a killed command as a clean exit")
  check('the execution handle reflects the SETTLED sandbox facts',
    /get sandbox\(\) \{ return settledRef\.current\?\.sandbox \?\? sandbox \}/.test(shell),
    'the harness reads the HANDLE, not result(): tool-bash processOutcome reads proc.sandbox.denied / runnerFailed for every background and promoted job, and both use execute(). A pre-settlement snapshot reports denied: false forever, so a fence that refused a write — or never established itself — never reaches the job detail or the model')
  check('a failed spawn is forced to a killed status, not a clean completion',
    /if \(failure !== undefined\) \{\s*\n\s*state\.status = 'killed'/.test(shell),
    'without this branch a spawn throw that was NOT a pre-aborted signal falls through to the ternary, and with no signal and an unaborted deadline it records completed with exitCode null — which tool-bash renders { status: completed, detail: exit code: 0 }, the M2 defect this all exists to prevent')
  check('a provider rejection settles the handle instead of rejecting done',
    // The onREJECTED handler specifically: matching only the onFulfilled line left
    // this pin green when the handler was deleted, i.e. exactly when done rejected.
    /\(error\) => settle\(\{ exitCode: null, signal: null \}, error\)/.test(shell),
    'the seam promises done NEVER rejects: the provider rejects for spawn/provider failures, so an unhandled rejection leaves the handle running forever, leaks the deadline timer and the caller-signal listener, and fails the job')
  check('a synchronous spawn throw is contained into a settled handle',
    /catch \(error\) \{\s*\n\s*spawnError = error/.test(shell) && /handle === undefined/.test(shell),
    'the provider throws synchronously for a pre-aborted signal (documented "@throws synchronously when pre-aborted") and tool-bash passes the caller signal unguarded, so an escaping throw would reject execute() with an infrastructure error instead of settling the killed handle the seam promises')
  check('the caller-declared expiry policy is carried and honoured',
    /onExpiry:\s*request\.onExpiry\s*\?\?\s*'kill'/.test(shell) && /spec\.onExpiry\s*!==\s*'none'/.test(shell),
    "tool-bash resolves background and promoted specs with onExpiry: 'none'; dropping it armed this executor's own deadline and killed background commands at the default timeout")
  check('a missing executable throws the class the terminal controller skips on',
    /throw new SubprocessExecutableNotFoundError\(/.test(subprocess),
    'api-terminal-controller catches SubprocessExecutableNotFoundError to try the next candidate; a plain Error rejects the whole shell discovery (zsh and fish are absent from most distributions)')
  check('terminal activity stays inside the documented union',
    /bridgeDown\)\s*return\s*\{\s*state:\s*'idle'/.test(codeOf(pty)) && !/'dead'/.test(codeOf(pty)),
    "SubprocessTerminalActivity is 'idle'|'busy'|'unknown' and retention reclaims only on 'idle'; a 'dead' state left a finished terminal — record, screen and control process — unreclaimed")
  // BEHAVIOUR, not a call-site count. A text pin here certified the revision in
  // which every directory listing came back empty — the two decode call sites
  // were present while the decoder itself was wrong. world.js imports nothing
  // from the harness, so the decoder can simply be called. The short-name
  // payload is the case a majority heuristic gets wrong.
  const worldModule = await import(pathToFileURL(join(pluginRoot, 'lib/wsl/world.js')).href)
  check('wsl.exe UTF-16LE diagnostics decode',
    worldModule.decodeWslOutput(Buffer.from('Wsl/Service/WSL_E_DISTRO_NOT_FOUND', 'utf16le')) === 'Wsl/Service/WSL_E_DISTRO_NOT_FOUND',
    'wsl.exe emits its own diagnostics as UTF-16LE while Linux-side output is UTF-8')
  check('plain UTF-8 passes through the decoder unchanged',
    worldModule.decodeWslOutput(Buffer.from('hello world\n', 'utf8')) === 'hello world\n')
  check('a VALID UTF-8 stream is never reinterpreted as UTF-16LE',
    worldModule.decodeWslOutput(Buffer.from('a\uFFFDb\n', 'utf8')) === 'a\uFFFDb\n'
      && worldModule.decodeWslOutput(Buffer.from('x\uFFFD\uFFFDy', 'utf8')) === 'x\uFFFD\uFFFDy'
      && worldModule.decodeWslOutput(Buffer.from('a\u0000b', 'utf8')) === 'a\u0000b',
    'a replacement-character count cannot tell a literal U+FFFD from a decoding failure, so counting them flipped valid buffers; the discriminator is that these buffers carry no NUL framing at all')
  // Both of these are regressions that a REVIEW found in a previous revision of
  // this function, so they are pinned rather than trusted.
  check('UTF-16LE whose bytes happen to be valid UTF-8 still decodes',
    worldModule.decodeWslOutput(Buffer.from('abc不', 'utf16le')) === 'abc不',
    'a "partial interleave must also fail UTF-8 validity" band was tried and rejected this: Buffer.from("abc不","utf16le") IS valid UTF-8, so the band decoded it as UTF-8')
  check('an odd-length buffer is never treated as UTF-16LE',
    worldModule.decodeWslOutput(Buffer.from([0x61, 0x00, 0x62, 0x00, 0x63, 0x00, 0x64])) === 'a\u0000b\u0000c\u0000d',
    'a UTF-16LE stream is always even-length, and toString("utf16le") silently DROPS the trailing byte — measured: printf a\\0b\\0c\\0d decoded to "abc"')
  check('a mostly-invalid buffer is not treated as UTF-16LE text',
    worldModule.decodeWslOutput(Buffer.from([0xff, 0xff])) === '\uFFFD\uFFFD',
    "printf 0xff 0xff decoded to a single U+FFFF glyph before the ceiling clause existed")
  check('a NUL as DATA is not mistaken for UTF-16LE framing',
    worldModule.decodeWslOutput(Buffer.from([0x61, 0x00, 0x62])) === 'a\u0000b',
    "'a\\0b' is one code unit and satisfies any interleave ratio, so the structural test needs a minimum length")
  check('a UTF-8 stream carrying a U+FFFD is NOT flipped to UTF-16LE',
    // A REAL assertion: this check previously passed its detail STRING where the
    // boolean goes, so it printed PASS unconditionally.
    worldModule.decodeWslOutput(Buffer.from('中文测试'.repeat(100), 'utf8').subarray(0, 1199)).includes('中文测试'),
    'the capture ceiling cuts a large CJK stream at a byte boundary, leaving ONE trailing U+FFFD; treating a replacement character as evidence flipped the WHOLE stream to UTF-16LE (measured end-to-end on a 1.1 MB CJK stream)')
  // The non-ASCII case is NOT solved by decoding: it is removed at the source.
  // Three decoding heuristics were written for it and each traded one failure
  // class for another (every listing empty, then a >1 MiB CJK stream mojibake,
  // then valid UTF-8 buffers flipped), so the plugin asks wsl.exe for UTF-8
  // instead. This pin keeps that request in place; verify-world asserts the
  // behavioural half (a real wsl.exe failure decodes to readable text).
  // FOUR spawn sites build a wsl.exe child env — the probe path (bridgeEnv), the
  // discovery call, the shell executor and the subprocess provider's two (spawn and
  // terminal). A site that forgets the constant silently gets UTF-16LE diagnostics
  // again, which is why it is one exported constant rather than four literals.
  // Per SITE, not a file-wide count of the identifier: a count also matches imports,
  // the constant's own definition and comments, so dropping the spread from one spawn
  // site left the count unchanged and the pin green (proven in review) while that path
  // silently went back to UTF-16LE diagnostics the decoder can no longer read.
  // BEHAVIOURAL, and structural where it can be: withWslEnvFlags injects the
  // switch LAST, so every provider path that funnels through it is covered even
  // when a new spawn site appears — a source-text pin over the known sites stayed
  // green through exactly that. listDistros is the one spawn that does not use
  // the helper (it is an execFile call with no WSLENV to derive), so its own env
  // option is still pinned by shape.
  // The text form of this token decodes both streams, and a NUL-framed payload is
  // indistinguishable from UTF-16LE at three or more code units — with
  // single-character names the bytes are IDENTICAL (Buffer.from('abc','utf16le')
  // === Buffer.from('a\0b\0c\0')). Without this opt-out the framing is destroyed
  // with nothing to signal it, and no threshold can recover it.
  check('execInWsl can return bytes for a NUL-framed protocol',
    /execInWsl: async \(\{ cwd, distro, command, username, timeoutMs, raw \}\)/.test(entry)
      && /\.\.\.\(raw === true \? \{ raw: true \} : \{\}\)/.test(entry),
    'the only consumer of ARBITRARY command output had no way to request bytes, while listLinuxDir opts out with raw')
  check('every wsl.exe child env carries the UTF-8 switch',
    worldModule.withWslEnvFlags({}).WSL_UTF8 === '1'
      && worldModule.withWslEnvFlags({ WSL_UTF8: '' }).WSL_UTF8 === '1'
      && !String(worldModule.withWslEnvFlags({ TERM: 'xterm' }).WSLENV ?? '').includes('WSL_UTF8')
      && (world.match(/env: \{ \.\.\.process\.env, \.\.\.WSL_CHILD_ENV \}/g) ?? []).length >= 1,
    'without WSL_UTF8 wsl.exe prints its own diagnostics as UTF-16LE (measured: 258 bytes for a missing distribution), which is what forced the decoder to guess between encodings')
  // The decoder's contract is TEXT (UTF-8 or UTF-16LE) and nothing more: a
  // stream that carries NUL bytes as DATA cannot be classified by any byte
  // heuristic — measured, a one-character-per-entry listing payload scores
  // 0.500 against the 0.5 interleave threshold while the real UTF-16LE
  // diagnostic scores 0.636, too close to separate. That is why the framed
  // consumer opts out with `raw: true` and decodes its own stream, and why the
  // listing behaviour is pinned END TO END in verify-world.mjs (a directory of
  // one-character names must list every entry). Pin the opt-out here, so a
  // future maintainer cannot quietly route the framed protocol back through
  // the text decoder.
  check('the NUL-framed listing protocol decodes its own stream',
    /raw: true/.test(world) && /result\.stdout\.toString\('utf8'\)/.test(world),
    'listLinuxDir must pass raw: true and decode UTF-8 itself; the text decoder cannot tell a framed listing from UTF-16LE')
}

// The browser half is reachable ONLY through `exports["./client"]`. The host's
// client-modules registry refuses to compose a package that declares
// `dsh.client` without that subpath — and because the registry is a REQUIRED
// host plugin, one such package takes the whole desktop down at startup:
//   DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate
//     client-modules: dsh-wsl-desktop declares dsh.client but exports no "./client" bundle
// The v0.2.0 release-packaging rewrite of package.json dropped the exports map
// and shipped exactly that, so 0.2.0/0.2.1 could not load at all. `main` is not
// a substitute: Node ignores it for the `./client` subpath.
{
  const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
  /** The path form of one exports entry: a bare string, or its `default`. */
  const exportPath = (entry) => {
    if (typeof entry === 'string') return entry
    if (entry === null || typeof entry !== 'object') return undefined
    return typeof entry.default === 'string' ? entry.default : undefined
  }
  const rel = exportPath(pkg.exports?.['./client'])
  const rootRel = exportPath(pkg.exports?.['.'])
  check('package.json exports "./client" for the declared client bundle', typeof rel === 'string', pkg.exports)
  check('package.json exports "." so the row resolves the package root', typeof rootRel === 'string', pkg.exports)
  check('the client entry point is not the host entry point', typeof rel !== 'string' || rel !== pkg.main, `client=${String(rel)} main=${String(pkg.main)}`)
  let present = false
  if (typeof rel === 'string') {
    try {
      await readFile(join(pluginRoot, rel), 'utf8')
      present = true
    } catch {
      present = false
    }
  }
  check('the declared client entry point exists on disk', present, rel)
  check('the declared client platform is web', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
