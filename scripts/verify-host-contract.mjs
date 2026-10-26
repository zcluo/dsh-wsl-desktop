/**
 * Offline checks for the host contract.
 *
 * The manifest is only useful if it stays true in three directions: every declared
 * symbol is actually used by the plugin, every host access the plugin makes is
 * declared, and the packages whose exports it imports still export them. The first
 * two are text facts; the third needs the installed host and SKIPs (exit 2) without it,
 * exactly like verify-modules.
 *
 * Run: node scripts/verify-host-contract.mjs
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { blankLiterals } from './source-text.mjs'
import {
  CLIENT_SYMBOLS,
  FEATURES,
  HOST_IMPORTS,
  HOST_SYMBOLS,
  probeClient,
  probeHost,
  resetContractCache,
} from '../lib/host/contract.js'
import { FEATURE_IDS } from '../lib/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value).slice(0, 300) })
const { check } = checker

/**
 * Read every production source file whose text the usage checks inspect.
 * @returns {Promise<{text: string, client: string}>} the concatenated text and the client file.
 */
async function readTree() {
  const files = [
    join(pluginRoot, 'lib', 'index.js'),
    join(pluginRoot, 'lib', 'http-admission.js'),
    join(pluginRoot, 'lib', 'host', 'contract.js'),
  ]
  const wslDir = join(pluginRoot, 'lib', 'wsl')
  for (const entry of await readdir(wslDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(join(wslDir, entry.name))
  }
  const texts = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  return {
    text: texts.join('\n'),
    client: await readFile(join(pluginRoot, 'lib', 'client.js'), 'utf8'),
  }
}

/**
 * Strip comments while KEEPING string literals.
 *
 * `blankLiterals` removes both, which would erase the service name inside a
 * `get('agentPresets')` call. The accessor scan needs the literal and must not read a
 * comment that merely mentions the call shape — the measured false positive was three
 * comments saying `ctx.get('sandbox')` while no live access existed.
 * @param {string} text - the source text.
 * @returns {string} the source with comment bodies replaced by spaces.
 */
function stripComments(text) {
  let out = ''
  let index = 0
  let quote = null
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += text[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      out += ' '
      index = end === -1 ? text.length : end + 2
      continue
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      out += ' '
      index = end === -1 ? text.length : end
      continue
    }
    out += char
    index += 1
  }
  return out
}

const tree = await readTree()
const production = blankLiterals(tree.text)
const commentless = stripComments(tree.text)
const clientCode = blankLiterals(tree.client)
const clientCommentless = stripComments(tree.client)
const allSymbols = [...HOST_SYMBOLS, ...CLIENT_SYMBOLS]

/**
 * Whether a token is referenced: as code, or as a string spelling the manifest
 * declares (an event name only ever appears as a literal).
 * @param {string} blanked - the source with literals blanked.
 * @param {string} raw - the source as written.
 * @param {string} token - the token.
 * @returns {boolean} whether it is referenced.
 */
function referenced(blanked, raw, token) {
  return blanked.includes(token) || raw.includes(`'${token}'`) || raw.includes(`"${token}"`)
}

console.log('\nmanifest integrity')
check('every symbol id is unique',
  new Set(allSymbols.map((symbol) => symbol.id)).size === allSymbols.length,
  allSymbols.map((symbol) => symbol.id))
check('every symbol names a known feature',
  allSymbols.every((symbol) => FEATURE_IDS.includes(symbol.feature)),
  allSymbols.filter((symbol) => !FEATURE_IDS.includes(symbol.feature)).map((symbol) => symbol.id))
check('every symbol has a kind and a path',
  allSymbols.every((symbol) => typeof symbol.kind === 'string' && Array.isArray(symbol.path)),
  allSymbols.filter((symbol) => typeof symbol.kind !== 'string' || !Array.isArray(symbol.path)).map((symbol) => symbol.id))
check('every feature requirement resolves to a declared symbol',
  Object.values(FEATURES).every((feature) => [...feature.required, ...feature.optional]
    .every((id) => allSymbols.some((symbol) => symbol.id === id))),
  Object.entries(FEATURES).filter(([, feature]) => [...feature.required, ...feature.optional]
    .some((id) => !allSymbols.some((symbol) => symbol.id === id))).map(([id]) => id))
check('every feature carries its remedy code',
  Object.values(FEATURES).every((feature) => feature.remedyCode === 'host-capability-missing'))
check('every host import names a module and an export',
  HOST_IMPORTS.every((entry) => typeof entry.module === 'string' && typeof entry.export === 'string'))
{
  // The manifest is useful only if it is the WHOLE set: a new host package
  // imported by lib/ must red until it is declared, or the drift this layer
  // exists to surface stays invisible.
  const found = new Set()
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const text = await readFile(full, 'utf8')
      // Anchored to a line beginning so JSDoc `@param {import(...)}` type
      // references do not count as runtime host imports.
      for (const match of text.matchAll(/^\s*import\s+(?:[\s\S]*?)\s+from\s+['"](@deepseek-ai\/[^'"]+)['"]/gmu)) found.add(match[1])
      for (const match of text.matchAll(/^\s*import\s+['"](@deepseek-ai\/[^'"]+)['"]/gmu)) found.add(match[1])
      for (const match of text.matchAll(/^\s*(?:await\s+)?import\(\s*['"](@deepseek-ai\/[^'"]+)['"]\s*\)/gmu)) found.add(match[1])
    }
  }
  await walk(join(pluginRoot, 'lib'))
  const declared = new Set(HOST_IMPORTS.map((entry) => entry.module))
  const undeclared = [...found].filter((module) => !declared.has(module)).sort()
  check('every host package imported by lib is declared in HOST_IMPORTS',
    undeclared.length === 0, undeclared)
  check('the reverse scan actually found the host imports', found.size >= 5, [...found].sort())
}
check('every client symbol says whether it is required',
  CLIENT_SYMBOLS.every((symbol) => typeof symbol.required === 'boolean'),
  CLIENT_SYMBOLS.filter((symbol) => typeof symbol.required !== 'boolean').map((symbol) => symbol.id))

console.log('\nusage: declared at both ends')
for (const symbol of HOST_SYMBOLS) {
  check(`${symbol.id} is referenced by the host source`,
    referenced(production, commentless, symbol.service) && referenced(production, commentless, symbol.member),
    `${symbol.service} / ${symbol.member}`)
}
for (const symbol of CLIENT_SYMBOLS) {
  const first = symbol.path[0]
  const member = symbol.path[symbol.path.length - 1]
  check(`${symbol.id} is referenced by the browser source`,
    referenced(clientCode, clientCommentless, first) && referenced(clientCode, clientCommentless, member),
    `${first} / ${member}`)
}

// The reverse direction: a host service the plugin fetches but the manifest does not
// declare is exactly the reach-in this layer exists to make visible.
{
  const accessors = new Set()
  for (const pattern of [/hostCtx\??\.get\(\s*'([^']+)'\s*\)/g, /ctx\.get\(\s*'([^']+)'\s*\)/g]) {
    for (const match of commentless.matchAll(pattern)) accessors.add(match[1])
  }
  const declared = new Set(HOST_SYMBOLS.map((symbol) => symbol.service))
  const injected = new Set(['webServer', 'connection'])
  check('every host service the plugin fetches is declared',
    [...accessors].every((name) => declared.has(name) || injected.has(name)),
    [...accessors].filter((name) => !declared.has(name) && !injected.has(name)))
}

console.log('\nprobe behaviour (fake host)')
/**
 * A host context with every declared service, optionally missing one member.
 * @param {string | null} [omit] - the member to delete from agentPresets.
 * @returns {object} the fake context and a call counter.
 */
function fakeHost(omit = null) {
  let calls = 0
  const presets = {
    readDocument: async () => ({ content: 'x' }),
    register: () => {},
    definitions: new Map(),
    resolve: async () => ({ id: 'standard' }),
    list: async () => [],
    serviceFor: () => ({}),
  }
  if (omit !== null) delete presets[omit]
  const services = {
    agentPresets: presets,
    agents: { create: async () => ({}) },
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    subprocess: { spawnTerminal: () => {} },
    workspaceRegistry: {},
  }
  return { get: (name) => { calls += 1; return services[name] }, calls: () => calls }
}

{
  resetContractCache()
  const host = fakeHost()
  const probe = await probeHost(host)
  check('a complete host is ok', probe.status === 'ok', probe)
  check('the host-scoped required feature is ok', probe.features['preset-generation'] === 'ok', probe.features)
  check('the client-scoped features are unknown on this side',
    probe.features.picker === 'unknown' && probe.features['session-create'] === 'unknown', probe.features)
  check('terminal, search and selftest are probed on this side',
    probe.features.terminal === 'ok' && probe.features.search === 'ok' && probe.features.selftest === 'ok', probe.features)
  const before = host.calls()
  const again = await probeHost(host)
  check('the second probe inside the TTL answers from cache',
    host.calls() === before && again.status === probe.status, `${before} -> ${host.calls()}`)
  resetContractCache()
  await probeHost(host)
  check('the reset forces a real reprobe', host.calls() > before, `${before} -> ${host.calls()}`)
}
{
  resetContractCache()
  const probe = await probeHost(fakeHost('readDocument'))
  check('a missing preset method degrades the feature',
    probe.features['preset-generation'] === 'degraded' && probe.status === 'degraded', probe)
  check('the degraded probe names the missing symbol',
    probe.missing.some((entry) => entry.id === 'agentPresets.readDocument'), probe.missing)
}
{
  const complete = {
    workspaces: { list: { getSnapshot: () => ({ items: [] }) }, create: async () => ({}) },
    uiWorkspace: { openSession: () => {} },
    remote: { session: { create: async () => ({}) } },
    sessions: { create: async () => ({}) },
  }
  const probe = probeClient(complete)
  check('a complete browser half is ok for its features',
    probe.features.picker === 'ok' && probe.features['session-create'] === 'ok', probe)
  const broken = { ...complete, remote: { session: {} } }
  const degraded = probeClient(broken)
  check('a missing remote session create degrades both client features',
    degraded.features.picker === 'degraded' && degraded.features['session-create'] === 'degraded', degraded)
  check('the degraded client probe names the missing symbol',
    degraded.missing.some((entry) => entry.id === 'remote.session.create'), degraded.missing)
}

console.log('\nhost package exports (needs the installed host)')
const deps = process.env.DSH_WSL_DEPS ?? join(pluginRoot, 'node_modules')
if (!existsSync(deps)) {
  checker.skip(HOST_IMPORTS.length)
  // Measured: setting DSH_WSL_DEPS at a directory whose packages resolve DOES run all of
  // these rows (48/48 against a pnpm store's hoisted directory). Point it at a directory
  // that can resolve the host packages, or link the host node_modules at the plugin root.
  console.log(`  SKIP  ${HOST_IMPORTS.length} import check(s) not evaluated, no dependencies at ${deps}.`)
  console.log('        Set DSH_WSL_DEPS to a node_modules directory that can resolve the host packages')
  console.log('        (for example a pnpm store\'s node_modules/.pnpm/node_modules), or link the host')
  console.log('        node_modules at the plugin root.')
} else {
  const modules = [...new Set(HOST_IMPORTS.map((entry) => entry.module))]
  // Resolve through the directory the caller named, not through the plugin root:
  // DSH_WSL_DEPS is allowed to point at a profile's node_modules, whose packages
  // resolve from the profile package.json beside it. A package that is not there
  // (host internals live inside the app bundle, not the profile) is a SKIP for
  // those exports, not a FAIL — the false red this check used to produce.
  const resolutionBase = process.env.DSH_WSL_DEPS === undefined
    ? join(pluginRoot, 'package.json')
    : join(dirname(deps), 'package.json')
  const requireFrom = createRequire(resolutionBase)
  const resolvedPaths = new Map()
  const unresolved = []
  for (const spec of modules) {
    try {
      resolvedPaths.set(spec, requireFrom.resolve(spec))
    } catch {
      unresolved.push(spec)
    }
  }
  if (unresolved.length === modules.length) {
    checker.skip(HOST_IMPORTS.length)
    console.log(`  SKIP  ${HOST_IMPORTS.length} import check(s) not evaluated: no declared host package resolves from ${deps}`)
  } else {
    for (const spec of modules) {
      const entries = HOST_IMPORTS.filter((item) => item.module === spec)
      if (unresolved.includes(spec)) {
        checker.skip(entries.length)
        console.log(`  SKIP  ${entries.length} check(s) for ${spec}: it does not resolve from ${deps}`)
        continue
      }
      let module = null
      let failure = null
      try {
        // Import the RESOLVED path, not the bare specifier: with DSH_WSL_DEPS pointing
        // at a profile, bare ESM resolution would still walk from this script's
        // directory (the plugin root) and miss the profile package the resolver just
        // found. The URL import uses the same package file the host would.
        module = await import(pathToFileURL(resolvedPaths.get(spec)).href)
      } catch (error) {
        failure = error
      }
      for (const entry of entries) {
        check(`${entry.id} is exported by the installed host`,
          failure === null && module !== null && entry.export in module,
          failure === null ? Object.keys(module ?? {}) : failure)
      }
    }
  }
}

const code = checker.failures > 0 ? 1 : checker.skipped > 0 ? 2 : 0
console.log(`\n${checker.passed} passed, ${checker.failures} failed, ${checker.skipped} skipped`)
process.exit(code)
