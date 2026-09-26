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

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const flag = (name, fallback) => {
  const hit = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const checkout = flag('checkout', process.env.DSH_CHECKOUT ?? 'E:/projects/deepseek-harness')
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
  if (!ok && detail !== undefined) console.log(`        ${String(detail)}`)
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
 * @returns {{ dom: object, row: object, cluster: object, trigger: object }} the fixture.
 */
function fixture() {
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
 * @returns {{ button: object|null, dispose: () => void, mutations: () => number }} the live plugin.
 */
function apply(dom) {
  let registration = null
  dom.window.__ModuleLoader__ = { load: (entry) => { registration = entry } }
  dom.window.eval(source)
  const module = registration.factory()
  const disposers = []
  module.apply({
    effect: (callback) => { disposers.push(callback()) },
    workspaces: { create: async () => ({ workspaceId: 'w' }) },
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

console.log(`\n${failures === 0 ? `${checks} check(s) passed` : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
