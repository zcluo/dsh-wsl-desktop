/**
 * Static checks on the browser half.
 *
 * The browser half is a hand-written `window.__ModuleLoader__` factory, so no
 * compiler or bundler sees it. These assertions pin the properties that a
 * broken edit would otherwise only reveal as a silent UI regression: the module
 * identity, the fact that it no longer shadows the shipped directory-flow hole,
 * the trigger-icon geometry it attaches to (cross-checked against the shipped
 * icon source), and the host calls the picker makes.
 *
 * Run: node scripts/verify-client-ui.mjs [--checkout=<dsh checkout>] [--client=<file>]
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const flag = (name, fallback) => {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const clientPath = flag('client', join(pluginRoot, 'lib', 'client.js'))
const checkout = flag('checkout', 'E:/projects/deepseek-harness')
const iconSourcePath = join(
  checkout, 'packages', 'client', 'ui-primitives', 'src', 'icons', 'index.tsx',
)

let failures = 0
let skipped = 0
let checks = 0

/**
 * Record one assertion.
 * @param {string} label - what was asserted.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - context shown on failure.
 */
function check(label, ok, detail) {
  checks += 1
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`)
  if (!ok && detail !== undefined) console.log(`        ${String(detail)}`)
  if (!ok) failures += 1
}

const source = await readFile(clientPath, 'utf8')
const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))

/** Source with comments and string bodies blanked, for structural assertions. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

/** Cordis Context members that are not injectable services. */
const NON_SERVICE_MEMBERS = ['effect', 'get', 'on', 'set', 'plugin', 'inject', 'provide']

console.log(`checking ${clientPath}\n`)

// Compiling the factory validates syntax without executing the module loader.
try {
  new vm.Script(source, { filename: clientPath })
  check('parses as JavaScript', true)
} catch (reason) {
  check('parses as JavaScript', false, reason)
}

const idMatch = /id:\s*'([^']+)'/.exec(source)
check('module id is the package name', idMatch?.[1] === pkg.name, `id=${idMatch?.[1]} name=${pkg.name}`)

check('does not shadow the shipped directory-flow hole',
  !code.includes('directoryFlow') && !code.includes('slots.register'))
check('has no slot registration at all', !/\bslots\b/.test(code))
check('attaches the companion instead of replacing the trigger', code.includes('.after(button)'))
check('inserts after the cluster, which caps its width and would clip a third child',
  code.includes('function actionCluster(trigger)')
  && code.includes('return trigger.parentElement ?? trigger')
  && code.includes('target.after(button)'))
check('never replaces a shipped DOM node', !code.includes('replaceWith('))

const injectMatch = /inject:\s*\[([^\]]*)\]/.exec(source)
const injected = (injectMatch?.[1] ?? '').split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean)
check('injects the services the picker reads',
  injected.length > 0 && injected.every((name) => code.includes(`ctx.${name}`)),
  `inject=[${injected.join(', ')}]`)
const reads = [...new Set([...code.matchAll(/ctx\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))]
  .filter((name) => !NON_SERVICE_MEMBERS.includes(name))
check('reads no service it did not inject',
  reads.every((name) => injected.includes(name)),
  `reads=[${reads.join(', ')}] inject=[${injected.join(', ')}]`)

check('releases the dialog and observer on dispose',
  /return \(\) => \{[\s\S]*?observer\.disconnect\(\)[\s\S]*?teardown\?\.\(\)/.test(code))
check('observes the document element, not a body that may not exist yet',
  code.includes('observer.observe(document.documentElement,')
  && !code.includes('observer.observe(document.body')
  && !code.includes('document.body.append'))
check('never mutates the tree from the branch the observer watches',
  !code.includes('setInterval')
  && source.includes("button.style.display = fits && triggerVisible ? '' : 'none'"))
check('follows the shipped actions when the header hides them',
  source.includes("getComputedStyle(trigger).visibility !== 'hidden'"))
check('prefers the shipped cluster and stands down on an unrecognised duplicate',
  code.includes('function hasHeaderActionsParent(trigger)')
  && code.includes('matches.find((trigger) => hasHeaderActionsParent(trigger)) ?? null'))
check('adopts the trigger class so the button matches the header',
  code.includes('button.className = trigger.className'))

// The browser half must not be able to reach a command-executing host method:
// the route is loopback-reachable, so an automatic caller is an authority
// surface, not a convenience.
check('calls no command-executing host method', !code.includes('execInWsl') && !code.includes('selftest'))

// The client carries a LIST of known trigger geometries (one per desktop
// generation); the shipped icon source must contain at least one of them, and
// every listed geometry must be a real prefix of the artwork it names.
const geometries = [...source.matchAll(/'((?:M)[^']{18,})'/g)].map((m) => m[1])
  .filter((g) => source.includes(`'${g}'`))
const triggerGeometries = [...source.matchAll(/'((?:M)[^']{18,})',?\s*(?:\/\/[^\n]*)?\n/g)]
  .map((m) => m[1])
  .filter((g) => /TRIGGER_ICON_PATHS/.test(source))
let iconSource = null
try {
  iconSource = await readFile(iconSourcePath, 'utf8')
} catch {
  iconSource = null
}
if (iconSource === null) {
  skipped += 1
  console.log(`  SKIP  trigger geometry matches the shipped icon — ${iconSourcePath} not readable`)
} else {
  // Find the artwork's path data under either icon naming generation.
  const artworkMatch = /ProjectAddOutlineArtwork[\s\S]*?<path d="(M[^"]+)"/.exec(iconSource)
    ?? /IconProjectAddOutline16[\s\S]*?<path[^>]*d="(M[^"]+)"/.exec(iconSource)
  const iconPath = artworkMatch?.[1]
  const known = /TRIGGER_ICON_PATHS = \[([\s\S]*?)\]/.exec(source)?.[1] ?? ''
  const listed = [...known.matchAll(/'((?:M)[^']+)'/g)].map((m) => m[1])
  // At least one listed geometry must be a real prefix of the shipped artwork.
  check('trigger geometry list covers the shipped add-workspace icon',
    listed.length >= 1
    && typeof iconPath === 'string' && iconPath.length >= 20
    && listed.some((geometry) => iconPath.startsWith(geometry)),
    `icon=${iconPath?.slice(0, 40)} known=[${listed.map((g) => g.slice(0, 18)).join('|')}]`)
}

const section = (start, end) => {
  const from = source.indexOf(start)
  if (from < 0) return ''
  const to = end === undefined ? source.length : source.indexOf(end, from + start.length)
  return source.slice(from, to < 0 ? source.length : to)
}
const picker = section('function openPicker')
check('validates the picked directory before adopting it',
  /checkPath'/.test(picker) && picker.indexOf("checkPath'") < picker.indexOf('workspaces.create'))
check('registers the workspace and opens the created session',
  picker.includes('ctx.workspaces.create({ path: facts.uncPath })')
  && picker.includes('ctx.uiWorkspace.openSession(sessionId)'))
// The harness fixes a session's preset at creation, so naming it afterwards is
// refused for any session that has taken a turn; the request must carry it.
check('names the WSL preset in the create request',
  picker.includes("call('wslPresetFor'")
  && picker.includes('agentPreset: preset.agentPreset')
  && !picker.includes('ctx.uiWorkspace.startSession('))
check('discards responses of a superseded directory listing', picker.includes('token !== state.token'))
check('gates browsing on the entered user, then lands in their home',
  picker.includes("state.phase = 'browse'")
  && picker.includes("call('resolveHome'")
  && picker.includes('username: name')
  && picker.includes('go(resolved.home)'))
check('switching distros re-prompts for the user',
  picker.includes('function chooseDistro(') && picker.includes('chooseDistro(name)'))
check('offers the distribution selector as themed buttons, not a <select>',
  picker.includes('function pill(') && !picker.includes("'select'"))
check('closes on Escape', picker.includes("event.key === 'Escape'"))
check('commits the path the operator typed, not the last navigated one',
  picker.includes('const target = state.draft')
  && picker.includes("call('checkPath', { distro: state.distro, path: target })"))
check('refuses to close while a commit is in flight', picker.includes('if (state.closed || state.working) return'))
check('re-checks cancellation after the create returns', picker.includes('if (state.closed) return'))

// A skip is a check that did not run; reporting it as a pass would make the
// suite's green meaningless exactly when the checkout is wrong. It gets its
// own exit code (2) so `verify-all` can show it as skipped without turning
// every machine without the harness checkout red.
console.log(`\n${failures === 0 ? `${checks - skipped} check(s) passed` : `${failures} check(s) failed`}`
  + `${skipped === 0 ? '' : `, ${skipped} skipped`}`)
process.exit(failures > 0 ? 1 : skipped > 0 ? 2 : 0)
