/**
 * Offline checks for the browser error catalog and the route classifier.
 *
 * The browser half receives a code, never the host message. This suite pins the
 * three places where a "readable failure" can silently regress: the catalog a code
 * resolves against, the params the wire is allowed to carry, and the classifier
 * that turns a thrown error into that code.
 *
 * Run: node scripts/verify-protocol.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import {
  CHECK_IDS,
  CHECK_LABELS,
  CHECK_REMEDIES,
  ERROR_CODES,
  FEATURE_IDS,
  FEATURE_LABELS,
  SAFE_PARAMS,
} from '../lib/protocol.js'
import { WslRouteError, browserFailure, classifyRouteFailure, routeErrorFor } from '../lib/route-errors.js'
import { WslDomainError } from '../lib/wsl/errors.js'
import { assertDistro, assertLinuxPath, assertUser } from '../lib/validate.js'

const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 300) })
const { check } = checker

const CODES = [
  'wsl-not-available', 'distro-unknown', 'distro-unreachable', 'user-unknown',
  'path-invalid', 'path-not-found', 'path-not-directory', 'path-denied', 'preset-not-ready',
  'host-capability-missing', 'host-plugin-stale', 'too-busy', 'internal',
  'transport', 'catalog-unavailable',
]
const FAMILIES = new Set(['debian', 'fedora', 'arch', 'alpine', 'suse'])

/**
 * Describe what is wrong with one remedy, or an empty list when it is well formed.
 * @param {object} entry - one catalog entry.
 * @returns {string[]} the problems.
 */
function remedyProblems(entry) {
  const remedy = entry?.remedy
  if (remedy === null || typeof remedy !== 'object') return ['no remedy object']
  if (remedy.kind === 'command') {
    const families = remedy.families ?? {}
    const badFamily = Object.keys(families).filter((key) => !FAMILIES.has(key))
    if (badFamily.length > 0) return [`unknown families: ${badFamily.join(',')}`]
    if (typeof remedy.value !== 'string' && Object.keys(families).length === 0) return ['no command value']
    return []
  }
  if (remedy.kind === 'link') {
    return typeof remedy.href === 'string' && (remedy.href.startsWith('https://') || remedy.href.startsWith('docs/'))
      ? [] : ['bad link']
  }
  if (remedy.kind === 'text') {
    return typeof remedy.zh === 'string' && remedy.zh.length > 0
      && typeof remedy.en === 'string' && remedy.en.length > 0 ? [] : ['text remedy is not bilingual']
  }
  return [`unknown kind ${JSON.stringify(remedy.kind)}`]
}

console.log('\ncatalog')
check('the catalog carries exactly the wire codes',
  Object.keys(ERROR_CODES).sort().join(',') === [...CODES].sort().join(','),
  Object.keys(ERROR_CODES))
check('every code carries both languages and a doc anchor',
  Object.values(ERROR_CODES).every((entry) => typeof entry.zh === 'string' && entry.zh.length > 0
    && typeof entry.en === 'string' && entry.en.length > 0
    && typeof entry.doc === 'string' && entry.doc.startsWith('DIAGNOSTICS.md#')),
  Object.entries(ERROR_CODES).filter(([, entry]) => !(entry.zh && entry.en && entry.doc?.startsWith('DIAGNOSTICS.md#'))).map(([code]) => code))
check('every remedy is well formed and bilingual where it carries prose',
  Object.values(ERROR_CODES).every((entry) => remedyProblems(entry).length === 0),
  Object.entries(ERROR_CODES).map(([code, entry]) => [code, remedyProblems(entry)]).filter(([, problems]) => problems.length > 0))

console.log('\nfeature and check vocabulary')
check('feature ids are the six known features',
  FEATURE_IDS.join(',') === 'picker,preset-generation,session-create,terminal,search,selftest',
  FEATURE_IDS)
check('every feature has a zh and en label',
  FEATURE_IDS.every((id) => FEATURE_LABELS[id]?.zh && FEATURE_LABELS[id]?.en), FEATURE_LABELS)
check('check ids are the eight known checks',
  CHECK_IDS.join(',') === 'bash,python3,util-linux,getent,runner,helper,nnp,wsl2', CHECK_IDS)
check('every check has a zh and en label',
  CHECK_IDS.every((id) => CHECK_LABELS[id]?.zh && CHECK_LABELS[id]?.en), CHECK_LABELS)
check('every check has exactly one remedy',
  CHECK_IDS.every((id) => CHECK_REMEDIES[id] !== undefined) && Object.keys(CHECK_REMEDIES).length === CHECK_IDS.length,
  Object.keys(CHECK_REMEDIES))
check('every check remedy is well formed',
  CHECK_IDS.every((id) => remedyProblems({ remedy: CHECK_REMEDIES[id] }).length === 0),
  Object.entries(CHECK_REMEDIES).map(([id, remedy]) => [id, remedyProblems({ remedy })]))

console.log('\nparams allowlist')
check('every code has a params allowlist',
  CODES.every((code) => Array.isArray(SAFE_PARAMS[code])), Object.keys(SAFE_PARAMS))
check('the allowlist names only real codes',
  Object.keys(SAFE_PARAMS).every((code) => CODES.includes(code)), Object.keys(SAFE_PARAMS))
check('internal allows the ref', SAFE_PARAMS.internal.includes('ref'), SAFE_PARAMS.internal)
check('user-unknown allows only the user', SAFE_PARAMS['user-unknown'].join(',') === 'user',
  SAFE_PARAMS['user-unknown'])

console.log('\nWslRouteError')
{
  const mutated = new WslRouteError('not-a-code')
  check('an unknown code becomes internal', mutated.code === 'internal', mutated.code)
  check('the internal fallback carries a six-hex ref',
    typeof mutated.params?.ref === 'string' && /^[0-9a-f]{6}$/.test(mutated.params.ref), mutated.params)
}
{
  const filtered = browserFailure(new WslRouteError('user-unknown', { user: 'me', path: '/x', extra: 1 }))
  check('browserFailure keeps only the allowed params',
    JSON.stringify(filtered) === JSON.stringify({ code: 'user-unknown', params: { user: 'me' } }), filtered)
  check('browserFailure never carries message, stack or error',
    !('error' in filtered) && !('message' in filtered) && !('stack' in filtered), Object.keys(filtered))
  const long = browserFailure(new WslRouteError('path-not-found', { path: 'x'.repeat(500) }))
  check('a param value is truncated to 200 characters',
    long.params.path.length === 200, long.params.path.length)
}

console.log('\nclassifier')
check('a timeout becomes distro-unreachable',
  classifyRouteFailure({ timedOut: true }).code === 'distro-unreachable')
check('a missing wsl.exe in a discovery call becomes wsl-not-available',
  classifyRouteFailure(Object.assign(new Error('x'), { code: 'ENOENT' }), { discovery: true }).code === 'wsl-not-available')
check('the same ENOENT outside discovery stays internal',
  classifyRouteFailure(Object.assign(new Error('x'), { code: 'ENOENT' })).code === 'internal')
check('a typed user error maps to user-unknown',
  classifyRouteFailure(new WslDomainError('user-unknown', 'nope')).code === 'user-unknown')
check('a typed path error maps to path-not-found',
  classifyRouteFailure(new WslDomainError('path-not-found', 'gone')).code === 'path-not-found')
check('a typed directory error maps to path-not-directory',
  classifyRouteFailure(new WslDomainError('path-not-directory', 'file')).code === 'path-not-directory')
check('a typed permission error maps to path-denied',
  classifyRouteFailure(new WslDomainError('path-denied', 'denied')).code === 'path-denied')
check('a typed unreachable error maps to distro-unreachable',
  classifyRouteFailure(new WslDomainError('distro-unreachable', 'down')).code === 'distro-unreachable')
{
  const internal = classifyRouteFailure(new Error('boom'), { ref: 'abc123' })
  check('an unclassified error is internal with the supplied ref',
    internal.code === 'internal' && internal.params?.ref === 'abc123', internal)
  const explicit = new WslRouteError('internal')
  check('an explicitly constructed internal always carries a ref',
    typeof explicit.params?.ref === 'string' && /^[0-9a-f]{6}$/.test(explicit.params.ref), explicit.params)
}
{
  let rejected = false
  try { new WslDomainError('ghost', 'x') } catch { rejected = true }
  check('a domain error refuses an unknown domain code', rejected)
}

console.log('\ndomain-to-wire mapping')
{
  const user = routeErrorFor(new WslDomainError('user-unknown', 'x'), { user: 'me', distro: 'd', path: '/p' })
  check('a domain user error keeps only the user',
    user instanceof WslRouteError && user.code === 'user-unknown'
    && JSON.stringify(browserFailure(user)) === JSON.stringify({ code: 'user-unknown', params: { user: 'me' } }),
    user)
  const missing = routeErrorFor(new WslDomainError('path-not-found', 'x'), { path: '/gone', user: 'me' })
  check('a domain path error keeps only the path',
    missing instanceof WslRouteError
    && JSON.stringify(browserFailure(missing)) === JSON.stringify({ code: 'path-not-found', params: { path: '/gone' } }),
    missing)
  const directory = routeErrorFor(new WslDomainError('path-not-directory', 'x'), { path: '/file' })
  check('a domain directory error keeps the path',
    directory.code === 'path-not-directory' && directory.params.path === '/file', directory)
  const down = routeErrorFor(new WslDomainError('distro-unreachable', 'x'), { distro: 'debian' })
  check('a domain unreachable error keeps the distro',
    down.code === 'distro-unreachable' && down.params.distro === 'debian', down)
  const passthrough = new Error('boom')
  check('a non-domain error is passed through unchanged', routeErrorFor(passthrough) === passthrough)
}

console.log('\nroute input validation')
{
  const failureOf = (call) => {
    try {
      call()
      return null
    } catch (error) {
      return error
    }
  }
  check('a traversal distro is distro-unknown',
    failureOf(() => assertDistro('../debian'))?.code === 'distro-unknown')
  check('a relative path is path-invalid',
    failureOf(() => assertLinuxPath('home/me'))?.code === 'path-invalid')
  check('a control-character path is path-invalid',
    failureOf(() => assertLinuxPath('/tmp/\u0001bad'))?.code === 'path-invalid')
  check('a backslash path is path-invalid',
    failureOf(() => assertLinuxPath('/home\\me'))?.code === 'path-invalid')
  check('a space in the user is user-unknown',
    failureOf(() => assertUser('bad user'))?.code === 'user-unknown')
  check('a valid triple passes',
    assertDistro('debian') === 'debian'
    && assertLinuxPath('/home/me') === '/home/me'
    && assertUser('me') === 'me' && assertUser(undefined) === undefined)
  const wire = browserFailure(failureOf(() => assertLinuxPath('/tmp/\u0001bad')))
  check('the invalid path never reaches the browser as internal', wire.code === 'path-invalid', wire)
}

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
