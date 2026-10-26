/**
 * Re-pin and regenerate one diagram artifact in a single step.
 *
 * Every commit that touches `lib/**` makes the committed architecture evidence
 * stale, and the fix is always the same four moves:
 *
 *   1. point the diagram source's `meta.repository.revision` at HEAD;
 *   2. clear the receipts the previous run owns (Archify refuses to overwrite an
 *      evidence path whose ownership sidecar does not match);
 *   3. `finalize --browser-check` so the page embeds the new revision;
 *   4. `visual-check`, then `scrub-receipts` because finalize writes absolute
 *      paths back into the receipts.
 *
 * Doing that by hand went wrong three times in one session (a filtered delete
 * missed the file, a stale receipt blocked the run). This owns the sequence.
 *
 * Run: node scripts/repin-diagram.mjs <name>
 *   <name> is the artifact's basename, e.g. `architecture` for
 *   `docs/diagrams-src/<name>.json` -> `docs/<name>.html`.
 * @module scripts/repin-diagram
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const name = process.argv[2]
if (!name) {
  console.error('usage: node scripts/repin-diagram.mjs <name>   (e.g. architecture)')
  process.exit(2)
}

const sourcePath = join(pluginRoot, 'docs', 'diagrams-src', `${name}.json`)
const artifactPath = join(pluginRoot, 'docs', `${name}.html`)
if (!existsSync(sourcePath)) {
  console.error(`no diagram source at docs/diagrams-src/${name}.json`)
  process.exit(2)
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pluginRoot, encoding: 'utf8' }).trim()

// 1. Re-pin. Only the `revision` field is touched: the geometry and the prose are
//    authored content, and a script that rewrote them would be a renderer.
const source = readFileSync(sourcePath, 'utf8')
const repinned = source.replace(/("revision"\s*:\s*")[0-9a-f]{40}(")/u, `$1${head}$2`)
if (repinned === source) {
  console.warn('warning: the source declares no 40-hex revision to re-pin')
}
writeFileSync(sourcePath, repinned, 'utf8')
console.log(`re-pinned ${name} to ${head}`)

// The diagram TYPE comes from the source itself (`diagram_type`), not from the
// filename: Archify validates the body against the type it is told, and handing it
// `architecture` for a workflow yields a page that renders the wrong schema rather
// than an error. A source without the field is refused here, because guessing it
// is how that mismatch would ship.
const declaredType = (() => {
  try {
    return JSON.parse(repinned).diagram_type
  } catch (error) {
    console.error(`docs/diagrams-src/${name}.json is not valid JSON: ${error.message}`)
    process.exit(2)
  }
})()
if (typeof declaredType !== 'string' || declaredType === '') {
  console.error(`docs/diagrams-src/${name}.json declares no diagram_type; cannot pick a renderer`)
  process.exit(2)
}

// 2. Clear the receipts this artifact owns. The browser-check sidecar blocks its
//    own regeneration when it describes a different page, so it goes first.
const prefix = `${name}.`
for (const entry of readdirSync(join(pluginRoot, 'docs'))) {
  if (!entry.startsWith(prefix)) continue
  if (!/\.(browser-check|visual-check|finalize|finalize-summary|delivery)/u.test(entry)) continue
  rmSync(join(pluginRoot, 'docs', entry), { force: true })
  console.log(`cleared docs/${entry}`)
}

// 3. Finalize: this is what embeds the revision into the page.
const archify = join(pluginRoot, '.superpowers', 'archify-3.2.0', 'extracted', 'archify', 'bin', 'archify.mjs')
if (!existsSync(archify)) {
  console.error('the vendored archify 3.2.0 is not present; restore .superpowers/archify-3.2.0')
  process.exit(2)
}
const finalize = execFileSync('node', [archify, 'finalize', declaredType, sourcePath, artifactPath, '--browser-check', '--repo-root', pluginRoot, '--json'], { encoding: 'utf8' })
const finalizeReport = JSON.parse(finalize)
if (finalizeReport.ok !== true) {
  console.error('finalize failed:', JSON.stringify(finalizeReport.gates), JSON.stringify(finalizeReport.diagnostics))
  process.exit(1)
}
console.log('finalize: all gates pass')

// 4. Measure, then scrub the paths finalize just wrote.
execFileSync('node', [archify, 'visual-check', artifactPath, '--json'], { encoding: 'utf8' })
console.log('visual-check: measured')
execFileSync('node', [join(pluginRoot, 'scripts', 'scrub-receipts.mjs')], { encoding: 'utf8' })
console.log('receipts: scrubbed')

// The gate that has to be green before this script can claim success.
execFileSync('node', [join(pluginRoot, 'scripts', 'verify-diagrams.mjs')], { encoding: 'utf8', stdio: 'inherit' })
