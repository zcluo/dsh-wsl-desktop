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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { classifyPublish, installWindow } from '../lib/release-check.js'

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
const age = await tryRun('pnpm', ['config', 'get', 'minimumReleaseAge'], profileRoot)
facts.minimumReleaseAge = age !== null && age !== '' && !Number.isNaN(Number(age)) ? Number(age) : null

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
if (facts.minimumReleaseAge === null) blockers.push('pnpm minimumReleaseAge could not be read from the profile')
const window = facts.published === false && facts.publishedAt !== null && facts.minimumReleaseAge !== null
  ? installWindow({ publishedAt: facts.publishedAt, minimumReleaseAgeMinutes: facts.minimumReleaseAge, now: new Date() })
  : null

const report = {
  target,
  facts,
  window: window === null ? null : { ready: window.ready, readyAt: window.readyAt?.toISOString?.() ?? null, detail: window.detail },
  ready: blockers.length === 0,
  blockers,
  steps: [
    `npm publish --access public`,
    `git tag -a v${target} -m "dsh-wsl-desktop ${target}"`,
    `git push origin main v${target}`,
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
  console.log(`  minimumReleaseAge: ${facts.minimumReleaseAge ?? 'unknown'}${window === null ? '' : ` (${window.detail})`}`)
  if (blockers.length > 0) {
    console.log('\nBLOCKED:')
    for (const blocker of blockers) console.log(`  - ${blocker}`)
  } else {
    console.log('\nREADY. Next steps:')
    for (const step of report.steps) console.log(`  ${step}`)
  }
}
process.exit(blockers.length === 0 ? 0 : 1)
