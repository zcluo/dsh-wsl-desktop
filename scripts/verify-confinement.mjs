/**
 * Verify WSL-side confinement against the real distribution.
 *
 * Runs the same command the executor builds (`buildConfinedCommand` through
 * `runWslShell`) and asserts the fence actually holds: the workspace is
 * writable, everything else on the read-only root is not, and files created
 * inside the namespace belong to the session user rather than root.
 *
 * Six checks below RUN the shipped helper inside the distribution, so they need
 * the checkout reachable from WSL — a drive path. When it is not (the suite is
 * run from a checkout that lives inside a distribution), those checks cannot run
 * at all: each is then a COUNTED skip that names its own label, its precondition
 * and the remedy, and the suite exits 2, which verify-all.mjs reports as SKIP
 * rather than as PASS. A skip that printed and exited 0 was a green aggregate
 * standing for checks that did not run — the class this convention removes
 * (verify-modules, verify-9p, verify-fs-fence and verify-client-ui implement it).
 *
 * Run: node scripts/verify-confinement.mjs [distro]
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runWslShell } from '../lib/wsl/world.js'
import {
  DENIAL_SIGNATURES,
  HELPER_PATH,
  HELPER_VERSION,
  RUNNER_HELPER,
  RUNNER_SUDO_UNSHARE,
  SETUP_FAILURE_EXIT,
  SETUP_FAILURE_MARKER,
  assertWorkspaceSpelling,
  buildConfinedCommand,
  detectRunner,
  resetConfinementCache,
  resolveIdentity,
  workspaceUnderPrivateTmp,
} from '../lib/wsl/confinement.js'
import { shellQuote, windowsToMntPath } from '../lib/wsl/paths.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro(process.argv[2])
const home = resolveLinuxHome(distro)
const run = (options) => runWslShell(options)

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

/**
 * The precondition the drive-path probes share: the shipped helper is reached
 * from inside the distribution by its /mnt spelling, which only a Windows drive
 * path has.
 * @param {string} path - the helper's Windows path.
 * @returns {string} the precondition clause.
 */
const drivePathPrecondition = (path) => `the checkout is not on a drive path (${path} has no /mnt spelling)`

/** The remedy for every drive-path probe: run the suite from a checkout the distribution can mount. */
const DRIVE_PATH_REMEDY = 'run the suite from a checkout on a Windows drive, which the distribution mounts under /mnt/<drive>'

/** Run one command through the confinement wrapper (the detected runner). */
async function confined(command, { mode, workspaceLinuxRoot, linuxCwd = '/' }) {
  const identity = await resolveIdentity({ distro, run }).catch((error) => {
    console.log(`        identity probe error: ${error.message}`)
    return null
  })
  if (identity === null) throw new Error('无法解析发行版内的用户身份')
  // Pass the DETECTED runner: once the operator installs the dsh-wsl-confine
  // helper, every check below must exercise the hardened path, not silently
  // keep testing the direct sudo-unshare runner.
  const wrapped = buildConfinedCommand({ command, linuxCwd, mode, workspaceLinuxRoot, identity, runner })
  const result = await runWslShell({ distro, linuxCwd, command: wrapped, timeoutMs: 60_000 })
  return { result, identity }
}

console.log('helper structural gates (offline)')
// The hardened dsh-wsl-confine helper ships as a bash script the JS side can
// only probe with `--version` — which bash parses incrementally, so a script
// that dies one line later still probes "available". v0.2.0 shipped three
// critical defects that no suite exercised: a missing semicolon made the whole
// script unparseable, the fence received its parameters as bare positional
// words (`bash -c script name KEY=VALUE`) that no variable reference can read
// — with `$UID` silently resolving to bash's built-in, i.e. root's uid under
// sudo — and the exemption-grep regex was inlined into a double-quoted string
// with a fatal `$"` sequence. These gates pin the fixed shapes so the helper
// can never again ship unrunnable.
const helperPathFile = fileURLToPath(new URL('../lib/wsl/dsh-wsl-confine.sh', import.meta.url))
const helperSource = await readFile(helperPathFile, 'utf8')
// The helper is a root-owned sudo target that calls twelve tools by bare name —
// getent, cut, sed, tr, mount, findmnt, grep, mountpoint, setpriv, env, bash,
// unshare — and sudo's env_reset does not save it. An EXPORTED PATH is replaced
// when sudoers sets secure_path (measured: `sudo -n printenv PATH` prints the
// secure_path value here), but a PATH handed over as a sudo command-line
// assignment still reaches the target (measured on debian, debian-dev and arch:
// `sudo -n PATH=/tmp/evil:/usr/bin:/bin printenv PATH` -> /tmp/evil:/usr/bin:/bin),
// and the NOPASSWD grant is argument-wildcarded. The identity gate is the worst
// case: it resolves getent and cut through that PATH and TRUSTS their output for
// the --uid/--gid comparison, so a forged answer satisfied --uid 0 --gid 0.
// Measured against a copy of this helper: with a forged getent/cut first on PATH
// the gate accepted `--uid 0 --gid 0` and execution reached the fence, while the
// same forged PATH refused the REAL identity — the gate answered from the
// caller's PATH either way. The pin is the helper's own guarantee, and it has to
// be the FIRST statement it executes: anything above it, the gate included, still
// resolves from the caller's PATH.
const pinnedPathLine = 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const helperLines = helperSource.split('\n')
const pinIndex = helperLines.indexOf(pinnedPathLine)
check('the helper pins PATH to the standard system directories',
  pinIndex !== -1,
  `expected the exact line \`${pinnedPathLine}\` — a pin that leans on the incoming PATH (PATH=$PATH:/usr/bin) pins nothing, because the incoming PATH is the caller's`)
check('the helper exports the pinned PATH so its children inherit it',
  helperLines.some((line) => line.trim() === 'export PATH'),
  'the fence body and the dropped command are separate processes; an unexported assignment leaves env/bash/unshare — and every bare-name call inside the fence — resolving from whatever PATH those children were handed')
// Statements, not text: the pin must be the first thing the script EXECUTES.
// The slice is guarded on the presence test, because indexOf returns -1 for a
// missing pin and `slice(0, -1)` would then scan almost the whole file — a check
// that can pass while the pin is absent is exactly the state this rejects.
const pinPrelude = pinIndex === -1
  ? ['<the pin is absent>']
  : helperLines.slice(0, pinIndex)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line !== 'set -euo pipefail')
check('the pin is the first statement the helper executes',
  pinIndex !== -1 && pinPrelude.length === 0,
  `only comments, blank lines and \`set -euo pipefail\` may precede the pin; found ${JSON.stringify(pinPrelude)} — every statement above it, the identity gate included, runs with the caller's PATH`)
// The pin must also be the LAST word on PATH: a later widening
// (export PATH="$PATH:/home/u/bin", PATH+=":/opt/bin") would put a caller-writable
// directory back in front of the gate's getent/cut, which is the whole defect. The
// matcher must cover the spellings a widening actually takes: an earlier
// /^\s*PATH=/ missed `export PATH=...` and `PATH+=...`, so the check was weaker
// than the claim in its own label.
const pathAssignments = helperSource.match(/^\s*(?:export\s+)?PATH\+?=/gm) ?? []
check('the pin is the only PATH assignment in the helper',
  pathAssignments.length === 1,
  `found ${pathAssignments.length} PATH assignment(s) — the pin must be the only one, in any spelling (PATH=, PATH+=, export PATH=, export PATH+=)`)
// Presence FIRST: indexOf returns -1 for a missing marker and -1 sorts before
// every real index, so the bare comparison would pass on a helper with no pin at
// all — the state this exists to reject.
check('the pin precedes the identity gate',
  helperSource.indexOf(pinnedPathLine) !== -1
    && helperSource.indexOf('getent passwd') !== -1
    && helperSource.indexOf(pinnedPathLine) < helperSource.indexOf('getent passwd'),
  'the gate trusts getent/cut output for the --uid/--gid comparison, so a pin placed after it has not pinned it')
// The pin above closes the PATH route into the helper's own startup. A
// caller-supplied BASH_ENV is the same class one step EARLIER, and it is worse:
// bash sources that file before the script's first line, as root, so nothing in
// this file — the pin included — has run yet. Measured on bash 5.2.37: `bash
// script`, a `#!/bin/bash` shebang under exec and `bash -c` all source it,
// while `bash -p script`, a `#!/bin/bash -p` shebang and `bash -p -c` do not.
// Privileged mode also stops the import of functions from the environment
// (measured: a forged `getent` function satisfied the identity gate without it).
// The shebang is pinned as LINE 1 rather than matched anywhere in the file: a
// `#!/bin/bash -p` line further down is not a shebang, so a scan-the-text check
// would pass on exactly the unfixed file this exists to reject.
const shebang = helperLines[0] ?? ''
check('the helper runs its own bash in privileged mode, so BASH_ENV is not sourced',
  shebang === '#!/bin/bash -p',
  `line 1 is ${JSON.stringify(shebang)} — without -p a caller-supplied BASH_ENV file is sourced as root BEFORE line 1`)
// -p stops THIS shell from processing BASH_ENV; it does not remove the variable from
// the environment, and every descendant inherits it. The drop-side `bash -lc
// "$DROP_COMMAND"` is not privileged and does process it (measured: it sourced the
// caller's file as the session user, inside the fence), and while the fence body was
// still a plain `bash -c` it sourced it as root BEFORE the fence was established
// (measured). The removal therefore has to sit on the ONE invocation every root-phase
// descendant hangs off — the exec tail's `env`, ahead of the fence body it launches.
// A comment-stripped view: the ordering assertion below is about what the file
// EXECUTES. A comment that merely mentions `bash -c` (this file carries several,
// including the one above this check) sorted before the unset and made the check
// fail on a correctly fixed helper - prose is not the invocation.
const helperCode = helperLines.filter((line) => !line.trimStart().startsWith('#')).join('\n')
const execTailAt = helperCode.indexOf('exec unshare')
const execTail = execTailAt === -1 ? '' : helperCode.slice(execTailAt)
// Presence FIRST: indexOf returns -1 for a missing unset and -1 sorts before
// every real index, so the ordering test alone would pass on a helper that never
// removes the variable — the state this exists to reject. The anchor is `$FENCE`
// rather than the string `bash -c`: the fence body's own invocation is spelled
// `bash -p -c` (see the check below), so the older spelling would have measured
// nothing there, and `$FENCE` is the script the fence body is handed either way.
check('the root-phase fence body is launched with BASH_ENV removed',
  execTail.indexOf('env -u BASH_ENV') !== -1
    && execTail.indexOf('env -u BASH_ENV') < execTail.indexOf('$FENCE'),
  'the fence body is a `bash -c` that processes BASH_ENV (measured), so the variable must be dropped on the exec tail BEFORE it launches that shell; an unset that only guards the helper\'s own shell leaves it in the environment for the descendant')
// -p is a property of the SHELL, not of the helper: the fence body is a separate
// `bash -c`, and a non-privileged bash imports functions from the environment
// (measured: `bash -p` -> `env` -> `bash -c` imports a caller's `mount()`, and
// `env -u BASH_ENV` does not remove it). Those functions ARE the fence: a
// coordinated `mount`/`findmnt`/`mountpoint` override made the sweep report a
// confined system while `/mnt/c` stayed writable (measured, a silent bypass), and
// faking `mount()` alone only failed closed at the postcondition by luck. Pin the
// fence body's OWN invocation: a `-p` anywhere else in the file (the shebang is a
// different line) does not make it privileged.
check('the root-phase fence body runs in privileged mode, so caller functions cannot be imported',
  /bash -p -c "\$FENCE" dsh-wsl-confine/.test(helperCode),
  'the fence body is a separate bash; without -p on THIS invocation an environment-provided function overrides the mount/findmnt/mountpoint the fence is built from, and a coordinated override voids the fence silently')
check('the helper has no missing-semicolon brace groups', !/exit 2 \}/.test(helperSource), 'found `exit 2 }` — the brace group stays open and bash aborts at EOF')
check('the fence receives its parameters as environment variables',
  helperSource.includes('DROP_UID="$uid"') && helperSource.includes('--reuid="$DROP_UID"'),
  'params must cross into `bash -c` via env(1); bare KEY=VALUE words are positional parameters, and $UID is a bash built-in')
// The exec tail's env(1) now carries an option (-u BASH_ENV) before its
// assignments, so the pin allows options and still requires env(1) itself to be the
// thing the DROP_* assignments follow — the property this check exists for is
// unchanged: bare KEY=VALUE words after the script name are positional parameters.
check('the exec tail passes env before the fence script',
  /env(?: -u [A-Za-z_][A-Za-z0-9_]*)* \\\n\s+DROP_UID=/.test(helperSource) && !/bash -c "\$FENCE" \\\n\s+dsh-wsl-confine \\\n\s+UID=/.test(helperSource), null)
check('the helper escapes ERE metacharacters before building the exemption pattern',
  helperSource.includes('[][\\\\^$.*+?(){}|]') && helperSource.includes("]/\\\\&/g'"),
  'the allow-list is DATA: unescaped, a workspace path containing ( ) | or [ becomes regex syntax — the real workspace is swept read-only, or a `|` grants an exemption to a path that was never allowed')
// The escape set protects METACHARACTERS; it never protected the SEPARATOR. The
// builder joins its entries line-wise and turns every LF into '|', so an LF inside
// the workspace value was indistinguishable from an entry boundary:
// '/home/u/proj/x<LF>/mnt/c' became an alternation that exempted /mnt/c from BOTH
// the read-only sweep and the writability postcondition — the fence reported
// success while the Windows filesystem stayed writable. A separator cannot be
// escaped (it IS the join), so the value must not be able to carry one: the refusal
// has to come BEFORE the builder, and the JS producer refuses the same spellings.
// (NUL-delimiting the pipeline would make the builder lossless by itself, but sed -z
// is GNU sed only — BusyBox sed 1.36 rejects it, and Alpine 3.20 is a distribution
// docs/DISTRO-SUPPORT.md lists as supported, so that form would break the fence for
// every confined command there. Measured, not assumed: alpine:3.20 -> "sed:
// unrecognized option: z", debian:12 -> GNU sed 4.9, -z accepted.)
check('the helper refuses control characters in --workspace',
  helperSource.includes('--workspace must not contain control characters'),
  'the exemption pattern is built from this value; the JS producer refuses the same spellings, and the helper must not depend on its caller for its own syntax safety')
check('the refusal precedes the pattern builder',
  // The presence test comes FIRST: indexOf returns -1 for a missing marker, and -1
  // sorts before every real index — without this the check would pass on a helper
  // that carries no refusal at all, which is exactly the state it exists to reject.
  helperSource.includes('--workspace must not contain control characters')
    && helperSource.indexOf('--workspace must not contain control characters') < helperSource.indexOf('KEEP_ENTRIES=('),
  'the value becomes pattern syntax at the builder, so a refusal placed after it would judge a pattern that was already built; a missing builder marker makes the comparison fail too')

// The detector accepts ONE version, so the two must be bumped together: bumping
// the helper alone makes detectRunner refuse it, which falls back to the direct
// runner and SKIPS the drift gate below — a silent mismatch. Pin them equal.
// A refusal that means "this fence cannot be established" must be classifiable as
// one: exit 97 + SETUP_FAILURE_MARKER, the pair shell.js's runnerFailed tests. An
// exit-2 usage code would make a fence that never ran read as a command failure.
// Built from the EXPORTED constants, not from literals: if SETUP_FAILURE_EXIT moves
// in confinement.js while the helper keeps exiting 97, shell.js's runnerFailed tests
// the pair and never matches — so a fence that never established itself would read as
// an ordinary command failure again. Hardcoding 97 here would keep this pin green
// through exactly that drift. The guard CONDITION is pinned too, or inverting it
// (refusing everything except /tmp) would still satisfy the message and the code.
check('the /tmp refusal is classifiable as a setup failure',
  new RegExp(`${SETUP_FAILURE_MARKER.replace(/[.*+?^${}()|[\]\\\\]/g, '\\\\$&')}: --workspace must not be \\/tmp[^\\n]*exit ${SETUP_FAILURE_EXIT}`).test(helperSource)
    && helperSource.includes('"$workspace" != /tmp && "$workspace" != /tmp/*'),
  'the private tmpfs would cover such a workspace, so the fence refuses it — that is a setup failure, not a malformed argument')
check('the shipped helper reports the version the detector requires',
  helperSource.includes(`VERSION='dsh-wsl-confine ${HELPER_VERSION}'`),
  `the helper must report ${HELPER_VERSION}; detectRunner refuses anything else, so a mismatch silently falls back to the direct sudo-unshare runner`)
check('the exemption grep consumes the pre-built pattern, anchored at both ends',
  helperSource.includes('grep -Ev "^(${DROP_EXEMPT})\\$"') && !helperSource.includes('sed "s/|$//"'),
  'the fence must not hand-build a pattern from a path; the shipped `/sys$")$"` tail was a bash parse error (closing paren outside the string plus a `$"` locale-quote)')
check('the drop identity is checked against the invoking user',
  helperSource.includes('getent passwd') && helperSource.includes('identity mismatch'),
  'the sudoers grant is argument-wildcarded; an unchecked --uid lets the session user run the helper as uid 0, and root inside the fence is not a reader - it can remount the fence read-write (measured), so that is root WRITE')
// That gate was wrapped in `if [[ -n "${SUDO_USER:-}" ]]; then ... fi`, so an EMPTY
// or unset SUDO_USER skipped it entirely - and the caller controls the variable.
// Measured on a copy of the shipped helper: `sudo -n SUDO_USER= <copy> --uid 0 --gid 0
// --home /root --cwd / -- 'cat /etc/shadow'` ran as uid 0 with /etc/shadow readable,
// and `sudo -n env -u SUDO_USER` did the same. The same route with SUDO_USER=root is
// accepted too; that one is NOT closable in the script (SUDO_UID is forgeable through
// the same SETENV route, so a cross-check buys nothing) and is documented instead.
//
// SEMANTIC, not textual. An earlier version of this pin required only the refusal
// message, its order and one exact wrapper spelling, and two mutations kept it GREEN
// while re-opening the hole: `[[ -v SUDO_USER ]]` (existence only, so an EMPTY value
// passed) and that guard plus a re-wrapped CALLER_UID comparison. The assertions are
// therefore about the CONDITION and the comparison's reachability: the condition must
// test the VALUE through the `:-` default form (which is what makes empty and unset
// one case) and its failure branch must exit 2, no conditional may sit between the
// refusal and the comparison, and the comparison must be a top-level statement (an
// indented one is inside something that can skip it). Judged on the comment-stripped
// view: the refusal must be CODE, not prose that mentions it.
const gateLines = helperCode.split('\n')
const guardAt = gateLines.findIndex((line) => line.includes('cannot determine the invoking user'))
const compareAt = gateLines.findIndex((line) => line.includes('"$uid" != "$CALLER_UID"'))
// Every assignment to CALLER_UID/CALLER_GID must DERIVE its value from the resolved
// record. A synthesized one - `[[ -n "$CALLER_UID" ]] || { CALLER_UID="$uid"; ... }` -
// leaves the guard and the comparison untouched, satisfies every clause above, and makes
// the comparison pass for any SUDO_USER that does not exist (measured: that mutation
// reached unshare with SUDO_USER=nosuchuser1234 instead of the identity mismatch).
const callerAssignments = gateLines.filter((line) => /(?:^|[;{\s])CALLER_(?:UID|GID)=/.test(line))
check('an empty or unset SUDO_USER is refused rather than skipping the identity gate',
  guardAt !== -1 && compareAt !== -1 && guardAt < compareAt
    && /\[\[\s*(?:-n|-z)\s+"\$\{SUDO_USER:-\}"\s*\]\]\s*(?:\|\||&&)\s*\{[^}]*exit 2;\s*\}/.test(gateLines[guardAt])
    && !/\bif\b/.test(gateLines.slice(guardAt, compareAt).join('\n'))
    && !/^\s/.test(gateLines[compareAt])
    && /-z\s+"\$CALLER_UID"/.test(gateLines[compareAt])
    && callerAssignments.length >= 2
    && callerAssignments.every((line) => line.includes('CALLER_RECORD') && /cut -d: -f[0-9]/.test(line)),
  'the guard must refuse on the VALUE (empty or unset) ahead of the comparison, the comparison must be reachable unconditionally AND keep its own fail-closed `-z "$CALLER_UID"` clause, and every CALLER_UID/CALLER_GID value must be derived from the getent record: `[[ -v SUDO_USER ]]`, a wrapped comparison, or a synthesized record each re-opens the hole this closes')
// The structural pin can only read text; these RUN the shipped helper, which is an
// assertion no spelling can satisfy. Unprivileged and deterministic: the refusal
// precedes every privileged step, so no grant is needed (the same pattern as the
// control-character refusal below). Both spellings, because bash treats them
// differently and the hole was exactly that difference: `[[ -v SUDO_USER ]]` passes
// the EMPTY one (falling through to the identity comparison, which answers with a
// different message) and a re-wrapped comparison skips the refusal entirely. Both
// mutations were measured to redden these two checks.
/**
 * The two spellings of "no SUDO_USER" the shipped helper must refuse — ONE list
 * for the loop below and for the SKIP's labels and count, so the SKIP cannot name
 * a different set than the loop evaluates.
 */
const SUDO_USER_PROBES = [['empty', 'SUDO_USER= '], ['unset', 'env -u SUDO_USER ']]
/**
 * The label one spelling's check carries.
 * @param {string} spelling - 'empty' or 'unset'.
 * @returns {string} the check label.
 */
const sudoUserRefusalLabel = (spelling) => `the shipped helper refuses an ${spelling} SUDO_USER before any privileged work`
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    skip(SUDO_USER_PROBES.map(([spelling]) => sudoUserRefusalLabel(spelling)), drivePathPrecondition(helperPathFile), DRIVE_PATH_REMEDY)
  } else {
    for (const [label, prefix] of SUDO_USER_PROBES) {
      const refusal = await runWslShell({
        distro,
        linuxCwd: '/',
        command: `${prefix}bash ${shellQuote(mnt)} --uid 0 --gid 0 --home /root --cwd / -- 'echo GATE-SKIPPED'; echo EXIT=$?`,
        loginShell: false,
        timeoutMs: 60_000,
      })
      check(sudoUserRefusalLabel(label),
        refusal.stdout.includes('EXIT=2')
          && refusal.stderr.includes('cannot determine the invoking user')
          && !refusal.stdout.includes('GATE-SKIPPED'),
        `stdout=${JSON.stringify(refusal.stdout.slice(-200))} stderr=${JSON.stringify(refusal.stderr.slice(-200))}`)
    }
  }
}
// M7 synthesizes the record instead of resolving it: with the guard untouched, one line
// that assigns CALLER_UID="$uid" when the record is empty makes the comparison pass for
// any user that does not exist. The pin asserts the derivation; this asserts it by
// running: a SUDO_USER that cannot be resolved must refuse with the identity mismatch,
// not walk on toward the fence.
/** The label the unresolvable-SUDO_USER check carries; the SKIP names the same value. */
const UNRESOLVABLE_SUDO_USER_LABEL = 'the shipped helper refuses a SUDO_USER that does not resolve'
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    skip([UNRESOLVABLE_SUDO_USER_LABEL], drivePathPrecondition(helperPathFile), DRIVE_PATH_REMEDY)
  } else {
    const refusal = await runWslShell({
      distro,
      linuxCwd: '/',
      command: `SUDO_USER=nosuchuser1234 bash ${shellQuote(mnt)} --uid 0 --gid 0 --home /root --cwd / -- 'echo GATE-SKIPPED'; echo EXIT=$?`,
      loginShell: false,
      timeoutMs: 60_000,
    })
    check(UNRESOLVABLE_SUDO_USER_LABEL,
      refusal.stdout.includes('EXIT=2')
        && refusal.stderr.includes('identity mismatch')
        && !refusal.stdout.includes('GATE-SKIPPED'),
      `stdout=${JSON.stringify(refusal.stdout.slice(-200))} stderr=${JSON.stringify(refusal.stderr.slice(-200))}`)
  }
}
// M5 reopens the ORIGINAL hole with the pin still green: the correct guard wrapped in
// `if [[ "$(id -u)" != 0 ]]; then ... fi` (flush-left, so a leading-whitespace test does
// not see it). The unprivileged variants above cannot see it either - they only vary
// SUDO_USER's emptiness while euid != 0, where the wrapper's condition is true. euid 0 is
// reachable with NO grant through a user namespace (measured: `unshare -r id -u` -> 0), so
// the same assertion is repeated under `unshare -r`: the guard must refuse on the VALUE
// whoever is running it. Probed first and SKIPped when the machine has no user
// namespaces - a check that reddens a healthy machine for a kernel-policy reason is worse
// than a documented gap — and the gap is DOCUMENTED rather than silent: the skip
// is counted and the suite exits 2, so verify-all shows SKIP where a green pass
// would have claimed the M5 assertion had run.
/** The label the user-namespace-root check carries; the SKIP names the same value. */
const USERNS_ROOT_LABEL = 'the shipped helper refuses an empty SUDO_USER under user-namespace root'
{
  const mnt = windowsToMntPath(helperPathFile)
  const usernsProbe = mnt === null ? null : await runWslShell({ distro, linuxCwd: '/', command: 'unshare -r id -u 2>/dev/null', loginShell: false, timeoutMs: 60_000 })
  if (mnt === null || usernsProbe.stdout.trim() !== '0') {
    // The two preconditions are named apart: they have different remedies, and a
    // SKIP whose reason is "helper not on a drive path" while the real cause is a
    // kernel policy sends the operator after the wrong thing.
    skip([USERNS_ROOT_LABEL],
      mnt === null
        ? drivePathPrecondition(helperPathFile)
        : `the distribution has no unprivileged user namespace (unshare -r id -u -> ${JSON.stringify(usernsProbe.stdout.trim())})`,
      mnt === null
        ? DRIVE_PATH_REMEDY
        : 'enable unprivileged user namespaces in the distribution (sysctl kernel.unprivileged_userns_clone=1, or CONFIG_USER_NS) and re-run')
  } else {
    const refusal = await runWslShell({
      distro,
      linuxCwd: '/',
      command: `SUDO_USER= unshare -r bash ${shellQuote(mnt)} --uid 0 --gid 0 --home /root --cwd / -- 'echo GATE-SKIPPED'; echo EXIT=$?`,
      loginShell: false,
      timeoutMs: 60_000,
    })
    check(USERNS_ROOT_LABEL,
      refusal.stdout.includes('EXIT=2')
        && refusal.stderr.includes('cannot determine the invoking user')
        && !refusal.stdout.includes('GATE-SKIPPED'),
      `stdout=${JSON.stringify(refusal.stdout.slice(-200))} stderr=${JSON.stringify(refusal.stderr.slice(-200))}`)
  }
}
/** The label the parse gate carries; the SKIP names the same value. */
const PARSE_GATE_LABEL = 'the helper parses under bash -n'
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    skip([PARSE_GATE_LABEL], drivePathPrecondition(helperPathFile), DRIVE_PATH_REMEDY)
  } else {
    const parse = await runWslShell({ distro, linuxCwd: '/', command: `bash -n ${shellQuote(mnt)} && echo PARSE-OK`, loginShell: false, timeoutMs: 60_000 })
    check(PARSE_GATE_LABEL, parse.stdout.includes('PARSE-OK'), parse.stderr)
  }
}
// A REAL invocation of the shipped helper, unprivileged and without sudo: the
// argument validation runs before anything privileged, so the refusal is
// deterministic and needs no grant. The LF is materialized INSIDE the
// distribution by printf, so the value crosses wsl.exe as plain text.
/** The label the control-character refusal carries; the SKIP names the same value. */
const CONTROL_CHARACTER_LABEL = 'the shipped helper exits 2 on a control character in --workspace'
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    skip([CONTROL_CHARACTER_LABEL], drivePathPrecondition(helperPathFile), DRIVE_PATH_REMEDY)
  } else {
    const refusal = await runWslShell({
      distro,
      linuxCwd: '/',
      command: `ws=$(printf '/home/u/proj/x\\n/mnt/c'); bash ${shellQuote(mnt)} --uid 1000 --gid 1000 --home /home/u --cwd / --workspace "$ws" -- true; echo EXIT=$?`,
      loginShell: false,
      timeoutMs: 60_000,
    })
    check(CONTROL_CHARACTER_LABEL,
      refusal.stdout.includes('EXIT=2') && refusal.stderr.includes('control characters'),
      `stdout=${JSON.stringify(refusal.stdout.slice(-200))} stderr=${JSON.stringify(refusal.stderr.slice(-200))}`)
  }
}
const helperIdentity = { uid: '1000', gid: '1000', home: '/home/tester', name: 'tester' }
const helperReadOnly = buildConfinedCommand({ command: 'true', linuxCwd: '/ws', mode: 'read-only', runner: RUNNER_HELPER, workspaceLinuxRoot: '/ws', identity: helperIdentity })
check('read-only never grants the helper a writable workspace', !helperReadOnly.includes('--workspace'), helperReadOnly)
const helperWrite = buildConfinedCommand({ command: 'true', linuxCwd: '/ws', mode: 'workspace-write', runner: RUNNER_HELPER, workspaceLinuxRoot: '/ws', identity: helperIdentity })
check('workspace-write routes through the helper with the workspace bound',
  helperWrite.includes('--workspace') && helperWrite.includes(HELPER_PATH), helperWrite)

// The producer refuses the spelling BEFORE either runner turns the value into a
// pattern, and the helper branch and the in-process branch are separate code
// paths — so both are asserted. The metacharacter workspace must still be
// ACCEPTED: the guard refuses control characters, and the escape set (not a
// refusal) is what keeps a legitimate path inert.
// A ReferenceError is NOT a refusal: it means the symbol under test is missing
// (or renamed), which must fail the suite rather than read as "refused" — a
// catch-everything helper turns its own four checks green before the guard
// exists. Only a deliberate throw counts.
const rejects = (fn) => {
  try { fn(); return false } catch (error) {
    if (error instanceof ReferenceError || error instanceof TypeError) throw error
    return true
  }
}
const controlWorkspace = '/ws\n/mnt/c'
const buildWith = (root, runner) => () => buildConfinedCommand({
  command: 'true', linuxCwd: root, mode: 'workspace-write', workspaceLinuxRoot: root, identity: helperIdentity, runner,
})
check('a control character in the workspace is refused before either builder runs',
  rejects(buildWith(controlWorkspace, RUNNER_HELPER)) === true
    && rejects(buildWith(controlWorkspace, RUNNER_SUDO_UNSHARE)) === true
    && rejects(buildWith('/home/u/My Project (v2)|probe', RUNNER_HELPER)) === false
    && rejects(buildWith('/home/u/My Project (v2)|probe', RUNNER_SUDO_UNSHARE)) === false,
  'the value becomes exemption syntax on both paths; a space, a paren and a pipe are legitimate path characters and are escaped, never refused')
check('a workspace containing a newline is refused, not turned into alternation',
  rejects(() => assertWorkspaceSpelling('/home/u/proj/x\n/mnt/c')) === true,
  'the exemption pattern is built from this value, and an LF was an entry separator')
check('a workspace containing a carriage return is refused',
  rejects(() => assertWorkspaceSpelling('/home/u/proj/x\r/mnt/c')) === true,
  'the guard covers every control character, not only the one that was exploitable')
check('a workspace containing a NUL is refused',
  rejects(() => assertWorkspaceSpelling('/home/u/proj/x\u0000/mnt/c')) === true,
  'a NUL cannot reach a shell variable, but the producer must not accept a spelling the fence can never carry')
check('an ordinary workspace with a space and a paren is still accepted',
  rejects(() => assertWorkspaceSpelling('/home/u/My Project (v2)')) === false,
  'the guard refuses control characters, not path characters')

// The private /tmp tmpfs is mounted AFTER the workspace bind, so a workspace at
// or below /tmp is covered by it: the bind disappears and `cd` into it fails,
// and a workspace of exactly /tmp would silently BE the ephemeral tmpfs while the
// 9P fs tool still sees the real directory. Both runners must refuse it. This is
// a REAL call, not a source-text match: buildConfinedCommand is pure.
{
  const tmpIdentity = { uid: '1000', gid: '1000', home: '/home/tester', name: 'tester' }
  const refuses = (root, runner) => {
    try {
      buildConfinedCommand({ command: 'true', linuxCwd: root, mode: 'workspace-write', workspaceLinuxRoot: root, identity: tmpIdentity, runner })
      return false
    } catch {
      return true
    }
  }
  check('a workspace at or below /tmp is refused by both runners',
    refuses('/tmp', RUNNER_HELPER) && refuses('/tmp', RUNNER_SUDO_UNSHARE)
      && refuses('/tmp/proj', RUNNER_HELPER) && refuses('/tmp/proj', RUNNER_SUDO_UNSHARE),
    'the private tmpfs would cover the workspace bind')
  check('a workspace that merely starts with /tmp is still allowed',
    !refuses('/tmpfoo', RUNNER_SUDO_UNSHARE) && !refuses('/tmpfoo', RUNNER_HELPER)
      && workspaceUnderPrivateTmp('/tmpfoo') === false,
    '/tmpfoo must not be caught by the prefix boundary — on EITHER runner, since the helper branch is its own code path')
  const readOnlyAcceptsTmp = (() => {
    try {
      buildConfinedCommand({ command: 'true', linuxCwd: '/tmp', mode: 'read-only', identity: tmpIdentity, runner: RUNNER_SUDO_UNSHARE })
      return true
    } catch {
      return false
    }
  })()
  check('read-only is unaffected by the /tmp refusal',
    readOnlyAcceptsTmp,
    'the guard exists because a WRITABLE workspace is bound; read-only binds nothing')
}

resetConfinementCache()
const probeRoot = `${home}/dsh-wsl-sandbox-probe`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf ${probeRoot} && mkdir -p ${probeRoot} && echo seed > ${probeRoot}/seed.txt` })

console.log(`probing confinement in ${distro}\n`)

console.log('runner detection')
// One transparent retry: the detection probe runs `wsl.exe`, and a single
// hiccup right after other suites hammered the VM can fail it while every
// real confinement check below still runs. The retry repeats the SAME probe;
// the outcome names both attempts so a persistent absence stays visible.
const detectOnce = () => detectRunner({ distro, run }).catch(() => null)
let runner = await detectOnce()
// Only a NULL outcome needs the retry. Keying this on `runner !== 'sudo-unshare'`
// made a helper machine sleep a second, re-probe a cached answer, and print
// "first attempt failed; retried once" — evidence of a failure that never
// happened.
let detectionRetried = runner === null
if (detectionRetried) {
  await new Promise((resolve) => { setTimeout(resolve, 1000) })
  runner = await detectOnce()
}
check('a confinement runner is available', runner === 'sudo-unshare' || runner === 'helper',
  `${String(runner)}${detectionRetried ? ' (first attempt failed; retried once)' : ''}`)
console.log(`        runner=${runner}`)
// The checks below exercise the DETECTED runner — for the hardened path that is
// the helper INSTALLED at HELPER_PATH, a copy the operator makes by hand. If
// that copy has drifted from the file this package ships, a green suite would
// describe an artifact nobody ships. Compare them, and name the repair.
//
// Only this branch can hide anything: when the detected runner is the direct
// sudo-unshare path there is no installed copy whose drift could matter, so no
// check is missing there and nothing is recorded. When the runner IS the helper
// the check has a subject, and a checkout with no /mnt spelling is then a counted
// skip.
/** The label the installed-copy comparison carries; the SKIP names the same value. */
const INSTALLED_HELPER_LABEL = 'the installed helper is the helper this package ships'
if (runner === RUNNER_HELPER) {
  const helperMnt = windowsToMntPath(helperPathFile)
  if (helperMnt === null) {
    // The same condition the bash -n gate above skips on: the checkout is not on
    // a drive path (it lives inside a distribution), so the shipped file has no
    // /mnt spelling to compare against. Failing here told the operator to
    // reinstall a byte-identical helper.
    skip([INSTALLED_HELPER_LABEL], drivePathPrecondition(helperPathFile), DRIVE_PATH_REMEDY)
  } else {
    const sums = await runWslShell({ distro, linuxCwd: '/', command: `md5sum ${shellQuote(HELPER_PATH)} ${shellQuote(helperMnt)} 2>/dev/null`, loginShell: false, timeoutMs: 60_000 })
    const [installedSum, shippedSum] = sums.stdout.trim().split('\n').map((line) => line.split(/\s+/)[0])
    check(INSTALLED_HELPER_LABEL,
      typeof installedSum === 'string' && installedSum !== '' && installedSum === shippedSum,
      `installed=${String(installedSum)} shipped=${String(shippedSum)} — the suite is exercising the installed copy; reinstall it per README: install -m 0755 -o root -g root <lib/wsl/dsh-wsl-confine.sh> ${HELPER_PATH}`)
  }
}
// Guarded exactly like the identical probe inside `confined()` above:
// resolveIdentity THROWS rather than returning null (confinement.js either builds
// a non-null object or throws carrying the probe's own evidence), so an unguarded
// call turns a transient probe fault into an unhandled rejection that aborts the
// whole suite before the summary — instead of the FAIL this check exists to print.
// With the guard, the null test below is meaningful again.
const identity = await resolveIdentity({ distro, run }).catch((error) => {
  console.log(`        identity probe error: ${error.message}`)
  return null
})
check('the session identity resolves', identity !== null && /^\d+$/.test(identity?.uid ?? ''), identity)
console.log(`        uid=${identity?.uid} gid=${identity?.gid}`)

console.log('\nworkspace-write')
const inside = await confined(`echo written > ${probeRoot}/inside.txt && echo INSIDE-OK`, { mode: 'workspace-write', workspaceLinuxRoot: probeRoot, linuxCwd: probeRoot })
check('a write inside the workspace succeeds', inside.result.exitCode === 0 && inside.result.stdout.includes('INSIDE-OK'), `${inside.result.exitCode} ${inside.result.stderr}`)
const outside = await confined(`echo written > ${home}/dsh-wsl-forbidden.txt && echo OUTSIDE-OK`, { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
check('a write outside the workspace is denied', !outside.result.stdout.includes('OUTSIDE-OK'), `${outside.result.exitCode} ${outside.result.stdout}`)
check('the denial carries a known signature', DENIAL_SIGNATURES.some((signature) => outside.result.stderr.includes(signature)), outside.result.stderr)
const scratch = await confined('echo written > /tmp/dsh-wsl-tmp.txt && echo TMP-OK', { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
check('the private scratch space stays writable', scratch.result.stdout.includes('TMP-OK'), `${scratch.result.exitCode} ${scratch.result.stderr}`)
const who = await confined('id -u; id -g', { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
check('the command runs as the session user, not root', who.result.stdout.trim().split(/\s+/)[0] === identity?.uid, who.result.stdout)
const ownership = await runWslShell({ distro, linuxCwd: '/', command: `stat -c '%u' ${probeRoot}/inside.txt` })
check('files created stay owned by the session user', ownership.stdout.trim() === identity?.uid, `owner=${ownership.stdout.trim()} expected=${identity?.uid}`)

console.log('\nworkspace path with whitespace')
// Regression probe for the exemption-pattern construction: the workspace path
// reaches the grep pattern as DATA, so a space (or any other metacharacter)
// in it must stay inert. Before the fix, a space word-split the grep argv,
// `|| true` swallowed the failure, and BOTH the sweep and the postcondition
// iterated zero times — reporting success while every mount except / stayed
// writable.
const spacedRoot = `${home}/dsh-wsl-sandbox probe dir`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf "${spacedRoot}" && mkdir -p "${spacedRoot}" && echo seed > "${spacedRoot}/seed.txt"` })
const inSpaced = await confined(`echo written > "${spacedRoot}/inside.txt" && echo SPACED-OK`, { mode: 'workspace-write', workspaceLinuxRoot: spacedRoot, linuxCwd: spacedRoot })
check('a write inside a space-named workspace succeeds', inSpaced.result.exitCode === 0 && inSpaced.result.stdout.includes('SPACED-OK'), `${inSpaced.result.exitCode} ${inSpaced.result.stderr}`)
const outSpaced = await confined(`echo written > "${home}/dsh-wsl-forbidden.txt" && echo OUT-SPACED-OK`, { mode: 'workspace-write', workspaceLinuxRoot: spacedRoot })
check('a write outside a space-named workspace is still denied',
  !outSpaced.result.stdout.includes('OUT-SPACED-OK') && DENIAL_SIGNATURES.some((signature) => outSpaced.result.stderr.includes(signature)),
  `${outSpaced.result.exitCode} ${outSpaced.result.stderr}`)

console.log('\nworkspace path with ERE metacharacters (exemption-pattern escaping)')
// A space was only the FIRST metacharacter. The workspace path is DATA for the
// exemption pattern, so every ERE metacharacter must stay inert. The helper
// joined its allow-list into the pattern unescaped, so a workspace such as
// `…/dsh-wsl-sandbox (v2)|probe` turned its own parentheses into an ERE group
// and its `|` into alternation: the pattern then stopped matching the REAL
// workspace — the sweep remounted it read-only, so every write inside it failed
// — while starting to match paths that were never granted. The in-process
// builder escaped through escapeEre() and was unaffected, so the two runners
// silently disagreed about the same fence.
const metaRoot = `${home}/dsh-wsl-sandbox (v2)|probe`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf "${metaRoot}" && mkdir -p "${metaRoot}" && echo seed > "${metaRoot}/seed.txt"` })
const inMeta = await confined(`echo written > "${metaRoot}/inside.txt" && echo META-OK`, { mode: 'workspace-write', workspaceLinuxRoot: metaRoot, linuxCwd: metaRoot })
check('a write inside a metacharacter-named workspace succeeds', inMeta.result.exitCode === 0 && inMeta.result.stdout.includes('META-OK'), `${inMeta.result.exitCode} ${inMeta.result.stderr}`)
const outMeta = await confined(`echo written > ${home}/dsh-wsl-forbidden.txt && echo OUT-META-OK`, { mode: 'workspace-write', workspaceLinuxRoot: metaRoot })
check('a write outside a metacharacter-named workspace is still denied',
  !outMeta.result.stdout.includes('OUT-META-OK') && DENIAL_SIGNATURES.some((signature) => outMeta.result.stderr.includes(signature)),
  `${outMeta.result.exitCode} ${outMeta.result.stderr}`)

console.log('\nspaced mount target outside the workspace (findmnt \\x20 decoding)')
// findmnt -r hex-escapes unsafe characters in TARGET (\x20 for space): before
// the decode-before-match fix, the sweep remounted the escaped literal name
// (ENOENT swallowed by `|| true`) and the postcondition tested the bogus name
// — so a spaced mount target outside the workspace stayed WRITABLE and the
// fail-closed exit 97 never fired. The bind below creates a REAL spaced mount
// target (unconfined setup, like the suites above), and the confined
// read-only run must deny a write under its REAL path.
const spacedMount = `${home}/mnt probe`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf "${spacedMount}" && mkdir -p "${spacedMount}" && sudo -n mount --bind "${home}" "${spacedMount}"` })
const mountedCheck = await runWslShell({ distro, linuxCwd: '/', command: `findmnt -rno TARGET "${spacedMount}"` })
check('the spaced bind target is mounted', mountedCheck.stdout.trim() === spacedMount || mountedCheck.stdout.trim().includes('probe'), `${JSON.stringify(mountedCheck.stdout)}`)
// The options are read INSIDE the same namespace that fenced them: the sweep
// remounts namespace-local mounts, so a findmnt from OUTSIDE this process sees
// the original `rw` — the previous check ran out there and could only ever have
// matched `errors=remount-ro` inside the ext4 options string, which made it an
// assertion that could not fail.
const spacedMountWrite = await confined(
  `echo written > "${spacedMount}/dsh-wsl-escape.txt" && echo SPACED-MOUNT-OK; echo "OPTIONS:$(findmnt -rno OPTIONS "${spacedMount}" | head -1)"`,
  { mode: 'read-only' },
)
check('a write into a spaced mount target is denied under its REAL path',
  !spacedMountWrite.result.stdout.includes('SPACED-MOUNT-OK') && DENIAL_SIGNATURES.some((signature) => spacedMountWrite.result.stderr.includes(signature)),
  `${spacedMountWrite.result.exitCode} ${spacedMountWrite.result.stderr}`)
const spacedOptions = /OPTIONS:(.*)/.exec(spacedMountWrite.result.stdout)?.[1]?.trim() ?? ''
check('the spaced mount target was remounted read-only inside the fence',
  /^ro(,|$)/.test(spacedOptions),
  `options=${JSON.stringify(spacedOptions)} stdout=${JSON.stringify(spacedMountWrite.result.stdout.slice(-200))}`)
await runWslShell({ distro, linuxCwd: '/', command: `sudo -n umount "${spacedMount}" && rm -rf "${spacedMount}"` })

console.log('\nread-only')
const readOnlyWrite = await confined(`echo written > ${probeRoot}/readonly.txt && echo RO-OK`, { mode: 'read-only' })
check('a write inside the workspace is denied', !readOnlyWrite.result.stdout.includes('RO-OK'), `${readOnlyWrite.result.exitCode} ${readOnlyWrite.result.stdout}`)
const readOnlyRead = await confined(`cat ${probeRoot}/seed.txt`, { mode: 'read-only', linuxCwd: probeRoot })
check('reads still work', readOnlyRead.result.stdout.includes('seed'), readOnlyRead.result.stderr)

console.log('\nseparately mounted filesystems')
// `mount -o remount,ro,bind /` makes ONE mount read-only. Every other mount
// keeps its own flags, so the honest question is not "is / read-only" but "is
// anything still writable". `test -w` answers it without writing anything — but
// only for a path that EXISTS: it is false for one that is not there at all, so
// the old `[ -w "$p" ] && echo WRITABLE || echo READONLY` reported a path this
// distribution does not have as READONLY. Measured on this suite: asked about a
// nonexistent path it printed `/mnt/ocr-missing-3 READONLY` and "the Windows
// filesystem is not writable" — the row whose whole subject is that path — PASSED,
// i.e. the row could be satisfied by a machine with no /mnt/c mounted at all.
// MISSING is therefore its own state, and each row below requires READONLY
// exactly, so an absent path FAILS the row instead of satisfying it.
const mounts = await confined(
  'findmnt -rno TARGET,OPTIONS | grep -E "^(/|/mnt/[a-z]|/dev/shm|/run/user)" | head -20; echo ---;'
  + ' for p in / /mnt/c /dev/shm "/run/user/$(id -u)"; do'
  + ' if [ ! -e "$p" ]; then printf "%s %s\\n" "$p" MISSING;'
  + ' elif [ -w "$p" ]; then printf "%s %s\\n" "$p" WRITABLE;'
  + ' else printf "%s %s\\n" "$p" READONLY; fi; done',
  { mode: 'workspace-write', workspaceLinuxRoot: probeRoot },
)
console.log(mounts.result.stdout.trim().split('\n').map((line) => `        ${line}`).join('\n'))
/** One path's state as the probe reported it: MISSING, WRITABLE or READONLY ('(not reported)' when absent). */
const mountState = (pattern) => new RegExp(`^${pattern} (\\w+)$`, 'm').exec(mounts.result.stdout)?.[1] ?? '(not reported)'
/** The failure detail, naming MISSING: it is the state that used to read as READONLY. */
const whyState = (pattern) => `state=${mountState(pattern)} — MISSING means the path does not exist in this distribution, and a path that is not there must not satisfy a writability row`
check('the root filesystem is present and read-only', mountState('/') === 'READONLY', whyState('/'))
check('the Windows filesystem is present and not writable', mountState('/mnt/c') === 'READONLY', whyState('/mnt/c'))
check('shared memory is present and not writable', mountState('/dev/shm') === 'READONLY', whyState('/dev/shm'))
check('the session runtime directory is present and not writable',
  mountState('/run/user/\\d+') === 'READONLY', whyState('/run/user/\\d+'))

console.log('\na setup step that cannot succeed')
// The steps are joined with `; ` and there is no `set -e`, so a failed mount
// used to leave the command running with a writable root while the caller was
// told the sandbox was fully enforced.
const failOpen = await confined('echo CONTINUED-AFTER-FAILED-SETUP', {
  mode: 'workspace-write',
  workspaceLinuxRoot: '/definitely-not-a-workspace-xyz',
})
check('a failed setup does not silently run the command anyway',
  !failOpen.result.stdout.includes('CONTINUED-AFTER-FAILED-SETUP'),
  `exit=${failOpen.result.exitCode} stdout=${JSON.stringify(failOpen.result.stdout)} stderr=${JSON.stringify(failOpen.result.stderr)}`)

console.log('\nprocess isolation')
// A namespace is a different inode for /proc/self/ns/pid, not merely a
// successful exit: `--pid` can be dropped and the command still exits 0.
const outerNs = await runWslShell({ distro, linuxCwd: '/', command: 'readlink /proc/self/ns/pid' })
const innerNs = await confined('readlink /proc/self/ns/pid', { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
check('a PID namespace is entered',
  innerNs.result.stdout.trim().length > 0 && innerNs.result.stdout.trim() !== outerNs.stdout.trim(),
  `outer=${outerNs.stdout.trim()} inner=${innerNs.result.stdout.trim()}`)
const pidns = await confined('echo PID=$$; ps -e --no-headers 2>/dev/null | wc -l', { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
console.log(`        ${pidns.result.stdout.trim().replace(/\n/g, ' | ')}`)

// Every fixture this suite creates is removed again, and quoted: two of them
// carry spaces and ERE metacharacters — which is the point of the sections
// above — so an unquoted rm would either miss them or be re-parsed.
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf ${shellQuote(probeRoot)} ${shellQuote(spacedRoot)} ${shellQuote(metaRoot)} ${shellQuote(`${home}/dsh-wsl-forbidden.txt`)} /tmp/dsh-wsl-tmp.txt` })
// A skip is a check that did not run, and reporting it as a pass would make this
// suite's green meaningless exactly where the shipped helper is the subject: exit
// 2 is what verify-all renders as SKIP (the sibling suites' ruling, applied here).
if (failures > 0) console.log(`\n${failures} CHECK(S) FAILED${skipped === 0 ? '' : `, ${skipped} CHECK(S) SKIPPED`}`)
else if (skipped > 0) console.log(`\nEVERY CHECK THAT COULD RUN PASSED, ${skipped} CHECK(S) SKIPPED — exit 2, so verify-all reports this suite as SKIP`)
else console.log('\nALL CHECKS PASSED')
process.exitCode = failures > 0 ? 1 : skipped > 0 ? 2 : 0
