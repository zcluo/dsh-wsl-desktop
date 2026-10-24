/**
 * Normalise machine-specific absolute paths in an Archify receipt before commit.
 *
 * The receipts are committed deliverables, so they must not carry this machine's
 * layout: scripts/release-check.mjs privacy-scans every TRACKED file for absolute
 * paths, and verify-diagrams.mjs rejects them in the *.visual-check.* set. Archify
 * writes absolute paths by default (it echoes the paths it was invoked with), so a
 * post-pass is required — the same pass already applied to architecture.visual-check.
 *
 * WHAT IS REWRITTEN: only path-valued fields. Shas and byte counts are untouched, so
 * the receipt still proves exactly what was measured.
 *
 *   repository-absolute  E:\projects\dsh-wsl-desktop\docs\x.json  ->  docs/x.json
 *   tool binary         C:\Program Files\nodejs\node.exe          ->  node
 *   browser binary      C:\Program Files\...\msedge.exe          ->  msedge
 *   scratch tool path   ...\.superpowers\archify-3.2.0\...\archify.mjs -> archify
 *
 * Usage: node scripts/normalize-archify-receipt.mjs <receipt.json> [...]
 *        node scripts/normalize-archify-receipt.mjs --check <receipt.json> [...]
 *          --check reports hits and exits 1 without writing (for a CI gate).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { relative, isAbsolute, resolve } from 'node:path'

/** Repository root, derived from this script's own location so a moved checkout still works. */
const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const isAbsolutePath = (value) =>
  typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))

/**
 * Rewrite one absolute path to a machine-independent spelling.
 * @param {string} value - the absolute path found in the receipt.
 * @returns {string} the normalised spelling.
 */
function normalise(value) {
  // Inside the repository: keep the repository-relative form, which is what the
  // receipt means ("this artifact, in this tree").
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    const relativeToRepo = relative(REPO_ROOT, value)
    if (relativeToRepo !== '' && !relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo)) {
      return relativeToRepo.replace(/\\/g, '/')
    }
  }
  // Outside the repository: it is a tool or browser binary. Keep the identity
  // (which program ran) and drop the install path, which is machine-specific.
  const base = value.split(/[\\/]/).pop() ?? value
  return base.replace(/\.mjs$/i, '').replace(/\.exe$/i, '').toLowerCase()
}

/**
 * Walk a parsed receipt and normalise every path-shaped value.
 * @param {unknown} node - current subtree.
 * @param {Array<{ trail: string, from: string, to: string }>} hits - collected rewrites.
 * @returns {unknown} the rewritten subtree.
 */
function walk(node, hits, trail = '') {
  if (Array.isArray(node)) return node.map((item, index) => walk(item, hits, `${trail}[${index}]`))
  if (node !== null && typeof node === 'object') {
    const next = {}
    for (const [key, value] of Object.entries(node)) next[key] = walk(value, hits, trail === '' ? key : `${trail}.${key}`)
    return next
  }
  if (isAbsolutePath(node)) {
    const rewritten = normalise(node)
    if (rewritten !== node) hits.push({ trail, from: node, to: rewritten })
    return rewritten
  }
  return node
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const files = args.filter((arg) => !arg.startsWith('--'))

if (files.length === 0) {
  console.error('usage: node scripts/normalize-archify-receipt.mjs [--check] <receipt.json> [...]')
  process.exit(2)
}

let touchedFiles = 0
let touchedValues = 0
const residual = []

for (const file of files) {
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const hits = []
  const rewritten = walk(original, hits)
  touchedValues += hits.length
  if (hits.length > 0) touchedFiles += 1
  for (const hit of hits) console.log(`  ${file}: ${hit.trail}\n      ${hit.from}\n   -> ${hit.to}`)
  if (!checkOnly && hits.length > 0) writeFileSync(file, `${JSON.stringify(rewritten, null, 2)}\n`)
  // A path that survives normalisation is a defect in this script, not in the input.
  for (const hit of hits) if (isAbsolutePath(hit.to)) residual.push(`${file}: ${hit.trail} -> ${hit.to}`)
}

if (residual.length > 0) {
  console.error('\nresidual absolute paths (normaliser is incomplete):')
  for (const line of residual) console.error('  ' + line)
  process.exit(1)
}

console.log(`\n${checkOnly ? 'found' : 'normalised'} ${touchedValues} value(s) across ${touchedFiles} file(s)`)
process.exit(checkOnly && touchedValues > 0 ? 1 : 0)
