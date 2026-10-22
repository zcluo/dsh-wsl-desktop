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
import { blankLiterals } from './source-text.mjs'
import { argvFlag, checkoutDefault, makeChecker } from './suite-shell.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const clientPath = argvFlag('client', join(pluginRoot, 'lib', 'client.js'))
const checkout = argvFlag('checkout', checkoutDefault(pluginRoot))
const iconSourcePath = join(
  checkout, 'packages', 'client', 'ui-primitives', 'src', 'icons', 'index.tsx',
)

const checker = makeChecker()
const { check } = checker

/**
 * Read a file every assertion below depends on, reporting a FAIL instead of throwing.
 *
 * A missing browser half or manifest is a DEPLOYMENT fault, not a finding: both reads
 * used to throw out of the suite before any check printed, so the operator saw a stack
 * trace instead of the file that was missing. Nothing below can be measured without
 * them, so the FAIL names the path and the remedy, then the suite stops.
 * @param {string} path - the file to read.
 * @param {string} label - the row's label.
 * @returns {Promise<string>} the file's text, or never (the process stops).
 */
async function readRequired(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    check(label, false, `could not read ${path}: ${error?.message ?? error} — run scripts/sync.ps1 to re-stage the plugin, then re-run`)
    process.exit(1)
  }
}

const source = await readRequired(clientPath, 'the shipped browser half is readable')
let pkg
try {
  pkg = JSON.parse(await readRequired(join(pluginRoot, 'package.json'), 'the plugin manifest is readable'))
} catch (error) {
  check('the plugin manifest is valid JSON', false, `${error?.message ?? error}`)
  process.exit(1)
}

// `blankLiterals` moved to ./source-text.mjs when the fs fence needed the same
// scanner for its own structural pin: one owner per rule, and the one-pass
// rationale travels with the function.

/** Source with comments and string bodies blanked, for structural assertions. */
const code = blankLiterals(source)

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
// A namespaced key (`remote.session`) is a cordis idiom — it gates one remote
// namespace rather than a top-level service — so it is satisfied by the parent
// spelling, which is how the code reads it.
check('injects the services the picker reads',
  injected.length > 0 && injected.every((name) => code.includes(`ctx.${name}`) || code.includes(`ctx.${name.split('.')[0]}`)),
  `inject=[${injected.join(', ')}]`)
const reads = [...new Set([...code.matchAll(/ctx\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))]
  .filter((name) => !NON_SERVICE_MEMBERS.includes(name))
check('reads no service it did not inject',
  // `reads.length > 0` first: `[].every(...)` is true, so without it a client that
  // stopped reading any ctx. service would turn this row green while measuring
  // nothing — the sibling row three lines up guards exactly this way.
  reads.length > 0 && reads.every((name) => injected.includes(name)),
  `reads=[${reads.join(', ')}] inject=[${injected.join(', ')}]`)

check('releases the dialog and observer on dispose',
  /return \(\) => \{[\s\S]*?observer\.disconnect\(\)[\s\S]*?teardown\?\.\(\)/.test(code))
check('observes the document element, not a body that may not exist yet',
  code.includes('observer.observe(document.documentElement,')
  && !code.includes('observer.observe(document.body')
  && !code.includes('document.body.append'))
// What this row measures, and nothing more: the companion's STEADY-STATE visibility is a
// style write, and no interval drives the sync. It is NOT "never mutates the tree from the
// observed branch" — the client does remove nodes there (`button.remove()` when the anchor
// is gone, `mine.remove()` in syncWorkspaceIcons), so the earlier label claimed more than
// the assertion established. It reads the BLANKED code, for the reason the accessor pins
// below state: the raw text also carries this literal inside a comment, so `source` let a
// comment satisfy the row while the code itself stopped writing that value (measured: with
// the write replaced by a `visibility` write and the old spelling left in a comment above
// it, the raw-text form printed OK).
// ...and the blanked code cannot carry the literal verbatim: `blankLiterals` blanks the
// string BODIES inside it (`''` and `'none'` both become `''`), so the pin reads the
// assignment's SHAPE instead — a style write whose condition is `fits && triggerVisible`.
// Reading the raw text was what let a comment satisfy the row; reading the code's shape
// cannot be satisfied by prose.
check('the steady-state visibility is a style write, and no interval drives the sync',
  !code.includes('setInterval')
  && /button\.style\.display\s*=\s*fits\s*&&\s*triggerVisible\s*\?/.test(code))
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
// generation); the shipped icon source must contain at least one of them.
let iconSource = null
try {
  iconSource = await readFile(iconSourcePath, 'utf8')
} catch {
  iconSource = null
}
if (iconSource === null) {
  // The three-piece SKIP rule: the named precondition (the path is not readable),
  // WHICH assertion did not run, and the remedy. The sibling suite's skip names
  // all three too, so the two stay consistent with each other.
  checker.skip(1)
  console.log(`  SKIP  trigger geometry matches the shipped icon (1 check not evaluated) — ${iconSourcePath} not readable`)
  console.log('        Remedy: pass --checkout=<dsh checkout> or set DSH_CHECKOUT to the harness checkout carrying packages/client/ui-primitives.')
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
  && picker.includes('createBoundSession(ctx, workspace.workspaceId, preset.agentPreset)')
  && !picker.includes('ctx.uiWorkspace.startSession('))
// ...and it has to survive the trip. `ctx.sessions.create` (the client service
// wrapper) rebuilds its payload from `workspaceId | cwd | sessionId` alone and
// silently DROPS `agentPreset`, so the create goes through the generated remote
// contract that forwards it. The negative keeps the lossy spelling from coming
// back: it looks correct at the call site and only fails at runtime.
check('the create carries the preset through the remote contract',
  /ctx\.remote\?\.session\?\.create/.test(source)
  && /create\(\{ workspaceId, agentPreset \}\)/.test(source)
  && !/ctx\.sessions\.create\(\{[^}]*agentPreset/.test(source))
// The workspace snapshot source hangs off `ctx.workspaces.list`, and the hop a
// reader is most likely to omit is the one that fails SILENTLY: written as
// `ctx.workspaces.path` the lookup yields undefined and the whole feature does
// nothing while every check still passes — which is exactly how it first
// shipped. The contract record is the document that OWNS the claim, not a fixed
// filename: this mechanism lived in README.md and now lives in docs/ARCHITECTURE.md
// (the README was trimmed to an entry document), so the pin moved with the claim
// rather than being deleted or left pointing at a file that no longer makes it.
//
// The code pin reads the BLANKED source, and matches the optional-chaining
// spelling. The raw text also carries this path inside the `console.warn`
// message below the read, so matching it there passed for a reason that had
// nothing to do with what the code reads: with the accessor renamed to a member
// that does not exist — the original silent no-op — every check still went
// green. Prose keeps the plain `ctx.workspaces.list` spelling; the code needs
// the `?.`.
const WORKSPACE_ACCESSOR = 'ctx.workspaces.list'
// The member-name boundary is load-bearing, not decoration: a plain
// `includes('ctx.workspaces?.list')` also matches `ctx.workspaces?.listing`, a
// member that does not exist, so the pin went green on exactly the silent no-op
// it was written to catch.
check('the client half reads the workspace source off `list`',
  /ctx\.workspaces\?\.list(?![A-Za-z0-9_$])/.test(code))
{
  const doc = 'docs/ARCHITECTURE.md'
  const text = await readFile(join(pluginRoot, doc), 'utf8')
  check(`${doc} documents the accessor the code reads`, text.includes(WORKSPACE_ACCESSOR),
    `${doc} never names ${WORKSPACE_ACCESSOR}`)
}

// The document-pair parity rule ("the two editions of a document name the same repository
// artifacts") moved to scripts/verify-docs.mjs: it outgrew a single pair once `docs/` became
// bilingual, and a rule about documents belongs in the document suite. What stays here is the
// accessor pin above — a claim about the CLIENT code, pinned in the one document that owns it.
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
check('the picker bootstraps the catalog before discovering',
  source.includes("call('bootstrap'") && source.includes('bootstrapOnce('))
check('a host failure renders from its code, never the raw message',
  source.includes('failureOf(') && source.includes('failure.code') && !source.includes('state.error = message('))
check('a degraded picker is a rendered state, not a silent skip',
  picker.includes("state.phase = 'degraded'") && source.includes('data-wsl-degraded'))
check('a failure without a catalog falls back to built-in copy',
  source.includes('FALLBACK_MESSAGES') && source.includes('renderFailureNode('))
check('the browse phase renders the advisory health strip', source.includes('data-wsl-health'))
check('a missing sidebar anchor has a visible fallback entry', source.includes('data-wsl-fallback-entry'))
check('the W button advertises and tracks the dialog',
  source.includes("aria-haspopup") && source.includes("aria-expanded"))

console.log('\nlocalised copy and dialog accessibility')

/**
 * String literals with their source offsets, skipping comments.
 *
 * The scan below asks whether every Chinese literal sits inside a bilingual
 * structure. A regex cannot answer that (the file is full of zh/en pairs), so the
 * literals are tokenised and their positions checked against the structures.
 * @param {string} text - the client source.
 * @returns {{ start: number, text: string }[]} the literals.
 */
function stringLiterals(text) {
  const found = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      if (end < 0) break
      index = end + 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = index
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue }
        if (text[index] === char) { index += 1; break }
        index += 1
      }
      found.push({ start, text: text.slice(start + 1, index - 1) })
      continue
    }
    index += 1
  }
  return found
}

/**
 * The spans of the named top-level objects, closed by a line-initial `}`.
 * @param {string} text - the client source.
 * @param {string[]} names - the constant names.
 * @returns {{ start: number, end: number }[]} the spans.
 */
function objectSpans(text, names) {
  const spans = []
  for (const name of names) {
    const start = text.indexOf(`const ${name} = {`)
    if (start < 0) continue
    const lineStart = text.lastIndexOf('\n', start) + 1
    const indent = text.slice(lineStart, start).match(/^\s*/)[0]
    const end = text.indexOf(`\n${indent}}`, start)
    spans.push({ start, end: end < 0 ? text.length : end })
  }
  return spans
}

const allowedSpans = objectSpans(source, ['COPY', 'FALLBACK_MESSAGES', 'CHECK_STATUS_LABELS', 'DETAIL_ZH'])
const offCopy = []
for (const literal of stringLiterals(source)) {
  if (!/[\u4e00-\u9fff]/.test(literal.text)) continue
  const lineStart = source.lastIndexOf('\n', literal.start) + 1
  const line = source.slice(lineStart, source.indexOf('\n', literal.start)).trim()
  if (line.startsWith('console.')) continue
  if (allowedSpans.some((span) => literal.start > span.start && literal.start < span.end)) continue
  if (/t\(\s*$/.test(source.slice(Math.max(0, literal.start - 40), literal.start))) continue
  const lineNumber = source.slice(0, literal.start).split('\n').length
  offCopy.push(`L${lineNumber} ${literal.text.slice(0, 30)}`)
}
check('no user-visible copy bypasses the bilingual structures',
  offCopy.length === 0, offCopy.slice(0, 8).join(' | '))

const copyBlock = objectSpans(source, ['COPY'])[0]
check('the older dialog copy lives in one COPY table',
  copyBlock !== undefined && source.includes('function copy(') && source.includes("copy('trigger')"))
if (copyBlock !== undefined) {
  const block = source.slice(copyBlock.start, copyBlock.end)
  const keys = [...block.matchAll(/^\s+(\w+): \{ zh:/gm)].map((match) => match[1])
  const paired = [...block.matchAll(/^\s+(\w+): \{ zh: '.*', en: .* \},$/gm)].map((match) => match[1])
  check('every COPY key carries both languages on one line',
    keys.length > 10 && paired.length === keys.length, `keys=${keys.length} paired=${paired.length}`)
  check('COPY covers the trigger, the user gate and the commit buttons',
    ['trigger', 'distroLabel', 'userPlaceholder', 'createOpen'].every((key) => keys.includes(key)),
    keys.join(','))
}

check('the dialog is described by a stable description element', source.includes('aria-describedby'))
check('async health and copy feedback announce through a live region',
  source.includes("'aria-live'") && source.includes("role', 'status'"))
check('Tab is trapped inside the dialog',
  source.includes("event.key !== 'Tab'") || source.includes("event.key === 'Tab'"))
check('the client declares no transition or animation to reduce',
  !/\btransition\s*:/.test(source) && !/\banimation\s*:/.test(source))

// A skip is a check that did not run; reporting it as a pass would make the
// suite's green meaningless exactly when the checkout is wrong. It gets its own
// exit code (2), which `verify-all` shows as SKIP only because verify-client-ui.mjs
// is declared in scripts/verify-all.mjs's DECLARED_SKIPS with the precondition that
// justifies it: undeclared, the same exit 2 fails that run instead.
console.log(`\n${checker.failures === 0 ? `${checker.checks - checker.skipped} check(s) passed` : `${checker.failures} check(s) failed`}`
  + `${checker.skipped === 0 ? '' : `, ${checker.skipped} skipped`}`)
process.exit(checker.failures > 0 ? 1 : checker.skipped > 0 ? 2 : 0)
