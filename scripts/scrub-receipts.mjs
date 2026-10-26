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
 *   - a path outside the repository keeps its last two segments: the basename is
 *     what a reader needs, the directory above it distinguishes two files that
 *     happen to share a name, and everything above THAT identifies the machine.
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
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const docs = join(pluginRoot, 'docs')
const checkOnly = process.argv.includes('--check')

/** A Windows absolute path, as JSON escapes it (`C:\\...`) or plainly. */
const WINDOWS_ABSOLUTE = /(?:[A-Za-z]:\\\\[^"'\n]*|[A-Za-z]:\\[^"'\n]*)/g
/**
 * A POSIX absolute path in a JSON string.
 *
 * Archify runs on Windows here, so its receipts carry drive paths — but the same
 * receipts are regenerated on other machines, and a rule that silently ignores one
 * spelling stops being a rule. The lookbehind rejects a leading `//` (which is how
 * a URL reaches this pattern: `https://host/path` would otherwise match from the
 * second slash) and the `:` of a scheme; the second alternative form covers the
 * `\/` escaping JSON permits.
 */
const POSIX_ABSOLUTE = /(?<![:\w/])\/(?!\/)(?:[\w.-]+\/)+(?:[\w.-]+)?|(?<![:\w])\\\/(?!\\\/)(?:[\w.-]+\\\/)+(?:[\w.-]+)?/g

/** The browser executables Archify records. */
const BROWSER = /"(?:executable)"\s*:\s*"(?:[^"]*[\\/])?(?:msedge|chrome|chromium)(?:\.exe)?"/gi

/**
 * Convert one absolute spelling to what the receipt should carry.
 *
 * A path under the repository becomes repository-relative, which is both portable
 * and the part a reader needs. A path outside it keeps its last TWO segments rather
 * than the basename alone: two `architecture.json` files in different directories
 * would otherwise collapse to the same string and the receipt would stop saying
 * which file it describes.
 * @param {string} raw - the path as it appears in the JSON text.
 * @returns {string} the scrubbed spelling.
 */
function scrubPath(raw) {
  const plain = raw.replace(/\\\\/gu, '\\').replace(/\\\//gu, '/')
  const inside = relative(pluginRoot, plain)
  if (inside !== '' && !inside.startsWith('..') && !inside.startsWith(sep)) {
    return inside.split(sep).join('/')
  }
  const segments = plain.split(/[\\/]+/u).filter((part) => part !== '')
  return segments.slice(-2).join('/')
}

const receipts = readdirSync(docs).filter((name) => /\.(visual-check|browser-check|finalize|finalize-summary|delivery).*\.json$/u.test(name))
let changed = 0
for (const name of receipts) {
  const path = join(docs, name)
  const before = readFileSync(path, 'utf8')
  let after = before.replace(WINDOWS_ABSOLUTE, (match) => scrubPath(match))
  after = after.replace(POSIX_ABSOLUTE, (match) => (match.includes('://') ? match : scrubPath(match)))
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
