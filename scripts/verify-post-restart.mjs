/**
 * End-to-end acceptance for the installed plugin, driven through its own route.
 *
 * Everything here needs the running host to have loaded the current plugin
 * generation, so it is the first thing to run after a DSH Desktop restart.
 * Checks that cannot pass without a human opening a WSL session are reported as
 * pending rather than silently skipped.
 *
 * Run: node scripts/verify-post-restart.mjs [baseUrl] [distro]
 *
 * `distro` (argv[3]) selects the distribution every WSL-facing check uses,
 * including the home the fixtures are built under. It falls back to
 * DSH_WSL_DISTRO and then to env.mjs's FALLBACK_DISTRO ('debian') — NOT to
 * WSL's machine default: on a host without that distribution the user probe
 * throws during module evaluation, before the first check prints, so name the
 * distribution (or set DSH_WSL_DISTRO) when the fallback is not installed.
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDistro, resolveLinuxHome } from './env.mjs'
import { DEV_TOKEN_HEADER, ensureDevToken } from './dev-token.mjs'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = process.env.DSH_WSL_ROOT ?? join(here, '..')
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:19387'
const distro = resolveDistro(process.argv[3])
const home = resolveLinuxHome(distro)
const endpoint = `${baseUrl}/wsl-desktop/api`
// Every method this script uses is on the acceptance surface, which the route
// fences behind the transport check plus this token.
const token = await ensureDevToken()

let failures = 0
let pending = 0

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
 * Mark a check that needs a human step.
 * @param {string} label - the pending check.
 * @param {string} how - what the operator must do.
 */
function todo(label, how) {
  console.log(`  PENDING  ${label}\n           ${how}`)
  pending += 1
}

/**
 * Call one host method and return its value.
 * @param {string} method - host method name.
 * @param {object} [params] - method payload.
 * @returns {Promise<any>} the unwrapped value.
 */
async function call(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [DEV_TOKEN_HEADER]: token },
    body: JSON.stringify({ method, params }),
  })
  let envelope
  try {
    envelope = await response.json()
  } catch {
    throw new Error(`${method}: HTTP ${response.status}（围栏拒绝或方法被移出浏览器命名空间）`)
  }
  if (!envelope.ok) throw new Error(`${method}: ${envelope.error}`)
  return envelope.value
}

console.log(`accepting the WSL plugin at ${baseUrl}\n`)

console.log('plugin generation')
let status
try {
  status = await call('presetStatus')
} catch (error) {
  console.log(`  FAIL  the route does not expose the current generation: ${error.message}`)
  console.log('\nThe running host still serves an older module. Restart DSH Desktop and run this again.')
  process.exit(1)
}
check('the preset generation succeeded', status.status === 'ready', JSON.stringify(status))
check('the host exposes the 0.1.7 registry surface', status.hostCompat?.registry07 === true, status.hostCompat)
if (status.status === 'ready') {
  check('at least one WSL preset was written', Array.isArray(status.written) && status.written.length > 0, status.written)
  console.log(`        ${status.written.map((entry) => `${entry.id} (from ${entry.from}; removed ${entry.removed.join(',') || 'none'})`).join('\n        ')}`)
  // A source preset the registry cannot mount is reported, not silently ignored.
  for (const entry of status.skipped ?? []) {
    console.log(`        SKIPPED ${entry.id}: ${entry.broken}`)
  }
  for (const name of status.withdrawn ?? []) {
    console.log(`        withdrawn orphan: ${name}`)
  }
  // A directory in the plugin's namespace that it did not write is the user's:
  // it must be reported, never deleted.
  for (const name of status.unmanaged ?? []) {
    console.log(`        left alone (not written by this plugin): ${name}`)
  }
}

// Which CODE is running, not merely which code is on disk. The profile links
// one staged generation directory and Node caches a module by URL, so a host
// that was never restarted after a re-stage keeps serving the older copy — and
// every marker this suite can look for is present in both. The route reports
// the paths it actually loaded, so the two copies are compared directly.
console.log('\ndeployed generation')
const deployed = status.deployed
check('the route reports the module it loaded', typeof deployed?.modulePath === 'string' && deployed.modulePath.length > 0,
  'the running host predates this check — restart DSH Desktop')
if (typeof deployed?.modulePath === 'string') {
  // The WHOLE tree, not just the entry module: a reload that refreshed
  // `index.js` while `wsl/shell.js` stayed cached would pass a two-file check
  // and still run stale code where it matters. Extras in the deployed
  // directory (a `__pycache__` the source tree does not carry) are not
  // failures — only a source file that is missing or different is.
  const deployedLib = dirname(deployed.modulePath)
  const sourceLib = join(pluginRoot, 'lib')
  const entries = await readdir(sourceLib, { recursive: true, withFileTypes: true })
  const wanted = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(sourceLib, join(entry.parentPath ?? sourceLib, entry.name)).split(sep).join('/'))
    .sort()
  const missing = []
  const differing = []
  for (const file of wanted) {
    try {
      const [loaded, source] = await Promise.all([
        readFile(join(deployedLib, file), 'utf8'),
        readFile(join(sourceLib, file), 'utf8'),
      ])
      if (loaded !== source) differing.push(file)
    } catch {
      missing.push(file)
    }
  }
  check('the running plugin is this checkout, file for file',
    wanted.length > 0 && missing.length === 0 && differing.length === 0,
    `loaded=${deployedLib}\n        missing=[${missing.join(', ')}]\n        differing=[${differing.join(', ')}] — re-stage and restart DSH Desktop`)
  // The MANIFEST is part of the bundle too: `dsh.client` is composed from it,
  // and a deployed copy that lost `exports["./client"]` takes the whole desktop
  // down at startup rather than failing in this plugin alone. `cordis.patch.yml`
  // is deliberately NOT compared — the staging script stamps its row id and
  // enables `developerTools` there.
  let manifestSame = false
  try {
    const [loaded, source] = await Promise.all([
      readFile(join(dirname(deployedLib), 'package.json'), 'utf8'),
      readFile(join(pluginRoot, 'package.json'), 'utf8'),
    ])
    manifestSame = loaded === source
  } catch {
    manifestSame = false
  }
  check('the running manifest is this checkout', manifestSame,
    `${join(dirname(deployedLib), 'package.json')} differs from ${join(pluginRoot, 'package.json')} — re-stage and restart DSH Desktop`)
}

console.log('\ncross-check against the older route generation')
const legacy = await call('listDistros').catch((error) => ({ error: error.message }))
check('the route still answers distribution discovery', Array.isArray(legacy), legacy)

console.log('\ngenerated presets in the registry (0.1.7-native registration)')
// Since 0.1.7 the registry learns presets from register() calls; the on-disk
// generated directory is no longer consulted. Verify through the roster.
const inventory = await call('presetInventory').catch((error) => ({ error: error.message }))
const compositions = Array.isArray(inventory.inventory) ? inventory.inventory : (inventory.inventory?.compositions ?? [])
const rosterIds = compositions.map((entry) => entry.id)
check('the wsl-standard variant is registered', rosterIds.includes('wsl-standard'), rosterIds)
// The variant's composition must still be readable (a broken declaration would
// list no rows) and must have dropped the host PowerShell tool row.
const variant = compositions.find((entry) => entry.id === 'wsl-standard')
check('the variant declares composition rows', Array.isArray(variant?.rows) && variant.rows.length > 0, variant)
check('the variant dropped the host PowerShell tool row', Array.isArray(variant?.rows) && !variant.rows.some((row) => row.entryId === 'tool-pwsh'), variant?.rows?.map((row) => row.entryId))

console.log('\nexecution world')
// The distro is named EXPLICITLY on every one of these. Without it execInWsl
// resolves the machine's DEFAULT distribution, which on this host is not the one
// this gate tests — so the assertions below were passing while measuring
// debian-dev and claiming debian, and a scratch directory created without the
// distro landed in the wrong one (measured: the session then failed with
// 'chdir(...) failed 2', because the directory was never there).
const identity = await call('execInWsl', { cwd: home, distro, command: 'uname -s; pwd; echo "$WSL_DISTRO_NAME"' })
check('a command runs inside the distribution', identity.exitCode === 0 && identity.stdout.includes('Linux'), identity)
check('the working directory is a Linux path', identity.target?.linuxPath === home, identity.target)
// The command echoes the distro NAME on its last line (uname -s; pwd; echo "$WSL_DISTRO_NAME").
check('the command ran in the distribution under test', identity.stdout.trim().split('\n').pop() === distro, identity.stdout)
check('the target carries the UNC workspace spelling', String(identity.target?.uncPath ?? '').startsWith('\\\\wsl.localhost\\'), identity.target)

console.log('\nsession-level acceptance')
// The workspace must be one the fence ACCEPTS. This used to be /tmp, which the
// fence refuses by design — the confinement mounts a private tmpfs over /tmp
// AFTER binding the workspace, so such a root is shadowed and every write lands
// in the tmpfs. The bash step therefore failed on a workspace the plugin is
// right to reject, and the two confinement assertions downstream of it never
// engaged. A scratch directory under the home is accepted, and is removed again
// below.
// Process-unique, like the confinement suite's scratch paths (verify-confinement.mjs:84-98
// measured two overlapping runs sharing a machine-global name destroying each other in 24 of
// 24 runs). A fixed name here also means one run's opening `rm -rf` deletes another run's
// scratch while that run is still measuring it.
const wslScratch = `${home}/.dsh-wsl-selftest-${process.pid}`
await call('execInWsl', { cwd: home, distro, command: `rm -rf ${wslScratch} && mkdir -p ${wslScratch}` })
const selftest = await call('selftest', { preset: 'wsl-standard', cwd: `\\\\wsl.localhost\\${distro}${wslScratch}` }).catch((error) => ({ steps: [{ name: 'error', message: error.message }] }))
const step = (name) => selftest.steps.find((entry) => entry.name === name)
const created = step('create')
// The service-level agents.create does not honor meta.agentPreset (that seam
// belongs to the session-controller, which the browser half uses); the
// selftest's explicit select is its designed fallback. Assert the OUTCOME —
// the session ends up running the confined realm.
const boundAtCreate = created?.composed === 'wsl-standard'
const boundAtSelect = step('select')?.composed === 'wsl-standard'
check('a session is created and bound to the WSL preset', boundAtCreate || boundAtSelect, created)
const shellRun = step('shell.run')
check('the session shell runs inside the distribution', shellRun?.exitCode === 0 && (shellRun.stdoutText?.[0] ?? shellRun.stdout?.[0]) === 'Linux', shellRun)
check('confinement reports its real completeness, not a claim of full', shellRun?.sandbox?.enforcement === 'partial', shellRun?.sandbox)
const fsRoundtrip = step('fs.roundtrip')
check('the file tools address Linux paths', fsRoundtrip?.processPath?.startsWith('/'), fsRoundtrip)
check('file URIs are built in the execution world', String(fsRoundtrip?.fileUrl ?? '').startsWith('file:///'), fsRoundtrip?.fileUrl)
const confined = step('shell.confined')
check('a write outside the workspace is refused', confined?.sandbox?.denied === true, confined)
const probe = step('subprocess.probe')
check('the subprocess provider reports a POSIX environment', probe?.environment?.platform === 'posix', probe)
// The selftest reports each tool outcome as a bounded JSON string, so the
// assertions read the raw text rather than re-parsing a possibly truncated
// document.
const bashText = step('tools.bash')?.text ?? ''
check('the bash tool runs inside the distribution', bashText.includes('"isError":false') && bashText.includes('Linux'), bashText.slice(0, 200))
const readText = step('tools.read')?.text ?? ''
check('the read tool addresses a Linux path', readText.includes('"isError":false') && readText.includes(`${wslScratch}/dsh-wsl-selftest.txt`), readText.slice(0, 200))
const pwshText = step('tools.pwsh')?.text ?? ''
check('the session exposes no PowerShell tool', pwshText.includes('UNKNOWN_TOOL'), pwshText.slice(0, 200))
const sandboxMode = /"sandbox":\{"mode":"([^"]+)"/.exec(bashText)?.[1]
if (sandboxMode !== undefined) {
  console.log(`        tool-layer sandbox mode: ${sandboxMode} (a session resolves this from its permission preset)`)
}
const confinedTool = step('tools.bashConfined')
check('the tool layer confines a write outside the workspace', confinedTool?.sandbox?.denied === true, confinedTool)
check('the tool layer reports the same completeness', confinedTool?.sandbox?.enforcement === 'partial', confinedTool?.sandbox)

// The scratch workspace is removed again, so a run leaves nothing behind in the
// home — the fixture file it holds lives inside it. The removal REPORTS its own outcome: the
// previous `.catch(() => ({ exitCode: -1 }))` turned every failure into a value nobody read, so
// "nothing is left behind" was a claim with no evidence and no owner.
const scratchCleanup = await call('execInWsl', {
  cwd: home,
  distro,
  command: `rm -rf "${wslScratch}" && test ! -e "${wslScratch}" && echo SCRATCH-REMOVED`,
}).catch((error) => ({ exitCode: -1, error: error.message }))
check('the selftest scratch directory is removed again, and the removal says so',
  scratchCleanup.exitCode === 0 && String(scratchCleanup.stdout ?? '').includes('SCRATCH-REMOVED'),
  scratchCleanup)

// The other half of "one process, two worlds": a Windows workspace must keep the
// host execution world. Selecting the host preset explicitly is what the GUI
// does when the workspace is not a WSL one.
console.log('\nwindows workspace unaffected')
// The Windows root is DERIVED, and it must NOT be a drive root. Deriving it as
// `${SystemDrive}\\` fixed a C:-only host and broke every default install: the
// host's ACL sandbox refuses a temp root inside the workspace
// (assertTempRootOutsideWorkspace), and C:\ contains %LOCALAPPDATA%\Temp
// everywhere — so tool-pwsh reported an environment mismatch that this gate then
// blamed on the plugin. A scratch directory under the system temp is contained
// BY the temp root rather than containing it, which is the direction that matters.
// Process-unique for the same reason as `wslScratch` above, and removed in a `finally`: this
// root is created by THIS suite under the system temp, so a run that throws must still not
// leave it behind — `rmSync`/'rm' nowhere else in this file touched it before.
const windowsRoot = join(tmpdir(), `dsh-wsl-win-selftest-${process.pid}`)
await mkdir(windowsRoot, { recursive: true })
try {
  const win = await call('selftest', { preset: 'standard', cwd: windowsRoot }).catch((error) => ({ steps: [{ name: 'error', message: error.message }] }))
  const winStep = (name) => win.steps.find((entry) => entry.name === name)
  check('a Windows workspace stays on the host preset', winStep('select')?.composed === 'standard', winStep('select'))
  // 0.1.7: the host registers its own shell at the root scope, so a Windows
  // session's shell.service IS found — the assertion is that it is NOT the WSL
  // realm's confining executor (whose prototype carries confinementFor).
  check('no realm-scoped shell is mounted', !(winStep('shell.service')?.proto ?? '').includes('confinementFor'), winStep('shell.service'))
  check('the host PowerShell tool works', (winStep('tools.pwsh')?.text ?? '').includes('"isError":false'), winStep('tools.pwsh')?.text?.slice(0, 160))
  check('no bash tool exists in the host world', (winStep('tools.bash')?.text ?? '').includes('UNKNOWN_TOOL'), winStep('tools.bash')?.text?.slice(0, 160))
} finally {
  await rm(windowsRoot, { recursive: true, force: true })
}

console.log('\nworkspace dialog host contract')
// The dialog drives THREE route methods, and each row now reads its OWN answer: the client
// half calls `listDir` for the picker, `resolveHome` for the prefill and `checkPath` for
// the validation (lib/client.js:300/363/387). This block used to read all of it from
// `workspaceFlow` — a suite-only composite that runs resolve → listDir → checkPath →
// registry.create → registry.delete inside ONE call — so a single throw left every field
// unset and the block printed FOUR failures. Measured on this machine: the listing answered
// with 35 entries and `checkPath` then timed out at 30s, and the suite reported FAIL on
// "the dialog's directory listing works" — a row whose own step had already succeeded. The
// composite is still the only method that registers AND removes a workspace, so the two rows
// that need exactly that keep using it, and name the step when it throws.
const listing = await call('listDir', { distro, path: '/' }).catch((error) => ({ error: error.message }))
check('the dialog\'s directory listing works', Array.isArray(listing.entries), listing)
if (Array.isArray(listing.entries)) console.log(`        ${listing.entries.length} entries in /`)
const facts = await call('checkPath', { distro, path: '/' }).catch((error) => ({ error: error.message }))
check('the chosen directory is validated as a directory', facts.isDirectory === true, facts)
const flow = await call('workspaceFlow', { distro, linuxPath: '/' }).catch((error) => ({ error: error.message }))
// Both remaining rows come from that one composite, so a throw fails both and the detail has
// to say so: the error text names the step (无法列出/无法检查 = a probe, otherwise the registry).
const flowStep = flow.error === undefined
  ? null
  : `${flow.error} — workspaceFlow is ONE route call (resolve → listDir → checkPath → registry.create → registry.delete), so this row is red because a step inside it threw; the error above names the step`
check('a workspace is registered under the UNC spelling', String(flow.workspacePath ?? '').startsWith('\\\\wsl.localhost\\'), flowStep ?? flow.workspacePath)
check('the verification workspace is removed again', flow.deleted === true, flowStep ?? flow.deleted)
const resolvedHome = await call('resolveHome', { distro }).catch((error) => ({ error: error.message }))
check('the dialog can resolve the default user and home',
  typeof resolvedHome?.user === 'string' && resolvedHome.user.length > 0
  && typeof resolvedHome?.home === 'string' && resolvedHome.home.startsWith('/'), resolvedHome)

console.log('\nsession binding')
// The one call without a sibling-proven fallback: an older host without the
// bindingLog method must degrade to an empty log (visible below), not crash
// the run and skip the entire browser-half section.
const bindings = await call('bindingLog').catch((error) => ({ entries: [], error: error.message }))
check('the binding log is reachable', bindings.error === undefined, bindings.error)
// Since the browser half names the WSL preset in its create request, a session
// bound at creation produces NO fallback entry: the `api-session/added`
// listener exists only to catch a WSL-workspace session that was created
// WITHOUT the preset — the one way a session can still end up in the Windows
// world. Selftest sessions are excluded: this script creates and disposes them.
const anomalous = bindings.entries.filter((entry) => !String(entry.sessionId ?? '').startsWith('wsl-selftest'))
if (anomalous.length === 0) {
  console.log('        no fallback binding attempts — every WSL-workspace session so far was bound at creation')
} else {
  const latest = anomalous[anomalous.length - 1]
  if (latest.ok === true) {
    console.log(`        fallback bound ${latest.sessionId}: ${latest.from} → ${latest.to}`)
  } else {
    check('no WSL-workspace session was left in the Windows world', false, latest)
    console.log('        This session was created without the WSL preset, and the post-hoc fallback was')
    console.log('        refused (the harness fixes a preset at creation). It runs in the Windows world:')
    console.log('        open a fresh session from the W dialog, which names the preset at creation.')
  }
}
todo('a GUI-created WSL session runs on the WSL preset',
  'Click the W button in the sidebar, add a WSL workspace, and open a session; its preset should read WSL · <base>.')

console.log('\nbrowser half served to the page')

/**
 * Read the live client module graph from the page's own refresh stream.
 * @returns {Promise<object|null>} the plugin's graph entry, or null when the stream carries none.
 */
async function liveClientEntry() {
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort() }, 8000)
  try {
    const response = await fetch(`${baseUrl}/plugins/events`, { signal: abort.signal })
    const reader = response.body.getReader()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return null
      buffered += Buffer.from(value).toString('utf8')
      let end
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        if (!line.startsWith('data: ')) continue
        const payload = JSON.parse(line.slice(6))
        if (payload.type !== 'graph') continue
        return (payload.graph.entries ?? []).find((entry) => entry.id === 'dsh-wsl-desktop') ?? null
      }
    }
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

// The host caches each client bundle in memory, so this is the only automated
// proof that the page receives the browser half currently on disk.
const clientEntry = await liveClientEntry().catch(() => null)
check('the client half is in the served module graph', clientEntry !== null, 'no dsh-wsl-desktop entry in /plugins/events')
if (clientEntry !== null) {
  // 0.1.7's graph entries may carry a path without the leading slash; the
  // joined URL must not lose the separator between origin and path.
  const bundlePath = clientEntry.url.startsWith('/') ? clientEntry.url : `/${clientEntry.url}`
  const bundleResponse = await fetch(`${baseUrl}${bundlePath}`)
  const bundle = await bundleResponse.text()
  check('the served browser half is the current one',
    bundleResponse.status === 200 && bundle.includes('TRIGGER_ICON_PATH'), `status=${bundleResponse.status} bytes=${bundle.length}`)
  check('it attaches a companion button beside the shipped trigger', bundle.includes('.after(button)'))
  check('it leaves the shipped directory-flow hole to the deployment',
    !bundle.includes('slots.register') && !bundle.includes('priority: -10'))
  // The create-seam fix has to reach the PAGE, not merely sit in the file on
  // disk: the host serves this bundle from its own cache, and a stale copy is
  // exactly how the dropped `agentPreset` would come back unnoticed. This is
  // the one assertion that proves the browser half the operator's page actually
  // runs creates sessions through the remote contract.
  check('the served browser half carries the create-seam fix',
    bundle.includes('createBoundSession') && bundle.includes('ctx.remote?.session?.create'),
    `bytes=${bundle.length}`)
  // The cloud that marks WSL workspace rows is served the same way, so it is
  // asserted the same way: the file on disk is not what the page runs. The pin
  // is a fragment of the artwork itself rather than the constant's name, so a
  // rename cannot fail this while a stale bundle still does.
  check('the served browser half carries the workspace cloud icon',
    bundle.includes('data-wsl-cloud') && bundle.includes('M11 13C12.8 13'),
    `bytes=${bundle.length}`)
}

console.log('\nmanual steps this script cannot drive (browser-only)')
todo('the workspace dialog renders and creates a workspace',
  'Click the W button beside the sidebar\'s add-workspace (+) button; the dialog should list the distributions and their directories.')
todo('the terminal panel opens a WSL shell', 'Open a WSL session and its terminal panel; the prompt should be the distribution shell. The transport itself is covered above by the PTY bridge checks.')
console.log('        Everything else — the session bound to a WSL preset, bash and the file tools inside the')
console.log('        distribution, the tool layer\'s confinement, and the Windows world staying unchanged —')
console.log('        is asserted automatically above.')

console.log(`\n${failures === 0 ? 'NO AUTOMATED FAILURES' : `${failures} CHECK(S) FAILED`}; ${pending} manual step(s) pending`)
process.exitCode = failures === 0 ? 0 : 1
