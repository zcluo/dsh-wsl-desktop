/**
 * Behavioural checks on the browser half, in a real DOM.
 *
 * The static checker (`verify-client-ui.mjs`) only reads the source; this runs
 * the actual factory against a jsdom fixture shaped like the shipped sidebar
 * header, so it can observe what the file *does*: where the companion lands,
 * what it does when the row has no room, and — the reason this file exists —
 * whether its own work feeds back into the observer it runs from.
 *
 * A previous version removed the node to hide it, which is itself a childList
 * mutation on the observed subtree; the observer then re-inserted it and the
 * two looped at display refresh. Source checks passed that version.
 *
 * Run: node scripts/verify-client-dom.mjs [--checkout=<dsh checkout>] [--client=<file>]
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argvFlag, checkoutDefault, makeChecker } from './suite-shell.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const checkout = argvFlag('checkout', checkoutDefault(pluginRoot))
const clientPath = argvFlag('client', join(pluginRoot, 'lib', 'client.js'))

const checker = makeChecker()
const { check } = checker

// jsdom comes from the harness checkout's dev dependencies. A missing
// checkout is a SKIP (exit 2 — the contract verify-all documents), not a
// failure: an unguarded load crashes with exit 1 and reads as a false FAIL.
/**
 * The sections this suite evaluates, named so the SKIP below can say WHICH assertions
 * did not run instead of only why: a reader of the log has to be able to tell that the
 * whole swap / weight / restore / observer-budget set went unmeasured, not merely that
 * jsdom was missing.
 */
const SECTIONS = [
  'collapsed rail (no room for a third icon)',
  'inline search expanded (the shipped cluster hides itself)',
  'a second control sharing the trigger geometry',
  'a duplicate with no recognisable cluster',
  'WSL workspace rows',
]
let JSDOM
try {
  JSDOM = createRequire(join(checkout, 'package.json'))('jsdom').JSDOM
} catch {
  console.log(`SKIP  every assertion in this suite (${SECTIONS.length} sections: ${SECTIONS.join('; ')}) — jsdom unavailable, no harness checkout; pass --checkout=… or set DSH_CHECKOUT`)
  process.exit(2)
}
const source = await readFile(clientPath, 'utf8')

/** The shipped trigger icon's first path command, mirrored from the plugin. */
const TRIGGER_PATH = 'M3.55246 0L3.55246 2.44252L6 2.44252'

/** The trigger as every desktop up to 0.2.1-rc2 rendered it: inline geometry. */
const INLINE_TRIGGER_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path transform="translate(9.52 2.52)" d="${TRIGGER_PATH}" fill="currentColor"></path>
              <path transform="translate(0.3496 2.35)" d="M4.76367 0C5.36861 0" fill="currentColor"></path>
            </svg>`

/**
 * The trigger as 0.2.1-rc3 renders it: a sprite reference with NO path child.
 *
 * `ui-primitives` `c3eead771d` (0.2.1-rc3) moved every product icon into the
 * document icon sprite, so the add-workspace button renders
 * `<svg data-icon="dsw-icon-project-add-outline-regular"><use href="#…"/></svg>`.
 * The suffix in the symbol id is the WEIGHT, so the glyph name is the identity
 * that survives a weight change.
 */
const SPRITE_TRIGGER_ICON = '<svg width="16" height="16" data-icon="dsw-icon-project-add-outline-regular" aria-hidden="true"><use href="#dsw-icon-project-add-outline-regular"></use></svg>'

/**
 * The same sprite icon with no `data-icon`, which is how markup that a theme or
 * an older bundler rewrote reaches the page: only the `<use>` reference names it.
 */
const SPRITE_TRIGGER_USE_ONLY = '<svg width="16" height="16" aria-hidden="true"><use href="#dsw-icon-project-add-outline-regular"></use></svg>'

/**
 * Build the sidebar header fixture: the shipped action cluster holding the
 * view-options button and the add-workspace trigger, inside the section row.
 * @param {string} [extra] - extra markup appended inside the sidebar, for a case
 * that needs rows the header fixture does not carry.
 * @param {string} [triggerIcon] - the trigger's icon markup; defaults to the
 * inline-geometry generation, and the sprite cases pass their own.
 * @returns {{ dom: object, row: object, cluster: object, trigger: object }} the fixture.
 */
function fixture(extra = '', triggerIcon = INLINE_TRIGGER_ICON) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="sidebar">
      <div class="sectionHeader" id="row">
        <span class="sectionLabel">工作区</span>
        <div class="searchSlot"></div>
        <div class="headerActions" id="cluster">
          <button class="iconButton" id="view"></button>
          <button class="iconButton" id="trigger" aria-label="add workspace">
            ${triggerIcon}
          </button>
        </div>
      </div>
      ${extra}
      <style>
        .hidden { visibility: hidden; }
      </style>
    </div>
  </body></html>`, { pretendToBeVisual: true, runScripts: 'outside-only' })
  return {
    dom,
    row: dom.window.document.getElementById('row'),
    cluster: dom.window.document.getElementById('cluster'),
    trigger: dom.window.document.getElementById('trigger'),
  }
}

/**
 * Give every measured element a box, since jsdom lays nothing out.
 *
 * The cluster keeps its shipped max-content width (two 28px buttons in wide
 * mode, two 36px icons in the rail); the companion is placed after it, which is
 * exactly what a real flex row does.
 * @param {object} fixtureParts - the fixture.
 * @param {number} rowWidth - the section row's width in CSS pixels.
 * @param {number} clusterWidth - the shipped cluster's width.
 */
function layout({ dom, row, cluster }, rowWidth, clusterWidth) {
  const boxes = new Map([
    [row, { x: 12, width: rowWidth }],
    [cluster, { x: 12, width: clusterWidth }],
  ])
  dom.window.Element.prototype.getBoundingClientRect = function () {
    let box = boxes.get(this)
    if (box === undefined) {
      // The companion sits after its previous sibling, which is the cluster.
      const previous = this.previousElementSibling
      const before = previous === null ? { x: 12, width: 0 } : boxes.get(previous)
        ?? { x: 12, width: 0 }
      box = { x: before.x + before.width + 4, width: 28 }
    }
    return {
      x: box.x, y: 0, width: box.width, height: 28,
      left: box.x, top: 0, right: box.x + box.width, bottom: 28,
      toJSON: () => ({}),
    }
  }
}

/**
 * Mirror the real `workspaces.list`.
 *
 * Two facts about the shipped service both have to hold: the snapshot accessor
 * hangs off `list`, NOT off the service object (an earlier stub that put
 * `getSnapshot` here directly is exactly why a wrong accessor passed this suite
 * while the running app kept rendering folders), and a REPLACED snapshot notifies
 * subscribers — that notification is how a re-pointed workspace reaches the plugin,
 * because the row markup does not move on its own. The first stub accepted a
 * listener and never called one, which under-mirrored the API and made a
 * store-only change invisible to the half under test.
 * @param {{ items: object[] }} state - the mutable snapshot object the case owns.
 * @returns {{ getSnapshot: () => object, subscribe: (listener: () => void) => () => void }}
 */
function workspaceStore(state) {
  const listeners = new Set()
  let items = state.items
  Object.defineProperty(state, 'items', {
    configurable: true,
    get: () => items,
    set: (value) => {
      items = value
      for (const listener of listeners) listener()
    },
  })
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/**
 * Load the browser half and apply it against a stub client context.
 * @param {object} dom - the jsdom window owner.
 * @param {{ items: object[] } | undefined} [workspaceState] - the mutable snapshot
 * the `workspaces.list` stub serves; omitted by every case written before
 * workspace rows existed, so those keep exercising the context they always did.
 * @param {((url: string, init: object) => Promise<object>) | undefined} [fetchImpl] - the
 * route stub a click-driven case needs; jsdom carries no fetch of its own.
 * @returns {{ button: object|null, dispose: () => void, mutations: () => number }} the live plugin.
 */
function apply(dom, workspaceState, fetchImpl, overrides = {}) {
  let registration = null
  dom.window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
  if (fetchImpl !== undefined) dom.window.fetch = fetchImpl
  dom.window.eval(source)
  const module = registration.factory()
  const disposers = []
  module.apply({
    effect: (callback) => { disposers.push(callback()) },
    workspaces: {
      create: async () => ({ workspaceId: 'w' }),
      // Mirrors IWorkspaces: the snapshot source hangs off `list`, NOT off the
      // service object. An earlier stub that put `getSnapshot` here directly is
      // exactly why a wrong accessor passed this suite while the running app
      // kept rendering folders — the fixture has to encode the real contract.
      // Absent by default, so cases written before workspace rows existed keep
      // exercising the context they always did.
      ...(workspaceState === undefined ? {} : { list: workspaceStore(workspaceState) }),
    },
    uiWorkspace: { startSession: () => {}, openSession: () => {} },
    // The capability probe reads these paths; a case that expects the picker to
    // be healthy has to provide them, exactly like the injected services.
    remote: { session: { create: async () => ({ ok: true, value: { sessionId: 's' } }) } },
    sessions: { create: async () => ({ sessionId: 's' }) },
    ...overrides,
  })
  let mutations = 0
  const counter = new dom.window.MutationObserver((records) => { mutations += records.length })
  counter.observe(dom.window.document.documentElement, { childList: true, subtree: true })
  return {
    button: dom.window.document.querySelector('[data-wsl-desktop="workspace-trigger"]'),
    dispose: () => { for (const dispose of disposers) dispose() },
    mutations: () => mutations,
  }
}

/** Let the plugin's rAF-scheduled work settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 250) })

/**
 * Count the paths that actually match the plugin's anchor geometry.
 * @param {object} dom - the jsdom window owner.
 * @returns {number} matching path count.
 */
function matchingPaths(dom) {
  return [...dom.window.document.querySelectorAll('svg > path[d]')]
    .filter((path) => path.getAttribute('d').startsWith(TRIGGER_PATH)).length
}

/**
 * Present one physical binding the way the live shortcut service does on a
 * Windows device: plus-separated modifiers and one ARIA string. Mirrored here
 * rather than imported so the fixture asserts the contract the browser half
 * actually receives, including the `primary` expansion that makes Ctrl+Alt+W.
 * @param {{ code: string, modifiers: string[] } | null} binding - the binding.
 * @returns {{ keys: string[], aria: string | undefined }} the presented labels.
 */
function presentBinding(binding) {
  if (binding === null) return { keys: [], aria: undefined }
  const modifiers = binding.modifiers.map((value) => (value === 'primary' ? 'control' : value))
  const key = binding.code.startsWith('Key') ? binding.code.slice(3) : binding.code
  const symbols = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' }
  const ariaNames = { control: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Meta' }
  const labels = modifiers.map((value) => symbols[value])
  return {
    keys: [...labels, key].flatMap((label, index) => (index === 0 ? [label] : ['+', label])),
    aria: [...modifiers.map((value) => ariaNames[value]), key].join('+'),
  }
}

/**
 * Mirror the shell's shortcut service: command registration plus the effective
 * catalog the W hint reads. The catalog row is DERIVED from the registered
 * command's Windows default, so a wrong default cannot hide behind a stub; the
 * rebind handle below stands in for a user edit in the shortcut settings.
 * @returns {{ service: object, commands: Map<string, object>, rebind: Function,
 *   subscribeCount: () => number }} the stub and its inspection handles.
 */
function shortcutService() {
  const listeners = new Set()
  const commands = new Map()
  const overrides = new Map()
  let rows = []
  let disposeCalls = 0
  const rowOf = (command) => {
    const binding = overrides.has(command.id)
      ? overrides.get(command.id)
      : command.defaults['desktop:windows'] ?? null
    const presented = presentBinding(binding)
    // A cleared binding keeps the row (the live catalog does) with no keys and
    // no ARIA, which is exactly what a hint must stop claiming.
    return {
      id: command.id, label: command.label(), aliases: command.aliases,
      keys: presented.keys, aria: presented.aria, binding,
      modified: overrides.has(command.id), conflicts: [], issue: null,
    }
  }
  const publish = () => {
    rows = [...commands.values()].map(rowOf)
    for (const listener of [...listeners]) listener()
  }
  const service = {
    platform: 'windows',
    runtime: 'desktop',
    catalog: {
      getSnapshot: () => rows,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    register: (command) => {
      if (commands.has(command.id)) throw new Error(`duplicate shortcut command: ${command.id}`)
      // The live service validates EVERY profile's defaults at registration,
      // not only the running one. A default that collides with another
      // command's web binding therefore refuses registration on the desktop
      // too — the failure the page-close seed below reproduces.
      const normalize = (binding, platform) => {
        const modifiers = new Set(binding.modifiers.map((value) => (value === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : value)))
        return { code: binding.code, modifiers: ['control', 'alt', 'shift', 'meta'].filter((value) => modifiers.has(value)) }
      }
      const overlaps = (left, right) => left.code === right.code && left.modifiers.join('+') === right.modifiers.join('+')
      for (const runtime of ['desktop', 'web']) {
        for (const platform of ['macos', 'windows', 'linux']) {
          const mine = command.defaults[`${runtime}:${platform}`]
          if (mine === undefined) continue
          for (const existing of commands.values()) {
            const other = existing.defaults[`${runtime}:${platform}`]
            if (other === undefined) continue
            if (overlaps(normalize(mine, platform), normalize(other, platform))) {
              throw new Error(`Conflicting shortcut defaults: ${command.id} and ${existing.id} (${runtime}:${platform})`)
            }
          }
        }
      }
      commands.set(command.id, command)
      publish()
      return () => { commands.delete(command.id); disposeCalls += 1; publish() }
    },
  }
  return {
    service,
    commands,
    rebind: (id, binding) => { overrides.set(id, binding); publish() },
    subscribeCount: () => listeners.size,
    disposeCalls: () => disposeCalls,
  }
}

console.log(`running ${clientPath} in jsdom\n`)

console.log('wide sidebar')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  check('the companion button exists', live.button !== null)
  check('it is a sibling of the shipped action cluster',
    live.button?.parentElement === parts.row && live.button?.previousElementSibling === parts.cluster,
    `parent=${live.button?.parentElement?.id} previous=${live.button?.previousElementSibling?.id}`)
  check('it is rendered where the row has room', live.button?.style.display === '',
    `display=${JSON.stringify(live.button?.style.display)}`)
  check('it carries the shipped icon-button class', live.button?.className === 'iconButton')
  live.dispose()
  check('dispose removes it', parts.dom.window.document.querySelector('[data-wsl-desktop]') === null)
}

console.log('\nthe W shortcut hint')
{
  // One registered command, its effective catalog row, and the aria claim that
  // turns the row into an assistive-technology shortcut.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  const command = shortcuts.commands.get('wsl.workspace.open')
  check('the W button registers one shortcut command',
    shortcuts.commands.size === 1 && command !== undefined, [...shortcuts.commands.keys()])
  check('the shortcut defaults to Ctrl+Alt+W on the Windows desktop profile',
    command?.defaults?.['desktop:windows']?.code === 'KeyW'
    && command?.defaults?.['desktop:windows']?.modifiers?.join('+') === 'primary+alt',
    command?.defaults)
  check('the command declares no Web default, which page.close already owns as Ctrl+Alt+W',
    command?.defaults?.['web:windows'] === undefined && command?.defaults?.['web:macos'] === undefined,
    command?.defaults)
  check('the command carries the W action label and both input regions',
    command?.label?.() === 'Add a WSL workspace'
    && command?.regions?.includes('page') === true
    && command?.regions?.includes('editable') === true
    && command?.regions?.includes('terminal') !== true,
    { label: command?.label?.(), regions: command?.regions })
  check('the command allows the sidebar modal, as the shipped add command does',
    command?.modals?.includes('sidebar') === true, command?.modals)
  check('the W button advertises the effective binding',
    live.button?.getAttribute('aria-keyshortcuts') === 'Control+Alt+W',
    live.button?.getAttribute('aria-keyshortcuts'))
  check('the W button no longer depends on the native title tooltip',
    live.button?.hasAttribute('title') !== true)

  // The bubble itself: portaled, labelled, and carrying the catalog's keys.
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const doc = parts.dom.window.document
  const bubble = doc.querySelector('[data-wsl-shortcut-tooltip]')
  check('hovering the W button reveals the shortcut tooltip',
    bubble !== null && bubble.style.display !== 'none',
    `display=${JSON.stringify(bubble?.style.display)}`)
  check('the tooltip is portaled beside the page, not clipped inside the header',
    bubble?.parentElement === doc.body && bubble?.style.position === 'fixed',
    `parent=${bubble?.parentElement?.tagName} position=${bubble?.style.position}`)
  check('the tooltip names the W action',
    bubble?.querySelector('[data-wsl-tooltip-label]')?.textContent === 'Add a WSL workspace',
    bubble?.querySelector('[data-wsl-tooltip-label]')?.textContent)
  check('the tooltip renders the effective keycaps',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent).join(' ') === 'Ctrl + Alt + W',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent))
  check('the tooltip is a visual aid, not a second accessible name',
    bubble?.getAttribute('role') === 'tooltip' && bubble?.getAttribute('aria-hidden') === 'true')
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerleave'))
  check('leaving the button hides the tooltip', bubble?.style.display === 'none')

  // Keyboard focus raises the same bubble. A pointer-acquired focus stays
  // quiet, so closing the picker back onto the button does not flash it.
  doc.documentElement.dataset.inputModality = 'pointer'
  live.button?.focus()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  check('a pointer-acquired focus does not raise the tooltip', bubble?.style.display === 'none')
  delete doc.documentElement.dataset.inputModality
  live.button?.blur()
  live.button?.focus()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  check('keyboard focus raises the tooltip too',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)

  // The shipped Tooltip keeps hover and focus as INDEPENDENT triggers: hovering
  // away from a focused anchor must not drop the bubble, and blurring while the
  // pointer is still over the anchor must not drop it either. Only the last
  // trigger clearing withdraws it.
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerleave'))
  check('pointer leave keeps the tooltip while the button stays focused',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  live.button?.blur()
  check('blur hides the tooltip once focus is gone', bubble?.style.display === 'none')

  live.button?.focus()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  live.button?.blur()
  check('blur keeps the tooltip while the pointer stays over the button',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerleave'))
  check('leaving hides the tooltip once focus is gone', bubble?.style.display === 'none')

  // A rebind in the shortcut settings is a catalog replacement; the hint must
  // follow it rather than keep the default it first saw.
  shortcuts.rebind('wsl.workspace.open', { code: 'KeyW', modifiers: ['control', 'shift'] })
  await settle()
  check('rebinding updates aria-keyshortcuts',
    live.button?.getAttribute('aria-keyshortcuts') === 'Control+Shift+W',
    live.button?.getAttribute('aria-keyshortcuts'))
  check('rebinding updates the visible keycaps',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent).join(' ') === 'Ctrl + Shift + W',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent))
  shortcuts.rebind('wsl.workspace.open', null)
  await settle()
  check('clearing the binding drops the aria claim',
    live.button?.hasAttribute('aria-keyshortcuts') !== true)
  check('clearing the binding leaves only the action name on the tooltip',
    bubble?.querySelectorAll('kbd')?.length === 0
    && bubble?.querySelector('[data-wsl-tooltip-label]')?.textContent === 'Add a WSL workspace',
    bubble?.querySelectorAll('kbd')?.length)

  live.button?.dispatchEvent(new parts.dom.window.Event('pointerleave'))
  check('the command and one catalog subscription are live while mounted',
    shortcuts.commands.size === 1 && shortcuts.subscribeCount() === 1,
    `commands=${shortcuts.commands.size} subscriptions=${shortcuts.subscribeCount()}`)
  live.dispose()
  check('dispose unregisters the shortcut command',
    shortcuts.commands.size === 0 && shortcuts.disposeCalls() === 1,
    `commands=${shortcuts.commands.size} disposals=${shortcuts.disposeCalls()}`)
  check('dispose releases the catalog subscription and the tooltip bubble',
    shortcuts.subscribeCount() === 0 && doc.querySelector('[data-wsl-shortcut-tooltip]') === null,
    `subscriptions=${shortcuts.subscribeCount()} bubbles=${doc.querySelectorAll('[data-wsl-shortcut-tooltip]').length}`)
}

console.log('\nthe shortcut tooltip follows the button out of view')
{
  // Inline search expansion hides the shipped action cluster, and the plugin
  // hides the companion with it. The pointer never leaves the button (it left
  // the hit-test tree), so no pointerleave is guaranteed; the tooltip must be
  // withdrawn by the same layout pass that hides the button.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  const doc = parts.dom.window.document
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = doc.querySelector('[data-wsl-shortcut-tooltip]')
  check('the tooltip is visible before the header hides it',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  parts.cluster.classList.add('hidden')
  parts.row.append(doc.createElement('i'))
  await settle()
  check('hiding the companion withdraws its tooltip',
    bubble !== null && bubble.style.display === 'none', bubble?.style.display)

  // The layout-driven withdrawal must also CLEAR the triggers, like the shipped
  // Tooltip's disabled effect. Otherwise the stale hover survives the hide: after
  // the header returns and the button is focused then blurred, the old hover
  // would keep the bubble on screen with no pointer over the anchor.
  parts.cluster.classList.remove('hidden')
  parts.row.append(doc.createElement('i'))
  await settle()
  check('the companion returns when the header shows it again',
    live.button?.style.display === '', live.button?.style.display)
  live.button?.focus()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  check('focus after the return shows the hint again',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  live.button?.blur()
  check('blur after a layout-driven hide does not resurrect the stale hover',
    bubble?.style.display === 'none', bubble?.style.display)
  live.dispose()
}
{
  // A React replacement can take the trigger (and the companion with it) out of
  // the document while the tooltip is showing; the hint must not outlive it.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  const doc = parts.dom.window.document
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = doc.querySelector('[data-wsl-shortcut-tooltip]')
  check('the tooltip is visible before the anchor is detached',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  parts.trigger.remove()
  parts.row.append(doc.createElement('i'))
  await settle()
  check('removing the anchor withdraws the tooltip too',
    bubble !== null && bubble.style.display === 'none', bubble?.style.display)
  live.dispose()
}

console.log('\nthe shortcut tooltip refuses a zero-area anchor')
{
  // Closing the picker refocuses its opener. If that opener is inside a
  // subtree that is already hidden, its box is zero; placing a fixed bubble
  // from that box would paint it at the viewport origin.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  parts.dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON: () => ({}) }
  }
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = parts.dom.window.document.querySelector('[data-wsl-shortcut-tooltip]')
  check('a zero-area anchor does not raise the tooltip',
    bubble === null || bubble.style.display === 'none', bubble?.style.display)
  live.dispose()
}

{
  // A media query can collapse the header on resize without a DOM mutation, so
  // the layout pass never runs. The resize handler must not reposition a bubble
  // from a zero box; it has to withdraw it.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  const doc = parts.dom.window.document
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = doc.querySelector('[data-wsl-shortcut-tooltip]')
  check('the tooltip is visible before the resize',
    bubble !== null && bubble.style.display !== 'none', bubble?.style.display)
  parts.dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0, toJSON: () => ({}) }
  }
  parts.dom.window.dispatchEvent(new parts.dom.window.Event('resize'))
  check('a resize that collapses the anchor withdraws the tooltip',
    bubble !== null && bubble.style.display === 'none', bubble?.style.display)
  live.dispose()
}

console.log('\nthe degraded entry advertises the shortcut')
{
  // The fallback chip is the only visible entry while the sidebar anchor is
  // missing; the shortcut still works then, so the claim belongs on it too.
  const parts = fixture()
  parts.trigger.remove()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const realSetTimeout = parts.dom.window.setTimeout
  parts.dom.window.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 5000 ? 20 : ms, ...args)
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  const open = parts.dom.window.document.querySelector('[data-wsl-fallback-entry]')
  check('the degraded entry carries the effective binding',
    open?.getAttribute('aria-keyshortcuts') === 'Control+Alt+W',
    open?.getAttribute('aria-keyshortcuts'))
  shortcuts.rebind('wsl.workspace.open', { code: 'KeyW', modifiers: ['control', 'shift'] })
  await settle()
  check('a rebind reaches the degraded entry too',
    open?.getAttribute('aria-keyshortcuts') === 'Control+Shift+W',
    open?.getAttribute('aria-keyshortcuts'))
  live.dispose()
}

console.log('\nthe shortcut catalog failing does not take the button down')
{
  // The shortcut service is injected, so a throwing catalog means the shell is
  // already broken. The hint is still peripheral: a failed read must not abort
  // the install that owns the W button and its picker.
  const parts = fixture()
  layout(parts, 344, 60)
  const warnings = []
  const originalWarn = parts.dom.window.console.warn
  parts.dom.window.console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const broken = {
    register: () => () => {},
    catalog: {
      getSnapshot: () => { throw new Error('catalog down') },
      subscribe: () => { throw new Error('subscribe down') },
    },
  }
  let thrown = null
  let live = null
  try {
    live = apply(parts.dom, { items: [] }, undefined, { shortcuts: broken })
  } catch (error) {
    thrown = error
  }
  await settle()
  parts.dom.window.console.warn = originalWarn
  check('a broken shortcut catalog does not take the W button down',
    live?.button?.isConnected === true, thrown?.message)
  check('a broken shortcut catalog does not claim a binding',
    live?.button?.hasAttribute('aria-keyshortcuts') !== true)
  check('a broken shortcut catalog is reported on the console',
    warnings.some((line) => line.includes('快捷键')), warnings)
  live?.dispose()
}

console.log('\nthe shortcut coexists with the shell page-close defaults')
{
  // ui-sidebar-right's page.close uses KeyW+primary+alt on web:windows (and
  // web:macos); the live registry validates every profile's defaults, so a
  // Ctrl+Alt+W web default on our command makes registration throw even on a
  // desktop runtime. This is the live failure the jsdom fixture now models.
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  shortcuts.service.register({
    id: 'page.close',
    label: () => 'Close page',
    aliases: ['close', 'page'],
    defaults: {
      'desktop:windows': { code: 'KeyW', modifiers: ['primary'] },
      'web:windows': { code: 'KeyW', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyW', modifiers: ['primary', 'alt'] },
    },
    regions: ['page'],
    modals: [],
    resolve: () => ({ status: 'pass' }),
  })
  const warnings = []
  const originalWarn = parts.dom.window.console.warn
  parts.dom.window.console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: shortcuts.service })
  await settle()
  parts.dom.window.console.warn = originalWarn
  const command = shortcuts.commands.get('wsl.workspace.open')
  check('the W shortcut registers beside page.close instead of being refused',
    command !== undefined, warnings)
  check('the W button still advertises Ctrl+Alt+W next to page.close',
    live.button?.getAttribute('aria-keyshortcuts') === 'Control+Alt+W',
    live.button?.getAttribute('aria-keyshortcuts'))
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = parts.dom.window.document.querySelector('[data-wsl-shortcut-tooltip]')
  check('the tooltip still carries the keycaps beside page.close',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent).join(' ') === 'Ctrl + Alt + W',
    [...(bubble?.querySelectorAll('kbd') ?? [])].map((key) => key.textContent))
  live.dispose()
}

console.log('\nthe shortcut opens the picker')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const shortcuts = shortcutService()
  const stub = routeStub({
    bootstrap: () => healthyBootstrap(),
    listDistros: () => ({ ok: true, value: [] }),
    defaultDistro: () => ({ ok: true, value: { distro: 'debian' } }),
  })
  const live = apply(parts.dom, { items: [] }, stub, { shortcuts: shortcuts.service })
  await settle()
  const command = shortcuts.commands.get('wsl.workspace.open')
  const resolution = command?.resolve?.({ region: 'page', modal: null, target: null })
  check('the shortcut resolves as a handled action', resolution?.status === 'handled', resolution?.status)
  resolution?.run?.()
  await settle()
  const dialog = parts.dom.window.document.querySelector('[role="dialog"]')
  check('running the shortcut opens the same W dialog as the button',
    dialog !== null && dialog.getAttribute('aria-label') === 'Add a WSL workspace',
    dialog?.getAttribute('aria-label'))
  check('the shortcut starts the picker bootstrap rather than a bare overlay',
    stub.calls.includes('bootstrap') === true, stub.calls)
  live.dispose()
}

console.log('\nthe W shortcut degrades without taking the button down')
{
  // A desktop whose shortcut catalog refuses this default (another plugin owns
  // Ctrl+Alt+W) must keep the W button; only the keycap claim disappears.
  const parts = fixture()
  layout(parts, 344, 60)
  const warnings = []
  const originalWarn = parts.dom.window.console.warn
  parts.dom.window.console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  const refusing = {
    register: () => { throw new Error('reserved shortcut default') },
    catalog: { getSnapshot: () => [], subscribe: () => () => {} },
  }
  const live = apply(parts.dom, { items: [] }, undefined, { shortcuts: refusing })
  await settle()
  parts.dom.window.console.warn = originalWarn
  check('a refused registration leaves the W button mounted',
    live.button?.isConnected === true)
  check('a refused registration does not claim a shortcut',
    live.button?.hasAttribute('aria-keyshortcuts') !== true)
  check('a refused registration is reported on the console',
    warnings.some((line) => line.includes('快捷键')), warnings)
  live.dispose()
}
{
  // The inject declaration gates activation on a real host, but the apply path
  // still has to tolerate a context without the service (a harness that calls
  // apply directly, or a future detached shell). The button and the label-only
  // tooltip must work, and nothing may claim a key binding.
  const parts = fixture()
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  const doc = parts.dom.window.document
  check('without the shortcut service the W button still mounts',
    live.button?.isConnected === true)
  check('without the shortcut service no aria binding is claimed',
    live.button?.hasAttribute('aria-keyshortcuts') !== true)
  live.button?.dispatchEvent(new parts.dom.window.Event('pointerenter'))
  await new Promise((resolve) => { setTimeout(resolve, 600) })
  const bubble = doc.querySelector('[data-wsl-shortcut-tooltip]')
  check('without the shortcut service the tooltip still names the action',
    bubble?.style.display !== 'none'
    && bubble?.querySelector('[data-wsl-tooltip-label]')?.textContent === 'Add a WSL workspace',
    bubble?.querySelector('[data-wsl-tooltip-label]')?.textContent)
  check('without the shortcut service the tooltip carries no keycaps',
    bubble?.querySelectorAll('kbd')?.length === 0,
    bubble?.querySelectorAll('kbd')?.length)
  live.dispose()
}

console.log('\ncollapsed rail (no room for a third icon)')
{
  const parts = fixture()
  layout(parts, 56, 72)
  const live = apply(parts.dom)
  await settle()
  check('the companion stays attached', live.button?.isConnected === true)
  check('it is hidden rather than removed', live.button?.style.display === 'none',
    `display=${JSON.stringify(live.button?.style.display)}`)
  const before = live.mutations()
  // Longer than the 2s re-entry interval the original defect was seeded by, so
  // a design that feeds its own observer has time to show it.
  await new Promise((resolve) => { setTimeout(resolve, 2600) })
  const after = live.mutations()
  // The loop this guards against produced ~30 cycles/second; a settled plugin
  // produces a handful of unrelated mutations (the counter's own bookkeeping).
  console.log(`        ${after - before} childList record(s) in 2.6s`)
  check('its own work settles instead of feeding the observer',
    after - before <= 2, `${after - before} childList records in 2.6s`)
  live.dispose()
}

console.log('\ninline search expanded (the shipped cluster hides itself)')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  parts.cluster.classList.add('hidden')
  // A mutation elsewhere in the tree is what re-runs the plugin's sync.
  parts.row.append(parts.dom.window.document.createElement('i'))
  await settle()
  check('the companion follows the shipped actions into hiding',
    live.button?.style.display === 'none', `display=${JSON.stringify(live.button?.style.display)}`)
  parts.cluster.classList.remove('hidden')
  parts.row.append(parts.dom.window.document.createElement('i'))
  await settle()
  check('and returns with them', live.button?.style.display === '')
  live.dispose()
}

console.log('\na second control sharing the trigger geometry')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const intruder = parts.dom.window.document.createElement('button')
  const svg = parts.dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const path = parts.dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', TRIGGER_PATH)
  svg.append(path)
  intruder.append(svg)
  parts.dom.window.document.body.append(intruder)
  check('the fixture really presents two candidate controls',
    matchingPaths(parts.dom) === 2, matchingPaths(parts.dom))
  const live = apply(parts.dom)
  await settle()
  check('the shipped cluster still wins the anchor',
    live.button?.isConnected === true && live.button?.previousElementSibling === parts.cluster,
    `connected=${live.button?.isConnected} previous=${live.button?.previousElementSibling?.id}`)
  live.dispose()
}

console.log('\nthe sprite-refactored trigger (0.2.1-rc3)')
{
  // The regression this section exists for: 0.2.1-rc3 rendered the same button
  // through the document icon sprite, so it carried no `<path>` at all. A
  // geometry-only scan found no anchor, the companion stood down, and the W
  // button disappeared from every sidebar — while both suites stayed green,
  // because the whole fixture tree was inline-geometry markup.
  const parts = fixture('', SPRITE_TRIGGER_ICON)
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  check('the companion attaches to a sprite-rendered trigger too',
    live.button !== null && live.button.previousElementSibling === parts.cluster,
    `button=${live.button === null ? 'absent' : 'present'}`)
  check('and is rendered rather than hidden as a fallback',
    live.button?.style.display === '', `display=${JSON.stringify(live.button?.style.display)}`)
  live.dispose()
}
{
  // A `<use>`-only icon carries the same identity, so a rewrite that drops
  // `data-icon` must not take the button down again.
  const parts = fixture('', SPRITE_TRIGGER_USE_ONLY)
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  check('a <use>-only icon identifies the trigger by its symbol reference',
    live.button?.isConnected === true,
    `button=${live.button === null ? 'absent' : 'present'}`)
  live.dispose()
}
{
  // The inverse: an unrelated sprite icon must NOT be adopted as the anchor,
  // or the companion would attach beside a stranger.
  const parts = fixture('', '<svg width="16" height="16" data-icon="dsw-icon-settings-outline-regular" aria-hidden="true"><use href="#dsw-icon-settings-outline-regular"></use></svg>')
  layout(parts, 344, 60)
  const live = apply(parts.dom)
  await settle()
  check('an unrelated sprite glyph is not mistaken for the trigger',
    live.button?.isConnected !== true,
    `button=${live.button === null ? 'absent' : 'present'}`)
  live.dispose()
}

console.log('\na duplicate with no recognisable cluster')
{
  const parts = fixture()
  layout(parts, 344, 60)
  // Neither candidate is inside a `*_headerActions` cluster, so the companion
  // has no way to tell which control the operator meant.
  parts.cluster.className = 'somethingElse'
  const clone = parts.cluster.cloneNode(true)
  parts.dom.window.document.body.append(clone)
  const live = apply(parts.dom)
  await settle()
  check('the companion stands down rather than guessing the anchor',
    live.button?.isConnected !== true, `button=${live.button === null ? 'absent' : 'present'}`)
  live.dispose()
}

/**
 * One shipped workspace row in the 0.2.1-rc3 sprite generation.
 *
 * The folder icon is no longer inline artwork: it is a sprite reference with no
 * `<path>` child, so the weight lives in the SYMBOL the row's `<svg>` names. A
 * detector reading only inline paths saw no stroked path and called every such
 * row fill-only, which painted the solid cloud on a collapsed row.
 * @param {string} id - workspace id, as it appears in data-row-key.
 * @param {string} label - the workspace name.
 * @param {boolean} [expanded] - whether the row renders its open icon.
 * @returns {string} the row markup.
 */
function spriteWorkspaceRow(id, label, expanded = false) {
  const glyph = expanded ? 'folder-open' : 'folder-close'
  const icon = `<svg width="16" height="16" data-icon="dsw-icon-${glyph}-regular" aria-hidden="true"><use href="#dsw-icon-${glyph}-regular"></use></svg>`
  return `<div class="projectRow" data-row-key="workspace:${id}" role="treeitem">
        <span class="slot folder">${icon}</span>
        <span class="projectText"><span class="title">${label}</span></span>
      </div>`
}

/**
 * The document sprite the icon references resolve against.
 *
 * Only the two folder glyphs carry artwork here, with exactly the weights the
 * shipped table gives them: `folder-close` is a 1px STROKED outline and
 * `folder-open` is FILL-only. The plugin reads this, not a hardcoded list.
 * @returns {string} the sprite markup.
 */
const FOLDER_SPRITE = `<svg aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <symbol id="dsw-icon-folder-close-regular" viewBox="0 0 16 16" fill="none" stroke-width="1"><path d="M1 3h5l1 1h8v9H1z" stroke="currentColor"></path></symbol>
  <symbol id="dsw-icon-folder-open-regular" viewBox="0 0 16 16" fill="none"><path d="M1 3h5l1 1h8v9H1z" fill="currentColor"></path></symbol>
</svg>`


/**
 * One shipped workspace row in the inline generation (before 0.2.1-rc3): the
 * leading folder slot React renders, the chevron that shares its size, and the
 * row key that carries the workspace id.
 * The leading icon mirrors the shipped artwork per state: collapsed renders the
 * STROKED outline (`IconFolderCloseRegular`), expanded the FILL-only one
 * (`IconFolderOpenRegular`). The cloud is expected to follow that weight.
 * @param {string} id - workspace id, as it appears in data-row-key.
 * @param {string} label - the workspace name.
 * @param {boolean} [expanded] - whether the row renders its open icon.
 * @returns {string} the row markup.
 */
/**
 * One shipped workspace row in the inline generation (before 0.2.1-rc3): the
 * leading folder slot React renders, the chevron that shares its size, and the
 * row key that carries the workspace id.
 * The leading icon mirrors the shipped artwork per state: collapsed renders the
 * STROKED outline (`IconFolderCloseRegular`), expanded the FILL-only one
 * (`IconFolderOpenRegular`). The cloud is expected to follow that weight.
 * @param {string} id - workspace id, as it appears in data-row-key.
 * @param {string} label - the workspace name.
 * @param {boolean} [expanded] - whether the row renders its open icon.
 * @returns {string} the row markup.
 */
function workspaceRow(id, label, expanded = false) {
  const folder = expanded
    ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1 3h5l1 1h8v9H1z" fill="currentColor"></path></svg>'
    : '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke-width="1"><path d="M1 3h5l1 1h8v9H1z" stroke="currentColor"></path></svg>'
  return `<div class="projectRow" data-row-key="workspace:${id}" role="treeitem">
        <span class="slot folder">${folder}</span>
        <span class="slot chevron"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4z" fill="currentColor"></path></svg></span>
        <span class="projectText"><span class="title">${label}</span></span>
      </div>`
}

console.log('\nWSL workspace rows')
{
  /** Windows-spelled UNC paths, assembled so the backslashes stay readable. */
  const WSL_UNC = ['', '', 'wsl.localhost', 'debian', 'home', 'me', 'proj'].join('\\')
  const LEGACY_UNC = ['', '', 'wsl$', 'ubuntu', 'srv'].join('\\')
  const WIN_PATH = ['E:', 'projects', 'win'].join('\\')
  const state = {
    items: [
      { workspaceId: 'wsl', path: WSL_UNC },
      { workspaceId: 'legacy', path: LEGACY_UNC },
      { workspaceId: 'win', path: WIN_PATH },
    ],
  }
  const parts = fixture(workspaceRow('wsl', 'proj') + workspaceRow('legacy', 'srv') + workspaceRow('win', 'win'))
  layout(parts, 344, 60)
  const live = apply(parts.dom, state)
  await settle()
  const doc = parts.dom.window.document
  const row = (id) => doc.querySelector(`[data-row-key="workspace:${id}"]`)
  const cloud = (id) => row(id).querySelector('svg[data-wsl-cloud]')
  const shipped = (id) => row(id).querySelector('span.folder > svg:not([data-wsl-cloud])')
  // The precondition the whole section reads through: without the shipped
  // folder icon there is nothing to swap, and a broken fixture must say so in
  // one FAIL rather than throw and take the remaining checks down with it.
  check('the fixture renders a folder slot on every row',
    shipped('wsl') !== null && shipped('legacy') !== null && shipped('win') !== null,
    `wsl=${shipped('wsl') !== null} legacy=${shipped('legacy') !== null} win=${shipped('win') !== null}`)
  check('a WSL workspace row shows the cloud', cloud('wsl') !== null)
  check('the cloud names its distribution', cloud('wsl')?.getAttribute('data-wsl-cloud') === 'debian',
    cloud('wsl')?.getAttribute('data-wsl-cloud'))
  check('the wsl$ spelling is covered too', cloud('legacy')?.getAttribute('data-wsl-cloud') === 'ubuntu',
    cloud('legacy')?.getAttribute('data-wsl-cloud'))
  check('a Windows workspace row is left alone',
    cloud('win') === null && shipped('win')?.style.display === '')
  // Optional chaining throughout: an assertion that throws on a missing node
  // hides every check after it, which is the opposite of reporting a failure.
  check('the cloud matches the folder icon metrics',
    cloud('wsl')?.getAttribute('width') === '16'
    && cloud('wsl')?.getAttribute('height') === '16'
    && cloud('wsl')?.getAttribute('viewBox') === '0 0 16 16'
    && cloud('wsl')?.getAttribute('aria-hidden') === 'true',
    `${cloud('wsl')?.getAttribute('width')}x${cloud('wsl')?.getAttribute('height')} ${cloud('wsl')?.getAttribute('viewBox')}`)
  check('the collapsed row gets the STROKED cloud, matching its folder outline',
    cloud('wsl')?.getAttribute('data-wsl-cloud-weight') === 'outline'
    && cloud('wsl')?.getAttribute('stroke-width') === '1'
    && cloud('wsl')?.querySelector('path[stroke="currentColor"]') !== null,
    `weight=${cloud('wsl')?.getAttribute('data-wsl-cloud-weight')}`)
  check('the shipped folder icon is hidden rather than removed',
    shipped('wsl')?.isConnected === true && shipped('wsl')?.style.display === 'none',
    `connected=${shipped('wsl')?.isConnected} display=${JSON.stringify(shipped('wsl')?.style.display)}`)

  // A workspace can be re-pointed at another directory, so the swap has to
  // come back off — the icon follows the path it is given, not a first sighting.
  state.items = [
    { workspaceId: 'wsl', path: WIN_PATH },
    { workspaceId: 'legacy', path: LEGACY_UNC },
    { workspaceId: 'win', path: WIN_PATH },
  ]
  // A mutation elsewhere in the tree is what re-runs the plugin's sync.
  parts.row.append(doc.createElement('i'))
  await settle()
  check('re-pointing the workspace restores the folder icon',
    cloud('wsl') === null && shipped('wsl')?.style.display === '',
    `cloud=${cloud('wsl') === null ? 'gone' : 'present'} display=${JSON.stringify(shipped('wsl')?.style.display)}`)

  // Expanding a workspace re-renders its OWN icon in the other weight; the cloud
  // has to follow rather than keep whichever one it was first built with.
  const expandedFolder = (() => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'M1 3h5l1 1h8v9H1z')
    path.setAttribute('fill', 'currentColor')
    svg.append(path)
    return svg
  })()
  // Guarded the way lines 327-341 mandate: a fixture that regressed must produce
  // one FAIL below, not a TypeError here that aborts the rest of the section.
  const legacyFolder = row('legacy')?.querySelector('span.folder')
  if (legacyFolder !== null && legacyFolder !== undefined) legacyFolder.replaceChildren(expandedFolder)
  parts.row.append(doc.createElement('i'))
  await settle()
  check('expanding the row rebuilds the cloud in the solid weight',
    cloud('legacy')?.getAttribute('data-wsl-cloud-weight') === 'solid'
    && cloud('legacy')?.querySelector('path[stroke]') === null
    && [...(cloud('legacy')?.children ?? [])].every((node) => node.getAttribute('fill') === 'currentColor'),
    `weight=${cloud('legacy')?.getAttribute('data-wsl-cloud-weight')}`)
  check('and the newly rendered folder icon is hidden in its turn',
    shipped('legacy')?.style.display === 'none')

  const before = live.mutations()
  await new Promise((resolve) => { setTimeout(resolve, 2600) })
  console.log(`        ${live.mutations() - before} childList record(s) in 2.6s`)
  check('the icon swap settles instead of feeding the observer',
    live.mutations() - before <= 2, `${live.mutations() - before} childList records in 2.6s`)

  live.dispose()
  check('dispose restores every swapped row',
    doc.querySelector('svg[data-wsl-cloud]') === null && shipped('legacy')?.style.display === '',
    `clouds=${doc.querySelectorAll('svg[data-wsl-cloud]').length}`)
}

console.log('\nWSL workspace rows in the sprite generation (0.2.1-rc3)')
{
  // The second defect from the same refactor: the row's folder icon became a
  // sprite reference, so there is no inline `<path>` to read a weight off. The
  // old detector therefore called BOTH states fill-only and painted the solid
  // cloud on a collapsed row.
  const UNC = ['', '', 'wsl.localhost', 'debian', 'home', 'me', 'proj'].join('\\')
  const state = {
    items: [
      { workspaceId: 'closed', path: UNC },
      { workspaceId: 'open', path: UNC },
    ],
  }
  const parts = fixture(
    spriteWorkspaceRow('closed', 'closed') + spriteWorkspaceRow('open', 'open', true) + FOLDER_SPRITE,
  )
  layout(parts, 344, 60)
  const live = apply(parts.dom, state)
  await settle()
  const doc = parts.dom.window.document
  const cloud = (id) => doc.querySelector(`[data-row-key="workspace:${id}"] svg[data-wsl-cloud]`)
  check('a sprite folder icon still gets a cloud',
    cloud('closed') !== null && cloud('open') !== null,
    `closed=${cloud('closed') !== null} open=${cloud('open') !== null}`)
  // The weight is read from the SYMBOL the row references, not from an inline path.
  check('a collapsed sprite row gets the STROKED cloud',
    cloud('closed')?.getAttribute('data-wsl-cloud-weight') === 'outline',
    `weight=${cloud('closed')?.getAttribute('data-wsl-cloud-weight')}`)
  check('an expanded sprite row gets the SOLID cloud',
    cloud('open')?.getAttribute('data-wsl-cloud-weight') === 'solid',
    `weight=${cloud('open')?.getAttribute('data-wsl-cloud-weight')}`)
  live.dispose()
}

console.log('\ncatalog rendering and the degraded gate')

/** The catalog a version-0.6 host serves. */
function catalogFixture() {
  return {
    codes: {
      'distro-unreachable': {
        zh: '发行版不可达。',
        en: 'The distribution is unreachable.',
        remedy: { kind: 'text', zh: '启动它。', en: 'Start it.' },
        doc: 'DIAGNOSTICS.md#distro-unreachable',
      },
      'host-capability-missing': {
        zh: '缺少宿主能力。',
        en: 'A host capability is missing.',
        remedy: { kind: 'link', href: 'https://example.test/docs' },
        doc: 'DIAGNOSTICS.md#host-capability-missing',
      },
      internal: {
        zh: '内部错误。',
        en: 'Internal error.',
        remedy: { kind: 'text', zh: '报告它。', en: 'Report it.' },
        doc: 'DIAGNOSTICS.md#internal',
      },
    },
    features: ['picker', 'preset-generation', 'session-create', 'terminal', 'search', 'selftest'],
    featureLabels: {
      picker: { zh: '工作区选择', en: 'Workspace picker' },
      'preset-generation': { zh: '会话预设', en: 'Session presets' },
      'session-create': { zh: '会话创建', en: 'Session creation' },
    },
    checks: [],
    checkLabels: {},
    checkRemedies: {},
    clientSymbols: [
      { id: 'workspaces.list', feature: 'picker', path: ['workspaces', 'list', 'getSnapshot'], required: true },
      { id: 'workspaces.create', feature: 'picker', path: ['workspaces', 'create'], required: true },
      { id: 'uiWorkspace.openSession', feature: 'picker', path: ['uiWorkspace', 'openSession'], required: true },
      { id: 'remote.session.create', feature: 'session-create', path: ['remote', 'session', 'create'], required: true },
      { id: 'sessions.create', feature: 'session-create', path: ['sessions', 'create'], required: false },
    ],
  }
}

/** A healthy capability answer. */
function healthyCapabilities() {
  return {
    status: 'ok',
    features: {
      picker: 'unknown',
      'preset-generation': 'ok',
      'session-create': 'unknown',
      terminal: 'ok',
      search: 'ok',
      selftest: 'ok',
    },
    missing: [],
  }
}

/** A healthy bootstrap envelope. */
function healthyBootstrap() {
  return {
    ok: true,
    value: {
      pluginVersion: '0.6.0',
      catalog: catalogFixture(),
      capabilities: healthyCapabilities(),
    },
  }
}

/**
 * A route stub that records every method it was asked for.
 * @param {Record<string, (body: object) => object>} handlers - one envelope per method.
 * @returns {Function} the fetch stub, with a `calls` array.
 */
function routeStub(handlers) {
  const calls = []
  const bodies = []
  const stub = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.method)
    bodies.push(body)
    const handler = handlers[body.method]
    if (handler === undefined) {
      return { status: 404, json: async () => ({ ok: false, code: 'unknown-method' }) }
    }
    return { status: 200, json: async () => handler(body) }
  }
  stub.calls = calls
  stub.bodies = bodies
  return stub
}

{
  // The host says preset-generation is degraded; the browser's own services are
  // complete. The merged answer must stop at the gate and never ask for distros.
  const parts = fixture()
  layout(parts, 344, 60)
  const state = { items: [] }
  const stub = routeStub({
    bootstrap: () => ({
      ok: true,
      value: {
        pluginVersion: '0.6.0',
        catalog: catalogFixture(),
        capabilities: {
          status: 'degraded',
          features: { ...healthyCapabilities().features, 'preset-generation': 'degraded' },
          missing: [{ id: 'agentPresets.readDocument', feature: 'preset-generation' }],
        },
      },
    }),
  })
  const live = apply(parts.dom, state, stub)
  await settle()
  live.button.click()
  await settle()
  const panel = parts.dom.window.document.querySelector('[data-wsl-degraded]')
  check('a degraded picker renders the degraded card', panel !== null,
    parts.dom.window.document.body.textContent?.slice(0, 120))
  check('the degraded card names the missing feature',
    panel?.textContent.includes('Session presets') === true,
    panel?.textContent?.slice(0, 160))
  check('a degraded picker asks for no distribution',
    !stub.calls.includes('listDistros'), stub.calls)
  const copyDiagnostics = [...(panel?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent === 'Copy diagnostics')
  copyDiagnostics?.click()
  const overlay = parts.dom.window.document.querySelector('[role="dialog"]')
  const announcer = [...(overlay?.children ?? [])]
    .find((node) => node.getAttribute?.('role') === 'status' && node.getAttribute('aria-live') === 'polite')
  check('a copy action is announced through the dialog live region',
    announcer?.textContent === 'Copied', announcer?.textContent)
  live.dispose()
}
{
  // A degraded answer is a phase, not a cached fact: the card must offer a fresh
  // check, and a recovered host must let the picker proceed.
  const parts = fixture()
  layout(parts, 344, 60)
  let boots = 0
  const degraded = {
    ok: true,
    value: {
      pluginVersion: '0.6.0',
      catalog: catalogFixture(),
      capabilities: {
        status: 'degraded',
        features: { ...healthyCapabilities().features, 'preset-generation': 'degraded' },
        missing: [],
      },
    },
  }
  const stub = routeStub({
    bootstrap: () => {
      boots += 1
      return boots === 1 ? degraded : healthyBootstrap()
    },
    listDistros: () => ({ ok: true, value: ['debian'] }),
    defaultDistro: () => ({ ok: true, value: { distro: 'debian' } }),
  })
  const live = apply(parts.dom, { items: [] }, stub)
  await settle()
  live.button.click()
  await settle()
  const retry = parts.dom.window.document.querySelector('[data-wsl-degraded-retry]')
  check('the degraded card offers a fresh check', retry !== null)
  retry?.click()
  await settle()
  check('retrying after a degraded answer re-runs bootstrap and proceeds',
    boots === 2 && stub.calls.includes('listDistros')
    && parts.dom.window.document.querySelector('[data-wsl-degraded]') === null,
    { boots, calls: stub.calls })
  live.dispose()
}
{
  // No route at all: bootstrap fails twice, discovery fails too, and the dialog
  // must still open with a code-carrying error instead of a stack.
  const parts = fixture()
  layout(parts, 344, 60)
  const failing = async () => { throw new Error('the route is down') }
  const live = apply(parts.dom, { items: [] }, failing)
  await settle()
  live.button.click()
  await new Promise((resolve) => { setTimeout(resolve, 800) })
  const error = parts.dom.window.document.querySelector('[data-wsl-error]')
  check('a failed bootstrap still opens the dialog with a coded error', error !== null,
    parts.dom.window.document.body.textContent?.slice(0, 160))
  check('the failure is the transport code', error?.getAttribute('data-wsl-error') === 'transport',
    error?.getAttribute('data-wsl-error'))
  check('the browser shows the fallback copy, not the host stack',
    error?.textContent.includes('route could not be reached') === true
    && error?.textContent.includes('the route is down') === false,
    error?.textContent?.slice(0, 160))
  check('the error is announced as an alert', error?.getAttribute('role') === 'alert')
  let copied = null
  Object.defineProperty(parts.dom.window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { copied = text } },
  })
  const copyAll = error?.querySelector('[data-wsl-diagnostics]')
  check('a failed browse offers the full diagnostic report', copyAll !== null,
    error?.textContent?.slice(0, 160))
  copyAll?.click()
  await settle()
  check('the report carries the code and params but not the host message',
    copied !== null && copied.includes('"code": "transport"') && !copied.includes('the route is down'),
    copied?.slice(0, 200))
  check('the report carries the plugin version and capability state',
    copied !== null && copied.includes('"pluginVersion"') && copied.includes('"capabilities"'),
    copied?.slice(0, 200))
  live.dispose()
}
{
  // A later discovery failure carries a catalog code; the raw `error` field the
  // developer route may include must never reach the page.
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub({
    bootstrap: () => ({
      ok: true,
      value: { pluginVersion: '0.6.0', catalog: catalogFixture(), capabilities: healthyCapabilities() },
    }),
    listDistros: () => ({
      ok: false,
      code: 'distro-unreachable',
      params: { distro: 'debian' },
      error: 'wsl.exe stderr SECRET',
    }),
  })
  const live = apply(parts.dom, { items: [] }, stub)
  await settle()
  live.button.click()
  await settle()
  const error = parts.dom.window.document.querySelector('[data-wsl-error="distro-unreachable"]')
  check('a catalog code is rendered with its own copy', error !== null,
    parts.dom.window.document.body.textContent?.slice(0, 160))
  check('the rendered failure is the catalog copy',
    error?.textContent.includes('The distribution is unreachable.') === true,
    error?.textContent?.slice(0, 160))
  check('the raw host error never reaches the page',
    error?.textContent.includes('SECRET') === false, error?.textContent?.slice(0, 160))
  check('the failure links its catalog doc',
    error?.querySelector('a[href*="DIAGNOSTICS.md#distro-unreachable"]') !== null,
    error?.querySelector('a')?.href)
  live.dispose()
}
{
  // An old host half answers `unknown-method`; that is a restart, not an
  // internal failure, and it must stay visible above the still-usable gate.
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub({
    bootstrap: () => ({ ok: false, code: 'unknown-method' }),
    listDistros: () => ({ ok: true, value: ['debian'] }),
    defaultDistro: () => ({ ok: true, value: { distro: 'debian' } }),
  })
  const live = apply(parts.dom, { items: [] }, stub)
  await settle()
  live.button.click()
  // bootstrapOnce retries one failure after 500ms before it settles.
  await new Promise((resolve) => { setTimeout(resolve, 800) })
  const error = parts.dom.window.document.querySelector('[data-wsl-error="host-plugin-stale"]')
  check('an old host half is reported as host-plugin-stale, not internal',
    error !== null, parts.dom.window.document.body.textContent?.slice(0, 160))
  live.dispose()
}
{
  // The browser's own required symbol is missing even though the host is
  // healthy: the merge must degrade, and still ask for no distribution.
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub({ bootstrap: () => healthyBootstrap() })
  const live = apply(parts.dom, { items: [] }, stub, { remote: undefined })
  await settle()
  live.button.click()
  await settle()
  check('a missing client-scope symbol degrades the picker',
    parts.dom.window.document.querySelector('[data-wsl-degraded]') !== null
    && !stub.calls.includes('listDistros'), stub.calls)
  live.dispose()
}

console.log('\nthe advisory health strip')

/**
 * The handlers a browse-to-health case needs.
 * @param {() => object} health - the health envelope.
 * @returns {Record<string, Function>} the route handlers.
 */
function browseHandlers(health) {
  return {
    bootstrap: () => healthyBootstrap(),
    listDistros: () => ({ ok: true, value: ['debian'] }),
    defaultDistro: () => ({ ok: true, value: { distro: 'debian' } }),
    resolveHome: () => ({ ok: true, value: { user: 'me', home: '/home/me' } }),
    listDir: () => ({
      ok: true,
      value: {
        path: '/home/me',
        parent: '/home',
        entries: [{ name: 'ok', kind: 'directory' }],
        hidden: 1,
      },
    }),
    health,
  }
}

/** Walk the dialog to the browse phase. */
async function reachBrowse(dom) {
  await settle()
  dom.window.document.querySelector('[data-wsl-desktop="workspace-trigger"]').click()
  await settle()
  const enter = dom.window.document.querySelector('[data-wsl-action="confirm-user"]')
  enter?.click()
  await settle()
}

{
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub(browseHandlers(() => ({
    ok: true,
    value: {
      distro: 'debian',
      user: 'me',
      runner: 'helper',
      ok: true,
      restricted: true,
      cached: false,
      checks: [
        { id: 'bash', status: 'pass' },
        { id: 'python3', status: 'warn', detail: 'version unreadable or below 3.8' },
      ],
    },
  })))
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const strip = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('the browse phase renders the health strip', strip !== null,
    parts.dom.window.document.body.textContent?.slice(0, 160))
  check('the strip reports pass and advisory counts',
    strip?.getAttribute('data-wsl-health') === '1,1,0', strip?.getAttribute('data-wsl-health'))
  const healthCall = stub.bodies.find((body) => body.method === 'health')
  check('the health request carries the confirmed distro and user',
    healthCall?.params.distro === 'debian' && healthCall?.params.username === 'me',
    healthCall?.params)
  const create = parts.dom.window.document.querySelector('[data-wsl-action="create"]')
  check('an advisory check does not disable creation', create !== null && create.disabled === false,
    create?.disabled)
  check('a hidden unrepresentable name is disclosed',
    parts.dom.window.document.body.textContent.includes('1 name(s) contain characters') === true,
    parts.dom.window.document.body.textContent?.slice(0, 200))
  parts.dom.window.document.querySelector('[data-wsl-health-toggle]')?.click()
  await settle()
  const expanded = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('the strip expands to the measured rows',
    expanded?.textContent.includes('version unreadable or below 3.8') === true,
    expanded?.textContent?.slice(0, 200))
  const expandedToggle = parts.dom.window.document.querySelector('[data-wsl-health-toggle]')
  check('the health toggle reports its expanded state',
    expandedToggle?.getAttribute('aria-expanded') === 'true',
    expandedToggle?.getAttribute('aria-expanded'))
  live.dispose()
}
{
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub(browseHandlers(() => ({
    ok: false,
    code: 'distro-unreachable',
    params: { distro: 'debian' },
  })))
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const strip = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('a failed health call renders its coded error', strip?.getAttribute('data-wsl-health') === 'error',
    strip?.getAttribute('data-wsl-health'))
  const create = parts.dom.window.document.querySelector('[data-wsl-action="create"]')
  check('a failed health call still leaves creation enabled', create !== null && create.disabled === false)
  live.dispose()
}
{
  // An all-unknown batch measured nothing: it must not claim restricted mode is
  // unavailable, which is a fact about a measured distribution.
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub(browseHandlers(() => ({
    ok: true,
    value: {
      distro: 'debian',
      checks: [{ id: 'bash', status: 'unknown', detail: 'not measured' }],
      ok: true,
      restricted: false,
    },
  })))
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const strip = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('an unmeasured batch does not claim restricted mode is unavailable',
    strip !== null && strip.textContent.includes('Restricted mode is unavailable') === false,
    strip?.textContent?.slice(0, 160))
  live.dispose()
}
{
  // The zh locale must localise the status and the fixed detail vocabulary; a
  // version string keeps its own identity.
  const parts = fixture()
  layout(parts, 344, 60)
  Object.defineProperty(parts.dom.window.navigator, 'language', { value: 'zh-CN', configurable: true })
  const stub = routeStub(browseHandlers(() => ({
    ok: true,
    value: {
      distro: 'debian',
      user: 'me',
      runner: 'helper',
      ok: true,
      restricted: true,
      checks: [{ id: 'python3', status: 'warn', detail: 'version unreadable or below 3.8' }],
    },
  })))
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  parts.dom.window.document.querySelector('[data-wsl-health-toggle]')?.click()
  await settle()
  const strip = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('the zh locale renders the localised health detail',
    strip?.textContent.includes('版本无法识别或低于 3.8') === true
    && strip?.textContent.includes('建议处理') === true,
    strip?.textContent?.slice(0, 200))
  const dialog = parts.dom.window.document.querySelector('[role="dialog"]')
  check('the zh locale renders the older dialog copy in Chinese',
    dialog?.textContent.includes('创建并打开') === true
    && live.button?.getAttribute('aria-label') === '添加 WSL 工作区',
    dialog?.textContent?.slice(0, 200))
  live.dispose()
}

console.log('\nthe English dialog, its description and the keyboard trap')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub(browseHandlers(() => ({
    ok: true,
    value: {
      distro: 'debian',
      user: 'me',
      runner: 'helper',
      ok: true,
      restricted: true,
      checks: [],
    },
  })))
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const doc = parts.dom.window.document
  const overlay = doc.querySelector('[role="dialog"]')
  const text = overlay?.textContent ?? ''
  check('the English dialog carries no Chinese copy',
    overlay !== null && !/[\u4e00-\u9fff]/.test(text), text.slice(0, 200))
  check('the dialog and its trigger use the English accessible name',
    overlay?.getAttribute('aria-label') === 'Add a WSL workspace'
    && live.button?.getAttribute('aria-label') === 'Add a WSL workspace')
  const description = doc.getElementById(overlay?.getAttribute('aria-describedby') ?? '')
  check('aria-describedby names the dialog purpose',
    description?.textContent === 'Create a workspace from a WSL distribution directory.',
    description?.textContent)
  const focusable = [...(overlay?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  last?.focus()
  doc.dispatchEvent(new parts.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  check('Tab from the last control wraps to the first', doc.activeElement === first,
    doc.activeElement?.outerHTML?.slice(0, 80))
  first?.focus()
  doc.dispatchEvent(new parts.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
  check('Shift+Tab from the first control wraps to the last', doc.activeElement === last,
    doc.activeElement?.outerHTML?.slice(0, 80))
  doc.dispatchEvent(new parts.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  check('Escape closes the dialog', doc.querySelector('[role="dialog"]') === null)
  check('focus returns to the W button', doc.activeElement === live.button)
  live.dispose()
}

console.log('\nthe browse filter and a failed listing')
{
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub({
    ...browseHandlers(() => ({
      ok: true,
      value: { distro: 'debian', user: 'me', runner: 'helper', ok: true, restricted: true, checks: [] },
    })),
    listDir: () => ({
      ok: true,
      value: {
        path: '/home/me',
        parent: '/home',
        entries: [
          { name: 'alpha', kind: 'directory' },
          { name: 'beta', kind: 'directory' },
          { name: 'alphabet', kind: 'directory' },
        ],
        hidden: 0,
      },
    }),
  })
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const doc = parts.dom.window.document
  const filter = doc.querySelector('[data-wsl-filter]')
  check('the browse phase offers a filter box', filter !== null)
  const names = () => [...doc.querySelectorAll('[data-wsl-entry]')]
    .filter((node) => node.style.display !== 'none')
    .map((node) => node.textContent.replace('📁 ', ''))
  check('every directory is listed before filtering', names().length === 3, names())
  filter.value = 'alp'
  filter.dispatchEvent(new parts.dom.window.Event('input', { bubbles: true }))
  await settle()
  check('the filter narrows the list to matching names',
    names().join(',') === 'alpha,alphabet', names())
  filter.value = 'zzz'
  filter.dispatchEvent(new parts.dom.window.Event('input', { bubbles: true }))
  await settle()
  check('a filter with no match says so instead of an empty box',
    names().length === 0 && doc.querySelector('[data-wsl-filter-empty]') !== null)
  live.dispose()
}
{
  const parts = fixture()
  layout(parts, 344, 60)
  let calls = 0
  const stub = routeStub({
    ...browseHandlers(() => ({
      ok: true,
      value: { distro: 'debian', user: 'me', runner: 'helper', ok: true, restricted: true, checks: [] },
    })),
    listDir: () => {
      calls += 1
      if (calls === 1) throw new Error('permission denied')
      return {
        ok: true,
        value: { path: '/home/me', parent: '/home', entries: [{ name: 'ok', kind: 'directory' }], hidden: 0 },
      }
    },
  })
  const live = apply(parts.dom, { items: [] }, stub)
  await reachBrowse(parts.dom)
  const doc = parts.dom.window.document
  const retry = doc.querySelector('[data-wsl-list-retry]')
  check('a failed listing offers a retry that re-runs the same load', retry !== null,
    doc.querySelector('[data-wsl-error]')?.textContent?.slice(0, 120))
  retry?.click()
  await settle()
  check('the retry clears the error and shows the directory',
    doc.querySelector('[data-wsl-error]') === null
    && [...doc.querySelectorAll('[data-wsl-entry]')].some((node) => node.textContent.includes('ok')),
    calls)
  live.dispose()
}

console.log('\nthe fallback entry and focus return')
{
  // No anchor at all: the companion stands down, and the timed fallback is the
  // only visible entry left. The 5s grace is shortened by replacing the window's
  // timer, not by adding a production test hook.
  const parts = fixture()
  parts.trigger.remove()
  layout(parts, 344, 60)
  const realSetTimeout = parts.dom.window.setTimeout
  parts.dom.window.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 5000 ? 20 : ms, ...args)
  const live = apply(parts.dom)
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  const container = parts.dom.window.document.querySelector('[data-wsl-fallback-entry-container]')
  const open = parts.dom.window.document.querySelector('[data-wsl-fallback-entry]')
  check('a missing anchor produces the visible fallback entry', container !== null && open !== null,
    parts.dom.window.document.body.textContent?.slice(0, 120))
  check('the fallback entry is a button that advertises the dialog',
    open?.tagName === 'BUTTON' && open?.getAttribute('aria-haspopup') === 'dialog')
  open?.click()
  await settle()
  check('the fallback entry opens the picker',
    parts.dom.window.document.querySelector('[role="dialog"]') !== null)
  parts.dom.window.document.dispatchEvent(new parts.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
  await settle()
  check('closing a fallback-opened dialog returns focus to the fallback button',
    parts.dom.window.document.activeElement === open,
    parts.dom.window.document.activeElement?.tagName)
  open?.click()
  await settle()
  parts.dom.window.document.querySelector('[data-wsl-fallback-dismiss]')?.click()
  check('the fallback entry can be dismissed',
    parts.dom.window.document.querySelector('[data-wsl-fallback-entry-container]') === null)
  live.dispose()
}
{
  // The real anchor appearing later wins over the failure-path entry.
  const parts = fixture()
  parts.trigger.remove()
  layout(parts, 344, 60)
  const realSetTimeout = parts.dom.window.setTimeout
  parts.dom.window.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 5000 ? 20 : ms, ...args)
  const live = apply(parts.dom)
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  check('the fallback is up before the anchor returns',
    parts.dom.window.document.querySelector('[data-wsl-fallback-entry-container]') !== null)
  parts.row.append(parts.trigger)
  await settle()
  check('the fallback leaves when the real anchor appears',
    parts.dom.window.document.querySelector('[data-wsl-fallback-entry-container]') === null)
  live.dispose()
}
{
  // Disposing before the grace expires must cancel the timer, not just hide the
  // node: a fired timer would append a fallback after the plugin is gone.
  const parts = fixture()
  parts.trigger.remove()
  layout(parts, 344, 60)
  const realSetTimeout = parts.dom.window.setTimeout
  parts.dom.window.setTimeout = (callback, ms, ...args) => realSetTimeout(callback, ms === 5000 ? 20 : ms, ...args)
  const live = apply(parts.dom)
  live.dispose()
  await new Promise((resolve) => { setTimeout(resolve, 100) })
  check('dispose cancels the fallback timer',
    parts.dom.window.document.querySelector('[data-wsl-fallback-entry-container]') === null)
}
{
  const parts = fixture()
  layout(parts, 344, 60)
  const stub = routeStub(browseHandlers(() => ({ ok: true, value: { distro: 'debian', checks: [], ok: true, restricted: true } })))
  const live = apply(parts.dom, { items: [] }, stub)
  await settle()
  live.button.click()
  await settle()
  parts.dom.window.document.dispatchEvent(new parts.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
  await settle()
  check('closing the dialog returns focus to the W button',
    parts.dom.window.document.activeElement === live.button,
    parts.dom.window.document.activeElement?.tagName)
  live.dispose()
}

console.log(`\n${checker.failures === 0 ? `${checker.checks} check(s) passed` : `${checker.failures} check(s) failed`}`)
process.exit(checker.failures === 0 ? 0 : 1)
