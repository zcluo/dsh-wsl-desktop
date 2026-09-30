/**
 * Behavioural checks on the staging script, against a disposable profile.
 *
 * `scripts/sync.ps1` DELETES staged generations, and which ones it keeps is the
 * whole point: the running host resolves ONE generation directory and writes
 * generated presets that name absolute module paths inside it, so deleting that
 * directory breaks every WSL session until the next restart. That already
 * happened once here, which is why the deletion filter is exercised rather than
 * merely read.
 *
 * Each case runs the real script against a throwaway DSH_HOME, so nothing
 * outside the temp directory is touched.
 *
 * Run: node scripts/verify-sync.mjs
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = process.env.DSH_WSL_ROOT ?? join(here, '..')
const script = join(pluginRoot, 'scripts', 'sync.ps1')

let failures = 0
let checks = 0

/**
 * Record one assertion.
 * @param {string} label - what was asserted.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  checks += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
  if (!ok && detail !== undefined) console.log(`        ${detailText(detail)}`)
  if (!ok) failures += 1
}

/** Candidate PowerShell hosts, in the order this machine is most likely to have them. */
const SHELL_CANDIDATES = ['powershell.exe', 'pwsh.exe', 'pwsh']

/**
 * The first candidate that actually answers.
 *
 * Probing beats assuming: `powershell.exe` ships with Windows but not with a
 * PowerShell-7-only image, and a missing host makes `execFile` fail with ENOENT
 * — which would otherwise surface as ordinary assertion failures blaming the
 * staging script for something the environment did.
 * @returns {Promise<string | null>} the usable executable, or null when none answers.
 */
async function resolveShell() {
  for (const candidate of SHELL_CANDIDATES) {
    const answered = await new Promise((resolve) => {
      execFile(candidate, ['-NoProfile', '-Command', 'exit 0'], { timeout: 30000 },
        (error) => resolve(error === null))
    })
    if (answered) return candidate
  }
  return null
}

/**
 * Whether one run said a thing, ignoring how the console wrapped it.
 * PowerShell breaks a long warning across lines, so a literal phrase match
 * fails on the wrapping rather than on the message.
 * @param {string} output - the run's stdout and stderr.
 * @param {RegExp} pattern - the phrase to look for.
 * @returns {boolean} true when the flattened output matches.
 */
function said(output, pattern) {
  return pattern.test(output.replace(/\s+/g, ' '))
}

/**
 * Run the staging script once against a disposable profile.
 * @param {object} options - the scenario.
 * @param {'linked'|'dangling'|'unlinked'} options.link - what the profile link looks like.
 * @param {number} [options.runs] - how many times to run the script (two models a
 * second stage before the desktop was ever restarted).
 * @returns {Promise<object>} the fixture and everything the run left behind.
 */
async function scenario({ link, runs = 1 }) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wsl-sync-'))
  const profile = join(home, 'profiles', 'verify')
  const plugins = join(profile, 'plugins')
  await mkdir(plugins, { recursive: true })
  // Three generations, so "keep the two newest" is a rule that can be observed
  // rather than a coincidence: 0002 is linked, 0001 was staged before it and is
  // what a desktop that has not restarted since would be running, 0000 is older
  // than both.
  const linked = join(plugins, 'dsh-wsl-desktop-0002')
  const previous = join(plugins, 'dsh-wsl-desktop-0001')
  const stale = join(plugins, 'dsh-wsl-desktop-0000')
  for (const dir of [linked, previous, stale]) {
    await mkdir(dir, { recursive: true })
  }
  // The profile's own manifest and lockfile, in the shape the installer leaves
  // them: both name the generation the link resolves.
  const spelled = linked.split('\\').join('/')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'verify',
    dependencies: { 'dsh-wsl-desktop': `link:${spelled}` },
  }, null, 2), 'utf8')
  await writeFile(join(profile, 'pnpm-lock.yaml'), [
    'importers:',
    '  .:',
    '    dependencies:',
    '      dsh-wsl-desktop:',
    `        specifier: link:${spelled}`,
    '        version: link:plugins/dsh-wsl-desktop-0001',
    '',
  ].join('\n'), 'utf8')
  const modules = join(profile, 'node_modules')
  if (link !== 'unlinked') {
    await mkdir(modules, { recursive: true })
    // A junction, because the profile falls back to one when the account has no
    // symlink privilege — and the script has to read that spelling too.
    await symlink(linked, join(modules, 'dsh-wsl-desktop'), 'junction')
    if (link === 'dangling') await rm(linked, { recursive: true, force: true })
  }
  let error = null
  let output = ''
  const staged = []
  for (let index = 0; index < runs; index += 1) {
    const run = await new Promise((resolve) => {
      execFile(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', 'verify'],
        { env: { ...process.env, DSH_HOME: home }, timeout: 120000 },
        (err, stdout, stderr) => resolve({ err, stdout, stderr }))
    })
    if (run.err !== null) error = run.err
    // The script prints the directory it staged as its last line.
    const printed = String(run.stdout).trim().split('\n').map((line) => line.trim()).filter((line) => line !== '').pop()
    if (printed !== undefined) staged.push(printed)
    // PowerShell's warning stream does not land on stderr for a `-File` run, so
    // the evidence is taken from both channels rather than assuming one.
    output += `${run.stdout}\n${run.stderr}`
  }
  const after = (await readdir(plugins)).sort()
  let linkTarget = null
  try {
    linkTarget = (await readlink(join(modules, 'dsh-wsl-desktop'))).split('\\').join('/')
  } catch {
    linkTarget = null
  }
  const manifest = await readFile(join(profile, 'package.json'), 'utf8')
  const lock = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
  return { home, profile, plugins, after, output, error, linkTarget, manifest, lock, linked, staged }
}

console.log(`running ${script} against disposable profiles\n`)

const shell = await resolveShell()
// Without a host there is nothing to exercise, and the per-scenario checks would
// blame the script for not having run — two of them would even PASS, because
// nothing happened to delete anything. Say so once and stop.
check('a PowerShell host is available to run the staging script', shell !== null,
  `tried ${SHELL_CANDIDATES.join(', ')} — install PowerShell and re-run`)
if (shell === null) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}

console.log('a profile link that resolves')
{
  const run = await scenario({ link: 'linked' })
  // `execFile` reports null only when the child actually started and exited 0.
  // An ENOENT or a non-zero exit lands here, and must not read as a script bug.
  check('the staging script ran', !run.error, run.error)
  check('the linked generation survives', run.after.includes('dsh-wsl-desktop-0002'), run.after)
  // The generation staged BEFORE the linked one is the one a desktop that has not
  // restarted since is still running, so it has to survive: re-pointing the link
  // is exactly what makes it a deletion candidate.
  check('the generation staged before it is kept', run.after.includes('dsh-wsl-desktop-0001'), run.after)
  check('the older generation is dropped', !run.after.includes('dsh-wsl-desktop-0000'), run.after)
  check('a new generation is staged', run.after.length === 3, run.after)
  // Staging alone does not deploy anything: the host resolves whatever the
  // profile link points at, so a run that only copies a directory leaves the
  // previous generation loaded and "stage then restart" loads old code.
  const staged = run.after.find((name) => !['dsh-wsl-desktop-0000', 'dsh-wsl-desktop-0001', 'dsh-wsl-desktop-0002'].includes(name))
  check('the profile link resolves the generation just staged',
    typeof staged === 'string' && run.linkTarget !== null && run.linkTarget.endsWith(staged),
    `link=${String(run.linkTarget)} staged=${String(staged)}`)
  check('the profile manifest names the generation just staged',
    typeof staged === 'string' && run.manifest.includes(staged), run.manifest)
  check('the lockfile names the generation just staged',
    typeof staged === 'string' && run.lock.includes(staged), run.lock)
  await rm(run.home, { recursive: true, force: true })
}

console.log('\nstaged twice before the desktop was ever restarted')
{
  const run = await scenario({ link: 'linked', runs: 2 })
  // The host loaded the generation the link resolved when it STARTED — 0001
  // here. Re-pointing the link is what makes a second stage dangerous: the
  // deletion filter keeps the LINKED generation, and after the first re-point
  // that is a generation nobody ever loaded, while the one in use is the
  // candidate for deletion. Deleting it breaks every WSL session until the next
  // restart, which is the failure the filter's own comment warns about.
  // `run.error`'s message is the command line; the actual PowerShell error is in
  // the captured output, so that is what the evidence shows.
  check('the staging script ran', !run.error, run.error === null ? undefined : run.output)
  // The stamp is second-resolution, so two runs inside one second share a
  // directory AND a row id — and the loader refuses a row id it has already
  // mounted, so the second stage would be ignored in silence rather than fail.
  check('each run stages its own generation',
    run.staged.length === 2 && run.staged[0] !== run.staged[1],
    run.staged.join('\n        '))
  check('the generation the host loaded is still on disk',
    run.after.includes('dsh-wsl-desktop-0002'), run.after)
  await rm(run.home, { recursive: true, force: true })
}

console.log('\na link whose target is already gone')
{
  const run = await scenario({ link: 'dangling' })
  // `execFile` reports null only when the child actually started and exited 0.
  // An ENOENT or a non-zero exit lands here, and must not read as a script bug.
  check('the staging script ran', !run.error, run.error)
  check('every generation is kept rather than guessed at',
    run.after.includes('dsh-wsl-desktop-0000'), run.after)
  check('and the run says so', said(run.output, /keeping every staged generation/i), run.output)
  await rm(run.home, { recursive: true, force: true })
}

console.log('\nno profile link at all')
{
  const run = await scenario({ link: 'unlinked' })
  // `execFile` reports null only when the child actually started and exited 0.
  // An ENOENT or a non-zero exit lands here, and must not read as a script bug.
  check('the staging script ran', !run.error, run.error)
  // Nothing identifies the generation the running host serves here either, so
  // the same rule has to apply: keep them and say so.
  check('every generation is kept rather than guessed at',
    run.after.includes('dsh-wsl-desktop-0000') && run.after.includes('dsh-wsl-desktop-0001'), run.after)
  check('and the run says so', said(run.output, /keeping every staged generation/i), run.output)
  await rm(run.home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? `${checks} check(s) passed` : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
