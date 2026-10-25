/**
 * Rewrite the delivery receipts so they carry no machine layout.
 *
 * Archify's `finalize` / `visual-check` write absolute paths into their receipts:
 * the artifact path, the specification path, the Node binary, the Chromium
 * executable, and the receipt links. Those files are committed, so the paths
 * become part of the repository and of the published documentation — the leak
 * the privacy row in `verify-diagrams.mjs` exists to catch.
 *
 * The rule is mechanical and must stay so:
 *
 *   - a path under the repository becomes repository-relative (POSIX spelling);
 *   - the browser executable becomes `msedge`, the name a reader can use;
 *   - a path outside the repository keeps only its basename, because the part
 *     that identifies this machine is the directory above it.
 *
 * Everything else in the file is left byte-identical, including the hashes: the
 * receipts' `sha256` fields describe OTHER files, so scrubbing a path does not
 * invalidate them.
 *
 * Run: node scripts/scrub-receipts.mjs [--check]
 *   --check reports what would change and exits 1 instead of writing.
 * @module scripts/scrub-receipts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const docs = join(pluginRoot, 'docs')
const checkOnly = process.argv.includes('--check')

/** A Windows absolute path, as JSON escapes it (`C:\\...`) or plainly. */
const ABSOLUTE = /(?:[A-Za-z]:\\\\[^"'\n]*|[A-Za-z]:\\[^"'\n]*)/g

/** The browser executables Archify records. */
const BROWSER = /"(?:executable)"\s*:\s*"(?:[^"]*[\\/])?(?:msedge|chrome|chromium)(?:\.exe)?"/gi

/**
 * Convert one absolute spelling to what the receipt should carry.
 * @param {string} raw - the path as it appears in the JSON text.
 * @returns {string} the scrubbed spelling.
 */
function scrubPath(raw) {
  const plain = raw.replace(/\\\\/g, '\\')
  const inside = relative(pluginRoot, plain)
  if (inside !== '' && !inside.startsWith('..') && !inside.startsWith(sep)) {
    return inside.split(sep).join('/')
  }
  // Outside the repository: the basename is the part a reader needs, and the
  // directory above it is the part that names this machine.
  return basename(plain)
}

const receipts = readdirSync(docs).filter((name) => /\.(visual-check|browser-check|finalize|finalize-summary|delivery).*\.json$/u.test(name))
let changed = 0
for (const name of receipts) {
  const path = join(docs, name)
  const before = readFileSync(path, 'utf8')
  let after = before.replace(ABSOLUTE, (match) => scrubPath(match))
  after = after.replace(BROWSER, '"executable": "msedge"')
  if (after === before) continue
  changed += 1
  if (checkOnly) {
    console.log(`would scrub ${name}`)
  } else {
    writeFileSync(path, after, 'utf8')
    console.log(`scrubbed ${name}`)
  }
}

console.log(changed === 0 ? 'no receipt carries a machine path' : `${changed} receipt(s) ${checkOnly ? 'need scrubbing' : 'scrubbed'}`)
process.exit(checkOnly && changed > 0 ? 1 : 0)
