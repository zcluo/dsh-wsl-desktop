/**
 * Document-pair parity.
 *
 * WHY: this repository keeps the material a reader needs in either language as translated
 * PAIRS. Two translated documents can never be textually equal — their prose is expected to
 * differ — but the repository ARTIFACTS they name are not a matter of language: a document that
 * tells the reader about `scripts/x.mjs` and one that never mentions it describe different
 * repositories. This suite asserts that invariant, once per declared pair.
 *
 * WHY A DECLARED TABLE rather than a naming rule: `docs/` deliberately also holds
 * single-language documents, for which no second language's text exists, so a rule like "every
 * .md has an .en.md sibling" would be false on a healthy tree and a check built on it would
 * redden a correct one. A pair is bilingual because this table says so. A declared pair whose
 * member is MISSING fails CLOSED — that is exactly the state in which a translation silently
 * rots, which is the failure this suite exists to catch.
 *
 * WHY A LANGUAGE SUFFIX IS NORMALIZED AWAY: each document links its counterpart in the other
 * language, so `README.md` names `docs/ARCHITECTURE.md` while `README.en.md` names
 * `docs/ARCHITECTURE.en.md`. Those are the SAME document, and a rule that treated them as two
 * artifacts would fail every correctly translated pair. So the `.en` side of a declared pair
 * canonicalizes onto its primary: same document, one identity. (This also makes the pair's own
 * language-switch links cancel out by construction, instead of needing an exclusion.)
 *
 * WHY THE DELIMITERS INCLUDE FULL-WIDTH PUNCTUATION: it was measured, not assumed. The Chinese
 * verification section wrote `跑真 sync.ps1：代次保留…` — a full-width colon glued to the name —
 * where the English wrote `runs the real sync.ps1 against …`. Splitting on ASCII marks alone
 * therefore did NOT register `sync.ps1` on the Chinese side, and the pair reported a divergence
 * that was purely an artifact of punctuation; worse, ANY Chinese sentence whose artifact name is
 * followed by a full-width mark was invisible to this rule. Punctuation is itself a matter of
 * language, so the splitter is language-neutral about it. Measured on the README pair before and
 * after widening: 32 artifacts each way and still in parity — widening only makes the rule see
 * MORE, so it cannot hide a one-sided edit.
 *
 * Run: node scripts/verify-docs.mjs
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/**
 * The declared bilingual pairs. Adding a translation means adding its row here; a row whose
 * file does not exist is an ERROR, not a silent no-op.
 * @type {Array<[string, string]>}
 */
const DOC_PAIRS = [
  ['README.md', 'README.en.md'],
  ['docs/ARCHITECTURE.md', 'docs/ARCHITECTURE.en.md'],
  ['docs/CONFINEMENT.md', 'docs/CONFINEMENT.en.md'],
  ['docs/FS-FENCE.md', 'docs/FS-FENCE.en.md'],
  ['docs/ENGINEERING-NOTES.md', 'docs/ENGINEERING-NOTES.en.md'],
  ['docs/PTY-BRIDGE.md', 'docs/PTY-BRIDGE.en.md'],
  ['docs/VERIFICATION.md', 'docs/VERIFICATION.en.md'],
]

/** The `.en` side of a declared pair, keyed by basename, mapping onto its primary's basename. */
const PRIMARY_BASENAME = new Map(DOC_PAIRS.map(([primary, secondary]) => [basename(secondary), basename(primary)]))

/** A repository file a document can NAME: a path ending in a known artifact extension. */
const ARTIFACT_TOKEN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mjs|cjs|js|ts|tsx|json|md|sh|ps1|ya?ml)$/

// Whitespace and both the ASCII and the full-width marks a sentence can put after a name.
const DELIMITERS = /[\s|()\x22\x27\x60,;:：；，、。！？（）［］【】「」『』“”‘’]+/

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
  if (!ok && detail !== undefined) console.log(`        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  if (!ok) failures += 1
}

/**
 * Canonicalize a named artifact so that a document's two language editions share one identity.
 * @param {string} token - an artifact path as it was written.
 * @returns {string} the same path with a declared pair's `.en` basename replaced by its primary.
 */
function canonicalArtifact(token) {
  const primary = PRIMARY_BASENAME.get(basename(token))
  if (primary === undefined) return token
  const dir = dirname(token)
  return dir === '.' ? primary : `${dir}/${primary}`
}

/**
 * The repository artifacts a document NAMES, keyed by canonical basename.
 * @param {string} text - the document text.
 * @returns {Map<string, Set<string>>} canonical basename -> the path spellings used for it.
 */
function namedArtifacts(text) {
  const named = new Map()
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*\x60\x60\x60/.test(line)) { inFence = !inFence; continue }
    const spans = []
    // A fence carries commands, so its whole line counts; outside one, only the marked spans do
    // — otherwise ordinary prose punctuation would read as an artifact reference.
    if (inFence) spans.push(line)
    else {
      for (const match of line.matchAll(/\x60([^\x60\n]+)\x60/g)) spans.push(match[1])
      for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) spans.push(match[1])
      for (const match of line.matchAll(/\*\*([^*\n]+)\*\*/g)) spans.push(match[1])
    }
    for (const span of spans) {
      // `:31-37` and `:333,346` are line references on one artifact; the delimiters separate
      // the artifacts on a recorded command line.
      for (const word of span.split(DELIMITERS)) {
        const token = word.replace(/^(?:\.\/|\$)/, '')
        if (!ARTIFACT_TOKEN.test(token)) continue
        const canonical = canonicalArtifact(token)
        const name = basename(canonical)
        if (!named.has(name)) named.set(name, new Set())
        // Basename identity is only sound while no two references are different files, so only
        // path-bearing references are recorded and compared (see the suffix rule below).
        if (canonical.includes('/')) named.get(name).add(canonical)
      }
    }
  }
  return named
}

const suffixOf = (one, other) => one === other || one.endsWith(`/${other}`) || other.endsWith(`/${one}`)

for (const [left, right] of DOC_PAIRS) {
  let leftText
  let rightText
  try {
    leftText = await readFile(join(pluginRoot, left), 'utf8')
  } catch {
    check(`the declared pair ${left} / ${right} exists`, false, `${left} is declared here but cannot be read`)
    continue
  }
  try {
    rightText = await readFile(join(pluginRoot, right), 'utf8')
  } catch {
    check(`the declared pair ${left} / ${right} exists`, false, `${right} is declared here but cannot be read`)
    continue
  }

  const leftNamed = namedArtifacts(leftText)
  const rightNamed = namedArtifacts(rightText)
  const undecidable = []
  for (const name of new Set([...leftNamed.keys(), ...rightNamed.keys()])) {
    const spellings = [...new Set([...(leftNamed.get(name) ?? []), ...(rightNamed.get(name) ?? [])])]
    if (spellings.length > 1 && !spellings.every((one) => suffixOf(one, spellings[0]))) {
      undecidable.push(`${name}: ${spellings.join(' / ')}`)
    }
  }
  const onlyLeft = [...leftNamed.keys()].filter((name) => !rightNamed.has(name)).sort()
  const onlyRight = [...rightNamed.keys()].filter((name) => !leftNamed.has(name)).sort()
  check(`${left} and ${right} name the same repository artifacts`,
    undecidable.length === 0 && onlyLeft.length === 0 && onlyRight.length === 0,
    `${left} only: [${onlyLeft.join(', ')}] ${right} only: [${onlyRight.join(', ')}]`
    + (undecidable.length === 0 ? '' : ` — undecidable basename(s): ${undecidable.join('; ')}`))
}

console.log(`\n${failures === 0 ? `${checks} pair(s) in parity` : `${failures} check(s) failed`}`)
process.exit(failures > 0 ? 1 : 0)
