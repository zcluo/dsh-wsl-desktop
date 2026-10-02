/**
 * Pin the revision claim the delivered diagram renders as "verified source at revision".
 *
 * docs/diagrams-src/architecture.json declares meta.repository.revision, and the built
 * HTML shows that value beside the components it cites: a reader takes it to mean the
 * diagram was checked against the tree AT THAT COMMIT. Nothing in the JSON enforces it,
 * and it is exactly the claim that rots silently — a cited module changes, the revision
 * stays where it was, and the artifact goes on saying "verified". This suite is the
 * enforcement, one row per cited path, and the rule is the sentence the claim is read as:
 *
 *     git merge-base --is-ancestor $(git log -1 --format=%H -- <path>) <revision>
 *
 * i.e. the last commit that changed the path must be an ANCESTOR of the declared revision,
 * so the revision's own tree carries the version the diagram was checked against.
 *
 * Why its own suite. Its subject is a DELIVERED ARTIFACT's provenance claim, which no other
 * suite reads: verify-package.mjs pins the published tarball and shells out to npm, so a
 * git-driven docs check living there would inherit that suite's npm precondition (a machine
 * without npm would report the docs claim as SKIP) and would report a documentation claim
 * as the package's state. verify-all.mjs gives every suite its own row for exactly this.
 *
 * A machine where git cannot run, or a tree that is not a git working tree (an exported
 * tarball, a vendored copy), cannot evaluate the claim at all: that is a COUNTED skip and
 * exit 2, never a green run, because a pass would claim provenance coverage this run did
 * not establish (the convention verify-modules, verify-9p, verify-fs-fence, verify-client-ui,
 * verify-confinement and verify-package implement).
 *
 * Run: node scripts/verify-diagrams.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detailText } from './detail.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
/** The diagram source whose meta.repository.revision the delivered HTML renders. */
const SOURCE_PATH = join(pluginRoot, 'docs', 'diagrams-src', 'architecture.json')

let failures = 0
let skipped = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${detailText(detail)}`}`)
  if (!ok) failures += 1
}

/**
 * Record checks that could not run here, and count them.
 * @param {string[]} labels - the assertions that were not evaluated.
 * @param {string} precondition - why they could not run.
 * @param {string} remedy - what the operator can do about it.
 */
function skip(labels, precondition, remedy) {
  skipped += labels.length
  console.log(`  SKIP  ${labels.join('; ')} — ${labels.length} check(s) not evaluated, ${precondition}; ${remedy}`)
}

/**
 * Run one git command in the checkout.
 *
 * spawnSync rather than execFileSync: `merge-base --is-ancestor` ANSWERS with its exit
 * status, and a throw would turn that answer into an exception. `null` means git itself
 * could not be started — the machine class the skip below is about, not a verdict.
 * @param {string[]} args - git arguments, after -C.
 * @returns {{status: number, stdout: string, stderr: string} | null} the run, or null when git did not start.
 */
function git(args) {
  const run = spawnSync('git', ['-C', pluginRoot, ...args], { encoding: 'utf8' })
  if (run.error !== undefined) return null
  return { status: run.status ?? 1, stdout: (run.stdout ?? '').trim(), stderr: (run.stderr ?? '').trim() }
}

/**
 * Every path the diagram cites, wherever the schema nests a `sources` entry.
 *
 * Recursive rather than `components[].sources[].path` by name: the schema is the artifact's
 * own, and a cited path that a restructure moved out of that one shape would silently stop
 * being checked — the vacuous-pass class this suite exists for.
 * @param {unknown} node - one JSON node.
 * @param {string[]} [found] - the paths collected so far.
 * @returns {string[]} the cited paths, in document order, without duplicates.
 */
function citedPaths(node, found = []) {
  if (Array.isArray(node)) {
    for (const entry of node) citedPaths(entry, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  for (const [key, value] of Object.entries(node)) {
    if (key === 'sources' && Array.isArray(value)) {
      for (const source of value) {
        const path = typeof source?.path === 'string' ? source.path.trim() : ''
        if (path !== '' && !found.includes(path)) found.push(path)
      }
      continue
    }
    citedPaths(value, found)
  }
  return found
}

/** The assertions that need only the source file; they run before the git precondition is measured. */
const BASE_CHECKS = [
  'the diagram source is readable JSON',
  'the source declares a repository revision and cites at least one path',
  'the declared revision is a commit in this repository',
  'the control: a path no commit carries is refused by the same rule',
]

let source = null
let problem = ''
try {
  source = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'))
} catch (error) {
  problem = String(error?.message ?? error)
}
check(BASE_CHECKS[0], source !== null, `${SOURCE_PATH} is not readable JSON: ${problem}`)

const revision = typeof source?.meta?.repository?.revision === 'string' ? source.meta.repository.revision.trim() : ''
const paths = source === null ? [] : citedPaths(source)
/** One label per cited path — the set the SKIP names, from the same list the rows print. */
const PATH_LABELS = paths.map((path) => `the last commit that changed ${path} is an ancestor of the declared revision`)
/**
 * The assertions that need GIT — the set the SKIP names.
 *
 * Rows 0 and 1 are deliberately absent: they only read the file and have already run by the
 * time the precondition is measured, so naming them would report rows that ran as rows that
 * did not (the sibling suites' rule: the labels come from the same list the checks print).
 */
const GIT_CHECKS = [BASE_CHECKS[2], ...PATH_LABELS, BASE_CHECKS[3]]

if (source !== null) {
  check(BASE_CHECKS[1], revision !== '' && paths.length > 0,
    { revision, paths, note: 'the claim is about cited paths, so a source that cites none cannot be pinned' })
}

// The git precondition, measured before anything is claimed about history: `--is-inside-work-tree`
// answers 'true' in a working tree and fails outside one, and git itself may not be installed.
const insideWorkTree = git(['rev-parse', '--is-inside-work-tree'])
const gitWorks = insideWorkTree !== null && insideWorkTree.status === 0 && insideWorkTree.stdout === 'true'
if (!gitWorks) {
  skip(GIT_CHECKS,
    `git cannot be run here or this is not a git working tree (git -C ${pluginRoot} rev-parse --is-inside-work-tree `
    + `-> ${insideWorkTree === null ? 'git did not start' : `exit ${insideWorkTree.status} ${JSON.stringify(insideWorkTree.stderr.slice(0, 120))}`})`,
    'run this suite from a git clone: the claim is about the repository history, and there is none here')
} else if (source !== null) {
  const type = git(['cat-file', '-t', revision])
  check(BASE_CHECKS[2],
    revision !== '' && type !== null && type.status === 0 && type.stdout === 'commit',
    { revision, type: type === null ? 'git did not start' : type.stdout || type.stderr })

  /**
   * The rule, applied to one path: the commit that last changed it, and whether the declared
   * revision is a DESCENDANT of that commit.
   * @param {string} path - a repo-relative path.
   * @returns {{ok: boolean, last: string, why: string}} the verdict and its evidence.
   */
  const ancestorOfRevision = (path) => {
    const log = git(['log', '-1', '--format=%H', '--', path])
    if (log === null) return { ok: false, last: '', why: 'git did not start' }
    if (log.stdout === '') return { ok: false, last: '', why: `no commit in this repository carries ${path}, so the claim cannot be verified for it` }
    const ancestry = git(['merge-base', '--is-ancestor', log.stdout, revision])
    if (ancestry === null) return { ok: false, last: log.stdout, why: 'git did not start' }
    return ancestry.status === 0
      ? { ok: true, last: log.stdout, why: '' }
      : { ok: false, last: log.stdout, why: `${path} was changed by ${log.stdout}, which is NOT an ancestor of ${revision}` }
  }

  for (const [index, path] of paths.entries()) {
    const verdict = ancestorOfRevision(path)
    check(PATH_LABELS[index], verdict.ok,
      verdict.ok ? undefined : { path, lastCommit: verdict.last, revision, why: verdict.why })
  }

  // The control: the same rule must REFUSE a path that no commit carries, or the rows above
  // would be satisfied by a rule that answers "yes" to anything.
  const control = ancestorOfRevision('docs/dsh-no-such-cited-path.txt')
  check(BASE_CHECKS[3], control.ok === false && control.why.includes('no commit'),
    { ok: control.ok, why: control.why })
}

if (failures > 0) console.log(`\n${failures} CHECK(S) FAILED${skipped === 0 ? '' : `, ${skipped} CHECK(S) SKIPPED`}`)
else if (skipped > 0) console.log(`\nEVERY CHECK THAT COULD RUN PASSED, ${skipped} CHECK(S) SKIPPED — exit 2, so verify-all reports this suite as SKIP`)
else console.log('\nALL CHECKS PASSED')
process.exitCode = failures > 0 ? 1 : skipped > 0 ? 2 : 0
