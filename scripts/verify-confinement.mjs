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
  RUNNER_HELPER,
  buildConfinedCommand,
  detectRunner,
  resetConfinementCache,
  resolveIdentity,
} from '../lib/wsl/confinement.js'
import { shellQuote, windowsToMntPath } from '../lib/wsl/paths.js'
import { resolveDistro, resolveLinuxHome } from './env.mjs'

const distro = resolveDistro(process.argv[2])
const home = resolveLinuxHome()
const run = (options) => runWslShell(options)

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

/** Run one command through the confinement wrapper. */
async function confined(command, { mode, workspaceLinuxRoot, linuxCwd = '/' }) {
  const identity = await resolveIdentity({ distro, run }).catch((error) => {
    console.log(`        identity probe error: ${error.message}`)
    return null
  })
  if (identity === null) throw new Error('无法解析发行版内的用户身份')
  const wrapped = buildConfinedCommand({ command, linuxCwd, mode, workspaceLinuxRoot, identity })
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
check('the helper has no missing-semicolon brace groups', !/exit 2 \}/.test(helperSource), 'found `exit 2 }` — the brace group stays open and bash aborts at EOF')
check('the fence receives its parameters as environment variables',
  helperSource.includes('DROP_UID="$uid"') && helperSource.includes('--reuid="$DROP_UID"'),
  'params must cross into `bash -c` via env(1); bare KEY=VALUE words are positional parameters, and $UID is a bash built-in')
check('the exec tail passes env before the fence script',
  /env \\\n\s+DROP_UID=/.test(helperSource) && !/bash -c "\$FENCE" \\\n\s+dsh-wsl-confine \\\n\s+UID=/.test(helperSource), null)
check('the exemption grep anchors only at the group end',
  helperSource.includes('|/dev|/proc|/sys)\\$') && !/\|\/sys\$"/.test(helperSource),
  'the shipped `/sys$")$"` tail is a bash parse error: closing paren outside the string plus a `$"` locale-quote')
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
const helperIdentity = { uid: '1000', gid: '1000', home: '/home/tester', name: 'tester' }
const helperReadOnly = buildConfinedCommand({ command: 'true', linuxCwd: '/ws', mode: 'read-only', runner: RUNNER_HELPER, workspaceLinuxRoot: '/ws', identity: helperIdentity })
check('read-only never grants the helper a writable workspace', !helperReadOnly.includes('--workspace'), helperReadOnly)
const helperWrite = buildConfinedCommand({ command: 'true', linuxCwd: '/ws', mode: 'workspace-write', runner: RUNNER_HELPER, workspaceLinuxRoot: '/ws', identity: helperIdentity })
check('workspace-write routes through the helper with the workspace bound',
  helperWrite.includes('--workspace') && helperWrite.includes(HELPER_PATH), helperWrite)

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
let detectionRetried = runner !== 'sudo-unshare'
if (detectionRetried) {
  await new Promise((resolve) => { setTimeout(resolve, 1000) })
  runner = await detectOnce()
}
check('a confinement runner is available', runner === 'sudo-unshare',
  `${String(runner)}${detectionRetried ? ' (first attempt failed; retried once)' : ''}`)
const identity = await resolveIdentity({ distro, run })
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
const spacedMountWrite = await confined(`echo written > "${spacedMount}/dsh-wsl-escape.txt" && echo SPACED-MOUNT-OK`, { mode: 'read-only' })
check('a write into a spaced mount target is denied under its REAL path',
  !spacedMountWrite.result.stdout.includes('SPACED-MOUNT-OK') && DENIAL_SIGNATURES.some((signature) => spacedMountWrite.result.stderr.includes(signature)),
  `${spacedMountWrite.result.exitCode} ${spacedMountWrite.result.stderr}`)
const spacedMountState = await runWslShell({ distro, linuxCwd: '/', command: `findmnt -rno OPTIONS "${spacedMount}" | head -1` })
check('the spaced mount target was remounted read-only', spacedMountState.stdout.includes('ro'), spacedMountState.stdout)
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

await runWslShell({ distro, linuxCwd: '/', command: `rm -rf ${probeRoot} ${home}/dsh-wsl-forbidden.txt /tmp/dsh-wsl-tmp.txt` })
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
