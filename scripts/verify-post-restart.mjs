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
import { makeChecker } from './suite-shell.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = process.env.DSH_WSL_ROOT ?? join(here, '..')
// The checkout's own version, so a host half that loaded a different generation is
// named here rather than inferred from the deployed manifest check above.
const sourceVersion = await readFile(join(pluginRoot, 'package.json'), 'utf8')
  .then((raw) => JSON.parse(raw).version)
  .catch(() => '')
// The harness exports DSH_WEB_URL for the host it just started, and `verify-all --live`
// runs this suite with NO argv (its spawnSync inherits the environment). Reading only
// argv[2] meant the live mode was structurally broken after every restart: DSH's web port
// CHANGES each time, so the list fell back to the hardcoded 19387 and every live suite
// reported a connection refusal against a port nothing serves. The environment knows the
// answer; guessing is what made the documented --live workflow unusable.
const baseUrl = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const distro = resolveDistro(process.argv[3])
const home = resolveLinuxHome(distro)
const endpoint = `${baseUrl}/wsl-desktop/api`
// Every method this script uses is on the acceptance surface, which the route
// fences behind the transport check plus this token.
const token = await ensureDevToken()

const checker = makeChecker({ pass: 'PASS' })
const { check } = checker
let pending = 0


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
  // Guarded, not assumed: the row above admits a non-array `written`, and mapping it
  // anyway threw a TypeError that suppressed the FAIL it had just printed.
  if (Array.isArray(status.written)) {
    console.log(`        ${status.written.map((entry) => `${entry.id} (from ${entry.from}; removed ${entry.removed.join(',') || 'none'})`).join('\n        ')}`)
  }
  // A row the transform kept WITHOUT a classifier verdict is the leak shape: the
  // removal rule is a closed list, so an upstream tool row this plugin has never
  // seen is copied into the WSL variant in silence — no removal, no report, every
  // suite green. The host reports those rows; asserting on the report is what turns
  // the next upstream addition into a decision instead of a leak. Remedy: add the
  // module to WORLD_MODULE_NAMES (drop it) or VERDICTED_KEPT_MODULES (keep it
  // deliberately) in lib/wsl/preset.js.
  const unclassified = status.written.flatMap((entry) => (entry.unclassified ?? []).map((row) => ({ preset: entry.id, ...row })))
  check('no preset row survived without a classifier verdict', unclassified.length === 0,
    unclassified.length === 0 ? undefined : `unclassified rows: ${JSON.stringify(unclassified)} — add each to WORLD_MODULE_NAMES (drop) or VERDICTED_KEPT_MODULES (keep) in lib/wsl/preset.js`)
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
// Named, not fatal: the sibling calls all catch, and an uncaught throw here used
// to suppress every section below — session acceptance, the Windows world, the
// dialog contract, session binding and the browser half — leaving the run with no
// verdict beyond a stack trace. All four rows stay printed and each names the
// cause, so a host-down or a mis-named distro reads as what it is.
let identity = null
let probeFailure
try {
  identity = await call('execInWsl', { cwd: home, distro, command: 'uname -s; pwd; echo "$WSL_DISTRO_NAME"' })
} catch (error) {
  probeFailure = error instanceof Error ? error.message : String(error)
}
const probeDetail = probeFailure ?? identity
check('a command runs inside the distribution',
  probeFailure === undefined && identity.exitCode === 0 && identity.stdout.includes('Linux'), probeDetail)
check('the working directory is a Linux path',
  probeFailure === undefined && identity.target?.linuxPath === home, probeDetail)
// The command echoes the distro NAME on its last line (uname -s; pwd; echo "$WSL_DISTRO_NAME").
check('the command ran in the distribution under test',
  probeFailure === undefined && identity.stdout.trim().split('\n').pop() === distro, probeDetail)
check('the target carries the UNC workspace spelling',
  probeFailure === undefined && String(identity.target?.uncPath ?? '').startsWith('\\\\wsl.localhost\\'), probeDetail)

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
// The scratch directory is OWNED here, for the same reason as the temp root below: the block
// between its creation and its removal can throw (this commit's own run saw a Wsaetimedout
// transient), and a pid-suffixed name left behind by a dead pid is one no later run cleans.
// The success-path removal below still REPORTS its own outcome; this `finally` is the abort
// path, and it is deliberately best-effort so a cleanup fault cannot mask the original throw.
try {
  await call('execInWsl', { cwd: home, distro, command: `rm -rf ${wslScratch} && mkdir -p ${wslScratch}` })
  // The reclaim pair is a BEFORE/AFTER, not a count of zero: a Web terminal panel of the
  // operator's own may legitimately hold a bridge open, and a suite that demanded an empty
  // distribution would redden on somebody else's session. What must not happen is OUR run
  // ADDING one that outlives it.
  //
  // Both readings are IDENTITIES, not counts. A count makes "our bridge appeared and one of
  // the operator's closed" indistinguishable from "nothing appeared" — the two collisions a
  // criterion about leakage cannot afford. Set containment is what "this run added nothing"
  // actually means.
  //
  // The bridge discriminator is NOT the bridge's filename. `lib/wsl/pty.js` runs the bridge as
  // `python3 -c <entire source>`, so `terminal-bridge.py` appears in no process's argv at all
  // (measured on a live bridge's /proc/<pid>/cmdline); `pgrep -f terminal-bridge.py` matches
  // only the wrapping `bash -lc` whose command text contains that spelling — measured as 1
  // with ZERO bridges. The string below is the bridge's own module docstring, which is in the
  // argv by construction, and the bracketed first letter keeps the pattern from matching
  // itself in that same wrapper (measured 2 with two bridges, 0 for a nonsense pattern).
  const probeDistro = async (command) => String((await call('execInWsl', { cwd: home, distro, command })).stdout ?? '')
  const linesOf = (text) => text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const bridgePids = async () => linesOf(await probeDistro(`pgrep -f -- '[P]TY bridge for the WSL execution world' || true`)).sort()
  const pluginFifos = async () => linesOf(await probeDistro('ls -1 /tmp/dsh-pty-*.fifo 2>/dev/null; echo END'))
    .filter((line) => line.startsWith('/tmp/dsh-pty-'))
  const bridgesBefore = await bridgePids()
  const fifosBefore = await pluginFifos()
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
  // The three watch rows: the provider's override observed from outside, driven the
  // way a consumer drives it, and mutated from inside the distribution. A watch row
  // that never armed reads as `notified: 0` with `watchError: null` — so each row
  // asserts a notification ARRIVED, not merely that the call returned.
  const fileWatch = step('fs.watch.file')
  check('the provider observes a file changed from inside the distribution',
    fileWatch?.notified > 0 && fileWatch?.watchError === null, fileWatch)
  const dirWatch = step('fs.watch.dir')
  check('the provider observes an entry created from inside the distribution',
    dirWatch?.notified > 0 && dirWatch?.watchError === null, dirWatch)
  const nativeWatch = step('fs.watch.native')
  check('the native primitive still cannot watch this share — the reason the override exists',
    nativeWatch?.threw === true && nativeWatch?.code === 'EISDIR', nativeWatch)
  const confined = step('shell.confined')
  check('a write outside the workspace is refused', confined?.sandbox?.denied === true, confined)
  const probe = step('subprocess.probe')
  check('the subprocess provider reports a POSIX environment', probe?.environment?.platform === 'posix', probe)
  // The selftest reports each tool outcome as a bounded JSON string, so the
  // assertions read the raw text rather than re-parsing a possibly truncated
  // document.
  //
  // Task 1 measured M1 = P2: the realm's `bash` IS the persistent tool now. Its result is the
  // terminal text, not the one-shot tool's `{ stdout, sandbox, … }` JSON envelope — so the
  // marker this row reads is the command's OWN output (`uname -s` prints Linux on this path
  // too), and the `sandbox` field the two rows below used to read is simply absent from it.
  // Keeping those two rows would have pinned two `undefined`s.
  const bashText = step('tools.bash')?.text ?? ''
  check('the bash tool runs inside the distribution',
    step('tools.bash')?.ok === true && bashText.includes('Linux'), bashText.slice(0, 200))
  const readText = step('tools.read')?.text ?? ''
  check('the read tool addresses a Linux path', readText.includes('"isError":false') && readText.includes(`${wslScratch}/dsh-wsl-selftest.txt`), readText.slice(0, 200))
  const pwshText = step('tools.pwsh')?.text ?? ''
  check('the session exposes no PowerShell tool', pwshText.includes('UNKNOWN_TOOL'), pwshText.slice(0, 200))
  // The realm's own search tools. A WSL realm REMOVES the host's grep/glob rows on
  // purpose (their argv[0] is a packaged Windows ripgrep) and this plugin's two rows put
  // the two names back, running the distribution's own grep/find. They are the only tools
  // here with no offline observer at all: `lib/wsl/search-tool.js` imports harness
  // packages, so no offline suite in this repo can drive it through the registry — the
  // selftest records the two rows, and these two checks are what reads them.
  //
  // The fixture names, the token and the line number are spelled AGAIN here on purpose:
  // lib/index.js writes them and this file asserts on their Linux paths — the pairing
  // `dsh-wsl-selftest.txt` already has between the two files (nothing derives one from
  // the other, so a rename has to move both copies).
  const searchProbe = `${wslScratch}/src/dsh-wsl-search-probe.ts`
  const searchNested = `${wslScratch}/src/a/b/deep.ts`
  const searchToken = 'dsh-wsl-search-needle'
  const grepStep = step('tool.search.grep')
  const grepText = grepStep?.text ?? ''
  // The LINE NUMBER, not merely the file: a hit on line 1 of the probe satisfies any
  // "the file was searched" reading, and the probe's match is deliberately on line 3.
  check('the search tools run inside the distribution',
    grepStep?.ok === true
    && grepText.includes(searchProbe)
    && grepText.includes('"lineNumber":3')
    && grepText.includes(searchToken),
    grepStep === undefined
      ? 'the selftest recorded no tool.search.grep step — the record name is spelled in lib/index.js'
      : grepText.slice(0, 300))
  // `.git` is the whole point of the exclusion list, and the fixture under `src/.git/`
  // carries the SAME token, INSIDE the pattern's reach: a find that stopped pruning the
  // six VCS names lists a third path here (measured). The nested file sits TWO directories
  // below the pattern's own prefix — a pattern not anchored to the search root matches
  // nothing at all (measured), which is the defect this clause pins.
  const globStep = step('tool.search.glob')
  const globText = globStep?.text ?? ''
  check('the glob tool lists without descending into VCS metadata',
    globStep?.ok === true
    && globText.includes(searchProbe)
    && globText.includes(searchNested)
    && !globText.includes('.git'),
    globStep === undefined
      ? 'the selftest recorded no tool.search.glob step — the record name is spelled in lib/index.js'
      : globText.slice(0, 300))

  // ---- criterion 1: the persistent shell, observed only here -------------------------------
  // The FIRST call established a cwd and exported a variable; the SECOND read both back. A
  // one-shot tool answers the second call with a fresh process, so these two rows ARE
  // criterion 1 — and they are its ONLY observation: no offline suite in this repository can
  // drive the harness's terminal stack, so an offline copy of this row would be a row about
  // nothing.
  const persistA = step('tools.bashPersist.a')
  const persistB = step('tools.bashPersist.b')
  // The recorded text is the whole tool-result envelope; the shell's own output is what the
  // cwd and the variable have to appear in. Parsed rather than substring-matched so a match
  // on the ENVELOPE (say, an echoed command line in `error`) cannot satisfy the row.
  //
  // The fallback also UNESCAPES. `lib/index.js` records at 800 bytes, so a longer result is a
  // TRUNCATED JSON document: `JSON.parse` then fails and the raw text is a single line of
  // escaped JSON, where the `(?:^|\n)`-anchored prompt clauses can never match past line one.
  // That would not be a false green — the echo clause still reads the text — but it would be a
  // row that quietly stopped checking one of its three clauses, so the fallback turns the
  // escapes back into the characters the clauses are written against.
  const persistText = (() => {
    const raw = persistB?.text ?? ''
    try {
      const envelope = JSON.parse(raw)
      return String(envelope?.value ?? envelope?.content?.[0]?.text ?? '')
    } catch {
      return raw.replace(/\\r\\n|\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  })()
  check('the persistent shell keeps its working directory across calls',
    persistA?.ok === true && persistB?.ok === true && persistText.includes('.dsh-wsl-persist-cwd'),
    persistB === undefined
      ? 'the selftest recorded no tools.bashPersist.b step — the record name is spelled in lib/index.js'
      : persistText.slice(0, 300))
  check('the persistent shell keeps an exported variable across calls',
    persistB?.ok === true && persistText.includes('dsh-wsl-persist-probe'), persistText.slice(0, 300))
  // The confinement question is asked of the FILE SYSTEM rather than of the tool's own
  // report: the persistent shell tried to write $HOME/.dsh-wsl-persist-outside, one level
  // above its workspace. Under the distribution-side confinement that write is refused, and
  // the file's absence is the outcome — not the shell's own diagnostic (measured M3: the
  // write is refused in-distro with `Read-only file system`, `write-exit=1`).
  //
  // GATED ON `persistB?.ok === true` (R49(a)): the absence of that file is only evidence if
  // the write was ATTEMPTED. In a P0/P1 world — the realm's `bash` never became the persistent
  // tool — no attempt happened and the file is absent for a reason that says nothing about
  // confinement, so an ungated row would read ABSENT and pass vacuously exactly where the
  // capability is missing. With the gate it reddens there instead.
  //
  // This row deliberately does NOT replace `shell.confined` (the service-level row above):
  // that one keeps pinning the confinement itself, which no longer rides on this tool.
  const outsideVerdict = String((await call('execInWsl', { cwd: home, distro, command: `test -e ${home}/.dsh-wsl-persist-outside && echo PRESENT || echo ABSENT` })).stdout ?? '').trim()
  check('the shell in a WSL session cannot write outside its workspace',
    persistB?.ok === true && outsideVerdict === 'ABSENT',
    {
      ok: persistB?.ok,
      outsideVerdict,
      note: 'ABSENT alone does not pass: persistB.ok must be true, or the write was never attempted. PRESENT means the persistent PTY is not confined in the distribution — Task 1 measured M3 and the docs must declare it (Task C1-b)',
    })

  // ---- criterion 2: the session gives its PTY back ------------------------------------------
  // TWO answers are required, not one (R28/R32). The bridge process going away is not the same
  // statement as the NAME going away: measured while this sweep was written, a session's end
  // leaves a 0-byte FIFO behind exactly when the bridge's own `finally` cannot run, and the
  // reclaim rule is a GENERATION rule, so a name can outlive its bridge. And neither is a
  // count: containment in an interned set says "this run added nothing", which is the claim.
  //
  // THE BRIDGE HALF NEEDS A POSITIVE CONTROL, and it is the row just below (R49(d), M4). On an
  // empty baseline `addedBridges.length === 0` is true BY CONSTRUCTION: "no bridge of ours
  // outlived the session" and "the discriminator matched nothing at all" are the same reading,
  // and a broken `pgrep` pattern would keep this row green forever. So the selftest records the
  // bridge set while its own PTY is still open (`tools.persistBridge`, read in `lib/index.js`
  // before it disposes the session), and this block asserts that the discriminator SAW a bridge
  // that this run created. The reclaim row is gated on that, so it cannot pass on a reading that
  // observed nothing. Known failure shape (R52), recorded rather than papered over: a host that
  // parks an idle persistent session would leave the positive control empty and redden these
  // two rows for a reason that is not a leak — the detail names both readings so that is
  // tellable from a real residue.
  const bridgeProbe = step('tools.persistBridge')
  const probePids = Array.isArray(bridgeProbe?.pids) ? bridgeProbe.pids : []
  const observedAdded = probePids.filter((pid) => !bridgesBefore.includes(pid))
  check('the bridge discriminator observes THIS run’s bridge while the session is open',
    bridgeProbe?.ok === true && observedAdded.length > 0,
    bridgeProbe === undefined
      ? 'the selftest recorded no tools.persistBridge step — the record name is spelled in lib/index.js'
      : {
          probePids,
          bridgesBefore,
          observedAdded,
          note: 'an empty observedAdded means the pgrep pattern no longer matches a live bridge (the discriminator is broken), or the persistent tool parked its session before this probe ran',
        })
  // THE RECLAIM ROW READS ONLY AFTER THE SESSION IS KNOWN TO BE TORN DOWN (root cause A of the
  // 2026-10-19 17:23 run).
  //
  // The session is released in the selftest's own `finally`, so a delta read right after the
  // selftest returns is a read of a session that may still be live — measured: a bridge pid AND
  // `/tmp/dsh-pty-45580-dbab20de-63d.fifo` present at that instant. Two defects in one:
  //   · the row could never pass for a session this run created, so it reported a leak that was a
  //     timing artefact; and
  //   · worse, it hid real ones — a residue that was genuinely leaked and one that was merely
  //     not-yet-cleaned read identically, so the row could not be trusted either way.
  //
  // The selftest now records `tools.persistTeardown` AFTER its disposal await, and this row is
  // gated on it. The gate is the fix for the READ POINT; the FIFO/bridge delta below is still the
  // EVIDENCE, and it can still redden on a real leak — teardown.ok true plus a leftover name is
  // exactly that, because the removal has been awaited by then.
  //
  // A FAILED disposal (`ok: false`) does NOT make the row pass by being "not observed": it
  // reddens, because the whole claim is that the session gives its PTY back, and a disposal that
  // threw is a session that may not have.
  const teardownStep = step('tools.persistTeardown')
  const teardownOk = teardownStep?.ok === true
  const bridgesAfter = teardownOk ? await bridgePids() : bridgesBefore
  const fifosAfter = teardownOk ? await pluginFifos() : fifosBefore
  const addedBridges = bridgesAfter.filter((pid) => !bridgesBefore.includes(pid))
  const addedFifos = fifosAfter.filter((name) => !fifosBefore.includes(name))
  check('the session leaves neither a PTY bridge process nor a plugin-named FIFO behind',
    bridgeProbe?.ok === true && observedAdded.length > 0 && teardownOk
    && addedBridges.length === 0 && addedFifos.length === 0,
    {
      teardown: teardownStep ?? 'the selftest recorded no tools.persistTeardown step — the record name is spelled in lib/index.js',
      readPoint: teardownOk ? 'after the disposal await' : 'NOT TAKEN — the session was never released, so a delta here would measure a live session',
      bridgesBefore,
      bridgesAfter,
      addedBridges,
      fifosBefore,
      fifosAfter,
      addedFifos,
      probePids,
      observedAdded,
      note: teardownOk
        ? 'teardown succeeded and the delta is read AFTER it, so a leftover name is a real leak'
        : 'the reclaim claim cannot be evaluated: disposal did not succeed, so the session may still be live',
    })

  // ---- the fence guard: a mode change is refused while the shell is open --------------------
  // The backend owns this rule (`terminal-bash/src/index.ts:52-62`) and refuses by throwing.
  // The selftest drives it from the realm after its persistent calls, so `refused` here is
  // the guard actually firing — the sentence is asserted too, because a throw for any other
  // reason (a dead agent, a bad payload) must not read as this guard.
  const fence = step('tools.persistFence')
  check('changing the sandbox mode is refused while a persistent terminal session is open',
    fence?.refused === true && /persistent terminal sessions/.test(String(fence?.reason ?? '')),
    fence ?? 'the selftest recorded no tools.persistFence step — the record name is spelled in lib/index.js')

  // ---- the interactive dialect: no prompt and no echo leak into the tool's text ------------
  // The distribution's interactive bash is driven through the backend's sanitize layer, and
  // this is the first time anything observes that. A leaked prompt or an echoed command line
  // is what "not sanitized" looks like, and it would be visible here.
  //
  // The prompt is matched by the backend's own CONTROLLED_PROMPT spelling (`dsh> `,
  // `terminal-bash/src/sanitize.ts:9`) and by bash's own `bash-5.2$` default, NOT by the
  // placeholder `__DSH_PERSISTENT_BASH_PROMPT__` the brief carried: that literal exists in no
  // implementation — measured with grep over the harness and this plugin — so a row keyed on
  // it could only ever pass vacuously.
  //
  // The echo clause quotes a fragment of the SECOND command verbatim (`lib/index.js` spells the
  // same command): a sanitizer that passed the terminal's echo through would put that line in
  // the text, and no legitimate output of this command contains a `"` or that assignment.
  check('the interactive shell’s prompt and echo do not leak into the tool’s output',
    persistB?.ok === true
    && !/(?:^|\n)\s*dsh> /m.test(persistText)
    && !/^\s*(bash|sh)-[\d.]+\$/m.test(persistText)
    && !persistText.includes('echo "$DSH_WSL_PERSIST_PROBE"'),
    persistText.slice(0, 300))

  // ---- the sweep judges age in the distribution's clock (R47) -------------------------------
  // The behavioural landing place for a SOURCE-SHAPE pin: no fixture can make two clocks
  // disagree, so `verify-pty-handle.mjs` can only pin the sweep's shape. This row is the
  // behaviour — a fresh LEGACY name must survive, a backdated one must go, and the verdicts
  // must not move when a host-side reading is shifted, because the host contributes only the
  // set difference.
  const sweepProbe = step('tools.persistSweep')
  check('the orphan sweep judges age in the distribution’s clock, not the host’s',
    sweepProbe?.youngKept === true && sweepProbe?.agedSwept === true,
    sweepProbe ?? 'the selftest recorded no tools.persistSweep step — the record name is spelled in lib/index.js')
  check('shifting the host-side reading does not change either sweep verdict',
    sweepProbe?.youngKeptAfterShift === true && sweepProbe?.agedSweptAfterShift === true,
    sweepProbe ?? 'the selftest recorded no tools.persistSweep step — the record name is spelled in lib/index.js')

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
} finally {
  await call('execInWsl', { cwd: home, distro, command: `rm -rf "${wslScratch}"` })
    .catch((error) => { console.log(`        the scratch directory could not be removed after a throw: ${error.message}`) })
}

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
try {
  // INSIDE the try, not before it: this suite creates the directory, so the try/finally that
  // removes it has to own the creation too. Before this the mkdir sat one statement above the
  // try, and a throw in between — anything, including an out-of-memory or the mkdir's own
  // rejection being reported by a caller — left the directory behind with NO owner, which the
  // reviewer confirmed as this file's only un-owned window (the sibling WSL scratch directory
  // above is owned the same way). A failing mkdir cannot orphan anything, and the finally's
  // `force: true` rm is a no-op for a directory that was never created.
  await mkdir(windowsRoot, { recursive: true })
  const win = await call('selftest', { preset: 'standard', cwd: windowsRoot }).catch((error) => ({ steps: [{ name: 'error', message: error.message }] }))
  const winStep = (name) => win.steps.find((entry) => entry.name === name)
  check('a Windows workspace stays on the host preset', winStep('select')?.composed === 'standard', winStep('select'))
  // 0.1.7: the host registers its own shell at the root scope, so a Windows
  // session's shell.service IS found — the assertion is that it is NOT the WSL
  // realm's confining executor (whose prototype carries confinementFor).
  check('no realm-scoped shell is mounted', !(winStep('shell.service')?.proto ?? '').includes('confinementFor'), winStep('shell.service'))
  check('the host PowerShell tool works', (winStep('tools.pwsh')?.text ?? '').includes('"isError":false'), winStep('tools.pwsh')?.text?.slice(0, 160))
  check('no bash tool exists in the host world', (winStep('tools.bash')?.text ?? '').includes('UNKNOWN_TOOL'), winStep('tools.bash')?.text?.slice(0, 160))
  // Criterion 3 for the NEW capability: the host world must not have gained a persistent
  // shell either. The probe rows run in this selftest too, so the host session answers them
  // itself — `bash` does not exist in the host world (the shipped row is win32-disabled), and
  // the persistent one was never mounted here. Both halves are asserted because the pair is
  // what distinguishes "no persistent shell" from "no bash at all": a host world that answered
  // the persistent pair would mean the realm's tool row leaked out of its isolate.
  const winPersistA = winStep('tools.bashPersist.a')
  const winPersistB = winStep('tools.bashPersist.b')
  // The fence probe must not report a REFUSAL here either: a host world with no terminal
  // session has nothing for the guard to protect, so the append is accepted or fails for an
  // unrelated reason — but "refused while a persistent terminal session is open" would mean
  // the realm's session is live inside the host world.
  const winFence = winStep('tools.persistFence')
  // ... and the bridge probe has to have been UNABLE to observe a distribution bridge. That
  // clause is what makes this row able to fail on its own evidence: the UNKNOWN_TOOL pair above
  // is also what `:512`'s "no bash tool exists" reads, so on its own this row could only fail
  // where that one already did. A host world that could SEE a bridge would mean the realm's
  // terminal (and with it the tool row) is live outside the isolate — a leak this row can name
  // even while both bash texts still say UNKNOWN_TOOL.
  const winBridge = winStep('tools.persistBridge')
  check('no persistent bash tool leaked into the host world',
    (winPersistA?.text ?? '').includes('UNKNOWN_TOOL')
    && (winPersistB?.text ?? '').includes('UNKNOWN_TOOL')
    && winBridge?.ok === false,
    {
      a: winPersistA?.text?.slice(0, 160) ?? 'no tools.bashPersist.a step was recorded',
      b: winPersistB?.text?.slice(0, 160) ?? 'no tools.bashPersist.b step was recorded',
      fence: winFence?.refused === true ? winFence.reason : 'the mode change was not refused in the host world',
      bridge: winBridge === undefined
        ? 'no tools.persistBridge step was recorded'
        : winBridge.ok === true
          ? `the host world OBSERVED a distribution bridge (${JSON.stringify(winBridge.pids ?? [])}) — the realm's terminal is live outside its isolate`
          : winBridge.error,
    })
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
/**
 * Did THIS run's workspace get removed?
 *
 * Scoped to what the composite can actually tell apart. A leftover registered at the UNC root
 * makes `workspaceFlow` answer `created:false, deleted:null` (lib/index.js:887-889:
 * `created = existing === undefined`, `if (created) deleted = await registry.delete(…)`), and
 * this suite has no route method that could remove a workspace it did not create — so a row
 * asserting `deleted === true` reddens on a condition the operator cannot act on, while
 * claiming something about a removal. A leftover is therefore DISCLOSED, and a genuine removal
 * failure (this run created it and it is still there) still reddens. The decision table is
 * pinned offline below, because exercising a leftover would mean deliberately leaving a
 * registered workspace on the operator's machine.
 */
const workspaceRemoved = (flow) => flow.created === false || flow.deleted === true
if (flow.created === false) {
  console.log(`  DISCLOSED  a workspace was ALREADY registered at ${String(flow.workspacePath ?? 'the UNC root')}; this run did not create it, so it could not be the one to remove it — reported, not read as a removal failure`)
}
check('the verification workspace is removed again when this run created it',
  workspaceRemoved(flow), flowStep ?? { created: flow.created, deleted: flow.deleted })
check('the workspace-removal rule: a leftover this run did not create is disclosed, not a failure, and a real removal failure still reddens',
  workspaceRemoved({ created: false, deleted: null }) === true
  && workspaceRemoved({ created: true, deleted: true }) === true
  && workspaceRemoved({ created: true, deleted: null }) === false
  && workspaceRemoved({ error: 'workspaceFlow: 无法检查 /' }) === false,
  { leftover: workspaceRemoved({ created: false, deleted: null }), removed: workspaceRemoved({ created: true, deleted: true }), notRemoved: workspaceRemoved({ created: true, deleted: null }), threw: workspaceRemoved({ error: 'x' }) })
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

console.log('\nhost contract (bootstrap)')
{
  let bootstrap
  try {
    bootstrap = await call('bootstrap')
  } catch (error) {
    check('the host half exposes the bootstrap catalog', false,
      `${error?.message ?? error} — the host half is older than the checkout; restart DSH Desktop`)
  }
  if (bootstrap !== undefined) {
    check('bootstrap answers with the catalog',
      bootstrap.catalog !== null && typeof bootstrap.catalog?.codes === 'object', bootstrap?.catalog)
    check('bootstrap reports this checkout version',
      bootstrap.pluginVersion === sourceVersion,
      `host=${String(bootstrap.pluginVersion)} checkout=${sourceVersion}`)
    check('the host-scope capability probe is ok',
      bootstrap.capabilities?.status === 'ok'
      && bootstrap.capabilities?.features?.['preset-generation'] === 'ok',
      bootstrap.capabilities)
    const pinned = ['wsl-not-available', 'distro-unreachable', 'user-unknown', 'path-not-found', 'path-not-directory', 'path-denied', 'preset-not-ready', 'too-busy', 'internal']
    check('the catalog carries the pinned browser codes',
      pinned.every((code) => bootstrap.catalog?.codes?.[code] !== undefined),
      pinned.filter((code) => bootstrap.catalog?.codes?.[code] === undefined))
    for (const feature of ['terminal', 'search']) {
      const status = bootstrap.capabilities?.features?.[feature]
      if (status !== 'ok') {
        // Browser-scope features do not block the picker; say so without failing
        // the gate, exactly as the capability matrix specifies.
        console.warn(`WARN  browser-scope feature ${feature} is ${String(status)} — the picker still works; check the browser-side symbol if the tool is missing.`)
      }
    }
    check('the catalog carries the doctor vocabulary',
      Array.isArray(bootstrap.catalog?.checks) && bootstrap.catalog.checks.length === 7
      && bootstrap.catalog?.checkRemedies !== null && typeof bootstrap.catalog?.checkRemedies === 'object',
      bootstrap.catalog?.checks)
  }
}

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
  // Caught, not left to the runtime: this fetch is the only pair of awaits in the file
  // without a guard, and a refused request used to kill the run with a stack trace —
  // skipping the failure summary and the pending manual steps with it.
  let bundleStatus = 0
  let bundle = ''
  let fetchProblem = ''
  try {
    const bundleResponse = await fetch(`${baseUrl}${bundlePath}`)
    bundleStatus = bundleResponse.status
    bundle = await bundleResponse.text()
  } catch (error) {
    fetchProblem = String(error?.message ?? error)
  }
  check('the served browser half is the current one',
    fetchProblem === '' && bundleStatus === 200 && bundle.includes('TRIGGER_ICON_PATH'),
    fetchProblem !== '' ? `the fetch failed: ${fetchProblem}` : `status=${bundleStatus} bytes=${bundle.length}`)
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

console.log(`\n${checker.failures === 0 ? 'NO AUTOMATED FAILURES' : `${checker.failures} CHECK(S) FAILED`}; ${pending} manual step(s) pending`)
process.exitCode = checker.failures === 0 ? 0 : 1
