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
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const flag = (name, fallback) => {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
// The harness checkout is this repo's sibling in a normal development layout;
// DSH_CHECKOUT / --checkout override it anywhere else.
const checkout = flag('checkout', process.env.DSH_CHECKOUT ?? join(pluginRoot, '..', 'deepseek-harness'))
const clientPath = flag('client', join(pluginRoot, 'lib', 'client.js'))

let failures = 0
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
  if (!ok && detail !== undefined) console.log(`        ${detailText(detail)}`)
  if (!ok) failures += 1
}

// jsdom comes from the harness checkout's dev dependencies. A missing
// checkout is a SKIP (exit 2 — the contract verify-all documents), not a
// failure: an unguarded load crashes with exit 1 and reads as a false FAIL.
let JSDOM
try {
  JSDOM = createRequire(join(checkout, 'package.json'))('jsdom').JSDOM
} catch {
  console.log('SKIP  jsdom unavailable (no harness checkout) — pass --checkout=… or set DSH_CHECKOUT')
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
 * Load the browser half and apply it against a stub client context.
 * @param {object} dom - the jsdom window owner.
 * @param {{ items: object[] } | undefined} [workspaceState] - the mutable snapshot
 * the `workspaces.list` stub serves; omitted by every case written before
 * workspace rows existed, so those keep exercising the context they always did.
 * @returns {{ button: object|null, dispose: () => void, mutations: () => number }} the live plugin.
 */
function apply(dom, workspaceState) {
  let registration = null
  dom.window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
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
      ...(workspaceState === undefined
        ? {}
        : { list: { getSnapshot: () => workspaceState, subscribe: () => () => {} } }),
    },
    uiWorkspace: { startSession: () => {} },
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
  row('legacy').querySelector('span.folder').replaceChildren(expandedFolder)
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
    doc.querySelector('svg[data-wsl-cloud]') === null && shipped('legacy').style.display === '',
    `clouds=${doc.querySelectorAll('svg[data-wsl-cloud]').length}`)
}

console.log(`\n${failures === 0 ? `${checks} check(s) passed` : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
