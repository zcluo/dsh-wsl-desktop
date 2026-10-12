/**
 * Pin the packaging contract the published tarball depends on: npm runs the
 * `prepack` hook, and the Python bytecode cache never reaches the file list.
 *
 * `files` in package.json whitelists all of lib/, and npm cannot exclude a
 * files-included path through .gitignore — measured on this tree, with the hook
 * bypassed the same package lists lib/wsl/__pycache__/terminal-bridge.cpython-313.pyc
 * (22 files instead of 21). `scripts.prepack` is therefore the only thing keeping
 * py_compile's cache out of the tarball. The hook sat at the package ROOT until
 * round 1 of the OCR review: npm reads lifecycle scripts from the `scripts` map
 * only, so a root-level `prepack` never runs, and the tarball published from that
 * tree shipped the cache.
 *
 * That regression is why the fixture below is CREATED before every pack. A
 * checkout that has never run py_compile carries no cache, so "no cache in the
 * list" is then an assertion that cannot fail — it would go green on the very
 * tree that shipped the defect. The control section re-runs the pack with the
 * hook bypassed, so the same run also proves the list CAN carry the artifact.
 *
 * The plugin icon is pinned here for the same reason: its declaration is metadata
 * the harness reads from package.json (packages/boot/app-boot/src/package-meta.ts
 * resolves a declared `icon` against the manifest's own directory, admits
 * SVG/PNG/JPEG/WebP up to 256 KiB, and reports a violation as a diagnostic that
 * keeps the display text while rendering NO icon). A declaration that resolves in
 * the checkout but whose file the `files` allowlist stops covering ships a package
 * whose market card has no icon, and nothing else in this repo reads the published
 * file list.
 *
 * Why its own suite. Its subject is the published artifact, which no other suite
 * reads, and it needs no distribution, no harness checkout and no host — npm
 * alone, from the package root. Folding it into verify-modules.mjs would report
 * it as that suite's state (and that suite is a counted SKIP in a checkout
 * without node_modules); verify-all.mjs gives every suite its own row.
 *
 * A machine where npm cannot run is a counted SKIP and exit 2, never a green run:
 * this suite cannot evaluate the artifact without npm, and a pass would claim a
 * packaging coverage it did not establish (the convention verify-modules,
 * verify-9p, verify-fs-fence and verify-client-ui implement).
 *
 * Run: node scripts/verify-package.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

let failures = 0
let skipped = 0

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

/**
 * Record checks that could not run here, and count them.
 *
 * A skip is a check that did not run: reporting it as a pass lets a green
 * aggregate stand for coverage that was never established, so the count reaches
 * the tail and the suite exits 2 — what verify-all.mjs renders as SKIP. The
 * labels are passed in from the same list the checks below print, so the SKIP
 * cannot name a set that differs from the one that did not run.
 * @param {string[]} labels - the assertions that were not evaluated.
 * @param {string} precondition - why they could not run.
 * @param {string} remedy - what the operator can do about it.
 */
function skip(labels, precondition, remedy) {
  skipped += labels.length
  console.log(`  SKIP  ${labels.join('; ')} — ${labels.length} check(s) not evaluated, ${precondition}; ${remedy}`)
}

/** The assertions the pack section records; the SKIP above names them and derives its count from the list. */
const PACK_CHECKS = [
  'the bytecode cache the hook exists to remove is on disk before the pack',
  'npm runs the prepack hook for this package',
  'the prepack hook removed the bytecode cache',
  'the file list carries no __pycache__ or .pyc path',
  'the file list carries the entry points package.json declares',
  'the file list carries the plugin icon package.json declares',
  'the control: with the hook bypassed the same cache IS listed',
]

/** The cache directory py_compile writes for the shipped bridge source. */
const CACHE_DIR = join(pluginRoot, 'lib', 'wsl', '__pycache__')
/** The artifact the tarball shipped before the hook moved into `scripts`. */
const CACHE_FILE = join(CACHE_DIR, 'terminal-bridge.cpython-313.pyc')

/** npm as the platform's shell spells it; a .cmd shim cannot be spawned directly (Node refuses it without a shell). */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
/** The shell npm is resolved by. Spawned explicitly with the command line as ONE argument: Node's `shell: true` plus an args array warns (DEP0190) on the parent's stderr, which verify-all inherits. */
const SHELL = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'sh'

/**
 * Run npm through the platform shell.
 * @param {string[]} args - npm arguments.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the run.
 */
function runNpm(args) {
  const line = [NPM, ...args].join(' ')
  return spawnSync(SHELL, process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['-c', line], {
    cwd: pluginRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
}

/**
 * Run `npm pack --dry-run --json` from the package root.
 *
 * --dry-run writes no tarball and still runs the lifecycle hooks, which is what
 * makes it usable as a pin: the hook's effect is observable without publishing
 * or leaving an artifact behind.
 * @param {string[]} extra - additional npm arguments.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} the run.
 */
const pack = (extra) => runNpm(['pack', '--dry-run', '--json', ...extra])

/**
 * The packed paths from a run's report.
 * @param {import('node:child_process').SpawnSyncReturns<string>} run - a pack run.
 * @returns {string[] | null} the paths, or null when stdout is not the expected report.
 */
function packedPaths(run) {
  try {
    const report = JSON.parse(run.stdout)
    const files = report?.[0]?.files
    return Array.isArray(files) ? files.map((entry) => entry.path) : null
  } catch {
    return null
  }
}

/**
 * Materialize the artifact the hook exists to remove.
 *
 * The bytes are a stand-in, and that is deliberate: the hook matches the
 * DIRECTORY name and npm lists the PATH, so what the pin needs is the file's
 * presence — a real py_compile run would add a Python interpreter to this
 * suite's prerequisites and make the subject depend on one. The 3.13 magic is
 * kept so the file reads as the artifact it stands in for.
 * @returns {boolean} whether the file is on disk afterwards.
 */
function writeCache() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CACHE_FILE, Buffer.concat([
      Buffer.from([0xcb, 0x0d, 0x0d, 0x0a]),
      Buffer.from('verify-package fixture: stands in for py_compile output for lib/wsl/terminal-bridge.py\n'),
    ]))
  } catch {
    // Reported as the check that failed, not as a crash: an unwritable tree is a
    // state this pin has to name, and a stack trace names nothing.
    return false
  }
  return existsSync(CACHE_FILE)
}

let pkg = null
let pkgProblem = ''
try {
  pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
} catch (error) {
  pkgProblem = String(error?.message ?? error)
}
const declared = [pkg?.main, pkg?.exports?.['.'], pkg?.exports?.['./client']].filter((value) => typeof value === 'string')
const entryPoints = [...new Set(declared.map((value) => value.replace(/^\.\//, '')))]

check('package.json parses and declares the strip as scripts.prepack',
  pkg !== null && typeof pkg.scripts?.prepack === 'string' && pkg.scripts.prepack.length > 0,
  pkgProblem !== ''
    ? `package.json is not readable JSON: ${pkgProblem}`
    : `scripts=${JSON.stringify(pkg?.scripts ?? null)} — npm reads lifecycle scripts from the scripts map; a root-level "prepack" key is never executed`)

/**
 * The icon formats and size the harness admits, and why a violation is worth a
 * row: `readPluginMeta` does not fail the plugin, it drops the icon and keeps the
 * text — a bad declaration is invisible in the UI it was written for.
 */
const ICON_MEDIA_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const ICON_MAX_BYTES = 256 * 1024

/**
 * Whether a declared icon path resolves inside the package root.
 *
 * The reader's own rule, applied in the reader's order: an absolute path, a
 * Windows path spelled on POSIX, or any URL-shaped value is refused before the
 * containment test — `resolve` would otherwise quietly turn `C:/icons/a.svg`
 * into a path inside the package on POSIX.
 * @param {string} declared - the manifest's `icon` value.
 * @returns {boolean} whether the value is a package-relative path inside the root.
 */
function iconInsidePackage(declared) {
  if (declared === '' || isAbsolute(declared) || win32.isAbsolute(declared)) return false
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(declared)) return false
  const local = relative(pluginRoot, resolve(pluginRoot, declared))
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

// Read from the SAME manifest the pack below packs, and asserted BEFORE the pack
// row that consumes it: with no declared icon that row's filter is empty, so it
// would pass on a package that declares no icon at all.
const declaredIcon = typeof pkg?.icon === 'string' ? pkg.icon.trim() : ''
const iconInside = iconInsidePackage(declaredIcon)
const iconTarget = iconInside ? resolve(pluginRoot, declaredIcon) : ''
const iconStat = iconTarget !== '' && existsSync(iconTarget) ? statSync(iconTarget) : null
check('package.json declares a plugin icon inside the package that the harness can read',
  iconInside && iconStat?.isFile() === true
    && ICON_MEDIA_TYPES.has(extname(iconTarget).toLowerCase())
    && iconStat.size <= ICON_MAX_BYTES,
  `icon=${JSON.stringify(pkg?.icon ?? null)} resolved=${JSON.stringify(iconTarget)} inside=${iconInside} file=${iconStat?.isFile() ?? false} ext=${JSON.stringify(extname(iconTarget))} size=${iconStat?.size ?? 'n/a'} — a declared icon resolves against its manifest directory and must be SVG, PNG, JPEG or WebP within ${ICON_MAX_BYTES} bytes`)

// The presence test runs npm the SAME way the pack below does. A second locator
// (where.exe / which) can answer from a source cmd.exe does not read — measured
// here: where.exe resolves npm with an EMPTY PATH — so the two could disagree,
// and the disagreement would surface as a FAIL on a machine whose npm is merely
// off PATH.
const npmVersion = runNpm(['--version'])
const npmUsable = npmVersion.status === 0 && /\d+\.\d+/.test(npmVersion.stdout ?? '')

if (!npmUsable) {
  skip(PACK_CHECKS,
    npmVersion.error !== undefined
      ? `cannot run ${SHELL} (${npmVersion.error.code ?? npmVersion.error.message})`
      : `\`npm --version\` exited ${npmVersion.status} (${JSON.stringify((npmVersion.stderr ?? '').trim().slice(0, 200))})`,
    'install Node.js, which ships npm, or put npm on PATH')
} else {
  try {
    // Setup assertion first: it is what makes the absence below evidence rather
    // than a property of a checkout that simply never ran py_compile.
    const fixtureOnDisk = writeCache()
    check(PACK_CHECKS[0], fixtureOnDisk, `could not create ${CACHE_FILE}`)

    const run = pack([])
    const paths = packedPaths(run)
    // npm announces every lifecycle script it runs as `> name@version script`;
    // the script body carries no "prepack" of its own, so the token is the
    // announcement. Without it the hook did not run — the regression itself.
    check(PACK_CHECKS[1],
      run.status === 0 && /prepack/.test(run.stderr ?? ''),
      `exit=${run.status} stderr=${JSON.stringify((run.stderr ?? '').slice(0, 400))} — npm announces each lifecycle script it runs; no announcement means the hook is not in the scripts map`)
    // The hook's OWN effect, independent of the file list: it removes the cache
    // from the working tree, so a hook that ran but stripped nothing is visible
    // even if the list were reported wrongly. The setup assertion is a clause
    // here too: with no cache on disk this row could not fail.
    check(PACK_CHECKS[2], fixtureOnDisk && !existsSync(CACHE_FILE),
      `${CACHE_FILE} survived the pack — the hook ran without removing it, was never run, or was never materialized`)
    check(PACK_CHECKS[3],
      paths !== null && paths.every((path) => !path.includes('__pycache__') && !path.endsWith('.pyc')),
      paths === null
        ? `npm pack did not report a file list: stdout=${JSON.stringify((run.stdout ?? '').slice(0, 300))} stderr=${JSON.stringify((run.stderr ?? '').slice(0, 300))}`
        : paths.filter((path) => path.includes('__pycache__') || path.endsWith('.pyc')))
    // A list that had been emptied would satisfy the row above, so the shipped
    // entry points are required by name.
    const missing = entryPoints.filter((entry) => !(paths ?? []).includes(entry))
    check(PACK_CHECKS[4], paths !== null && missing.length === 0,
      `missing from the pack: ${JSON.stringify(missing)} — package.json declares ${JSON.stringify(entryPoints)}`)

    // The declaration above is read from the checkout's manifest; this row reads
    // the LIST the tarball will carry, so one fact is pinned at both ends. npm
    // reports packed paths with forward slashes on every platform.
    const iconEntry = iconInside ? relative(pluginRoot, iconTarget).split(sep).join('/') : ''
    check(PACK_CHECKS[5], paths !== null && iconEntry !== '' && paths.includes(iconEntry),
      `the packed list carries no ${JSON.stringify(iconEntry)}: ${JSON.stringify((paths ?? []).filter((path) => path.startsWith('lib/')))}`)

    // THE CONTROL. --ignore-scripts skips the hook, so the cache must survive AND
    // appear: that is the measurement proving the row above is not vacuous.
    if (writeCache()) {
      const control = pack(['--ignore-scripts'])
      const controlPaths = packedPaths(control)
      const listed = (controlPaths ?? []).some((path) => path.endsWith('.pyc'))
      check(PACK_CHECKS[6],
        control.status === 0 && !/prepack/.test(control.stderr ?? '') && listed && existsSync(CACHE_FILE),
        `exit=${control.status} announced=${/prepack/.test(control.stderr ?? '')} listed=${listed} onDisk=${existsSync(CACHE_FILE)} paths=${JSON.stringify((controlPaths ?? []).filter((path) => path.endsWith('.pyc')))}`)
    } else {
      // PACK_CHECKS[6] is the control row; [5] is the plugin-icon row, which this
      // failure used to redden a second time (after its own PASS) while leaving the
      // control row never evaluated at all.
      check(PACK_CHECKS[6], false, `could not recreate ${CACHE_FILE} for the control`)
    }
  } finally {
    // The fixture is this suite's own residue: the hook removes it on the way
    // through, but a reddened run must not leave a cache behind for the next
    // `npm pack` — or for git status — to find.
    rmSync(CACHE_DIR, { recursive: true, force: true })
  }
}

// A skip is a check that did not run, and reporting it as a pass would make this
// suite's green meaningless exactly where the artifact is the subject: exit 2 is
// what verify-all renders as SKIP (the sibling suites' ruling, applied here).
if (failures > 0) console.log(`\n${failures} CHECK(S) FAILED${skipped === 0 ? '' : `, ${skipped} CHECK(S) SKIPPED`}`)
else if (skipped > 0) console.log(`\nEVERY CHECK THAT COULD RUN PASSED, ${skipped} CHECK(S) SKIPPED — exit 2, so verify-all reports this suite as SKIP`)
else console.log('\nALL CHECKS PASSED')
process.exitCode = failures > 0 ? 1 : skipped > 0 ? 2 : 0
