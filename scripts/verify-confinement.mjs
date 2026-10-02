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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  helperOwnershipScript,
  helperSelectionScript,
  resetConfinementCache,
  resolveIdentity,
  workspaceUnderPrivateTmp,
} from '../lib/wsl/confinement.js'
// The no-new-privs probe and its refusal decision are read through the NAMESPACE
// rather than as named imports: a named import of an export that has been renamed
// or removed is a module-load SyntaxError, so the suite would end with a stack
// trace instead of the labelled FAIL that names the missing symbol. The check
// below is about the symbol's EXISTENCE, so it has to survive its absence.
import * as noNewPrivsProbe from '../lib/wsl/confinement.js'
import { shellQuote, windowsToMntPath } from '../lib/wsl/paths.js'
import { blankLiterals } from './source-text.mjs'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { detailText } from './detail.mjs'

const distro = resolveDistro(process.argv[2])
const home = resolveLinuxHome(distro)
const run = (options) => runWslShell(options)

// Every scratch path this suite owns is made UNIQUE TO THIS PROCESS. They were all
// machine-global — `<home>/dsh-wsl-sandbox-probe`, `<home>/dsh-wsl-sandbox probe dir`,
// `<home>/dsh-wsl-sandbox (v2)|probe`, `<home>/mnt probe`, `<home>/dsh-wsl-forbidden.txt`,
// and the `/tmp`, `/opt` and `/root` fixture trees — so two runs overlapping in time
// destroyed each other: each run's OPENING `rm -rf` deletes the other's fixture, and one
// run's CLEANUP deletes a tree the other is still measuring. Measured with two
// overlapping runs of this suite: 24 of 24 runs exited 1, against 0 of 1 alone. The
// chdir into the shared workspace probe appears in ALL 24 (`chdir(<home>/dsh-wsl-sandbox-probe)
// failed 2`), `a PID namespace is entered` reports an EMPTY inner namespace in 20, and
// 8 runs lost the whole 20-check fixture table to a half-built `/opt` tree because the
// other run's `rm -rf` landed between this run's `mkdir` and its `install`
// (`install: cannot create regular file '/opt/dsh-wsl-helper-fixtures/keep-0755': No such
// file or directory`). The pid is enough and is what verify-9p.mjs settled on:
// concurrent processes never share one, and a reused pid finds only its own leftover,
// which the opening `rm -rf` removes anyway.
//
// NO PATH HERE HAS TO BE MACHINE-GLOBAL FOR WHAT THE SUITE PROVES. Every containment a
// fixture depends on is a property of the path's PREFIX or of its SPELLING, never of its
// full name, so a `-<pid>` suffix leaves all of them intact:
//   - the workspace probes must sit OUTSIDE /tmp (the fence refuses a writable workspace
//     at or below /tmp — pinned below) and under the session home; the space- and
//     metacharacter-named workspaces must still CARRY a space, a paren and a pipe;
//   - the spaced mount target must still carry a space, and must be outside the workspace;
//   - the user fixture tree must sit under /tmp, so that its ANCESTOR is writable (that
//     is the "root-owned copy under a writable ancestor" case);
//   - the root fixture tree must sit in a root-owned, non-writable tree (/opt);
//   - the private fixture tree must sit in a 0700 root tree the session user cannot
//     traverse (/root).
// The suffix keeps the CONFINEMENT assertions exactly as strong as they were; it changes
// only which name each run gives its own copy of the fixture.
const runSuffix = process.pid

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
console.log('\nno-new-privs: three states, and two of them refuse (offline)')
// Finding 1: the probe answered null for "could not run" while the detector
// coerced it with `?? false`, so "this setpriv cannot set NO_NEW_PRIVS" (a
// measured limitation of the machine) and "I have no idea" (an unknown boundary)
// were the SAME value — and the caller then built the drop WITHOUT the flag while
// still describing `enforcement: 'partial'`. The three states are asserted apart,
// and the refusal they drive is asserted as a DECISION: a healthy machine cannot
// produce the unmeasured state (the probe answers yes or no whenever it runs),
// which is why the refusal was extracted into a pure exported function instead of
// staying three lines only a broken distribution could reach.
//
// The injected `run` is the probe's own seam, so these rows need no distribution
// and no drive path: they are the same rows the finding was proved with, and they
// are what reddens when `detectNoNewPrivs` starts answering with a boolean again.
const detectNoNewPrivs = noNewPrivsProbe.detectNoNewPrivs
const noNewPrivsRefusal = noNewPrivsProbe.noNewPrivsRefusal
if (typeof detectNoNewPrivs !== 'function' || typeof noNewPrivsRefusal !== 'function') {
  check('confinement.js exports the no-new-privs probe and the refusal decision shell.js throws with',
    false, { detectNoNewPrivs: typeof detectNoNewPrivs, noNewPrivsRefusal: typeof noNewPrivsRefusal })
} else {
  resetConfinementCache()
  let notRunCalls = 0
  const notMeasured = await detectNoNewPrivs({
    distro,
    run: async () => { notRunCalls += 1; throw new Error('wsl.exe: 发行版未注册') },
  })
  check('a probe that did not run reports NOT MEASURED (null), not "unsupported" (false)',
    notMeasured === null, { got: notMeasured })
  check('the unmeasured probe was retried once, so one hiccup does not become a refusal',
    notRunCalls === 2, { attempts: notRunCalls })
  // The shape a distro-level wsl.exe failure has: a non-zero exit and EMPTY stdout.
  // A probe that answered nothing has not answered "no". The empty-answer class is
  // what `answer !== 'yes' -> false` got wrong.
  resetConfinementCache()
  const silentProbe = await detectNoNewPrivs({
    distro,
    run: async () => ({ exitCode: 258, stdout: '', stderr: 'no such distribution' }),
  })
  check('a non-zero probe with an empty answer is NOT MEASURED too',
    silentProbe === null, { got: silentProbe })
  // The measurements that ARE answers stay answers, and a measured answer is cached:
  // re-probing a decided machine on every confined command is the cost the cache exists
  // to avoid, while an UNMEASURED result must not be cached (it would freeze an unknown
  // into a decision).
  resetConfinementCache()
  let noCalls = 0
  const saidNo = await detectNoNewPrivs({ distro, run: async () => { noCalls += 1; return { stdout: 'no\n' } } })
  check('the probe answering "no" reports false (a MEASURED unsupported setpriv)',
    saidNo === false, { got: saidNo })
  const againNo = await detectNoNewPrivs({ distro, run: async () => { noCalls += 1; return { stdout: 'no\n' } } })
  check('a measured answer is cached, so the next command does not re-probe it',
    againNo === false && noCalls === 1, { got: againNo, probes: noCalls })
  resetConfinementCache()
  const saidYes = await detectNoNewPrivs({ distro, run: async () => ({ stdout: 'yes\n' }) })
  check('the probe answering "yes" reports true (measured supported)', saidYes === true, { got: saidYes })
  resetConfinementCache()
  let unmeasuredCalls = 0
  await detectNoNewPrivs({ distro, run: async () => { unmeasuredCalls += 1; throw new Error('boom') } })
  await detectNoNewPrivs({ distro, run: async () => { unmeasuredCalls += 1; throw new Error('boom') } })
  check('an unmeasured probe is NOT cached: the next command re-probes instead of reusing an unknown',
    unmeasuredCalls === 4, { attempts: unmeasuredCalls })
  // The refusal itself. Two DISTINGUISHABLE texts: one is a property of the machine
  // (install the helper, or a newer util-linux) and the other is not (retry). A single
  // text for both would make an operator chase the wrong remedy, and would re-conflate
  // the two states at the point the operator actually reads.
  const unsupported = noNewPrivsRefusal(false)
  const unmeasured = noNewPrivsRefusal(null)
  check('a measured-supported setpriv is not refused', noNewPrivsRefusal(true) === null, { got: noNewPrivsRefusal(true) })
  check('a measured-unsupported setpriv is refused', typeof unsupported === 'string' && unsupported.length > 0, { got: unsupported })
  check('an UNMEASURED setpriv is refused TOO (the finding: the flag was dropped and the command still ran)',
    typeof unmeasured === 'string' && unmeasured.length > 0, { got: unmeasured })
  check('the two refusals are DIFFERENT texts, so a log grep can tell the states apart',
    unsupported !== unmeasured, { unsupported, unmeasured })
  check('both refusals are wsl-sandbox errors',
    String(unsupported).startsWith('wsl-sandbox:') && String(unmeasured).startsWith('wsl-sandbox:'),
    { unsupported, unmeasured })
  check('the unsupported text names an unsupported setpriv, not a failed probe',
    /不支持/.test(unsupported ?? '') && !/无法测量/.test(unsupported ?? ''), { unsupported })
  check('the unmeasured text names a probe that could not be measured, not an unsupported setpriv',
    /无法测量/.test(unmeasured ?? '') && !/不支持/.test(unmeasured ?? ''), { unmeasured })
  // The refusal is only load-bearing if the EXECUTOR consults it. shell.js is the host
  // half and its harness imports do not resolve in this checkout (verify-modules SKIPs
  // its host-half import for that reason), so this half is a SOURCE pin over comment-
  // and literal-blanked text — the same technique verify-world.mjs's finding-4 pins use,
  // and the reason the finding's own first version of this pin matched a COMMENT that
  // named the call instead of the call.
  const shellCode = blankLiterals(await readFile(fileURLToPath(new URL('../lib/wsl/shell.js', import.meta.url)), 'utf8'))
  const decisionAt = shellCode.indexOf('noNewPrivsRefusal(')
  const buildAt = shellCode.indexOf('buildConfinedCommand(', decisionAt < 0 ? 0 : decisionAt)
  check('shell.js consults the exported refusal decision before it builds the command',
    decisionAt >= 0 && buildAt > decisionAt, { decisionAt, buildAt })
  check('shell.js THROWS SandboxUnavailableError on a refusal (the direct runner refuses like its siblings)',
    decisionAt >= 0 && /throw new SandboxUnavailableError\(/.test(shellCode.slice(decisionAt, decisionAt + 900)),
    { window: shellCode.slice(decisionAt, decisionAt + 400) })
  check('shell.js no longer assigns the raw probe result to the drop flag',
    !/noNewPrivs\s*=\s*await detectNoNewPrivs\(/.test(shellCode))
}
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
const probeRoot = `${home}/dsh-wsl-sandbox-probe-${runSuffix}`
// The path every "outside the workspace" probe tries to write. It carries the pid too:
// the tail removes it, and an unconfined `rm -rf` of a name another run owns is the same
// cross-run delete as the trees above.
const forbiddenPath = `${home}/dsh-wsl-forbidden-${runSuffix}.txt`
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
const outside = await confined(`echo written > ${forbiddenPath} && echo OUTSIDE-OK`, { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
check('a write outside the workspace is denied', !outside.result.stdout.includes('OUTSIDE-OK'), `${outside.result.exitCode} ${outside.result.stdout}`)
check('the denial carries a known signature', DENIAL_SIGNATURES.some((signature) => outside.result.stderr.includes(signature)), outside.result.stderr)
const scratch = await confined(`echo written > /tmp/dsh-wsl-tmp-${runSuffix}.txt && echo TMP-OK`, { mode: 'workspace-write', workspaceLinuxRoot: probeRoot })
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
const spacedRoot = `${home}/dsh-wsl-sandbox probe dir-${runSuffix}`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf "${spacedRoot}" && mkdir -p "${spacedRoot}" && echo seed > "${spacedRoot}/seed.txt"` })
const inSpaced = await confined(`echo written > "${spacedRoot}/inside.txt" && echo SPACED-OK`, { mode: 'workspace-write', workspaceLinuxRoot: spacedRoot, linuxCwd: spacedRoot })
check('a write inside a space-named workspace succeeds', inSpaced.result.exitCode === 0 && inSpaced.result.stdout.includes('SPACED-OK'), `${inSpaced.result.exitCode} ${inSpaced.result.stderr}`)
const outSpaced = await confined(`echo written > "${forbiddenPath}" && echo OUT-SPACED-OK`, { mode: 'workspace-write', workspaceLinuxRoot: spacedRoot })
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
const metaRoot = `${home}/dsh-wsl-sandbox (v2)|probe-${runSuffix}`
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf "${metaRoot}" && mkdir -p "${metaRoot}" && echo seed > "${metaRoot}/seed.txt"` })
const inMeta = await confined(`echo written > "${metaRoot}/inside.txt" && echo META-OK`, { mode: 'workspace-write', workspaceLinuxRoot: metaRoot, linuxCwd: metaRoot })
check('a write inside a metacharacter-named workspace succeeds', inMeta.result.exitCode === 0 && inMeta.result.stdout.includes('META-OK'), `${inMeta.result.exitCode} ${inMeta.result.stderr}`)
const outMeta = await confined(`echo written > ${forbiddenPath} && echo OUT-META-OK`, { mode: 'workspace-write', workspaceLinuxRoot: metaRoot })
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
const spacedMount = `${home}/mnt probe-${runSuffix}`
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

console.log('\nthe helper selection gate, measured against fixtures the session user can replace')
// Finding 3's subject is a PATH, not a predicate: "the sudoers grant names a path
// the session user can replace" is only measured by building such paths and asking
// the shipped probe about them. These are the fixtures the finding was reproduced
// with — a session-user-owned copy, a root-owned copy under a writable ancestor, a
// root-owned 0777 copy, and a session-user-OWNED 0555 file under a root-owned tree
// (nothing about it is writable, so ONLY the owner check refuses it; the first
// fixture set could not distinguish that check, which is how the gap was found).
//
// The helper's BYTES are written to the host temp directory rather than read from
// the checkout: the fixtures need the shipped file reachable from inside the
// distribution, and a temp path has a /mnt spelling even where the checkout does
// not (the precondition the drive-path checks above skip on). The host tree and
// the fixture trees are removed in the same run.
const FIXTURE_SOURCE_DIR = mkdtempSync(join(tmpdir(), 'dsh-wsl-helper-fixtures-'))
const FIXTURE_SOURCE_HOST = join(FIXTURE_SOURCE_DIR, 'dsh-wsl-confine.sh')
writeFileSync(FIXTURE_SOURCE_HOST, helperSource)
const FIXTURE_SOURCE_MNT = windowsToMntPath(FIXTURE_SOURCE_HOST)
// All three carry the pid. What the gate's answers depend on is the PREFIX — writable
// ancestor under /tmp, root-owned tree under /opt, untraversable 0700 root tree under
// /root — so the suffix costs the section none of its subject, while the shared names
// cost it everything: the setup below is a `set -e` script whose `rm -rf`/`mkdir`/`install`
// sequence a concurrent run's identical sequence interleaves with, and the
// whole fixture table then skips on a fixture that was half-built rather than unbuildable.
const FIXTURE_USER_TREE = `/tmp/dsh-wsl-helper-fixtures-${runSuffix}`
const FIXTURE_ROOT_TREE = `/opt/dsh-wsl-helper-fixtures-${runSuffix}`
const FIXTURE_PRIVATE_TREE = `/root/dsh-wsl-helper-fixtures-${runSuffix}`
// A version the detector cannot accept, DERIVED from the current one so it can never
// become it: a literal would silently turn into the current version the day
// HELPER_VERSION moved to that string, and the row would then fail on a correct helper.
const FIXTURE_STALE_VERSION = 'dsh-wsl-confine ' + HELPER_VERSION + '-stale'
const userCopyPath = FIXTURE_USER_TREE + '/user-copy'
const rootInUserDirPath = FIXTURE_USER_TREE + '/root-in-userdir'
const root0777Path = FIXTURE_USER_TREE + '/root-0777'
const keep0755Path = FIXTURE_ROOT_TREE + '/keep-0755'
const mode0700Path = FIXTURE_ROOT_TREE + '/mode-0700'
const mode0775Path = FIXTURE_ROOT_TREE + '/mode-0775'
const user0555Path = FIXTURE_ROOT_TREE + '/user-0555'
const stale0755Path = FIXTURE_ROOT_TREE + '/stale-0755'
const privateKeepPath = FIXTURE_PRIVATE_TREE + '/keep-0755'
const absentPath = FIXTURE_ROOT_TREE + '/absent'
// The two shapes the gate's doc promises and the table had no row for: a DIRECTORY at the
// grant path (a root:root 0755 directory satisfies -x, uid 0, no write bits and every
// ancestor test, so only the type test refuses it) and a root-owned SYMLINK to an
// acceptable file.
const dirHelperPath = FIXTURE_ROOT_TREE + '/dir-helper'
const linkToFile = FIXTURE_ROOT_TREE + '/link-to-file'
// The symlinked ANCESTOR pair. The walk tests each LEXICAL component with '[ -w ]', which
// FOLLOWS a symlink, so a link into a writable tree must refuse and a link into a
// root-owned 0755 tree must not: the pair is what isolates "the walk sees through the
// component" from "the component is a link".
const linkIntoWritable = FIXTURE_ROOT_TREE + '/linkdir'
const linkIntoSafe = FIXTURE_ROOT_TREE + '/linkdir-safe'
const safeTreeDir = FIXTURE_ROOT_TREE + '/safe-tree'
const viaWritableLink = linkIntoWritable + '/root-in-userdir'
const viaSafeLink = linkIntoSafe + '/keep-0755'
/**
 * Every fixture the gate is asked about, and the ownership answer it must give.
 * The third element is a clause: the labels below read "the ownership gate <clause>".
 */
const FIXTURE_CASES = [
  [userCopyPath, 'no', 'refuses a session-user-owned copy under /tmp'],
  [rootInUserDirPath, 'no', 'refuses a root-owned copy under a writable ancestor'],
  [root0777Path, 'no', 'refuses a group/other-writable copy on its mode bits'],
  [user0555Path, 'no', 'refuses a session-user-OWNED 0555 file even though nothing about it is writable (the owner can chmod it back)'],
  [mode0775Path, 'no', 'refuses a root-owned 0775 file (the session user is not in group root, so [ -w ] alone would pass it)'],
  [mode0700Path, 'no', 'refuses a root-owned 0700 file (the pre-existing execute-bit rule)'],
  [privateKeepPath, 'no', 'refuses a 0755 root file the session user cannot even traverse'],
  [dirHelperPath, 'no', 'refuses a DIRECTORY at the grant path (only the type test refuses it: -x, uid 0 and the mode bits all pass for a directory)'],
  [linkToFile, 'no', 'refuses a root-owned SYMLINK to an acceptable file (the grant names a path, so the link is part of the trust decision)'],
  [viaWritableLink, 'no', 'refuses a helper reached through a symlinked ancestor that resolves into a writable tree (the walk follows the component)'],
  [viaSafeLink, 'yes', 'accepts a helper reached through a symlinked ancestor that resolves into a root-owned 0755 tree (the refusal above is the target, not the link)'],
  [stale0755Path, 'yes', 'accepts a stale-version copy (the version half is a separate pin)'],
  [keep0755Path, 'yes', 'accepts a root-owned 0755 file in a root-owned tree'],
  [absentPath, 'no', 'refuses a path that does not exist'],
]
const OWNERSHIP_LABELS = FIXTURE_CASES.map(([, , clause]) => 'the ownership gate ' + clause)
const SELECTION_REFUSAL_LABELS = FIXTURE_CASES.filter(([, want]) => want === 'no')
  .map(([, , clause]) => 'the selection probe ' + clause)
/** The two selection rows whose version half has to reach a fixture path through sudo. */
const SELECTION_GRANTED_LABELS = [
  'the selection probe accepts a root-owned 0755 file in a root-owned tree',
  'the selection probe refuses a stale version even though its ownership half passes',
]
const FIXTURE_LABELS = [...OWNERSHIP_LABELS, ...SELECTION_REFUSAL_LABELS, ...SELECTION_GRANTED_LABELS]
const FIXTURE_SETUP = [
  'set -e',
  'rm -rf ' + FIXTURE_USER_TREE,
  'sudo -n rm -rf ' + FIXTURE_ROOT_TREE + ' ' + FIXTURE_PRIVATE_TREE,
  'mkdir -p ' + FIXTURE_USER_TREE,
  'cp ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + userCopyPath + ' && chmod 0755 ' + userCopyPath,
  'sudo -n install -m 0755 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + rootInUserDirPath,
  'sudo -n install -m 0777 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + root0777Path,
  'sudo -n mkdir -p ' + FIXTURE_ROOT_TREE + ' ' + FIXTURE_PRIVATE_TREE,
  'sudo -n chmod 0755 ' + FIXTURE_ROOT_TREE,
  'sudo -n chmod 0700 ' + FIXTURE_PRIVATE_TREE,
  'sudo -n install -m 0755 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + keep0755Path,
  'sudo -n install -m 0700 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + mode0700Path,
  'sudo -n install -m 0775 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + mode0775Path,
  'sudo -n install -m 0555 -o $(id -un) -g $(id -gn) ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + user0555Path,
  'sudo -n install -m 0755 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + privateKeepPath,
  // The type shape: a root:root 0755 DIRECTORY at a grant path. Every other test passes for
  // it (-x, uid 0, 755 has no write bits, no writable ancestor), so only '[ -f ]' refuses it.
  'sudo -n mkdir -p ' + dirHelperPath + ' && sudo -n chmod 0755 ' + dirHelperPath,
  // The link shape: a root-owned symlink whose target IS an acceptable file.
  'sudo -n ln -s ' + keep0755Path + ' ' + linkToFile,
  // The symlinked-ancestor pair: one link into the writable user tree, one into a root-owned
  // 0755 tree that carries its own root:root 0755 file.
  'sudo -n mkdir -p ' + safeTreeDir + ' && sudo -n chmod 0755 ' + safeTreeDir,
  // The file goes to its REAL path first: the link is created after it, so the install
  // cannot fail on a directory the setup has not made yet (measured: 'install: cannot
  // create regular file .../linkdir-safe/keep-0755: No such file or directory').
  'sudo -n install -m 0755 -o root -g root ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + safeTreeDir + '/keep-0755',
  'sudo -n ln -s ' + safeTreeDir + ' ' + linkIntoSafe,
  'sudo -n ln -s ' + FIXTURE_USER_TREE + ' ' + linkIntoWritable,
  'sudo -n cp ' + shellQuote(FIXTURE_SOURCE_MNT) + ' ' + FIXTURE_USER_TREE + '/stale.sh',
  "sudo -n sed -i " + shellQuote("s/^VERSION=.*$/VERSION='" + FIXTURE_STALE_VERSION + "'/") + ' ' + FIXTURE_USER_TREE + '/stale.sh',
  'sudo -n install -m 0755 -o root -g root ' + FIXTURE_USER_TREE + '/stale.sh ' + stale0755Path,
  'rm -f ' + FIXTURE_USER_TREE + '/stale.sh',
  'for p in ' + [userCopyPath, rootInUserDirPath, root0777Path, keep0755Path, mode0700Path, mode0775Path, user0555Path, privateKeepPath, stale0755Path, dirHelperPath, linkToFile, linkIntoWritable, linkIntoSafe, viaSafeLink].join(' ') + '; do sudo -n stat -c "%u:%a %n" "$p"; done',
  'echo fixtures-ok',
].join('\n')
const FIXTURE_CLEANUP = 'sudo -n rm -rf ' + FIXTURE_ROOT_TREE + ' ' + FIXTURE_PRIVATE_TREE + '; rm -rf ' + FIXTURE_USER_TREE
/**
 * The answer one probe script gives: the gate prints exactly one word, yes or no.
 *
 * A third outcome is possible and is NOT an answer. `wsl.exe` itself can fail —
 * the same transient `resolveDistroHome` retries for (measured there once in six
 * full runs) — which leaves stdout empty, and that reads exactly like "the gate
 * answered something else". An inconclusive answer is retried ONCE, the ruling the
 * identity and runner probes already follow; a script that never answers still
 * fails its row, with the second answer as the evidence.
 * @param {string} scriptText - the gate script.
 * @returns {Promise<string>} the gate's answer, 'yes' or 'no' when it answered at all.
 */
async function fixtureAnswer(scriptText) {
  const ask = async () => (await runWslShell({ distro, linuxCwd: '/', command: scriptText, loginShell: false, timeoutMs: 60_000 })).stdout.trim()
  const first = await ask()
  if (first === 'yes' || first === 'no') return first
  await new Promise((resolve) => { setTimeout(resolve, 500) })
  return await ask()
}
/**
 * The version a fixture's helper reports, through the grant.
 *
 * Retried only when it answered NOTHING — a transient `wsl.exe` failure — never when
 * it answered a version: a grant that does not cover the path answers nothing here, and
 * that is the measured premise the accept rows are gated on.
 * @param {string} path - the fixture path.
 * @returns {Promise<string>} the reported version, or '' when sudo did not run it.
 */
async function fixtureVersion(path) {
  const ask = async () => (await runWslShell({ distro, linuxCwd: '/', command: 'sudo -n ' + shellQuote(path) + ' --version 2>/dev/null', loginShell: false, timeoutMs: 60_000 })).stdout.trim()
  const first = await ask()
  if (first !== '') return first
  await new Promise((resolve) => { setTimeout(resolve, 500) })
  return await ask()
}
/** The first non-empty line of a command's stderr, for a precondition that stays readable. */
const firstLine = (text) => (text.trim().split('\n').find((line) => line.trim() !== '') ?? '').trim()
if (FIXTURE_SOURCE_MNT === null) {
  skip(FIXTURE_LABELS,
    'the host temp directory has no /mnt spelling (' + FIXTURE_SOURCE_HOST + ')',
    'run the suite on the host, whose temp directory is a drive path the distribution mounts, or copy the shipped helper into the distribution by hand')
} else {
  const setupResult = await runWslShell({ distro, linuxCwd: '/', command: FIXTURE_SETUP, loginShell: false, timeoutMs: 120_000 })
  if (!setupResult.stdout.includes('fixtures-ok')) {
    // The fixtures need a grant that can create root-owned files under /opt and
    // /root — a machine class, not a defect. The precondition names what the setup
    // itself answered, so the skip cannot send the operator after the wrong thing.
    skip(FIXTURE_LABELS,
      'the fixtures could not be built in the distribution (setup exit ' + setupResult.exitCode + ': ' + firstLine(setupResult.stderr) + ')',
      'this section needs a sudo grant that can create root-owned files in /opt and /root (sudo -n -l); grant it, or run the suite where the grant is (ALL) NOPASSWD: ALL')
  } else {
    // The premise the gate's answers are only meaningful against: a fixture that
    // silently failed to get its owner or mode would make the rows below pass for the
    // wrong reason, and the fixture set itself is where that class of gap was found.
    const fixtureStats = new Map()
    for (const line of setupResult.stdout.trim().split('\n')) {
      const match = /^(\d+):(\w+) (.+)$/.exec(line.trim())
      if (match !== null) fixtureStats.set(match[3], match[1] + ':' + match[2])
    }
    const uid = identity?.uid ?? '?'
    const expectedStats = [
      [userCopyPath, uid + ':755'],
      [rootInUserDirPath, '0:755'],
      [root0777Path, '0:777'],
      [user0555Path, uid + ':555'],
      [keep0755Path, '0:755'],
      [mode0700Path, '0:700'],
      [mode0775Path, '0:775'],
      [privateKeepPath, '0:755'],
      [stale0755Path, '0:755'],
      // The new shapes' own premise: the directory is a root-owned 0755 DIRECTORY, the two
      // links are root-owned symlinks (stat does not follow, so 777 is the LINK's mode), and
      // the file behind the safe link is a regular root:root 0755. Without this row a missing
      // fixture would answer "no" to the refusal rows and they would pass vacuously.
      [dirHelperPath, '0:755'],
      [linkToFile, '0:777'],
      [linkIntoWritable, '0:777'],
      [linkIntoSafe, '0:777'],
      [viaSafeLink, '0:755'],
    ]
    check('the fixtures carry the owner and mode the gate is asked about (uid:mode)',
      expectedStats.every(([path, want]) => fixtureStats.get(path) === want),
      { expected: expectedStats.map(([path, want]) => path + ' want ' + want + ' got ' + String(fixtureStats.get(path))), stderr: firstLine(setupResult.stderr) })
    for (const [path, wantOwnership, clause] of FIXTURE_CASES) {
      const gotOwnership = await fixtureAnswer(helperOwnershipScript(path))
      check('the ownership gate ' + clause, gotOwnership === wantOwnership, { path, want: wantOwnership, got: gotOwnership })
      // The refusal cases never reach sudo: the gate refuses FIRST, which is the
      // property the finding is about. They are therefore measurable under any grant.
      if (wantOwnership === 'no') {
        const gotSelection = await fixtureAnswer(helperSelectionScript(path))
        check('the selection probe ' + clause, gotSelection === 'no', { path, got: gotSelection })
      }
    }
    // The accept side of the FULL probe has to reach a fixture path through sudo,
    // and a sudoers file narrowed to the installed helper (what the README
    // recommends) does not cover the fixture tree. The premise is measured, not
    // assumed: where it holds both rows run, and where it does not they are counted
    // skips rather than rows that would pass or fail for the wrong reason.
    const grantProbe = await fixtureVersion(keep0755Path)
    if (grantProbe === 'dsh-wsl-confine ' + HELPER_VERSION) {
      check(SELECTION_GRANTED_LABELS[0], await fixtureAnswer(helperSelectionScript(keep0755Path)) === 'yes', { path: keep0755Path })
      const staleAnswer = await fixtureVersion(stale0755Path)
      const staleSelection = await fixtureAnswer(helperSelectionScript(stale0755Path))
      check(SELECTION_GRANTED_LABELS[1],
        staleAnswer === FIXTURE_STALE_VERSION && staleSelection === 'no',
        { path: stale0755Path, reportedVersion: staleAnswer, wanted: FIXTURE_STALE_VERSION, selection: staleSelection })
    } else {
      skip(SELECTION_GRANTED_LABELS,
        'the sudoers grant does not cover the fixture tree (sudo -n <fixture> --version answered ' + JSON.stringify(grantProbe) + ')',
        'add a NOPASSWD grant for the fixture path, or run this suite where the grant is (ALL) NOPASSWD: ALL')
    }
    // The same two properties on the deployment's OWN helper: the file the grant
    // names must be accepted, or the hardened runner could never be selected. No
    // skip is recorded when the detected runner is the direct path — there is no
    // installed helper then, so no check is missing (the ruling the drift check
    // above states for the same branch).
    if (runner === RUNNER_HELPER) {
      check('the ownership gate accepts the installed helper', await fixtureAnswer(helperOwnershipScript(HELPER_PATH)) === 'yes', { path: HELPER_PATH })
      check('the selection probe accepts the installed helper', await fixtureAnswer(helperSelectionScript(HELPER_PATH)) === 'yes', { path: HELPER_PATH })
    }
  }
  // The structural half of the same finding: sudo must sit AFTER the gate, so a
  // path the session user can replace never reaches it. Anchored on the gate's OWN
  // text (everything before its final echo) rather than on a line that a rewrite
  // would remove, so the ordering assertion cannot pass vacuously on a gate whose
  // anchor line is gone.
  const ownershipText = helperOwnershipScript(HELPER_PATH)
  const gateBody = ownershipText.slice(0, ownershipText.lastIndexOf('echo "$ok"'))
  const selectionText = helperSelectionScript(HELPER_PATH)
  const sudoAt = selectionText.indexOf('sudo -n')
  check('the ownership gate never invokes sudo (its answer holds under a narrowed grant)',
    gateBody.length > 0 && !/sudo/.test(gateBody), { gate: ownershipText })
  check('the full probe asks sudo only AFTER the gate, so a replaceable path never reaches it',
    sudoAt > gateBody.length, { sudoAt, gateLength: gateBody.length })
  check('both version fixtures are judged by the same gate text (only the path differs)',
    helperSelectionScript(HELPER_PATH).split(shellQuote(HELPER_PATH)).join('PATH') === helperSelectionScript(keep0755Path).split(shellQuote(keep0755Path)).join('PATH'))
  const fixtureCleanup = await runWslShell({ distro, linuxCwd: '/', command: FIXTURE_CLEANUP + '; ls -d ' + FIXTURE_ROOT_TREE + ' ' + FIXTURE_PRIVATE_TREE + ' ' + FIXTURE_USER_TREE + ' 2>/dev/null; echo cleaned', loginShell: false, timeoutMs: 60_000 })
  check('the fixture trees are removed again (nothing is left in the distribution)',
    fixtureCleanup.stdout.trim() === 'cleaned', { stdout: fixtureCleanup.stdout.trim(), stderr: firstLine(fixtureCleanup.stderr) })
}
rmSync(FIXTURE_SOURCE_DIR, { recursive: true, force: true })
// Every fixture this suite creates is removed again, and quoted: two of them
// carry spaces and ERE metacharacters — which is the point of the sections
// above — so an unquoted rm would either miss them or be re-parsed.
await runWslShell({ distro, linuxCwd: '/', command: `rm -rf ${shellQuote(probeRoot)} ${shellQuote(spacedRoot)} ${shellQuote(metaRoot)} ${shellQuote(forbiddenPath)} /tmp/dsh-wsl-tmp-${runSuffix}.txt` })
// A skip is a check that did not run, and reporting it as a pass would make this
// suite's green meaningless exactly where the shipped helper is the subject: exit
// 2 is what verify-all renders as SKIP (the sibling suites' ruling, applied here).
if (failures > 0) console.log(`\n${failures} CHECK(S) FAILED${skipped === 0 ? '' : `, ${skipped} CHECK(S) SKIPPED`}`)
else if (skipped > 0) console.log(`\nEVERY CHECK THAT COULD RUN PASSED, ${skipped} CHECK(S) SKIPPED — exit 2, so verify-all reports this suite as SKIP`)
else console.log('\nALL CHECKS PASSED')
process.exitCode = failures > 0 ? 1 : skipped > 0 ? 2 : 0
