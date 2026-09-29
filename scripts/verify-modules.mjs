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
const PURE = ['lib/wsl/paths.js', 'lib/wsl/preset.js', 'lib/wsl/fence.js', 'lib/http-admission.js']

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
  check('refusals throw the structured FS_SANDBOX_DENIED',
    (source.match(/FS_SANDBOX_DENIED/g) ?? []).length >= 2)
  check('containment compares with a separator boundary',
    /isLexicallyUnderHost/.test(fence) && /startsWith\(bounded\)/.test(fence))
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
