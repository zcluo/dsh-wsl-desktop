/**
 * The publish-readiness preflight.
 *
 * Collects the facts the 0.7.0 release learned the hard way — registry auth,
 * version occupancy, tags, a dirty tree, and pnpm's minimumReleaseAge — and hands
 * them to the pure rules in `lib/release-check.js`. It never publishes, tags or
 * edits anything; with a clean verdict it prints the exact command sequence.
 *
 * Run: node scripts/release-check.mjs [--version <x.y.z>] [--json]
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { classifyPublish, installWindow, liveGateEvidence } from '../lib/release-check.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const json = process.argv.includes('--json')
const versionFlag = process.argv.indexOf('--version')
const target = versionFlag >= 0 ? process.argv[versionFlag + 1] : JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(String(target))) {
  console.error(`release-check: "${target}" is not a dotted version`)
  process.exit(1)
}
const profile = process.env.DSH_PROFILE ?? 'desktop'
const profileRoot = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'), 'profiles', profile)

/**
 * Run a command, returning null instead of throwing.
 * @param {string} command - the executable.
 * @param {string[]} args - its arguments.
 * @param {string} [cwd] - the working directory.
 * @returns {Promise<string|null>} trimmed stdout, or null on failure.
 */
async function tryRun(command, args, cwd = pluginRoot) {
  try {
    // npm and pnpm are `.cmd` shims on Windows; execFile cannot spawn them without
    // a shell (EINVAL), and `shell: true` is a deprecation/escaping hazard. Invoke
    // cmd.exe explicitly: every argv here is a fixed word or a dotted version that
    // was validated above, so there is nothing for cmd to reinterpret.
    const [file, argv] = process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
      : [command, args]
    const { stdout } = await run(file, argv, { cwd, timeout: 30_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Run an executable by absolute path, without the cmd.exe indirection.
 *
 * `tryRun` goes through cmd.exe because `npm` and `pnpm` are `.cmd` shims that
 * cannot be spawned directly on Windows. That indirection is exactly what breaks
 * a path containing spaces: cmd re-splits the command line, the spawn fails, and
 * the caller reports "not on PATH" — the wrong cause. `execFile` quotes its argv
 * correctly for a direct spawn, so anything that is already a real executable
 * (node itself, or an explicit override path) takes this route instead.
 * @param {string} file - the executable.
 * @param {string[]} args - its arguments.
 * @param {string} cwd - the working directory.
 * @returns {Promise<string|null>} trimmed stdout, or null on failure.
 */
async function tryRunExec(file, args, cwd = pluginRoot) {
  try {
    const { stdout } = await run(file, args, { cwd, timeout: 30_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Read one pnpm setting, honouring an explicit `DSH_PNPM` override.
 *
 * `pnpm` is not always on PATH: this machine's DSH ships pnpm as a bare `.mjs`
 * under the runtime directory, with no `.cmd` shim, so a by-name spawn fails even
 * though the plugin manager runs pnpm fine. Hard-coding that path would put one
 * machine's layout in a public repository, so the override is explicit instead:
 * `DSH_PNPM` may name a shim (spawned directly) or a `.mjs` (spawned through node).
 * @param {string[]} args - pnpm arguments.
 * @param {string} cwd - the working directory.
 * @returns {Promise<string|null>} trimmed stdout, or null when pnpm is unusable.
 */
async function tryPnpm(args, cwd) {
  const override = process.env.DSH_PNPM
  if (override === undefined || override === '') return tryRun('pnpm', args, cwd)
  // A `.mjs` is run by the node that is running this script, so no PATH lookup and
  // no cmd.exe: `process.execPath` is an absolute executable even when it sits in
  // a directory whose name contains spaces.
  if (/\.m?js$/u.test(override)) return tryRunExec(process.execPath, [override, ...args], cwd)
  // An explicit path needs no shim resolution either.
  if (/[\\/]/u.test(override)) return tryRunExec(override, args, cwd)
  return tryRun(override, args, cwd)
}

const facts = {
  target,
  authenticated: false,
  latest: null,
  published: false,
  localTag: false,
  remoteTag: false,
  dirty: false,
  publishedAt: null,
  minimumReleaseAge: null,
}

facts.authenticated = (await tryRun('npm', ['whoami'])) !== null
facts.latest = (await tryRun('npm', ['view', 'dsh-wsl-desktop', 'version'])) || null
facts.published = (await tryRun('npm', ['view', `dsh-wsl-desktop@${target}`, 'version'])) !== null
facts.localTag = (await tryRun('git', ['tag', '--list', `v${target}`])) !== ''
const remoteTags = await tryRun('git', ['ls-remote', '--tags', 'origin', `v${target}`])
facts.remoteTag = remoteTags !== null && remoteTags !== ''
const status = await tryRun('git', ['status', '--porcelain'])
facts.dirty = status !== null && status.split('\n').some((line) => line !== '' && !line.startsWith('?? '))
const times = await tryRun('npm', ['view', 'dsh-wsl-desktop', 'time', '--json'])
try {
  const parsed = JSON.parse(times ?? '{}')
  facts.publishedAt = parsed[target] ?? null
} catch {
  facts.publishedAt = null
}
// THREE outcomes, kept apart on purpose. Collapsing them into one "could not be
// read" blocker cost real time on 2026-11-15: the message pointed at the profile's
// configuration, while the actual cause was that `pnpm` is not on PATH in this
// shell (the bundled pnpm is a `.mjs` invoked through node). A diagnostic that
// names the wrong layer sends the reader to the wrong file.
const age = await tryPnpm(['config', 'get', 'minimumReleaseAge'], profileRoot)
if (age === null) {
  facts.minimumReleaseAge = null
  facts.minimumReleaseAgeCause = 'pnpm-unavailable'
} else if (age === '' || age === 'undefined' || Number.isNaN(Number(age))) {
  // ABSENT IS NOT UNKNOWN, and it is not zero either. Measured on 2026-11-15 by
  // publishing and installing: the profile set nothing, `pnpm config get
  // minimumReleaseAge` printed `undefined`, and pnpm STILL applied an age policy
  // -- installing the just-published 0.8.1 made it write
  // `minimumReleaseAgeExclude: [dsh-wsl-desktop@0.8.1]` into pnpm-workspace.yaml.
  // So an effective default exists, and it is PERMISSIVE: without
  // `minimumReleaseAgeStrict: true` pnpm records the exclusion and proceeds
  // rather than blocking ("set minimumReleaseAgeStrict to true to gate these
  // updates with a prompt", pnpm's own message). The install therefore is not
  // gated, which is what this preflight needs to know -- but the reason is the
  // permissive default, NOT a window of zero.
  facts.minimumReleaseAge = 'unset (pnpm default, permissive)'
  facts.minimumReleaseAgeCause = 'default-permissive'
} else {
  facts.minimumReleaseAge = Number(age)
  facts.minimumReleaseAgeCause = null
}

const verdict = classifyPublish({
  target,
  latest: facts.latest,
  published: facts.published,
  localTag: facts.localTag,
  remoteTag: facts.remoteTag,
  dirty: facts.dirty,
})
const blockers = [...verdict.blockers]
if (!facts.authenticated) blockers.push('npm is not authenticated (npm whoami failed)')
// Only an unreadable value blocks. A profile that sets nothing has no window —
// that is pnpm's documented default, not a gap in the facts.
if (facts.minimumReleaseAge === null) {
  blockers.push('pnpm is not on PATH, so pnpm\'s minimumReleaseAge — and therefore the install window after publishing — cannot be read. Point DSH_PNPM at the bundled pnpm.mjs, or put pnpm on PATH.')
}

// Live-gate evidence. The offline matrix cannot execute the route handler at all,
// so the suites that can are the ones this project's worst defect escaped — see
// `liveGateEvidence` for the measurement. A receipt from `--live` is the proof.
// ONE flag, TWO accepted spellings. `verify-all.mjs` takes `--receipt[=path]`, so
// a user who learned it there writes `--receipt=x.json` here too — and the earlier
// `indexOf('--receipt')` read only the space form, silently ignoring the equals
// form and falling back to the default path. The result was a FALSE BLOCKER on a
// perfectly good receipt. Both forms are accepted now, and a bare `--receipt`
// means the default path (matching `verify-all`), so there is no undefined-path
// case left either.
const receiptArg = process.argv.find((arg) => arg === '--receipt' || arg.startsWith('--receipt='))
const receiptPath = (() => {
  const fallback = join(pluginRoot, 'verify-receipt.json')
  if (receiptArg === undefined) return fallback
  const inline = receiptArg.startsWith('--receipt=') ? receiptArg.slice('--receipt='.length) : ''
  if (inline !== '') return inline
  const next = process.argv[process.argv.indexOf(receiptArg) + 1]
  return next === undefined || next.startsWith('--') ? fallback : next
})()
let receipt = null
try {
  receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
} catch {
  receipt = null
}
const evidence = liveGateEvidence({ receipt, target })
blockers.push(...evidence.blockers)
facts.receiptPath = receiptPath
facts.liveEvidence = evidence.ready

/**
 * Privacy scan: the published artifact must not carry secrets or the operator's
 * machine layout. Tracked files are grep-able offline; the package manifest is
 * checked separately so test-only records cannot ship even if tracked.
 */
const privacy = { secretHits: [], pathHits: [], packageHits: [] }
const tracked = await tryRun('git', ['ls-files'])
// Patterns are assembled from fragments so this file does not match itself; a
// literal credential prefix or registry-token field name in the scanner would
// make every run red.
const secretPatterns = [
  new RegExp('npm' + '_' + '[A-Za-z0-9]{20,}', 'u'),
  new RegExp('gh' + '[pousr]_[A-Za-z0-9]{20,}', 'u'),
  new RegExp('github' + '_pat_[A-Za-z0-9_]{20,}', 'u'),
  new RegExp('sk' + '-' + '[A-Za-z0-9]{20,}', 'u'),
  /AKIA[0-9A-Z]{16}/u,
  /BEGIN [A-Z ]*PRIVATE KEY/u,
  new RegExp('_auth' + 'Token', 'u'),
]
const homeName = (() => {
  try { return userInfo().username } catch { return '' }
})()
const pathPatterns = [
  // A test fixture's `C:\\Users\\X\\PROJ` is a placeholder, not a machine path;
  // real account names are longer than one character.
  /\b[A-Za-z]:\\\\Users\\\\(?!X\\\\)/u,
  /\b[A-Za-z]:\\\\projects\\\\/u,
  ...(homeName === '' ? [] : [new RegExp(`/home/${homeName}(?:/|$)`, 'u')]),
]
for (const path of (tracked ?? '').split('\n').filter((line) => line !== '')) {
  let text = ''
  try { text = await readFile(join(pluginRoot, path), 'utf8') } catch { continue }
  if (secretPatterns.some((pattern) => pattern.test(text))) privacy.secretHits.push(path)
  if (pathPatterns.some((pattern) => pattern.test(text))) privacy.pathHits.push(path)
}
if (privacy.secretHits.length > 0) blockers.push(`tracked files look like they carry a secret: ${privacy.secretHits.join(', ')}`)
if (privacy.pathHits.length > 0) blockers.push(`tracked files carry a machine-specific path: ${privacy.pathHits.join(', ')}`)
// Archify writes absolute paths into its receipts on every finalize/visual-check,
// so "remember to scrub" is not a rule a human keeps. This runs the scrubber in
// check mode: any receipt that would still change is a blocker with its own name.
//
// A `null` result is a FAILURE, not a pass: `tryRun` returns null when the child
// could not be spawned or exited non-zero. Treating that as "nothing to scrub"
// would turn a broken or deleted scrubber into a green preflight, which is the
// exact silent pass this gate exists to prevent.
const unscrubbed = await tryRun('node', ['scripts/scrub-receipts.mjs', '--check'])
if (unscrubbed === null) {
  blockers.push('the receipt privacy check could not run (node scripts/scrub-receipts.mjs --check failed); fix it before publishing')
} else if (unscrubbed.includes('need scrubbing')) {
  const names = unscrubbed.split('\n').filter((line) => line.startsWith('would scrub ')).map((line) => line.slice('would scrub '.length))
  blockers.push(`delivery receipts still carry machine paths (run node scripts/scrub-receipts.mjs): ${names.join(', ')}`)
}
const pack = await tryRun('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'])
if (pack !== null && pack !== '') {
  try {
    const manifest = JSON.parse(pack.slice(pack.indexOf('[')))[0]
    const files = (manifest.files ?? []).map((entry) => entry.path)
    const forbidden = [/^\.superpowers\//u, /^\.archify\//u, /\.visual-check\.json$/u, /\.finalize.*\.json$/u, /(^|\/)\.env/u, /(^|\/)[^/]*token[^/]*$/iu, /\.pem$/u, /\.key$/u]
    privacy.packageHits = files.filter((file) => forbidden.some((pattern) => pattern.test(file)))
    if (privacy.packageHits.length > 0) blockers.push(`the npm package would ship test or secret material: ${privacy.packageHits.join(', ')}`)
  } catch {
    blockers.push('the npm package manifest could not be parsed (npm pack --dry-run --json)')
  }
} else {
  blockers.push('the npm package manifest could not be produced (npm pack --dry-run failed)')
}
const window = facts.published === false && facts.publishedAt !== null && facts.minimumReleaseAge !== null
  ? installWindow({ publishedAt: facts.publishedAt, minimumReleaseAgeMinutes: facts.minimumReleaseAge, now: new Date() })
  : null

const report = {
  target,
  facts,
  window: window === null ? null : { ready: window.ready, readyAt: window.readyAt?.toISOString?.() ?? null, detail: window.detail },
  privacy,
  ready: blockers.length === 0,
  blockers,
  steps: [
    `npm publish --access public`,
    `git tag -a v${target} -m "dsh-wsl-desktop ${target}"`,
    `git push origin main v${target}`,
    // ORDER RULE: confirm the registry copy is installable BEFORE removing the
    // installed one. Reversing it leaves the profile with no plugin until pnpm's
    // minimumReleaseAge window opens.
    ...(window !== null && window.ready === false
      ? [`# wait until ${window.readyAt.toISOString()} (minimumReleaseAge), then re-run this check`]
      : ['# window open: the registry copy installs now']),
    `plugin_manager remove_bundle dsh-wsl-desktop`,
    `plugin_manager install_bundle dsh-wsl-desktop@${target}`,
    `node scripts/verify-post-restart.mjs`,
  ],
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`release target ${target}`)
  console.log(`  npm authenticated: ${facts.authenticated}`)
  console.log(`  registry latest:  ${facts.latest ?? 'unknown'}`)
  console.log(`  target published: ${facts.published}`)
  console.log(`  tags:            local=${facts.localTag} remote=${facts.remoteTag}`)
  console.log(`  tracked changes: ${facts.dirty}`)
  console.log(`  minimumReleaseAge: ${facts.minimumReleaseAge ?? `unreadable (${facts.minimumReleaseAgeCause})`}${window === null ? '' : ` (${window.detail})`}`)
  console.log(`  live gate receipt: ${facts.liveEvidence ? 'usable' : `NOT usable (${facts.receiptPath})`}`)
  if (blockers.length > 0) {
    console.log('\nBLOCKED:')
    for (const blocker of blockers) console.log(`  - ${blocker}`)
  } else {
    console.log('\nREADY. Next steps:')
    for (const step of report.steps) console.log(`  ${step}`)
  }
}
process.exit(blockers.length === 0 ? 0 : 1)
