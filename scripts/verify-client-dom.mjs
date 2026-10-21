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

/**
 * Build the sidebar header fixture: the shipped action cluster holding the
 * view-options button and the add-workspace trigger, inside the section row.
 * @param {string} [extra] - extra markup appended inside the sidebar, for a case
 * that needs rows the header fixture does not carry.
 * @returns {{ dom: object, row: object, cluster: object, trigger: object }} the fixture.
 */
function fixture(extra = '') {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="sidebar">
      <div class="sectionHeader" id="row">
        <span class="sectionLabel">工作区</span>
        <div class="searchSlot"></div>
        <div class="headerActions" id="cluster">
          <button class="iconButton" id="view"></button>
          <button class="iconButton" id="trigger" aria-label="add workspace">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path transform="translate(9.52 2.52)" d="${TRIGGER_PATH}" fill="currentColor"></path>
              <path transform="translate(0.3496 2.35)" d="M4.76367 0C5.36861 0" fill="currentColor"></path>
            </svg>
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
function apply(dom, workspaceState, fetchImpl) {
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
 * One shipped workspace row: the leading folder slot React renders, the
 * chevron that shares its size, and the row key that carries the workspace id.
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
  const stub = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.method)
    const handler = handlers[body.method]
    if (handler === undefined) {
      return { status: 404, json: async () => ({ ok: false, code: 'unknown-method' }) }
    }
    return { status: 200, json: async () => handler(body) }
  }
  stub.calls = calls
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
    listDir: () => ({ ok: true, value: { path: '/home/me', parent: '/home', entries: [] } }),
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
  const create = parts.dom.window.document.querySelector('[data-wsl-action="create"]')
  check('an advisory check does not disable creation', create !== null && create.disabled === false,
    create?.disabled)
  parts.dom.window.document.querySelector('[data-wsl-health-toggle]')?.click()
  await settle()
  const expanded = parts.dom.window.document.querySelector('[data-wsl-health]')
  check('the strip expands to the measured rows',
    expanded?.textContent.includes('version unreadable or below 3.8') === true,
    expanded?.textContent?.slice(0, 200))
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
  const entry = parts.dom.window.document.querySelector('[data-wsl-fallback-entry]')
  check('a missing anchor produces the visible fallback entry', entry !== null,
    parts.dom.window.document.body.textContent?.slice(0, 120))
  entry?.querySelectorAll('button')[0]?.click()
  await settle()
  check('the fallback entry opens the picker',
    parts.dom.window.document.querySelector('[role="dialog"]') !== null)
  entry?.querySelectorAll('button')[1]?.click()
  check('the fallback entry can be dismissed',
    parts.dom.window.document.querySelector('[data-wsl-fallback-entry]') === null)
  live.dispose()
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
