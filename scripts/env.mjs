/**
 * Environment the live verification suites need, resolved instead of hardcoded.
 *
 * The suites run real commands inside a real distribution, so they need a
 * distribution name and a Linux home directory. Both are properties of the
 * machine, not of the plugin: resolve them, and let an operator override either
 * one. Nothing here is a secret — the token file the host mints is never read.
 *
 * A suite that compares TWO shares needs a second distribution, which is also a
 * property of the machine: `resolveOtherDistro` asks the machine for one, so no
 * suite has to carry the author's distro names.
 *
 * Overrides: `DSH_WSL_DISTRO`, `DSH_WSL_USER`, `DSH_WSL_HOME`,
 * `DSH_WSL_OTHER_DISTRO`.
 */

import { execFileSync } from 'node:child_process'

/** Distribution used when nothing else selects one. */
const FALLBACK_DISTRO = 'debian'

/**
 * A spelled value, when it spells something.
 *
 * The override tests used to be `!== undefined`, which is the wrong question:
 * `DSH_WSL_USER=` (an empty value, which a shell or a CI variable produces easily)
 * IS defined, so it was returned as the login name and `resolveLinuxHome` then built
 * the literal `/home/` — a home that cannot exist. An empty spelling means "not
 * set", which is what the fallback and the probe are for.
 * @param {string|undefined} value - a spelled value.
 * @returns {string|undefined} the value when it is non-empty, else undefined.
 */
function nonEmpty(value) {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Ceiling for the user probe, and how many times it is attempted.
 *
 * The ceiling is mandatory: this probe sits on the critical path of nearly every
 * suite, and wsl.exe is exactly the call a cold VM start can hang. The RETRY is
 * equally mandatory: a cold start can exceed the ceiling once and then answer
 * instantly, and an unhandled ETIMEDOUT used to throw out of module evaluation —
 * killing the suite with a stack trace before a single check printed, which reads
 * as a broken suite rather than a distro that was slow to wake.
 *
 * Named away from PROBE_TIMEOUT_MS on purpose: scripts/wsl-probe.mjs exports that
 * exact name at 60_000, and this module's ceiling is 30_000 for a deliberate
 * reason — this is the MODULE-EVALUATION probe, synchronous, on the critical path
 * of every suite, with the broader repeat (any failure, not a timeout alone). Two
 * same-named constants with different values made importing the wrong one a
 * one-keystroke mistake.
 */
const MODULE_EVAL_PROBE_TIMEOUT_MS = 30_000
const PROBE_ATTEMPTS = 2

/**
 * The distribution under test.
 * @param {string|undefined} argument - explicit argv value, when the caller takes one.
 * @returns {string} the distribution name.
 */
export function resolveDistro(argument) {
  return nonEmpty(argument) ?? nonEmpty(process.env.DSH_WSL_DISTRO) ?? FALLBACK_DISTRO
}

/**
 * The Linux user the distribution runs commands as.
 * @param {string} [distro] - the distribution to ask; defaults to the selected one.
 * @returns {string} the login name reported inside that distribution.
 */
export function resolveLinuxUser(distro = resolveDistro()) {
  const override = nonEmpty(process.env.DSH_WSL_USER)
  if (override !== undefined) return override
  // A ceiling is mandatory: this probe sits on the critical path of nearly
  // every suite, and wsl.exe is exactly the call a cold VM start can hang.
  //
  // The distribution is named explicitly: with no `-d` this probe answers for
  // the machine's DEFAULT distribution, so running a suite with
  // DSH_WSL_DISTRO=<other> returned another distribution's user and every
  // fixture path under `home` pointed at a home that does not exist there.
  const failures = []
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    try {
      const user = execFileSync('wsl.exe', ['-d', distro, '-e', 'id', '-un'], { encoding: 'utf8', timeout: MODULE_EVAL_PROBE_TIMEOUT_MS }).trim()
      if (user !== '') return user
      failures.push('empty answer')
    } catch (error) {
      // The CODE is what identifies the cause: 'ETIMEDOUT' for the cold-start case,
      // or the exit code for a distribution that is not there. The message would be
      // a truncated command line, which names nothing.
      failures.push(error?.code ?? error?.status ?? 'failed')
    }
  }
  // Still an error, but a LEGIBLE one: it names the distribution and the two ways
  // out, instead of surfacing a raw spawnSync ETIMEDOUT from module evaluation.
  throw new Error(
    `cannot resolve the Linux user in distribution "${distro}" (${failures.join(', ')}). `
    + `Wake the distribution once ("wsl.exe -d ${distro} -- true"), or set DSH_WSL_DISTRO / DSH_WSL_USER.`,
  )
}

/**
 * The Linux home directory of that user.
 * @param {string} [distro] - the distribution to ask; defaults to the selected one.
 * @returns {string} an absolute Linux path.
 */
export function resolveLinuxHome(distro) {
  const override = nonEmpty(process.env.DSH_WSL_HOME)
  if (override !== undefined) return override
  return `/home/${resolveLinuxUser(distro)}`
}

/**
 * Every distribution this machine has installed.
 *
 * `wsl.exe -l -q` is the only offline source of that list, and it writes
 * UTF-16LE; a host build answering UTF-8 would leave no NUL byte, so the
 * encoding is read from the bytes rather than assumed (a garbled name would
 * resolve to a distribution that does not exist, which is the failure this
 * function exists to prevent).
 * @returns {string[]} installed distribution names, in registry order.
 */
export function listDistros() {
  let raw
  try {
    raw = execFileSync('wsl.exe', ['-l', '-q'], { timeout: MODULE_EVAL_PROBE_TIMEOUT_MS })
  } catch (error) {
    throw new Error(`cannot list the WSL distributions (${error?.code ?? error?.status ?? 'failed'}). `
      + 'Wake WSL once ("wsl.exe -- true"), or set DSH_WSL_DISTRO / DSH_WSL_OTHER_DISTRO.')
  }
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')
  return text.split(/\r?\n/).map((name) => name.trim()).filter((name) => name.length > 0)
}

/**
 * A distribution OTHER than the selected one — the second share a
 * cross-distribution assertion compares against.
 *
 * The caller must be able to tell "there is none" from a name, so this returns
 * undefined rather than inventing one: a caller that cannot find a second share
 * has to say so, not assert against nothing.
 * @param {string} [distro] - the selected distribution, excluded from the choice.
 * @returns {string|undefined} another installed distribution's name, or undefined when there is none.
 */
export function resolveOtherDistro(distro = resolveDistro()) {
  // `!== undefined` HERE, unlike the three overrides above, and the difference is
  // deliberate: an explicitly EMPTY DSH_WSL_OTHER_DISTRO means "this machine has no
  // second share", and the suites report that as a SKIP naming the family and the
  // missing precondition (verify-9p.mjs's otherProblem branch, pinned by
  // verify-fs-fence-skip.mjs's "empty override" section). Folding an empty value back
  // into the probe would find SOME second distribution and silently measure a share
  // the operator said they did not have.
  if (process.env.DSH_WSL_OTHER_DISTRO !== undefined) return process.env.DSH_WSL_OTHER_DISTRO
  return listDistros().find((name) => name.toLowerCase() !== distro.toLowerCase())
}
