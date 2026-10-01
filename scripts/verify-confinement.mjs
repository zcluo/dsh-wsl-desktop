/**
 * Verify WSL-side confinement against the real distribution.
 *
 * Runs the same command the executor builds (`buildConfinedCommand` through
 * `runWslShell`) and asserts the fence actually holds: the workspace is
 * writable, everything else on the read-only root is not, and files created
 * inside the namespace belong to the session user rather than root.
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
check('the helper has no missing-semicolon brace groups', !/exit 2 \}/.test(helperSource), 'found `exit 2 }` — the brace group stays open and bash aborts at EOF')
check('the fence receives its parameters as environment variables',
  helperSource.includes('DROP_UID="$uid"') && helperSource.includes('--reuid="$DROP_UID"'),
  'params must cross into `bash -c` via env(1); bare KEY=VALUE words are positional parameters, and $UID is a bash built-in')
check('the exec tail passes env before the fence script',
  /env \\\n\s+DROP_UID=/.test(helperSource) && !/bash -c "\$FENCE" \\\n\s+dsh-wsl-confine \\\n\s+UID=/.test(helperSource), null)
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
  'the sudoers grant is argument-wildcarded; an unchecked --uid lets the session user run the helper as uid 0 (a root-read primitive)')
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    console.log('  SKIP  bash -n parse gate (helper not on a drive path)')
  } else {
    const parse = await runWslShell({ distro, linuxCwd: '/', command: `bash -n ${shellQuote(mnt)} && echo PARSE-OK`, loginShell: false, timeoutMs: 60_000 })
    check('the helper parses under bash -n', parse.stdout.includes('PARSE-OK'), parse.stderr)
  }
}
// A REAL invocation of the shipped helper, unprivileged and without sudo: the
// argument validation runs before anything privileged, so the refusal is
// deterministic and needs no grant. The LF is materialized INSIDE the
// distribution by printf, so the value crosses wsl.exe as plain text.
{
  const mnt = windowsToMntPath(helperPathFile)
  if (mnt === null) {
    console.log('  SKIP  the shipped helper refuses a control character in --workspace (helper not on a drive path)')
  } else {
    const refusal = await runWslShell({
      distro,
      linuxCwd: '/',
      command: `ws=$(printf '/home/u/proj/x\\n/mnt/c'); bash ${shellQuote(mnt)} --uid 1000 --gid 1000 --home /home/u --cwd / --workspace "$ws" -- true; echo EXIT=$?`,
      loginShell: false,
      timeoutMs: 60_000,
    })
    check('the shipped helper exits 2 on a control character in --workspace',
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
if (runner === RUNNER_HELPER) {
  const helperMnt = windowsToMntPath(helperPathFile)
  if (helperMnt === null) {
    // The same condition the bash -n gate above SKIPs on: the checkout is not on
    // a drive path (it lives inside a distribution), so the shipped file has no
    // /mnt spelling to compare against. Failing here told the operator to
    // reinstall a byte-identical helper.
    console.log('  SKIP  the installed helper is the helper this package ships (helper not on a drive path)')
  } else {
    const sums = await runWslShell({ distro, linuxCwd: '/', command: `md5sum ${shellQuote(HELPER_PATH)} ${shellQuote(helperMnt)} 2>/dev/null`, loginShell: false, timeoutMs: 60_000 })
    const [installedSum, shippedSum] = sums.stdout.trim().split('\n').map((line) => line.split(/\s+/)[0])
    check('the installed helper is the helper this package ships',
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
// anything still writable". `test -w` answers it without writing anything.
const mounts = await confined(
  'findmnt -rno TARGET,OPTIONS | grep -E "^(/|/mnt/[a-z]|/dev/shm|/run/user)" | head -20; echo ---;'
  + ' for p in / /mnt/c /dev/shm "/run/user/$(id -u)"; do printf "%s %s\\n" "$p" "$([ -w "$p" ] && echo WRITABLE || echo READONLY)"; done',
  { mode: 'workspace-write', workspaceLinuxRoot: probeRoot },
)
console.log(mounts.result.stdout.trim().split('\n').map((line) => `        ${line}`).join('\n'))
check('the root filesystem is read-only', /^\/ READONLY$/m.test(mounts.result.stdout), mounts.result.stdout)
check('the Windows filesystem is not writable', /^\/mnt\/c READONLY$/m.test(mounts.result.stdout), mounts.result.stdout)
check('shared memory is not writable', /^\/dev\/shm READONLY$/m.test(mounts.result.stdout), mounts.result.stdout)
check('the session runtime directory is not writable',
  /^\/run\/user\/\d+ READONLY$/m.test(mounts.result.stdout), mounts.result.stdout)

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
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1