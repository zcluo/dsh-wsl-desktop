/**
 * Host half of `dsh-wsl-desktop`.
 *
 * Two jobs:
 *
 * 1. Answer the browser's WSL questions over the same-origin route — the
 *    browser cannot run `wsl.exe`.
 * 2. Derive and register the WSL agent presets in the runtime preset registry. A
 *    session's execution world is chosen by its preset, so this is what lets one
 *    Desktop instance run Windows workspaces and WSL workspaces side by side.
 *    (Before 0.1.7 this half MATERIALIZED them into the user preset root; the
 *    registry owns them now, and nothing under $DSH_HOME is written.)
 * @module dsh-wsl-desktop
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, watch as nativeFsWatch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  MAX_BODY_BYTES, DEV_TOKEN_HEADER, bodyAdmission, dispatchAdmission, fenceRejection, methodAdmission, preflight, tokenMatches,
} from './http-admission.js'
import { buildVariantPlugins } from './wsl/preset.js'
import { setLocalSubprocess } from './wsl/host-refs.js'
import { checkLinuxPath, defaultDistro, defaultWorkspaceUnc, listDistros, listLinuxDir, resolveDistroHome, runWslShell } from './wsl/world.js'
import { joinWslUnc, parseWslUnc, shellQuote, windowsToMntPath } from './wsl/paths.js'
import { WslRouteError, browserFailure, routeErrorFor } from './route-errors.js'
import { CHECK_IDS, CHECK_LABELS, CHECK_REMEDIES, DOCS, ERROR_CODES, FEATURE_IDS, FEATURE_LABELS } from './protocol.js'
import { CLIENT_SYMBOLS, probeHost } from './host/contract.js'
import { healthFor } from './wsl/doctor.js'
import { assertDistro, assertLinuxPath, assertUser } from './validate.js'
import { sweepOrphanFifos } from './wsl/pty.js'
import { WATCH_INTERVAL_MS } from './wsl/watch.js'

/** Loader row identity, also used in diagnostics. */
export const name = 'wsl-desktop'

/**
 * This plugin publishes a route, so it requires the route owner. `connection`
 * carries the composition's trust fence: its Host/Origin check defeats DNS
 * rebinding, and its browser authentication (the login-token cookie) gates every
 * caller before any method runs.
 */
export const inject = ['webServer', 'connection']

/** Plugin config. */
export const Config = z.object({
  /**
   * Same-origin endpoint the browser half posts to. Configurable so a second
   * generation can be mounted beside a running one, which is how the host half
   * is exercised without restarting the application.
   */
  // MUST stay equal to the browser half's ENDPOINT (lib/client.js): nothing derives
  // one from the other, and a deployment that mounts the route elsewhere loses the
  // picker silently — the failure this default is the only record of.
  routePath: z.string().default('/wsl-desktop/api'),
  /**
   * Path to `wsl.exe`. Every probe this half runs spawns it — discovery, directory
   * listing, path checks, home resolution and the acceptance self-test — so a
   * deployment where `wsl.exe` is not on PATH sets it here as well as on the WSL
   * providers. Left at the default it is the bare name resolved from PATH.
   */
  wslPath: z.string().default('wsl.exe'),
  /**
   * Expose the acceptance surface — command execution, session self-test, preset
   * regeneration — to a caller presenting this installation's development token.
   * Off by default: the browser half needs only the read-only discovery methods,
   * and the rest exist for verification rather than for the product.
   */
  developerTools: z.boolean().default(false),
})

/** Directory of this module, used to name the provider rows absolutely. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The path the RUNNING host loaded this module from.
 *
 * The profile links one staged generation directory and Node caches a module
 * by URL, so a host that was never restarted after a re-stage keeps serving the
 * older copy while the source tree on disk says otherwise. Reporting the loaded
 * path is what lets the acceptance suite compare the two; a marker string
 * cannot, because every generation carries it.
 */
const SELF_MODULE = fileURLToPath(import.meta.url)

/** Prefix of every preset this plugin owns; its own outputs are never sources. */
const GENERATED_PREFIX = 'wsl-'

/**
 * The generated variant id for a resolved base preset.
 *
 * A preset that is already a variant keeps its id; anything else gets the prefix. The
 * selftest and createWorkspace both derived it this way — the second site's own comment
 * admitted it resolved exactly like the first — so a change to the prefix rule had two
 * homes.
 * @param {{ id: string }} preset - the resolved base preset.
 * @returns {string} the variant id.
 */
function variantIdFor(preset) {
  return preset.id.startsWith(GENERATED_PREFIX) ? preset.id : `${GENERATED_PREFIX}${preset.id}`
}

/**
 * Module specifiers of the WSL providers, as the preset rows must name them.
 * The 0.1.7 loader imports row names via `new URL(name, baseUrl)` or a bare
 * `import(name)` — a backslash Windows path fails both, so the rows carry
 * `file://` URL spellings, which import() accepts on every generation.
 */
const SUBPROCESS_MODULE = pathToFileURL(join(HERE, 'wsl', 'subprocess.js')).href
const SHELL_MODULE = pathToFileURL(join(HERE, 'wsl', 'shell.js')).href
const FS_MODULE = pathToFileURL(join(HERE, 'wsl', 'fs.js')).href
/**
 * The realm's own confinement provider. It exists so the realm's `sandbox` service — the
 * one `terminal-bash` resolves for every mode but `danger-full-access` — is answered from
 * inside the distribution instead of by the host's `sandbox-local`, whose Windows rung
 * grants an ACL on the policy's workspace root and fails on this realm's 9P UNC spelling
 * (`GetNamedSecurityInfoW`, Win32 1). The row that mounts it is the one that makes the
 * group's `sandbox: true` isolation load-bearing.
 */
const SANDBOX_MODULE = pathToFileURL(join(HERE, 'wsl', 'sandbox.js')).href
/**
 * The realm's own `grep`/`glob` module. Named here, beside the three providers, for the same
 * reason they are: a row must name a module the LOADER can import, and a `file://` URL is the
 * one spelling that survives every generation. The two search rows both name this module (the
 * row's `config.tool` picks which of the two tools it registers), because the search names the
 * model already knows have to be re-mounted by something this plugin owns — the host's search
 * package is removed inside a WSL realm, not reused.
 */
const SEARCH_MODULE = pathToFileURL(join(HERE, 'wsl', 'search-tool.js')).href

/** Last preset materialization outcome, reported through the route. */
let presetState = { status: 'pending' }

/** Recent preset-binding decisions, reported through the route. */
const bindingLog = []

/** Most binding decisions kept for inspection. */
const BINDING_LOG_LIMIT = 50

/** The plugin context, captured so route methods can reach host services. */
let hostCtx

/**
 * The configured `wsl.exe` path, captured where the route methods can read it.
 *
 * The methods table is module-level (the route dispatcher calls into it without
 * carrying the plugin's config), so the configured path is held beside the
 * captured context rather than threaded through every signature.
 */
let routeWslPath = 'wsl.exe'

/** Whether the preset registry has been reached; `bootstrap` waits briefly for it. */
let hostReady = false

/** The plugin version, read from the shipped package.json once. */
let pluginVersionValue = null

/**
 * Read the plugin's own version.
 * @returns {Promise<string>} the declared version, or `unknown` when unreadable.
 */
async function pluginVersion() {
  if (pluginVersionValue !== null) return pluginVersionValue
  try {
    const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    pluginVersionValue = typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    pluginVersionValue = 'unknown'
  }
  return pluginVersionValue
}

/**
 * Wait briefly for the host services, then probe the contract.
 *
 * The browser opens the dialog as soon as the W button is clicked, which can be
 * before the preset registry has resolved. `pending` is an honest answer; the client
 * retries once and treats a still-pending state as unknown rather than degraded.
 * @returns {Promise<object>} the probe, or a pending marker.
 */
async function probeHostWhenReady() {
  if (hostCtx === undefined) {
    return { status: 'pending', features: {}, missing: [], checkedAt: new Date().toISOString() }
  }
  const deadline = Date.now() + 5_000
  while (!hostReady && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!hostReady) {
    // The registry never appeared. Probing the context anyway reports the missing
    // feature as degraded; returning `pending` here would leave the picker
    // proceeding against a world it cannot name a preset in.
    if (hostCtx.get('agentPresets') === undefined) return probeHost(hostCtx)
    return { status: 'pending', features: {}, missing: [], checkedAt: new Date().toISOString() }
  }
  return probeHost(hostCtx)
}

/**
 * The methods whose ENOENT means "WSL itself is missing" rather than "a plugin
 * import is missing".
 */
const DISCOVERY_METHODS = new Set([
  'listDistros', 'defaultDistro', 'listDir', 'checkPath', 'resolve', 'resolveHome', 'wslPresetFor',
])

/**
 * The harness home that holds the user preset root.
 * @returns {string} the resolved `$DSH_HOME`.
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Resolve a location the caller supplied into one distribution plus Linux path.
 * @param {unknown} location - UNC path, absolute Linux path, or Windows drive path.
 * @param {string | undefined} distroHint - distribution to use for a non-UNC location.
 * @returns {Promise<{ distro: string, linuxPath: string, uncPath: string }>} the resolved target.
 * @throws Error when the location names no world.
 */
async function resolveLocation(location, distroHint) {
  if (typeof location !== 'string' || location.length === 0) throw new Error('缺少路径')
  const unc = parseWslUnc(location)
  if (unc !== null) return { ...unc, uncPath: joinWslUnc(unc.distro, unc.linuxPath) }
  const linuxPath = location.startsWith('/') ? location : windowsToMntPath(location)
  if (linuxPath === null) throw new Error(`路径既不是 WSL 路径也不是 Windows 路径：${location}`)
  const distro = distroHint ?? await defaultDistro()
  if (distro === undefined) throw new Error('无法确定 WSL 发行版：请显式指定发行版')
  return { distro, linuxPath, uncPath: joinWslUnc(distro, linuxPath) }
}

/**
 * Locate the directory a preset was discovered under.
 *
 * A preset may name a row by a path relative to its own directory, so the
 * variant needs that base to rewrite the name to something that still resolves
 * from where the variant lives.
 *
 * Both spellings are historical: the package is `@deepseek-ai/dsh-agent-preset`
 * (singular — the plural name never existed, so this resolve always threw), and
 * since the presets moved into profile YAML declarations the package ships no
 * `presets/<id>/agent.cordis.yml` tree at all. Neither branch is expected to
 * hit on a current desktop; a base preset that DOES use relative row names
 * therefore has no resolvable source directory, and `buildVariantPlugins`
 * leaves the name as it found it. This stays a lookup rather than a guess so
 * the failure mode is unchanged if a deployment ever ships that tree again.
 * @param {string} id - preset id.
 * @returns {string | undefined} the directory, or undefined when it cannot be found.
 */
function sourceDirFor(id) {
  const local = join(dshHome(), '.agent-presets', id)
  if (existsSync(join(local, 'agent.cordis.yml'))) return local
  try {
    const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-preset/package.json'))
    const shipped = join(dirname(manifest), 'presets', id)
    if (existsSync(join(shipped, 'agent.cordis.yml'))) return shipped
  } catch {
    // A deployment without the preset package leaves relative names as they are.
  }
  return undefined
}

/**
 * Read a base preset's declared plugin rows as OBJECTS.
 *
 * 0.1.7 keeps each declaration's `PresetDefinition` — with `plugins` as entry
 * objects — in a registry map that is TS-private but reachable in-process
 * (ctx.get returns the service instance). No YAML parser is needed on this
 * path; the public readDocument only exposes a re-dumped text form.
 * @param {object} presets - the agentPresets service.
 * @param {string} id - base preset id.
 * @returns {readonly object[] | null} the declared rows, or null when unreachable.
 */
function basePluginsOf(presets, id) {
  const plugins = presets.definitions?.get?.(id)?.config?.plugins
  return Array.isArray(plugins) ? plugins : null
}

/**
 * Derive and register the WSL variant presets (0.1.7-native).
 *
 * Since 0.1.7 the registry learns presets from `register()` calls by declaring
 * plugins; the on-disk generated directory is no longer consulted. For every
 * base preset this plugin derives `wsl-<base>` and registers it; the returned
 * disposer is kept so a plugin dispose (or a re-registration) withdraws the
 * variant cleanly.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} distro - distribution to pin.
 * @param {{ disposed: boolean, disposers: Map<string, Function> }} generation - this
 *   registration generation's lifecycle token; the plugin's teardown flips
 *   `disposed` synchronously before draining, and the loop re-checks it around
 *   every await so a disable landing mid-registration cannot orphan a variant
 *   whose disposer nobody owns. The disposer map lives ON the generation, so
 *   one generation's teardown drains only the variants it registered.
 * @param {{ disposers: Map<string, Function>} | null} previous - the generation
 *   whose variants must be withdrawn before this one registers (register()
 *   refuses duplicates).
 * @returns {Promise<object>} the registration outcome for the route.
 */
/**
 * Run a shell spec through whichever seam the host exposes, and always hand back a
 * handle whose `result()` is awaitable.
 *
 * 0.1.7 hosts expose `execute`, which resolves with a live handle; older ones have
 * only `run`, whose settled result carries no `result()` projection. Both selftest
 * steps used to spell that dual dispatch themselves, and the second one called
 * `.result()` on `run`'s settled result — a TypeError on exactly the hosts that
 * branch exists to support. One owner, so the two steps cannot drift again.
 * @param {object} shell - the realm's shell service.
 * @param {object} spec - the resolved spec to run.
 * @returns {Promise<{ result: () => Promise<object> }>} a result()-able handle.
 */
function runShellSpec(shell, spec) {
  if (typeof shell.execute === 'function') return shell.execute(spec)
  return shell.run(spec).then((settled) => ({ result: async () => settled }))
}

async function materializePresets(ctx, distro, generation, previous) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new Error('agentPresets 服务不可用')
  // 版本门控：本插件的目标面是 0.1.7 的运行时注册架构。旧宿主（无
  // readDocument）会在下面的派生循环里逐项失败——在这里一次性给出人话拒绝，
  // 而不是让操作者从一堆静默降级里猜。
  const hostCompat = { registry07: typeof presets.readDocument === 'function' }
  if (hostCompat.registry07 !== true) {
    throw new Error('需要 DSH Desktop 0.1.7+：当前宿主的 agentPresets 缺少 readDocument（0.1.6 及以下不受支持）。请升级桌面，或使用 0.1.6 兼容的插件版本。')
  }
  /**
   * The answer a round gives when its generation was torn down mid-flight: the preset
   * surface stays READY (the previous generation is still registered), nothing is
   * written, and the skip says why. Spelled once — it stood three times, so the
   * wording and the shape each had three homes.
   */
  const abandonedRound = () => ({ status: 'ready', hostCompat, written: [], skipped: [{ id: '-', reason: '插件已卸载，放弃本轮注册' }] })
  if (generation?.disposed) return abandonedRound()
  const roster = await presets.list()
  if (generation?.disposed) return abandonedRound()
  const written = []
  const skipped = []

  // Withdraw the previous generation first: register() refuses duplicates.
  for (const [id, dispose] of previous?.disposers ?? []) {
    try { await dispose() } catch { /* already gone */ }
    previous?.disposers.delete(id)
    if (generation?.disposed) return abandonedRound()
  }

  for (const preset of roster) {
    const id = typeof preset?.id === 'string' ? preset.id : undefined
    if (id === undefined) continue
    // Our own variants are outputs, never sources (wsl-wsl-standard, …).
    if (id.startsWith(GENERATED_PREFIX)) {
      skipped.push({ id, reason: '落在本插件的生成命名空间里，不作为派生源' })
      continue
    }
    // A preset the registry reports as unmountable cannot be repaired by deriving.
    if (typeof preset.broken === 'string' && preset.broken.length > 0) {
      skipped.push({ id, broken: preset.broken })
      continue
    }
    const basePlugins = basePluginsOf(presets, id)
    if (basePlugins === null) {
      skipped.push({ id, reason: '无法读取声明行对象（registry 内部结构变化）' })
      continue
    }
    const variantId = `${GENERATED_PREFIX}${id}`
    const display = typeof preset?.name === 'string' && preset.name.length > 0 ? preset.name : id
    // The transform belongs INSIDE the per-preset try: a malformed base row
    // must skip THIS preset, not abort the loop after earlier variants were
    // already withdrawn (which would leave zero variants registered).
    try {
      const sourceDir = sourceDirFor(id)
      const { plugins, removed, unclassified } = buildVariantPlugins(basePlugins, {
        subprocessPath: SUBPROCESS_MODULE,
        shellPath: SHELL_MODULE,
        fsPath: FS_MODULE,
        sandboxPath: SANDBOX_MODULE,
        searchPath: SEARCH_MODULE,
        ...(distro !== undefined ? { distro } : {}),
        ...(sourceDir !== undefined ? { sourceDir } : {}),
      })
      const dispose = await presets.register({
        id: variantId,
        name: `WSL · ${display}`,
        description: `在 WSL 发行版里执行（由 ${id} 派生）`,
        plugins,
      })
      // The check-after-await → synchronous-set pair is atomic against the
      // synchronous teardown (single-threaded JS): a disable landing during
      // register() hands the just-obtained variant straight back to its
      // disposer instead of orphaning it in the registry.
      if (generation?.disposed) {
        try { await dispose() } catch { /* already gone */ }
        skipped.push({ id: variantId, reason: '插件已卸载，注册即撤回' })
        continue
      }
      generation.disposers.set(variantId, dispose)
      // `unclassified` travels with the report: a row the transform kept without
      // a classifier verdict is the leak shape this transform exists to prevent,
      // and a record nobody can read is the same as no record.
      written.push({ id: variantId, from: id, removed, unclassified })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A duplicate means a previous generation is still mounted (host without
      // restart after a sync): report rather than fail the whole generation.
      skipped.push({ id: variantId, reason: message })
    }
  }
  return { written, skipped, hostCompat }
}

/** Serialises refreshPresets so boot-time and developer-token calls cannot interleave. */
let refreshMutex = Promise.resolve()

/** The live registration generation; teardown flips its disposed flag. */
let currentGeneration = null

/**
 * Refresh the presets, recording the outcome for the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} distro - distribution to pin.
 * @param {{ disposed: boolean } | null} generation - this registration
 *   generation's lifecycle token (see materializePresets).
 * @returns {Promise<object>} the new preset state.
 */
async function refreshPresets(ctx, distro, generation = currentGeneration) {
  const run = async () => {
    // A caller may omit the generation (developer-token regenerate before the
    // inject ran): mint a transient one so every disposer has an owner.
    const gen = generation ?? { disposed: false, disposers: new Map() }
    // Withdrawal targets the PREVIOUS generation's disposers; a self-refresh
    // (developer-token regenerate) withdraws its own — the exact behaviour of
    // the historical shared map, minus the cross-generation teardown theft.
    const previous = currentGeneration === gen ? gen : currentGeneration
    currentGeneration = gen
    presetState = { status: 'running' }
    try {
      const result = await materializePresets(ctx, distro, gen, previous)
      presetState = { status: 'ready', ...result }
    } catch (error) {
      presetState = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    return presetState
  }
  const result = refreshMutex.then(run, run)
  refreshMutex = result.then(() => {}, () => {})
  return result
}

/**
 * Methods the browser half may call while composing a workspace.
 *
 * This is the whole browser-reachable surface. Everything else in {@link METHODS}
 * executes commands, creates sessions or rewrites the preset root, and is
 * reachable only by a caller presenting the development token — the route is on
 * loopback, so "the browser can reach it" is an authority decision, not a
 * convenience.
 */
const BROWSER_METHODS = new Set([
  'bootstrap',
  'health',
  'listDistros',
  'defaultDistro',
  'listDir',
  'checkPath',
  'resolve',
  'resolveHome',
  'wslPresetFor',
])

/** The method table the route dispatches into. */
const METHODS = {
  /**
   * The static catalog plus the host's current capability state.
   *
   * One call, so the dialog does not race three separate discoveries, and so a host
   * whose shape changed still answers with the vocabulary a newer browser half needs.
   * @returns {Promise<object>} plugin version, catalog and capabilities.
   */
  bootstrap: async () => ({
    pluginVersion: await pluginVersion(),
    docsBase: DOCS,
    catalog: {
      codes: ERROR_CODES,
      features: FEATURE_IDS,
      featureLabels: FEATURE_LABELS,
      checks: CHECK_IDS,
      checkLabels: CHECK_LABELS,
      checkRemedies: CHECK_REMEDIES,
      clientSymbols: CLIENT_SYMBOLS,
    },
    capabilities: await probeHostWhenReady(),
  }),

  /**
   * Measure one distribution's prerequisites. Read-only and advisory.
   * @param {{ distro: string, username?: string }} params - distribution and optional user.
   * @returns {Promise<object>} the doctor's checklist.
   */
  health: async ({ distro, username }) => {
    assertDistro(distro)
    assertUser(username)
    return healthFor({ distro, username, wslPath: routeWslPath })
  },

  /**
   * List the installed distributions.
   * @returns {Promise<string[]>} distribution names.
   */
  listDistros: () => listDistros({ wslPath: routeWslPath }),

  /**
   * Report the default distribution.
   * @returns {Promise<{ distro: string | null }>} the registry default.
   */
  defaultDistro: async () => ({ distro: (await defaultDistro()) ?? null }),

  /**
   * List one Linux directory.
   * @param {{ distro: string, path: string }} params - distribution and absolute Linux path.
   * @returns {Promise<object>} the listing.
   */
  listDir: async ({ distro, path }) => {
    assertDistro(distro)
    assertLinuxPath(path ?? '/')
    try {
      return await listLinuxDir(distro, path ?? '/', { wslPath: routeWslPath })
    } catch (error) {
      throw routeErrorFor(error, { distro, path })
    }
  },

  /**
   * Check one Linux path and report the workspace spelling it would take.
   * @param {{ distro: string, path: string }} params - distribution and absolute Linux path.
   * @returns {Promise<object>} path facts plus the UNC spelling.
   */
  checkPath: async ({ distro, path }) => {
    // Grammar-validate before any wsl.exe side effect or UNC join.
    assertDistro(distro)
    assertLinuxPath(path)
    const uncPath = joinWslUnc(distro, path)
    let facts
    try {
      facts = await checkLinuxPath(distro, path, { wslPath: routeWslPath })
    } catch (error) {
      throw routeErrorFor(error, { distro, path })
    }
    // The route used to return the facts and let the browser decide; the browser now
    // receives the same code for the same two outcomes as every other failure.
    if (facts.exists !== true) throw new WslRouteError('path-not-found', { path })
    if (facts.isDirectory !== true) throw new WslRouteError('path-not-directory', { path })
    return { ...facts, uncPath }
  },

  /**
   * Resolve a location without touching the filesystem.
   * @param {{ location: string, distro?: string }} params - the location to resolve.
   * @returns {Promise<object>} the resolved target.
   */
  resolve: async ({ location, distro }) => {
    if (typeof location !== 'string' || location.trim() === '') {
      throw new WslRouteError('path-invalid', { path: typeof location === 'string' ? location : '' })
    }
    if (distro !== undefined) assertDistro(distro)
    try {
      return await resolveLocation(location, distro)
    } catch (error) {
      if (error instanceof WslRouteError) throw error
      // A WSL UNC with an unusable distribution/segment, or a location that is
      // neither a WSL nor a Windows path, is caller input. `resolveLocation` is
      // async, so the await is load-bearing: without it nothing it throws is
      // observable here.
      throw new WslRouteError('path-invalid', { path: location }, { cause: error })
    }
  },

  /**
   * Resolve a distribution user's home directory.
   *
   * The workspace dialog prefills its path with the answer, so the picker
   * opens in the operator's own files rather than at the filesystem root.
   * A read-only query against the distribution's user database, in the same
   * discovery class as `listDir`/`checkPath`.
   * @param {{ distro: string, username?: string }} params - distribution and optional user.
   * @returns {Promise<object>} the resolved user and home.
   */
  resolveHome: async ({ distro, username }) => {
    assertDistro(distro)
    assertUser(username)
    try {
      return await resolveDistroHome(distro, username, { wslPath: routeWslPath })
    } catch (error) {
      throw routeErrorFor(error, { distro, user: username })
    }
  },

  /**
   * The preset a new session in a WSL workspace must be created with.
   *
   * The harness fixes a session's preset at creation, so the browser half has to
   * name the variant in its create request; this resolves it against the live
   * roster instead of letting the client guess the id.
   * @param {{ base?: string }} params - base preset id; absent uses the configured default.
   * @returns {Promise<{ agentPreset: string, base: string }>} the variant to request.
   */
  wslPresetFor: async ({ base } = {}) => {
    const presets = hostCtx?.get('agentPresets')
    if (presets === undefined) throw new WslRouteError('host-capability-missing', { feature: 'preset-generation' })
    let resolved
    try {
      resolved = await presets.resolve(base)
    } catch (error) {
      const failure = new WslRouteError('preset-not-ready', { preset: typeof base === 'string' ? base : '' }, { cause: error })
      // The browser never sees this message; the dev-token caller and the host log
      // need the underlying reason to tell a mount fault from a broken variant.
      failure.message = `route failure: preset-not-ready (${error instanceof Error ? error.message : String(error)})`
      throw failure
    }
    const agentPreset = variantIdFor(resolved)
    let roster
    try {
      roster = await presets.list()
    } catch (error) {
      const failure = new WslRouteError('preset-not-ready', { preset: agentPreset }, { cause: error })
      failure.message = `route failure: preset-not-ready (${error instanceof Error ? error.message : String(error)})`
      throw failure
    }
    const variant = roster.find((preset) => preset.id === agentPreset)
    if (variant === undefined || variant.broken !== undefined) {
      const reason = variant?.broken ?? new Error(`preset variant ${JSON.stringify(agentPreset)} is not in the roster`)
      const failure = new WslRouteError('preset-not-ready', { preset: agentPreset }, { cause: reason })
      failure.message = `route failure: preset-not-ready (${reason instanceof Error ? reason.message : String(reason)})`
      throw failure
    }
    return { agentPreset, base: resolved.id }
  },

  /**
   * Run one command inside a distribution.
   * @param {{ cwd?: string, distro?: string, command: string, username?: string, timeoutMs?: number, raw?: boolean }} params - execution request.
   *   Pass \`raw\` when the command's output may carry NUL bytes as DATA. The text
   *   form decodes both streams, and a NUL-framed protocol (\`find -print0\`,
   *   \`ls --zero\`, \`xargs -0\`) is indistinguishable from UTF-16LE text at three or
   *   more code units — with single-character names the two are byte-identical — so
   *   the framing would be lost with nothing to signal it. \`raw\` returns the
   *   streams as Buffers, byte for byte. \`listLinuxDir\` opts out the same way.
   * @returns {Promise<object>} the outcome plus the exact argv used.
   */
  execInWsl: async ({ cwd, distro, command, username, timeoutMs, raw }) => {
    if (typeof command !== 'string') throw new Error('execInWsl: command 必须是字符串')
    const target = await resolveLocation(cwd ?? '/', distro)
    const result = await runWslShell({
      distro: target.distro,
      linuxCwd: target.linuxPath,
      command,
      ...(username !== undefined ? { username } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(raw === true ? { raw: true } : {}),
      wslPath: routeWslPath,
    })
    return { ...result, target }
  },

  /**
   * Report the current preset generation state and the loaded module paths.
   * @returns {Promise<object>} the state, plus `deployed` — the path the running host loaded.
   */
  presetStatus: () => Promise.resolve({
    ...presetState,
    deployed: { modulePath: SELF_MODULE },
  }),

  /**
   * Exercise one WSL session end to end through the realm's own providers.
   *
   * This is the acceptance path that does not need the GUI: create a session
   * whose cwd is a WSL workspace and whose preset is a generated WSL variant,
   * then reach the realm's `shell` / `fs` / `subprocess` with
   * `agentPresets.serviceFor` — the services a realm hides from the outside —
   * and run real work through each.
   * @param {{ preset?: string, cwd?: string }} params - preset id and workspace cwd.
   * @returns {Promise<{ steps: object[] }>} one entry per attempted step.
   */
  selftest: async ({ preset = 'wsl-standard', cwd }) => {
    const steps = []
    /**
     * Record one step outcome.
     * @param {string} name - step name.
     * @param {object} value - observed facts.
     */
    const record = (name, value) => steps.push({ name, ...value })
    // Declared OUTSIDE the try so the `finally` can release it: the disposal capability lives on
    // the handle (`dispose()`), not on the agent, and a binding scoped to the try made that
    // capability unreachable from the one block whose job is to release it.
    let handle
    let agent
    try {
      const agents = hostCtx.get('agents')
      const presets = hostCtx.get('agentPresets')
      if (agents === undefined || presets === undefined) throw new Error('agents / agentPresets 服务不可用')
      // NOT /tmp: the fence refuses a workspace root under /tmp by design (the
      // confinement mounts a private tmpfs over /tmp AFTER binding the workspace,
      // so such a root would be shadowed and every write would silently land in
      // the tmpfs). The distribution home exists, is writable, and is not
      // shadowed. The resolution itself lives in world.js, in the order that
      // works (default distribution -> its home -> the UNC spelling), because
      // this expression used to call resolveDistroHome(undefined, ...) — which
      // throws before any probe — and then handed its {user, home} result to a
      // function that requires a path string. Nothing reddened: every acceptance
      // path passes cwd. The default is now exercised by verify-world/check-2.
      const workspaceCwd = cwd ?? (await defaultWorkspaceUnc({ wslPath: routeWslPath })).uncPath
      const sessionId = `wsl-selftest-${Date.now()}`
      handle = await agents.create({ sessionId, meta: { cwd: workspaceCwd, agentPreset: preset } })
      agent = handle?.agent ?? handle
      record('create', {
        ok: true,
        sessionId: String(agent?.id ?? sessionId),
        handleKeys: Object.keys(handle ?? {}),
        composed: presets.composedPreset(agent.ctx) ?? null,
        cwd: workspaceCwd,
      })

      // A session created through the service does not pass the browser's
      // preset intent, so the selftest selects it explicitly when the automatic
      // binding has not already done so.
      if (presets.composedPreset(agent.ctx) !== preset) {
        try {
          await presets.select(agent, preset)
          record('select', { ok: true, composed: presets.composedPreset(agent.ctx) ?? null, bindings: bindingLog.length })
        } catch (error) {
          record('select', { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }

      // A realm hides its services from the outside by design: the preset mount
      // owns its own fiber, so `agent.ctx.get(name)` resolves the HOST plane.
      // The registry is the only thing that can look inside, and it exposes
      // that as the SERVICE METHOD `agentPresets.serviceFor(agent, name)`.
      //
      // This used to resolve the package-level `serviceForAgent(ctx, agent,
      // name)` export dynamically. DSH 0.2.1-alpha.1 REMOVED that export
      // (commit 2e3ab61940, "fix(presets): own composition mounts in registry
      // service"; no upgrade-guide entry covers it), and the removal was
      // silent here: the typeof probe simply missed, the ctx.get fallback then
      // measured the HOST shell, and every step still reported success.
      // `serviceFor` performs the same mount-fiber store scan the removed
      // export did, reached through the service instead of the module.
      //
      // The ctx.get fallback stays for genuinely pre-0.1.7 hosts, but the
      // accessor that answered travels WITH each observation, so a fallback
      // can never again be read as a realm measurement.
      const realmAccessor = typeof presets.serviceFor === 'function' ? 'agentPresets.serviceFor' : 'agent.ctx.get'
      const realmService = realmAccessor === 'agentPresets.serviceFor'
        ? (name) => presets.serviceFor(agent, name)
        : (name) => agent.ctx.get(name)

      const shell = realmService('shell')
      record('shell.service', {
        found: shell !== undefined,
        accessor: realmAccessor,
        sandboxMode: shell?.sandboxMode ?? null,
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(shell ?? {})).join(','),
        executeType: typeof shell?.execute,
        runType: typeof shell?.run,
      })
      if (shell !== undefined && typeof workspaceCwd === 'string' && workspaceCwd.startsWith('\\\\wsl.localhost\\')) {
        // The live-handle shell.run block is WSL-only: a Windows session's
        // bash-local cannot spawn Linux commands, and its infrastructure
        // failure would abort the whole selftest.
        const spec = shell.resolve({ command: 'uname -s; pwd; id -un; echo "$WSL_DISTRO_NAME"', workdir: workspaceCwd })
        // 0.1.7: execute resolves with a live handle; the settled result is
        // its memoized result() projection. Dual-dispatch for older hosts — one
        // owner, runShellSpec, shared with the confined step below.
        const execution = await runShellSpec(shell, spec)
        const result = await execution.result()
        record('shell.run', {
          exitCode: result?.exitCode,
          stdoutText: result?.stdout?.text?.trim().split('\n') ?? null,
          stderrText: result?.stderr?.text?.slice(0, 300) ?? null,
          sandbox: result?.sandbox ?? null,
          raw: JSON.stringify(result ?? null).slice(0, 400),
        })
      }

      const fs = realmService('fs')
      record('fs.service', { found: fs !== undefined, accessor: realmAccessor })
      if (fs !== undefined) {
        // A mutation is called the way the tool layer calls it: `tool-fs`
        // resolves a per-call policy and stamps the calling session's cwd as the
        // workspace root (`tool-fs/src/sandbox.ts:88-93`). Calling `writeText`
        // without that policy is a call no real consumer makes, and under a
        // confining backend it is refused for having no root to be contained by.
        try {
          const policy = { mode: 'workspace-write', workspaceRoot: workspaceCwd }
          const written = await fs.writeText(
            await fs.resolve('dsh-wsl-selftest.txt', { cwd: workspaceCwd }),
            'hello from the wsl world\n',
            undefined,
            undefined,
            policy,
          )
          const target = await fs.resolve('dsh-wsl-selftest.txt', { cwd: workspaceCwd })
          const text = await fs.readText(target)
          record('fs.roundtrip', {
            operation: written.operation,
            processPath: fs.processPath(target),
            fileUrl: fs.fileUrl(target),
            hostPath: fs.processPathFromHostPath(windowsToMntPath(workspaceCwd) ?? workspaceCwd) ?? null,
            text: text.trim(),
          })
        } catch (error) {
          record('fs.roundtrip', { error: error instanceof Error ? error.message : String(error) })
        }

        // Watch rows: the strategy the provider installs, driven the way a consumer
        // drives it, and mutated from INSIDE the distribution — the case the rows are
        // about. No model-facing tool reaches `fs.watch`, so the provider's own entry
        // is the only place this can be observed.
        if (fs !== undefined && shell !== undefined && typeof workspaceCwd === 'string' && workspaceCwd.startsWith('\\\\wsl.localhost\\')) {
          /**
           * The policy every mutation below carries. A request that omits `sandboxPolicy`
           * makes `bash-sandbox`'s `resolve()` substitute the session-less default, and the
           * confinement then binds a root that does NOT contain this scratch workspace —
           * measured: every mutation failed EROFS ("Read-only file system"). The fallback is
           * not a MISSING root: `lib/wsl/confinement.js` binds the command's cwd when a policy
           * carries none. It is a root from the deployment's own world, which
           * `lib/wsl/paths.js` maps to `/mnt/<drive>/…`. The tool layer never meets this
           * because `tool-bash` stamps the resolved policy into its request; a direct
           * provider call has to stamp it itself.
           */
          const workspaceWritePolicy = { mode: 'workspace-write', workspaceRoot: workspaceCwd }

          /**
           * Arm one watch, mutate the target from the distribution, report what arrived.
           * @param {{ targetKey: string }} target - the resolved watch target.
           * @param {string} command - the shell command that changes it.
           * @returns {Promise<object>} the observation row.
           */
          const observeWatch = async (target, command) => {
            const controller = new AbortController()
            const linuxPath = fs.processPath(target)
            let notified = 0
            let watchError = null
            let unwatch
            try {
              unwatch = await fs.watch(target, (error) => {
                if (error === undefined) notified += 1
                else watchError = String(error?.message ?? error)
              }, controller.signal)
              const execution = await runShellSpec(shell, shell.resolve({ command, workdir: workspaceCwd, sandboxPolicy: workspaceWritePolicy }))
              // The mutation's outcome is REPORTED, not assumed. A refused write otherwise
              // leaves `notified: 0` with a null `watchError`, which reads exactly like a
              // watcher that armed and observed nothing — two different facts this row must
              // not conflate.
              const result = await execution.result()
              if (result.exitCode !== 0) {
                const failure = `the mutation failed: exit ${result.exitCode ?? 'null'} ${(result.stderr?.text ?? '').slice(0, 200)}`.trim()
                // Both facts survive: a watcher error and a failed mutation can coexist, and
                // reporting only one of them drops the other from the row.
                watchError = watchError === null ? failure : `${watchError}; ${failure}`
              }
              // The window is 5 polling periods: measured latency is 2-52ms, so 1500ms is
              // ~29x the slowest measured case, and a poll that never runs still reddens.
              await new Promise((resolve) => setTimeout(resolve, 5 * WATCH_INTERVAL_MS))
            } catch (error) {
              watchError = error instanceof Error ? error.message : String(error)
            } finally {
              controller.abort()
              if (unwatch !== undefined) await unwatch().catch(() => {})
            }
            return { notified, watchError, linuxPath }
          }

          // The probe file EXISTS before the watch is armed — that is the point of the row.
          // `fs.watchFile` on an ABSENT path notifies once immediately at arming (measured
          // Node semantics, pinned offline in scripts/verify-watch.mjs, because an injected
          // io can never fire by itself: only the default seam shows the baseline is real).
          // With the file absent, `notified > 0` would be satisfied by that arming baseline
          // alone — even if the in-distribution append below were never observed. An
          // existing file is silent until it changes, so a notification here can only be
          // the append.
          const fileTarget = await fs.resolve('dsh-wsl-watch-probe.txt', { cwd: workspaceCwd })
          // Created through the shell this block already runs its mutations with. A create
          // that FAILED must not read as a false green, so its outcome is reported in the
          // row: an absent path would notify from its arming baseline and pass on nothing.
          const probeCreated = await runShellSpec(shell, shell.resolve({ command: `printf 'x\\n' > '${fs.processPath(fileTarget)}'`, workdir: workspaceCwd, sandboxPolicy: workspaceWritePolicy }))
            .then((execution) => execution.result())
            .catch((error) => ({ exitCode: null, stderr: { text: String(error?.message ?? error) } }))
          record('fs.watch.file', probeCreated.exitCode === 0
            ? await observeWatch(fileTarget, `printf 'x\\n' >> '${fs.processPath(fileTarget)}'`)
            : {
              notified: 0,
              watchError: `the probe file could not be created: exit ${probeCreated.exitCode ?? 'null'} ${probeCreated.stderr?.text?.slice(0, 200) ?? ''}`.trim(),
              linuxPath: fs.processPath(fileTarget),
            })

          const dirTarget = await fs.resolve('.', { cwd: workspaceCwd })
          const dirCommand = `printf 'x\\n' > '${fs.processPath(dirTarget)}/dsh-wsl-watch-entry.txt'`
          record('fs.watch.dir', await observeWatch(dirTarget, dirCommand))
          await runShellSpec(shell, shell.resolve({ command: `rm -f '${fs.processPath(dirTarget)}/dsh-wsl-watch-entry.txt'`, workdir: workspaceCwd, sandboxPolicy: workspaceWritePolicy }))
            .then((execution) => execution.result()).catch(() => {})

          // Why the override exists, recorded rather than assumed: if a future host or
          // WSL release makes this work, this row says so and the override can go.
          let nativeThrew = false
          let nativeCode = null
          try {
            const probe = nativeFsWatch(fileTarget.targetKey, () => {})
            probe.close()
          } catch (error) {
            nativeThrew = true
            nativeCode = error?.code ?? null
          }
          record('fs.watch.native', { threw: nativeThrew, code: nativeCode, path: fileTarget.targetKey })
        }
      }

      const subprocess = realmService('subprocess')
      record('subprocess.service', { found: subprocess !== undefined, accessor: realmAccessor })
      if (subprocess !== undefined) {
        try {
          const environment = await subprocess.terminalEnvironment()
          const executable = await subprocess.resolveExecutable('uname')
          record('subprocess.probe', { environment, executable })
        } catch (error) {
          // A Windows session has no `uname` on PATH — the probe failing is
          // recorded, never fatal: the selftest must keep covering the
          // remaining steps.
          record('subprocess.probe', { found: true, error: error instanceof Error ? error.message : String(error) })
        }
      }

      if (shell !== undefined) {
        const execution = await runShellSpec(
          shell,
          shell.resolve({ command: 'echo blocked > /dsh-wsl-forbidden.txt', workdir: workspaceCwd }),
        ).catch((error) => ({ result: async () => ({ exitCode: null, stderr: { text: String(error?.message ?? error) }, sandbox: null }) }))
        const confined = await execution.result()
        record('shell.confined', {
          exitCode: confined.exitCode,
          stderr: confined.stderr?.text?.slice(0, 200) ?? '',
          sandbox: confined.sandbox ?? null,
        })
      }

      // The model calls tools, not providers. Driving the registry is what makes
      // the acceptance cover the layer a session actually uses.
      const tools = hostCtx.get('tools')
      if (tools !== undefined && agent !== undefined) {
        const controller = new AbortController()
        /**
         * Execute one tool on the session's behalf.
         * @param {string} toolName - registered tool name.
         * @param {object} args - parsed tool arguments.
         * @returns {Promise<object>} a normalized outcome.
         */
        const invoke = async (toolName, args) => {
          try {
            const result = await tools.execute({
              callId: `wsl-selftest-${toolName}-${Date.now()}`,
              name: toolName,
              arguments: args,
              agent,
              signal: controller.signal,
            })
            return { ok: true, result: JSON.parse(JSON.stringify(result ?? null)) }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        }
        const bashTool = await invoke('bash', { command: 'uname -s; pwd', description: 'selftest: confirm the WSL world' })
        record('tools.bash', {
          ok: bashTool.ok,
          error: bashTool.error ?? null,
          text: JSON.stringify(bashTool.result ?? null).slice(0, 400),
        })
        // Derived from the workspace, not hardcoded: the fixture used to live at
        // /tmp/dsh-wsl-selftest.txt, which only worked while the workspace was
        // /tmp — and a /tmp workspace is exactly what the fence refuses.
        //
        // The realm's fs service only exists in a WSL session, so a host
        // (Windows) session falls back to the workspace spelling. Without this
        // guard the dereference threw OUTSIDE any try, which killed the selftest
        // before the host PowerShell step it exists to assert — the same
        // WSL-only reasoning the shell.run block above already applies.
        const fixturePath = fs !== undefined && typeof fs.processPath === 'function'
          ? fs.processPath(await fs.resolve('dsh-wsl-selftest.txt', { cwd: workspaceCwd }))
          : `${workspaceCwd}/dsh-wsl-selftest.txt`
        const readTool = await invoke('read', { file_path: fixturePath })
        record('tools.read', {
          ok: readTool.ok,
          error: readTool.error ?? null,
          text: JSON.stringify(readTool.result ?? null).slice(0, 400),
        })
        const pwshTool = await invoke('pwsh', { command: 'echo host-side', description: 'selftest: this tool must not exist in a WSL session' })
        record('tools.pwsh', {
          ok: pwshTool.ok,
          error: pwshTool.error ?? null,
          text: JSON.stringify(pwshTool.result ?? null).slice(0, 200),
        })

        // The realm's own `grep`/`glob`: the host removes both names from a WSL world
        // (their argv[0] is a packaged Windows ripgrep) and this plugin mounts them back
        // on the distribution's own grep/find. NO offline suite can drive them — the row
        // module imports harness packages — so these two rows are the only observation of
        // the chain end to end, and `scripts/verify-post-restart.mjs` reads them.
        //
        // The step names are `tool.search.*` (singular `tool`, as the plan spells them),
        // NOT the `tools.*` the sibling rows use: the suite pairs with these exact strings,
        // and both files are the only two places they appear.
        //
        // The fixture names, the token and the line number are spelled AGAIN in
        // `scripts/verify-post-restart.mjs`, which asserts on their Linux paths — the same
        // pairing `dsh-wsl-selftest.txt` already has between the two files. Three fixture
        // facts, each one earning its place:
        //
        //   - the probe carries the token on LINE 3, so a hit pins the line NUMBER rather
        //     than merely "some line of the right file";
        //   - `.git/x/hidden.ts` carries the same token and sits where the glob pattern
        //     reaches, so a search that stopped excluding the six VCS names prints an extra
        //     path (the shape Task 1's measurement removed) instead of passing quietly;
        //   - `src/a/b/deep.ts` is TWO directories below the pattern's own prefix, which is
        //     what pins "the pattern is anchored to the search root": an unanchored
        //     `src/*.ts` matches NOTHING (measured), so this file either appears or the
        //     anchoring broke.
        //
        // Written through the shell executor, not `fs`, and that is deliberate: the
        // fixtures must exist in the world the search PROCESS runs in. A file written
        // through the Windows-side share and a `grep` started through wsl.exe are only
        // guaranteed to agree while the share serves the same running distribution —
        // measured on this machine, after a host restart the share kept serving a stale
        // view that the distribution could not see at all.
        let searchFixtureError = null
        const searchToken = 'dsh-wsl-search-needle'
        if (shell === undefined || typeof workspaceCwd !== 'string' || !workspaceCwd.startsWith('\\\\wsl.localhost\\')) {
          // A host (Windows) session has no distribution shell and no search tools; the
          // rows still record, so the suite's WSL run can tell "no fixture" from "no row".
          searchFixtureError = 'the WSL shell executor is unavailable, so the search fixtures were not created'
        } else {
          const searchFixtureCommand = [
            'mkdir -p src/a/b src/.git/x',
            `printf '%s\\n' 'the search probe, written by the selftest' 'second line, so the match is not on line one' '${searchToken}' > src/dsh-wsl-search-probe.ts`,
            `printf '%s\\n' '${searchToken}' > src/.git/x/hidden.ts`,
            `printf '%s\\n' 'the nested file a root-relative pattern must find' > src/a/b/deep.ts`,
          ].join(' && ')
          // The policy is mandatory, not decorative: a `shell.resolve` with none gets the
          // session-less default root, which does NOT contain this scratch workspace —
          // measured, every write then failed EROFS. Same object the watch mutations and
          // the fs roundtrip above stamp, for the same reason.
          const searchFixturePolicy = { mode: 'workspace-write', workspaceRoot: workspaceCwd }
          const searchFixture = await runShellSpec(shell, shell.resolve({
            command: searchFixtureCommand,
            workdir: workspaceCwd,
            sandboxPolicy: searchFixturePolicy,
          }))
            .then((execution) => execution.result())
            .catch((error) => ({ exitCode: null, stderr: { text: String(error?.message ?? error) } }))
          if (searchFixture.exitCode !== 0) {
            searchFixtureError = `the search fixtures could not be written: exit ${searchFixture.exitCode ?? 'null'} ${(searchFixture.stderr?.text ?? '').slice(0, 200)}`.trim()
          }
        }
        // Both rows fold the fixture outcome into `ok`: a row that could not be given its
        // fixture must not read as a passing observation of the tool.
        //
        // Both also record at 800 bytes, where their siblings use 400: this page carries
        // the probe AND the nested path (each an absolute path under the scratch) plus the
        // value those paths came from, and a cut that removed the `lineNumber` would red
        // the assertion for a reason that is not the tool's. Measured on the real
        // distribution output with a real scratch spelling: 309 (grep) and 356 (glob)
        // bytes — 444 bytes of headroom, which is the point of the larger budget.
        const grepSearch = await invoke('grep', { pattern: searchToken })
        record('tool.search.grep', {
          ok: grepSearch.ok && searchFixtureError === null,
          error: grepSearch.error ?? searchFixtureError,
          text: JSON.stringify(grepSearch.result ?? null).slice(0, 800),
        })
        const globSearch = await invoke('glob', { pattern: 'src/**/*.ts' })
        record('tool.search.glob', {
          ok: globSearch.ok && searchFixtureError === null,
          error: globSearch.error ?? searchFixtureError,
          text: JSON.stringify(globSearch.result ?? null).slice(0, 800),
        })

        // A tool resolves its policy from the session's logged permission state
        // (`tool-bash/src/index.ts:199`), which a programmatically created
        // session does not have. Recording one is what makes the tool layer's
        // confinement observable here.
        //
        // Do NOT delete this append, and do not move it below the persistent calls: it is
        // LOAD-BEARING for the fence row (`tools.persistFence`) further down, in a way that is
        // invisible from there. The backend's guard only refuses a mode CHANGE, so if the
        // logged mode were left at `danger-full-access` the later append would be a no-op and
        // be accepted — and the fence row would redden on a guard that is working perfectly.
        // This append is what makes that change a transition. `tools.bashConfined` itself has
        // no reader in `scripts/verify-post-restart.mjs` any more (the two rows that read it
        // were replaced when the realm's `bash` became the persistent tool), so it stays as the
        // observation of the confined path plus the owner of this append, not as an assertion.
        try {
          agent.session.append('sandbox/mode', { mode: 'workspace-write' })
          const confinedTool = await invoke('bash', {
            command: 'echo x > /dsh-wsl-tool-forbidden.txt',
            description: 'selftest: confirm the tool layer confines writes',
          })
          const parsed = JSON.parse(JSON.stringify(confinedTool.result ?? null))
          record('tools.bashConfined', {
            ok: confinedTool.ok,
            error: confinedTool.error ?? null,
            sandbox: parsed?.value?.sandbox ?? null,
            stderr: parsed?.value?.stderr?.text?.slice(0, 200) ?? '',
          })
        } catch (error) {
          record('tools.bashConfined', { ok: false, error: error instanceof Error ? error.message : String(error) })
        }

        // The persistent shell, measured on the TWO calls that distinguish it from a
        // one-shot `bash`: the first establishes a cwd and exports a variable, the second
        // reads both back. A one-shot tool answers the second call with a fresh process, so
        // this pair is what makes "state survives" observable instead of asserted. The third
        // observation rides in the second call: a write OUTSIDE the workspace ($HOME is one
        // level above this scratch), which the confined path refuses — if the file appears,
        // whatever answered `bash` is not confined inside the distribution.
        //
        // It sits AFTER the `sandbox/mode` append above on purpose: the backend refuses a
        // mode change while a persistent terminal session is open
        // (`terminal-bash/src/index.ts:52-62`), so a probe placed earlier would turn that
        // append into a refusal and redden the two confinement rows for the wrong reason.
        //
        // The step names are spelled AGAIN in scripts/verify-post-restart.mjs — the same
        // two-file pairing `dsh-wsl-selftest.txt` and `tool.search.*` already have.
        const persistToken = 'dsh-wsl-persist-probe'
        const persistA = await invoke('bash', {
          command: `mkdir -p .dsh-wsl-persist-cwd && cd .dsh-wsl-persist-cwd && export DSH_WSL_PERSIST_PROBE=${persistToken}`,
          description: 'selftest: establish a state a persistent shell must keep',
        })
        record('tools.bashPersist.a', {
          ok: persistA.ok,
          error: persistA.error ?? null,
          text: JSON.stringify(persistA.result ?? null).slice(0, 400),
        })
        const persistB = await invoke('bash', {
          command: `pwd; echo "$DSH_WSL_PERSIST_PROBE"; echo probe > "$HOME/.dsh-wsl-persist-outside"; echo write-exit=$?`,
          description: 'selftest: read the state back and try a write outside the workspace',
        })
        record('tools.bashPersist.b', {
          ok: persistB.ok,
          error: persistB.error ?? null,
          text: JSON.stringify(persistB.result ?? null).slice(0, 800),
        })

        // F8's guard, observed from the realm: once a persistent terminal session exists, a
        // `sandbox/mode` change must be REFUSED with the backend's own sentence. It runs after
        // the persistent calls on purpose — before them there is no owner activity to guard.
        //
        // Wrapped in its own try, and the catch records rather than rethrows: the backend
        // refuses by THROWING, and `session.append` throws before committing
        // (`packages/core/session/src/index.ts:876-902`, pinned by its own suite), so an
        // unguarded append here would leave the session's logged mode untouched AND escape
        // into the outer catch, where it would kill every row below and report one `error`
        // step instead. The refusal is the OBSERVATION, so it is recorded as a step.
        try {
          agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
          record('tools.persistFence', { refused: false, reason: 'the mode change was accepted while a persistent terminal session was open' })
        } catch (error) {
          record('tools.persistFence', { refused: true, reason: error instanceof Error ? error.message : String(error) })
        }

        // The clock-domain row the controller added to this task (R47): the orphan sweep's age
        // decision must be made entirely INSIDE the distribution.
        //
        // Why this exists at all: the sweep was changed to one command with two answers
        // (`find … -print`, a marker, `find … -mmin +2 -print`) precisely so the age
        // comparison never crosses a clock domain (`lib/wsl/pty.js:417-489`). The offline pin
        // for that change is a SOURCE-SHAPE pin (`scripts/verify-pty-handle.mjs`), because no
        // fixture can make two clocks disagree — `touch -t` sets the time explicitly, and
        // skewing a distribution's clock is out of bounds. R41 accepted the shape pin on the
        // condition that the BEHAVIOURAL evidence lands here. Without it, a future "fix" that
        // reintroduced a second clock source (`stat -c %Y` in the distro, compared against
        // `Date.now()` on the host) would redden nothing.
        //
        // What it does NOT do: it does not FAKE skew. It proves the host's clock is not an
        // input — the strongest honest evidence available here — by planting two LEGACY names
        // in the distro (one fresh, one backdated), running the real sweep, and then running it
        // again with this process's `Date.now()` shifted by 45 days. A sweep that consulted the
        // host clock at all would change a verdict across that shift.
        //
        // Cleanup is unconditional and one command: the probe's own names carry this host's
        // pid, so a crashed run's residue is collectable by the next generation's sweep too.
        const sweepNames = { young: `/tmp/dsh-pty-${process.pid}-t3sweepyoung.fifo`, aged: `/tmp/dsh-pty-${process.pid}-t3sweepaged.fifo` }
        // The distribution comes from the workspace this session runs in — the same source
        // `shell.run` and the search fixtures use — not from a config default: on a host whose
        // default distribution differs from the workspace's, the probe would then plant its
        // names in one distribution and sweep another, and read `youngKept` off a directory
        // where nothing was ever planted. A host (Windows) session has no distribution at all,
        // and says so instead of reporting four absent rows.
        const sweepTarget = typeof workspaceCwd === 'string' ? parseWslUnc(workspaceCwd) : null
        const sweepDistro = sweepTarget?.distro
        // ONE runner for the probe's distribution calls, with the configured `wsl.exe` path
        // threaded through the same named select the rest of this file uses. FOUR source sites
        // (`sweepList`, `sweepPlant`, the clock read and the cleanup) issuing EIGHT invocations
        // per run — three listings, two plants, the clock read, the bridge probe below and the
        // cleanup — not four calls. `scripts/verify-world.mjs` pins this file's probe SITES by
        // count, and the `...sweepSelect` spread above is what carries the configured path
        // through this runner; that pin now covers THIS form structurally as well
        // (`insideCall` + `carrier` in the structural row beside the count table), so dropping
        // the spread reddens it instead of silently reverting to the default `wsl.exe`.
        const sweepSelect = { wslPath: routeWslPath }
        const sweepShell = (command) => runWslShell({ distro: sweepDistro, linuxCwd: '/', loginShell: false, command, ...sweepSelect })
        const sweepList = async () => String((await sweepShell('ls -1 /tmp/dsh-pty-*.fifo 2>/dev/null; echo END')).stdout ?? '')
          .split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/tmp/dsh-pty-'))
        const sweepPlant = () => sweepShell(
          `rm -f ${shellQuote(sweepNames.young)} ${shellQuote(sweepNames.aged)}`
          + ` && mkfifo ${shellQuote(sweepNames.young)}`
          + ` && mkfifo ${shellQuote(sweepNames.aged)}`
          // 2020-01-01: older than any creation window, by six years.
          + ` && touch -t 202001010000 ${shellQuote(sweepNames.aged)}`,
        )
        // THE POSITIVE CONTROL for criterion 2's bridge half (R49(d), M4). It is read HERE,
        // while this selftest's own persistent PTY is still open — the session is disposed in
        // the outer `finally`, so this is the last point at which a bridge of this run is
        // guaranteed to exist. Without it the suite's "this run added no bridge" clause passes
        // by construction on an empty baseline: a pgrep that matches nothing is
        // indistinguishable from a bridge that was never created, and a broken pattern would
        // read as a clean run forever. Recorder discipline is the same as every other probe:
        // a host-world session records the REASON it could not observe, never an empty row.
        let bridgeProbe
        try {
          if (sweepDistro === undefined) throw new Error('this session runs in the host world, so there is no bridge to observe')
          const listing = await sweepShell(`pgrep -f -- '[P]TY bridge for the WSL execution world' || true`)
          const pids = String(listing.stdout ?? '')
            .split('\n').map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).sort()
          bridgeProbe = { ok: true, distro: sweepDistro, pids, count: pids.length }
        } catch (error) {
          bridgeProbe = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        record('tools.persistBridge', bridgeProbe)
        let sweepProbe
        try {
          // A Windows session cannot host this probe: the sweep is a distribution-side
          // operation and there is no distribution to sweep. Recorded as the REASON, never as
          // an empty row — the suite's row has to be able to tell "no distribution" from
          // "the probe did not run".
          if (sweepDistro === undefined) throw new Error('this session runs in the host world, so there is no distribution to sweep')
          // The measurement (not an assertion): how far apart the two clocks actually are on
          // THIS machine. Recorded so the report can state it instead of assuming agreement.
          const hostMs = Date.now()
          const clock = await sweepShell('date +%s; date -u +%Y-%m-%dT%H:%M:%SZ')
          const [distroSecondsText, distroIso] = String(clock.stdout ?? '').trim().split('\n')
          await sweepPlant()
          const planted = await sweepList()
          const removedFirst = await sweepOrphanFifos({ distro: sweepDistro }, { wslPath: routeWslPath })
          const afterFirst = await sweepList()
          // The host-side shift. `Date.now` is the only host clock this process offers the
          // sweep, so patching it is the whole of "the host's reading changed".
          //
          // DECLARED AS A SHARED-INPUT MUTATION, because that is what it is: `Date.now` is
          // PROCESS-GLOBAL on a live host, and anything else in this process that reads
          // `Date.now()` inside the patched window would be stamped 45 days into the future —
          // `session.append`'s event timestamps (`packages/core/session/src/index.ts:820`) are
          // the concrete example. Two things keep that exposure small and are the reason this
          // shape is acceptable at all: the window holds ONE await (the sweep), and it is
          // restored in `finally` on every path. The reading that follows the sweep is taken
          // OUTSIDE the window on purpose, so the window cannot grow back by an edit that
          // slides a line.
          await sweepPlant()
          const realNow = Date.now
          const HOST_SHIFT_MS = 45 * 24 * 3600 * 1000
          let removedShifted
          try {
            Date.now = () => realNow() + HOST_SHIFT_MS
            removedShifted = await sweepOrphanFifos({ distro: sweepDistro }, { wslPath: routeWslPath })
          } finally {
            Date.now = realNow
          }
          // Unpatched by construction: this is the observation of what the patched sweep left,
          // and it must not itself run under a fake clock.
          const afterShift = await sweepList()
          sweepProbe = {
            distro: sweepDistro,
            distroSeconds: Number(distroSecondsText),
            hostSeconds: hostMs / 1000,
            deltaSeconds: Math.round((hostMs / 1000 - Number(distroSecondsText)) * 1000) / 1000,
            distroIso: distroIso ?? null,
            planted,
            youngKept: afterFirst.includes(sweepNames.young),
            agedSwept: !afterFirst.includes(sweepNames.aged),
            removedFirst,
            afterFirst,
            hostShiftMs: HOST_SHIFT_MS,
            youngKeptAfterShift: afterShift.includes(sweepNames.young),
            agedSweptAfterShift: !afterShift.includes(sweepNames.aged),
            removedShifted,
            afterShift,
          }
        } catch (error) {
          sweepProbe = { error: error instanceof Error ? error.message : String(error) }
        } finally {
          // Unconditional: the fixtures are this host's, and a throw above must not leave them
          // for the operator to find. Best-effort by design — a cleanup fault must not mask
          // the observation, and each name is collectable by a later sweep regardless.
          if (sweepDistro !== undefined) {
            await sweepShell(`rm -f ${shellQuote(sweepNames.young)} ${shellQuote(sweepNames.aged)}`).catch(() => {})
          }
        }
        record('tools.persistSweep', sweepProbe)
      }
      return { steps }
    } catch (error) {
      record('error', {
        message: error instanceof Error ? error.message : String(error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 5),
      })
      return { steps }
    } finally {
      // A selftest session is a live agent in the registry; release it.
      //
      // THE RELEASE WAS A NO-OP, and that is what the live gate measured (root cause A of the
      // 2026-10-19 17:23 run). `agent?.dispose?.()` is an OPTIONAL call on the AGENT, and the
      // harness's agent surface has no `dispose` — `dispose()` belongs to the HANDLE
      // (`AgentHandle`, `packages/core/agent/src/index.ts:160-163`), which is the capability that
      // stops and drains the loop, unregisters the agent and unwinds its scope. So the await
      // resolved immediately having done nothing, the session's PTY was never torn down, and the
      // suite that read the bridge/FIFO delta right after this returned was reading a session
      // that had never been released. (The optional call is WHY it failed silently: `?.` turned a
      // missing method into a no-op instead of a TypeError.)
      //
      // `?? fallback` is kept for hosts whose create() answers a bare agent (the same
      // dual-dispatch the create step above documents); on those the disposal is still
      // best-effort, and the recorded step says which shape ran so a reader can tell.
      let teardown
      const startedAt = Date.now()
      try {
        const target = handle ?? agent
        const method = target?.dispose
        if (typeof method !== 'function') {
          teardown = { ok: false, error: 'the created value exposes no dispose() — nothing was released' }
        } else {
          await method.call(target)
          teardown = { ok: true, via: target === handle ? 'handle' : 'agent', elapsedMs: Date.now() - startedAt }
        }
      } catch (error) {
        // Disposal failure does not change what the checks observed, but it MUST be visible:
        // a throw here is the difference between "the session was released" and "the suite is
        // about to read the residue of a session that is still alive".
        teardown = { ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - startedAt }
      }
      // RECORDED AFTER the await, which is the whole point: this step is the suite's permission
      // to read the bridge/FIFO delta. A row that reads without it is reading mid-teardown, and
      // measured on the 17:23 run that produced a bridge and a FIFO belonging to a session whose
      // disposal had not run at all (root cause A). It is recorded even when disposal FAILED —
      // `ok: false` is the suite's signal that the residue it finds is real, not a timing artefact.
      record('tools.persistTeardown', teardown)
    }
  },

  /**
   * Exercise the workspace flow the sidebar dialog performs, and clean up.
   *
   * The dialog's own rendering needs a browser, but its host contract does not:
   * this lists a Linux directory, checks it, registers the workspace under the
   * UNC spelling, and removes it again so no test workspace is left behind.
   * @param {{ distro?: string, linuxPath?: string }} params - target directory.
   * @returns {Promise<object>} what each step observed.
   */
  workspaceFlow: async ({ distro, linuxPath }) => {
    const registry = hostCtx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
    // Default the same way the selftest does — the distribution home, never /tmp:
    // the fence refuses a workspace root under /tmp (confinement mounts a private
    // tmpfs over it after binding the workspace), so a workspace registered there
    // could never be used as a writable root. This method's old default handed the
    // registry exactly such a path.
    const location = linuxPath ?? (await defaultWorkspaceUnc({ wslPath: routeWslPath })).uncPath
    const target = await resolveLocation(location, distro)
    const listing = await listLinuxDir(target.distro, target.linuxPath, { wslPath: routeWslPath })
    const facts = await checkLinuxPath(target.distro, target.linuxPath, { wslPath: routeWslPath })
    const existing = await registry.resolveByPath(target.uncPath)
    const workspace = existing ?? await registry.create(target.uncPath, `wsl-selftest ${target.linuxPath}`)
    const created = existing === undefined
    let deleted = null
    if (created) deleted = await registry.delete(workspace.id)
    return {
      distro: target.distro,
      linuxPath: target.linuxPath,
      uncPath: target.uncPath,
      directoryEntries: listing.entries.length,
      isDirectory: facts.isDirectory,
      workspaceId: String(workspace.id),
      workspacePath: workspace.path,
      created,
      deleted,
    }
  },

  /**
   * Report recent preset-binding decisions.
   * @returns {Promise<object>} the decisions, newest last.
   */
  bindingLog: () => Promise.resolve({ entries: bindingLog }),

  /**
   * Read the harness's own view of every preset's composition.
   *
   * This is what proves a generated preset is not merely written to disk but
   * accepted, parsed and resolved by the preset registry.
   * @returns {Promise<object>} the composition inventory.
   */
  presetInventory: async () => {
    const presets = hostCtx.get('agentPresets')
    if (presets === undefined) throw new Error('agentPresets 服务不可用')
    return { inventory: await presets.compositionInventory() }
  },

  /**
   * Report which presets the registry currently sees.
   * @returns {Promise<object>} the roster.
   */
  presetRoster: async () => {
    const presets = hostCtx.get('agentPresets')
    if (presets === undefined) throw new Error('agentPresets 服务不可用')
    const roster = await presets.list()
    return { roster: roster.map((entry) => ({ id: entry.id, name: entry.name, broken: entry.broken ?? null, isDefault: entry.isDefault ?? false })) }
  },

  /**
   * Regenerate the WSL presets from the current roster.
   * @param {{ distro?: string }} params - optional distribution to pin.
   * @returns {Promise<object>} the new state.
   */
  regeneratePresets: ({ distro }) => refreshPresets(hostCtx, distro),

  /**
   * Create (or find) the workspace for a WSL directory.
   *
   * The workspace is registered under its UNC spelling because that is the only
   * form the Windows-side harness accepts as an absolute workspace path.
   * @param {{ distro?: string, path: string, title?: string }} params - the WSL directory.
   * @returns {Promise<object>} the workspace identity and the preset to open it with.
   */
  createWorkspace: async ({ distro, path, title }) => {
    const target = await resolveLocation(path, distro)
    const facts = await checkLinuxPath(target.distro, target.linuxPath, { wslPath: routeWslPath })
    if (!facts.isDirectory) throw new Error(`${target.linuxPath} 不是一个存在的目录`)
    const registry = hostCtx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
    const existing = await registry.resolveByPath(target.uncPath)
    const workspace = existing ?? await registry.create(target.uncPath, title ?? target.linuxPath)
    // The preset a client should open this workspace with, resolved against the
    // live roster exactly like `wslPresetFor` — not a hardcoded guess. The
    // workspace itself does not depend on it, so an unavailable registry
    // degrades to the default spelling instead of failing the creation.
    let presetId = 'wsl-standard'
    try {
      const presets = hostCtx.get('agentPresets')
      if (presets !== undefined) {
        const resolved = await presets.resolve()
        const candidate = variantIdFor(resolved)
        const roster = await presets.list()
        if (roster.some((preset) => preset.id === candidate && preset.broken === undefined)) presetId = candidate
      }
    } catch {
      // Reported as the default spelling; the browser half resolves again at
      // session-creation time, which is the seam that matters.
    }
    return {
      workspaceId: workspace.id,
      path: workspace.path,
      title: workspace.title,
      created: existing === undefined,
      presetId,
      linuxPath: target.linuxPath,
      distro: target.distro,
    }
  },

  /**
   * List the registered WSL variant presets (0.1.7 registry roster).
   * @returns {Promise<object>} the variant ids and display names.
   */
  listPresetDirectories: async () => {
    // 0.1.6 read generated directories off disk; the registry is the source of
    // truth now. The method name is kept for the developer surface.
    const presets = hostCtx?.get('agentPresets')
    if (presets === undefined) return { root: null, names: [] }
    const roster = await presets.list()
    const names = roster
      .filter((preset) => typeof preset.id === 'string' && preset.id.startsWith(GENERATED_PREFIX))
      .map((preset) => preset.id)
    return { root: null, names }
  },

  /**
   * Read one registered preset's declared child-plugin list, for inspecting
   * the transform in place.
   * @param {{ id: string }} params - preset id.
   * @returns {Promise<object>} the preset document.
   */
  readPreset: async ({ id }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`readPreset: 非法的预设 id ${JSON.stringify(id)}`)
    }
    const presets = hostCtx?.get('agentPresets')
    if (presets === undefined) throw new Error('readPreset: agentPresets 服务不可用')
    // 0.1.7: readDocument returns the declaration re-dumped as YAML content.
    const doc = await presets.readDocument(id)
    return { id: doc.agentPreset, content: doc.content }
  },
}

/**
 * Read one JSON request body, bounded.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @returns {Promise<{ text: string | null, byteLength: number }>} the body, or null past the ceiling.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return { text: null, byteLength: size }
    }
    chunks.push(chunk)
  }
  return { text: Buffer.concat(chunks, size).toString('utf8'), byteLength: size }
}

/**
 * Answer one request with a JSON envelope and an explicit status.
 * @param {import('node:http').ServerResponse} res - the response to complete.
 * @param {number} status - the HTTP status.
 * @param {{ ok: boolean }} payload - the envelope, success or failure.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Answer with one admission rejection.
 * @param {import('node:http').ServerResponse} res - the response to complete.
 * @param {import('./http-admission.js').Rejection} rejection - the refusal.
 */
function sendRejection(res, rejection) {
  sendJson(res, rejection.status, { ok: false, code: rejection.code, error: rejection.message })
}

/** Trust surface consumed here; the browser-side connection package owns the full type. */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * This installation's development token, minted on first use.
 *
 * The file is owner-only and lives outside the repository. A web page cannot
 * read it, which is what keeps the acceptance surface unreachable from a
 * cross-site request even though the route itself is on loopback.
 * @returns {Promise<string>} the token.
 */
async function devToken() {
  const path = join(dshHome(), 'wsl-desktop-dev-token')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing.length > 0) return existing
    // An empty file is unusual — treat it like absent and re-mint below.
  } catch (error) {
    // ENOENT = first use. Any other read failure (ACL, AV lock, disk) must
    // fail loud rather than silently rotate the credential and revoke every
    // scripted caller.
    if (error?.code !== 'ENOENT') throw error
  }
  const minted = randomBytes(32).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${minted}\n`, { mode: 0o600 })
  return minted
}

/**
 * Whether one request may use the acceptance surface.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {{ developerTools: boolean }} config - resolved plugin config.
 * @returns {Promise<boolean>} true for a caller presenting this installation's token.
 */
async function isDeveloperCaller(req, config) {
  if (config.developerTools !== true) return false
  return tokenMatches(req.headers[DEV_TOKEN_HEADER], await devToken(), timingSafeEqual)
}

/**
 * Register the WSL route and generate the WSL presets.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ routePath: string, developerTools: boolean, wslPath?: string }} config - resolved plugin config.
 */
export function apply(ctx, config) {
  hostCtx = ctx
  routeWslPath = config.wslPath
  hostReady = false
  // Bound concurrent route methods: each discovery call spawns wsl.exe, and a
  // misbehaving page could fan out without limit. Named because a bare "8" here
  // was once mis-read as a wsl.exe SPAWN cap — it is not: one route method may
  // fan out several children (a command plus its probes). The spawn cap is
  // MAX_CONCURRENT_SPAWNS in lib/wsl/world.js.
  const MAX_ROUTE_IN_FLIGHT = 8
  let routeInFlight = 0
  // The WSL providers start `wsl.exe`, an ordinary Windows process, through the
  // host's own subprocess provider. A realm that isolates `subprocess` shadows
  // `ctx.subprocess`, so the root provider is captured here for them to reuse.
  ctx.inject(['subprocess'], (scope) => {
    setLocalSubprocess(scope.subprocess)
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.routePath,
    handler: async (req, res) => {
      // The fence first, exactly as every shipped host route does it: without
      // this, a cross-site `text/plain` POST is a CORS-simple request with no
      // preflight, and this route can run commands. One call returns two arms:
      // 403 when the Host/Origin is not trusted (the DNS-rebinding defence) and
      // 401 when the browser session is not authenticated. A development token
      // replaces the SECOND arm only — a local script cannot present a browser
      // cookie — and never the first: a token holder gains nothing from a
      // trusted Host, but a foreign Host must stay refused for every caller.
      const developer = await isDeveloperCaller(req, config)
      const rejection = fenceRejection({
        rejection: connectionOf(ctx).requestRejection(req),
        developer,
      })
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end()
        return
      }
      const early = preflight({ httpMethod: req.method, contentType: req.headers['content-type'] })
      if (early.ok !== true) {
        sendRejection(res, early)
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'bad-request', error: `请求体读取失败：${String(error)}` })
        return
      }
      const sized = bodyAdmission({ byteLength: body.text === null ? MAX_BODY_BYTES + 1 : body.byteLength })
      if (sized.ok !== true) {
        sendRejection(res, sized)
        return
      }
      let envelope
      try {
        envelope = JSON.parse(body.text || '{}')
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'bad-request', error: `请求体不是合法 JSON：${String(error)}` })
        return
      }
      const method = envelope === null || typeof envelope !== 'object' ? undefined : envelope.method
      const named = methodAdmission({ method })
      if (named.ok !== true) {
        sendRejection(res, named)
        return
      }
      const run = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : undefined
      const admitted = dispatchAdmission({
        method,
        developer,
        known: run !== undefined,
        browserReachable: BROWSER_METHODS.has(method),
      })
      if (admitted.ok !== true) {
        sendRejection(res, admitted)
        return
      }
      if (routeInFlight >= MAX_ROUTE_IN_FLIGHT) {
        sendJson(res, 503, { ok: false, code: 'too-busy' })
        return
      }
      routeInFlight += 1
      try {
        sendJson(res, 200, { ok: true, value: await run(envelope.params ?? {}) })
      } catch (error) {
        // A rejected method is a request-level outcome, not a transport fault.
        // Browser callers receive a catalog code and only the params that code
        // allows; the message can embed wsl.exe stderr or resolved host paths.
        const failure = browserFailure(error, { discovery: DISCOVERY_METHODS.has(method) })
        if (failure.code === 'internal') {
          const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
          ctx.logger?.error?.(`wsl-desktop: ${method} failed (ref ${failure.params.ref}): ${detail}`)
        }
        if (developer) {
          const detail = error instanceof Error ? (error.cause?.message ?? error.message) : String(error)
          sendJson(res, 400, { ok: false, ...failure, error: detail })
        } else {
          sendJson(res, 400, { ok: false, ...failure })
        }
      } finally {
        routeInFlight -= 1
      }
    },
  }), `wsl-desktop: POST ${config.routePath}`)
  // Preset generation is best-effort at boot: the route reports the outcome
  // instead of failing the whole composition when the roster is unavailable.
  // `inject` waits for the registry rather than racing boot order.
  ctx.inject(['agentPresets'], (scope) => {
    // Per-generation lifecycle token: teardown flips `disposed` synchronously
    // as its FIRST statement, before draining — a materialization parked at an
    // await re-checks the flag around every register() and hands any
    // just-registered variant straight back to its disposer, so a disable
    // landing mid-registration cannot orphan a wsl-* preset in the registry.
    // Per-generation disposer ownership: one generation's teardown drains only
    // the variants ITS registration created, so a second generation mounted
    // beside a running one (the documented same-process exercise path) can no
    // longer have its variants torn down by the first generation's dispose.
    const generation = { disposed: false, disposers: new Map() }
    scope.effect(() => () => {
      generation.disposed = true
      for (const [, dispose] of generation.disposers) void dispose()
      generation.disposers.clear()
    }, 'wsl-desktop: variant preset disposal')
    void defaultDistro().then(
      (distro) => refreshPresets(scope, distro, generation),
      () => refreshPresets(scope, undefined, generation),
    ).finally(() => {
      // The probe is allowed to run even after a failed materialization: the result
      // then says which capability is missing, instead of leaving the browser on
      // "pending" forever.
      hostReady = true
      // One startup line, as the spec asks: the post-restart gate and a bug report
      // both need the capability state without opening the dialog.
      void probeHost(hostCtx).then((status) => {
        ctx.logger?.info?.(`wsl-desktop: capabilities ${JSON.stringify(status)}`)
      }, () => {})
    })
  })

  // The browser half names the WSL preset in its session create request — the
  // only race-free seam, because the harness composes the preset at creation.
  // This listener is the LAST RESORT for a WSL-workspace session created
  // without a preset (some other entry point): it tries a post-hoc select,
  // which is refused for any session that has already taken a turn, and both
  // outcomes land in `bindingLog` as an anomaly signal.
  //
  // ONE listener, not two. `agent/created` is a scoped event, but a listener
  // registered without a scope is admitted globally, so registering both paths
  // made every session issue two concurrent `select` calls and append two
  // `agent-preset/selected` events for one creation. `api-session/added` carries
  // no scope, always arrives, and its summary carries the cwd and blankness the
  // decision needs, so the agent is looked up from the registry.
  ctx.on('api-session/added', (summary) => {
    void bindWslSession(ctx, summary)
  })
}

/**
 * Append one preset-binding decision, trimming to the inspection limit.
 * @param {object} entry - the decision to record.
 */
function recordBinding(entry) {
  bindingLog.push(entry)
  if (bindingLog.length > BINDING_LOG_LIMIT) bindingLog.splice(0, bindingLog.length - BINDING_LOG_LIMIT)
}

/**
 * Bind one newly visible session to the WSL variant of its preset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ sessionId?: unknown, cwd?: unknown }} summary - the session summary.
 * @returns {Promise<void>} settlement.
 */
async function bindWslSession(ctx, summary) {
  const cwd = typeof summary?.cwd === 'string' ? summary.cwd : ''
  if (parseWslUnc(cwd) === null) return
  const agents = ctx.get('agents')
  if (agents === undefined) return
  const agent = agents.get(summary?.sessionId)
  if (agent === undefined) {
    recordBinding({ sessionId: String(summary?.sessionId), cwd, ok: false, error: 'agent 尚未注册' })
    return
  }
  await bindWslPreset(ctx, agent, cwd, String(summary?.sessionId))
}

/**
 * Select the WSL variant of the agent's current preset.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} agent - the live agent.
 * @param {string} cwd - the session working directory.
 * @param {string} sessionId - the session identity, for the log.
 * @returns {Promise<void>} settlement.
 */
async function bindWslPreset(ctx, agent, cwd, sessionId) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return
  const current = presets.composedPreset(agent.ctx)
  if (typeof current === 'string' && current.startsWith(GENERATED_PREFIX)) return
  const from = typeof current === 'string' && current.length > 0 ? current : 'standard'
  const wanted = `${GENERATED_PREFIX}${from}`
  try {
    const chosen = await presets.select(agent, wanted)
    recordBinding({ sessionId, cwd, from, to: chosen, ok: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    recordBinding({ sessionId, cwd, from, to: wanted, ok: false, error: reason })
    // This is the last-resort path for a session this plugin did not create
    // (the browser half names the preset in its create request, which is the
    // only race-free seam). A refusal here means the session is running in the
    // host world, so it must not stay invisible in an in-memory array.
    ctx.logger?.warn?.(
      `wsl-desktop: 会话 ${sessionId} 未能切到 ${wanted}（${reason}）；`
      + '它运行在宿主执行世界里。请在 W 对话框里新建会话，或在预设选择器里手动切换。',
    )
  }
}
