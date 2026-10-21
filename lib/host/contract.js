/**
 * The host contract: every runtime symbol this plugin depends on, declared once.
 *
 * A desktop update has broken this plugin four times in one release (0.1.6 → 0.1.7),
 * and once more silently when an export was removed. A missing symbol used to surface
 * as a half-working feature or a stack in a log; here it becomes a feature-level fact
 * that the route can report and the dialog can show.
 *
 * Static imports are not probed at runtime — a missing export fails the module load
 * before any object exists to inspect. They live in {@link HOST_IMPORTS} so the
 * offline verifier can check them against an installed desktop.
 * @module dsh-wsl-desktop/host/contract
 */

import { FEATURE_IDS } from '../protocol.js'

/** How long one host probe answers from its cache. */
export const HOST_CACHE_MS = 5_000

/**
 * Capability groups, each with the symbols it needs.
 *
 * `required` members must be present for the feature to be `ok`. A group with no
 * runtime host symbol (for example `picker`, whose services live in the browser) is
 * `unknown` here and is filled in by {@link probeClient} on the client half.
 */
export const FEATURES = Object.freeze({
  picker: {
    required: ['workspaces.list', 'workspaces.create', 'uiWorkspace.openSession', 'remote.session.create'],
    optional: ['sessions.create'],
    remedyCode: 'host-capability-missing',
  },
  'preset-generation': {
    required: [
      'agentPresets.readDocument',
      'agentPresets.register',
      'agentPresets.definitions',
      'agentPresets.resolve',
      'agentPresets.list',
    ],
    optional: [],
    remedyCode: 'host-capability-missing',
  },
  'session-create': {
    required: ['remote.session.create'],
    optional: ['sessions.create', 'api-session/added'],
    remedyCode: 'host-capability-missing',
  },
  terminal: {
    required: ['subprocess.spawnTerminal'],
    optional: [],
    remedyCode: 'host-capability-missing',
  },
  search: {
    required: ['tools.register', 'systemPrompt.section'],
    optional: [],
    remedyCode: 'host-capability-missing',
  },
  selftest: {
    required: ['agents.create', 'agentPresets.serviceFor'],
    optional: ['workspaceRegistry'],
    remedyCode: 'host-capability-missing',
  },
})

/** The host services a symbol belongs to; used by the usage check and the probe. */
export const HOST_SYMBOLS = Object.freeze([
  { id: 'agentPresets.readDocument', feature: 'preset-generation', kind: 'method', service: 'agentPresets', member: 'readDocument', path: ['agentPresets', 'readDocument'] },
  { id: 'agentPresets.register', feature: 'preset-generation', kind: 'method', service: 'agentPresets', member: 'register', path: ['agentPresets', 'register'] },
  // The registry's definitions Map is TS-private. Declared because the plugin reads it
  // to derive variants; the declaration makes the private reach visible instead of
  // hiding it in one expression.
  { id: 'agentPresets.definitions', feature: 'preset-generation', kind: 'member', service: 'agentPresets', member: 'definitions', path: ['agentPresets', 'definitions'] },
  { id: 'agentPresets.resolve', feature: 'preset-generation', kind: 'method', service: 'agentPresets', member: 'resolve', path: ['agentPresets', 'resolve'] },
  { id: 'agentPresets.list', feature: 'preset-generation', kind: 'method', service: 'agentPresets', member: 'list', path: ['agentPresets', 'list'] },
  { id: 'agentPresets.serviceFor', feature: 'selftest', kind: 'method', service: 'agentPresets', member: 'serviceFor', path: ['agentPresets', 'serviceFor'] },
  { id: 'agents.create', feature: 'selftest', kind: 'method', service: 'agents', member: 'create', path: ['agents', 'create'] },
  { id: 'tools.register', feature: 'search', kind: 'method', service: 'tools', member: 'register', path: ['tools', 'register'] },
  { id: 'systemPrompt.section', feature: 'search', kind: 'method', service: 'systemPrompt', member: 'section', path: ['systemPrompt', 'section'] },
  { id: 'subprocess.spawnTerminal', feature: 'terminal', kind: 'method', service: 'subprocess', member: 'spawnTerminal', path: ['subprocess', 'spawnTerminal'] },
  { id: 'workspaceRegistry', feature: 'selftest', kind: 'service', service: 'workspaceRegistry', member: 'workspaceRegistry', path: ['workspaceRegistry'] },
  // The event cannot be probed without creating a session; it is declared so its absence
  // from the other lists is a decision rather than an omission.
  { id: 'api-session/added', feature: 'session-create', kind: 'unprobeable', service: 'session', member: 'api-session/added', path: [] },
])

/**
 * Host packages whose exports the plugin imports statically.
 *
 * A missing export here fails the module load; the runtime probe cannot see that,
 * so the offline verifier resolves each module and checks the named export.
 */
export const HOST_IMPORTS = Object.freeze([
  { id: 'dsh-subprocess:SubprocessRuntime', module: '@deepseek-ai/dsh-subprocess', export: 'SubprocessRuntime' },
  { id: 'dsh-subprocess:SubprocessExecutableNotFoundError', module: '@deepseek-ai/dsh-subprocess', export: 'SubprocessExecutableNotFoundError' },
  { id: 'dsh-shell:ShellExecutor', module: '@deepseek-ai/dsh-shell', export: 'ShellExecutor' },
  { id: 'dsh-sandbox:SandboxProvider', module: '@deepseek-ai/dsh-sandbox', export: 'SandboxProvider' },
  { id: 'dsh-sandbox:SandboxUnavailableError', module: '@deepseek-ai/dsh-sandbox', export: 'SandboxUnavailableError' },
  { id: 'dsh-fs-local:LocalFileSystem', module: '@deepseek-ai/dsh-fs-local', export: 'LocalFileSystem' },
  { id: 'dsh-fs:FsError', module: '@deepseek-ai/dsh-fs', export: 'FsError' },
  { id: 'dsh-llm:HarnessError', module: '@deepseek-ai/dsh-llm', export: 'HarnessError' },
  { id: 'dsh-tools:defineTool', module: '@deepseek-ai/dsh-tools', export: 'defineTool' },
])

/** The services the browser half reads; the host serves this list to the client. */
export const CLIENT_SYMBOLS = Object.freeze([
  { id: 'workspaces.list', feature: 'picker', kind: 'member', path: ['workspaces', 'list', 'getSnapshot'] },
  { id: 'workspaces.create', feature: 'picker', kind: 'method', path: ['workspaces', 'create'] },
  { id: 'uiWorkspace.openSession', feature: 'picker', kind: 'method', path: ['uiWorkspace', 'openSession'] },
  { id: 'remote.session.create', feature: 'session-create', kind: 'method', path: ['remote', 'session', 'create'] },
  { id: 'sessions.create', feature: 'session-create', kind: 'method', path: ['sessions', 'create'] },
])

/** One cached host probe. */
let hostCache = null

/** The in-flight host probe, shared by concurrent callers. */
let hostInflight = null

/**
 * Resolve the service a symbol's path starts from.
 *
 * The host context exposes services through `get`; a client context exposes them as
 * properties. Both are tried, `get` first, so the same resolver serves both halves.
 * @param {object} root - the context.
 * @param {string} name - the service name.
 * @returns {unknown} the service, or undefined.
 */
function serviceOf(root, name) {
  if (root === null || root === undefined) return undefined
  if (typeof root.get === 'function') {
    try {
      const value = root.get(name)
      if (value !== undefined) return value
    } catch {
      // A throwing get is a missing service for this purpose.
    }
  }
  return root[name]
}

/**
 * Resolve one declared symbol.
 * @param {object} root - the context.
 * @param {object} entry - one manifest entry.
 * @returns {{present: boolean, reason?: string}} the outcome.
 */
export function resolveSymbol(root, entry) {
  if (entry.kind === 'unprobeable') return { present: true }
  const [service, ...rest] = entry.path
  let value = serviceOf(root, service)
  if (value === null || value === undefined) {
    return { present: false, reason: `${service} is not available` }
  }
  for (const segment of rest) {
    value = value?.[segment]
    if (value === undefined || value === null) {
      return { present: false, reason: `${entry.id} is not available` }
    }
  }
  if (entry.kind === 'method' && typeof value !== 'function') {
    return { present: false, reason: `${entry.id} is not callable` }
  }
  return { present: true }
}

/**
 * Evaluate one side's features from a symbol list.
 * @param {object} root - the context.
 * @param {ReadonlyArray<object>} symbols - the side's manifest.
 * @returns {{features: Record<string,string>, missing: object[]}} the outcome.
 */
function evaluateFeatures(root, symbols) {
  const present = new Map()
  const missing = []
  for (const symbol of symbols) {
    const outcome = resolveSymbol(root, symbol)
    present.set(symbol.id, outcome.present)
    if (!outcome.present) missing.push({ id: symbol.id, feature: symbol.feature, reason: outcome.reason })
  }
  const features = {}
  for (const id of FEATURE_IDS) {
    const required = FEATURES[id].required.filter((symbolId) => symbols.some((symbol) => symbol.id === symbolId))
    // A group with no symbol on THIS side is the other half's to answer.
    if (required.length === 0) {
      features[id] = 'unknown'
      continue
    }
    features[id] = required.every((symbolId) => present.get(symbolId) === true) ? 'ok' : 'degraded'
  }
  return { features, missing }
}

/**
 * Probe the host half.
 *
 * `status` covers the host side of the picker path (`preset-generation`); the browser
 * half's `picker` and `session-create` are `unknown` here and are merged by the client.
 * @param {object} ctx - the host context.
 * @returns {Promise<{status: string, features: Record<string,string>, missing: object[], checkedAt: string}>}
 *   the cached probe.
 */
export async function probeHost(ctx) {
  const now = Date.now()
  if (hostCache !== null && now - hostCache.at < HOST_CACHE_MS) return hostCache.result
  if (hostInflight !== null) return hostInflight
  hostInflight = Promise.resolve().then(() => {
    const { features, missing } = evaluateFeatures(ctx, HOST_SYMBOLS)
    const preset = features['preset-generation']
    const status = preset === 'ok' ? 'ok' : preset === 'degraded' ? 'degraded' : 'unknown'
    const result = {
      status,
      features,
      missing,
      checkedAt: new Date().toISOString(),
    }
    hostCache = { at: Date.now(), result }
    return result
  }).finally(() => {
    hostInflight = null
  })
  return hostInflight
}

/**
 * Probe the browser half against the manifest the host served.
 * @param {object} ctx - the client context.
 * @param {ReadonlyArray<object>} [symbols] - the client manifest.
 * @returns {{features: Record<string,string>, missing: object[]}} the outcome (no status).
 */
export function probeClient(ctx, symbols = CLIENT_SYMBOLS) {
  return evaluateFeatures(ctx, symbols)
}

/** Forget the cached host probe; used by the verification suites. */
export function resetContractCache() {
  hostCache = null
  hostInflight = null
}
