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
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
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
 * @returns {Promise<{ home: string, plugins: string, after: string[], output: string, error: Error | null }>} the run.
 */
async function scenario({ link }) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wsl-sync-'))
  const plugins = join(home, 'profiles', 'verify', 'plugins')
  await mkdir(plugins, { recursive: true })
  const linked = join(plugins, 'dsh-wsl-desktop-0001')
  const other = join(plugins, 'dsh-wsl-desktop-0000')
  for (const dir of [linked, other]) {
    await mkdir(dir, { recursive: true })
  }
  if (link !== 'unlinked') {
    const modules = join(home, 'profiles', 'verify', 'node_modules')
    await mkdir(modules, { recursive: true })
    // A junction, because the profile falls back to one when the account has no
    // symlink privilege — and the script has to read that spelling too.
    await symlink(linked, join(modules, 'dsh-wsl-desktop'), 'junction')
    if (link === 'dangling') await rm(linked, { recursive: true, force: true })
  }
  const run = await new Promise((resolve) => {
    execFile(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', 'verify'],
      { env: { ...process.env, DSH_HOME: home }, timeout: 120000 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }))
  })
  const after = (await readdir(plugins)).sort()
  // PowerShell's warning stream does not land on stderr for a `-File` run, so
  // the evidence is taken from both channels rather than assuming one.
  const output = `${run.stdout}\n${run.stderr}`
  return { home, plugins, after, output, error: run.error }
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
  check('the linked generation survives', run.after.includes('dsh-wsl-desktop-0001'), run.after)
  check('the unlinked generation is dropped', !run.after.includes('dsh-wsl-desktop-0000'), run.after)
  check('a new generation is staged', run.after.length === 2, run.after)
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
