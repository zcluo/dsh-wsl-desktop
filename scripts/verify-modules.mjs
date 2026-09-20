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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${String(detail)}`}`)
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

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1