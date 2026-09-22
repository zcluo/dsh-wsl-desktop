/**
 * Host half of `dsh-wsl-desktop`.
 *
 * Two jobs:
 *
 * 1. Answer the browser's WSL questions over the same-origin route — the
 *    browser cannot run `wsl.exe`.
 * 2. Materialize the WSL agent presets into the user preset root. A session's
 *    execution world is chosen by its preset, so this is what lets one Desktop
 *    instance run Windows workspaces and WSL workspaces side by side.
 * @module dsh-wsl-desktop
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  MAX_BODY_BYTES, DEV_TOKEN_HEADER, bodyAdmission, dispatchAdmission, methodAdmission, preflight, tokenMatches,
} from './http-admission.js'
import { renderPresetMetadata, renderWslPreset, sweepDecision } from './wsl/preset.js'
import { setLocalSubprocess } from './wsl/host-refs.js'
import { checkLinuxPath, defaultDistro, listDistros, listLinuxDir, resolveDistroHome, runWslShell } from './wsl/world.js'
import { joinWslUnc, parseWslUnc, windowsToMntPath } from './wsl/paths.js'

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
  routePath: z.string().default('/wsl-desktop/api'),
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

/** Prefix of every preset this plugin owns; its own outputs are never sources. */
const GENERATED_PREFIX = 'wsl-'

/**
 * Sidecar this plugin writes into every directory it generates. A name prefix
 * is not proof of ownership, so the sweep only withdraws marked directories.
 */
const GENERATED_MARKER = '.dsh-wsl-desktop-generated'

/** Module specifier of the WSL subprocess provider, as the preset row must name it. */
const SUBPROCESS_MODULE = join(HERE, 'wsl', 'subprocess.js')

/** Module specifier of the WSL shell executor, as the preset row must name it. */
const SHELL_MODULE = join(HERE, 'wsl', 'shell.js')

/** Module specifier of the WSL filesystem provider. */
const FS_MODULE = join(HERE, 'wsl', 'fs.js')

/** Last preset materialization outcome, reported through the route. */
let presetState = { status: 'pending' }

/** Recent preset-binding decisions, reported through the route. */
const bindingLog = []

/** Most binding decisions kept for inspection. */
const BINDING_LOG_LIMIT = 50

/** The plugin context, captured so route methods can reach host services. */
let hostCtx

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
 * Write one WSL variant of every shipped preset into the user preset root.
 *
 * Variants are rewritten rather than replaced: a session keeps its persona,
 * skills and tools, and only swaps the execution world. The previous
 * generation is overwritten in place so a restart never sees two of them.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} distro - distribution pinned into the filesystem row.
 * @returns {Promise<{ written: object[], withdrawn: string[], skipped: object[] }>} what changed and what was refused.
 */
/**
 * Locate the directory a preset was discovered under.
 *
 * A preset may name a row by a path relative to its own directory, so the
 * variant needs that base to rewrite the name to something that still resolves
 * from where the variant lives.
 * @param {string} id - preset id.
 * @returns {string | undefined} the directory, or undefined when it cannot be found.
 */
function sourceDirFor(id) {
  const local = join(dshHome(), '.agent-presets', id)
  if (existsSync(join(local, 'agent.cordis.yml'))) return local
  try {
    const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-presets/package.json'))
    const shipped = join(dirname(manifest), 'presets', id)
    if (existsSync(join(shipped, 'agent.cordis.yml'))) return shipped
  } catch {
    // A deployment without the preset package leaves relative names as they are.
  }
  return undefined
}

async function materializePresets(ctx, distro) {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) throw new Error('agentPresets 服务不可用')
  const root = join(dshHome(), '.agent-presets')
  const roster = await presets.list()
  const written = []
  const skipped = []
  /** Variants kept for one more boot because their source was skipped. */
  const retained = new Set()
  for (const preset of roster) {
    const id = typeof preset?.id === 'string' ? preset.id : undefined
    if (id === undefined) continue
    // Our own variants are outputs, never sources. Without this the registry
    // sees them on the next boot and wraps them again (wsl-wsl-standard, …).
    // A user preset that happens to live in this namespace is reported rather
    // than silently ignored: it is theirs, and it is never a source.
    if (id.startsWith(GENERATED_PREFIX)) {
      skipped.push({ id, reason: '落在本插件的生成命名空间里，不作为派生源' })
      continue
    }
    // A preset the registry already reports as unmountable cannot be repaired by
    // deriving from it. The orphan sweep below KEEPS the previous variant one
    // more boot: its absolute module paths are written into live sessions, so
    // deleting it on a transient registry failure would break those sessions
    // until a restart. A permanently broken source keeps reporting `broken`
    // every boot, and the variant shows up in `skipped` each time.
    if (typeof preset.broken === 'string' && preset.broken.length > 0) {
      skipped.push({ id, broken: preset.broken })
      retained.add(`${GENERATED_PREFIX}${id}`)
      continue
    }
    const source = await presets.read(id)
    const sourceDir = sourceDirFor(id)
    const variant = renderWslPreset(source, {
      ...(sourceDir !== undefined ? { sourceDir } : {}),
      subprocessPath: SUBPROCESS_MODULE,
      shellPath: SHELL_MODULE,
      fsPath: FS_MODULE,
      ...(distro !== undefined ? { distro } : {}),
    })
    const display = typeof preset?.name === 'string' && preset.name.length > 0 ? preset.name : id
    const directory = join(root, `${GENERATED_PREFIX}${id}`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, GENERATED_MARKER), `${name}\n`, 'utf8')
    await writeFile(join(directory, 'agent.cordis.yml'), variant.yaml, 'utf8')
    await writeFile(
      join(directory, 'preset.yml'),
      renderPresetMetadata({
        name: `WSL · ${display}`,
        description: `在 WSL 发行版里执行（由 ${id} 派生）`,
      }),
      'utf8',
    )
    written.push({ id: `${GENERATED_PREFIX}${id}`, from: id, removed: variant.removed })
  }
  // The prefix is this plugin's namespace, but a prefix is not proof of
  // ownership: a user may have authored `wsl-<something>` themselves. Only a
  // directory carrying this plugin's marker is withdrawn; an unmarked one is
  // reported so the operator can see why it was left alone.
  const withdrawn = []
  const unmanaged = []
  const expected = new Set(written.map((entry) => entry.id))
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const decision = sweepDecision({
      name: entry.name,
      prefix: GENERATED_PREFIX,
      expected: expected.has(entry.name) || retained.has(entry.name),
      marked: existsSync(join(root, entry.name, GENERATED_MARKER)),
    })
    if (decision === 'unmanaged') {
      unmanaged.push(entry.name)
      continue
    }
    if (decision !== 'withdraw') continue
    await rm(join(root, entry.name), { recursive: true, force: true })
    withdrawn.push(entry.name)
  }
  return { written, withdrawn, skipped, unmanaged }
}

/**
 * Refresh the presets, recording the outcome for the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string | undefined} distro - distribution to pin.
 * @returns {Promise<object>} the new preset state.
 */
async function refreshPresets(ctx, distro) {
  presetState = { status: 'running' }
  try {
    const result = await materializePresets(ctx, distro)
    presetState = { status: 'ready', ...result, root: join(dshHome(), '.agent-presets') }
  } catch (error) {
    presetState = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  return presetState
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
   * List the installed distributions.
   * @returns {Promise<string[]>} distribution names.
   */
  listDistros: () => listDistros(),

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
  listDir: async ({ distro, path }) => listLinuxDir(distro, path ?? '/'),

  /**
   * Check one Linux path and report the workspace spelling it would take.
   * @param {{ distro: string, path: string }} params - distribution and absolute Linux path.
   * @returns {Promise<object>} path facts plus the UNC spelling.
   */
  checkPath: async ({ distro, path }) => {
    // Grammar-validate the distro before any wsl.exe side effect.
    const uncPath = joinWslUnc(distro, path)
    const facts = await checkLinuxPath(distro, path)
    return { ...facts, uncPath }
  },

  /**
   * Resolve a location without touching the filesystem.
   * @param {{ location: string, distro?: string }} params - the location to resolve.
   * @returns {Promise<object>} the resolved target.
   */
  resolve: ({ location, distro }) => resolveLocation(location, distro),

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
  resolveHome: ({ distro, username }) => resolveDistroHome(distro, username),

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
    if (presets === undefined) throw new Error('agent presets 尚不可用')
    const resolved = await presets.resolve(base)
    const agentPreset = resolved.id.startsWith(GENERATED_PREFIX)
      ? resolved.id
      : `${GENERATED_PREFIX}${resolved.id}`
    const roster = await presets.list()
    const variant = roster.find((preset) => preset.id === agentPreset)
    if (variant === undefined) throw new Error(`WSL 预设 ${agentPreset} 尚未生成`)
    if (variant.broken !== undefined) throw new Error(`WSL 预设 ${agentPreset} 无法挂载：${variant.broken}`)
    return { agentPreset, base: resolved.id }
  },

  /**
   * Run one command inside a distribution.
   * @param {{ cwd?: string, distro?: string, command: string, username?: string, timeoutMs?: number }} params - execution request.
   * @returns {Promise<object>} the outcome plus the exact argv used.
   */
  execInWsl: async ({ cwd, distro, command, username, timeoutMs }) => {
    if (typeof command !== 'string') throw new Error('execInWsl: command 必须是字符串')
    const target = await resolveLocation(cwd ?? '/', distro)
    const result = await runWslShell({
      distro: target.distro,
      linuxCwd: target.linuxPath,
      command,
      ...(username !== undefined ? { username } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    return { ...result, target }
  },

  /**
   * Report the current preset generation state.
   * @returns {Promise<object>} the state.
   */
  presetStatus: () => Promise.resolve(presetState),

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
    let agent
    try {
      const agents = hostCtx.get('agents')
      const presets = hostCtx.get('agentPresets')
      if (agents === undefined || presets === undefined) throw new Error('agents / agentPresets 服务不可用')
      const workspaceCwd = cwd ?? (await resolveLocation('/tmp', undefined)).uncPath
      const sessionId = `wsl-selftest-${Date.now()}`
      const handle = await agents.create({ sessionId, meta: { cwd: workspaceCwd, agentPreset: preset } })
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

      const shell = presets.serviceFor(agent, 'shell')
      record('shell.service', { found: shell !== undefined, sandboxMode: shell?.sandboxMode ?? null })
      if (shell !== undefined) {
        const spec = shell.resolve({ command: 'uname -s; pwd; id -un; echo "$WSL_DISTRO_NAME"', workdir: workspaceCwd })
        const result = await shell.run(spec)
        record('shell.run', {
          exitCode: result.exitCode,
          stdout: result.stdout.text.trim().split('\n'),
          stderr: result.stderr.text.slice(0, 300),
          sandbox: result.sandbox ?? null,
        })
      }

      const fs = presets.serviceFor(agent, 'fs')
      record('fs.service', { found: fs !== undefined })
      if (fs !== undefined) {
        // A mutation is called the way the tool layer calls it: `tool-fs`
        // resolves a per-call policy and stamps the calling session's cwd as the
        // workspace root (`tool-fs/src/sandbox.ts:88-93`). Calling `writeText`
        // without that policy is a call no real consumer makes, and under a
        // confining backend it is refused for having no root to be contained by.
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
      }

      const subprocess = presets.serviceFor(agent, 'subprocess')
      record('subprocess.service', { found: subprocess !== undefined })
      if (subprocess !== undefined) {
        const environment = await subprocess.terminalEnvironment()
        const executable = await subprocess.resolveExecutable('uname')
        record('subprocess.probe', { environment, executable })
      }

      if (shell !== undefined) {
        const confined = await shell
          .run(shell.resolve({ command: 'echo blocked > /dsh-wsl-forbidden.txt', workdir: workspaceCwd }))
          .catch((error) => ({ exitCode: null, stderr: { text: String(error?.message ?? error) }, sandbox: null }))
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
        const readTool = await invoke('read', { file_path: '/tmp/dsh-wsl-selftest.txt' })
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

        // A tool resolves its policy from the session's logged permission state
        // (`tool-bash/src/index.ts:199`), which a programmatically created
        // session does not have. Recording one is what makes the tool layer's
        // confinement observable here.
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
      try {
        await agent?.dispose?.()
      } catch {
        // Disposal failure does not change what the checks observed.
      }
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
  workspaceFlow: async ({ distro, linuxPath = '/tmp' }) => {
    const registry = hostCtx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
    const target = await resolveLocation(linuxPath, distro)
    const listing = await listLinuxDir(target.distro, target.linuxPath)
    const facts = await checkLinuxPath(target.distro, target.linuxPath)
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
    const facts = await checkLinuxPath(target.distro, target.linuxPath)
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
        const candidate = resolved.id.startsWith(GENERATED_PREFIX)
          ? resolved.id
          : `${GENERATED_PREFIX}${resolved.id}`
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
   * List the generated WSL preset directories.
   * @returns {Promise<object>} the directory names found on disk.
   */
  listPresetDirectories: async () => {
    const root = join(dshHome(), '.agent-presets')
    const { readdir } = await import('node:fs/promises')
    let names = []
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('wsl-'))
        .map((entry) => entry.name)
    } catch {
      // An absent preset root simply means nothing has been generated yet.
      names = []
    }
    return { root, names }
  },

  /**
   * Read one generated preset back, for inspecting the transform in place.
   * @param {{ id: string }} params - preset directory id.
   * @returns {Promise<object>} the preset text.
   */
  readPreset: async ({ id }) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`readPreset: 非法的预设 id ${JSON.stringify(id)}`)
    }
    const path = join(dshHome(), '.agent-presets', id, 'agent.cordis.yml')
    return { path, text: await readFile(path, 'utf8') }
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
 * @param {{ routePath: string, developerTools: boolean }} config - resolved plugin config.
 */
export function apply(ctx, config) {
  hostCtx = ctx
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
      // preflight, and this route can run commands.
      const rejection = connectionOf(ctx).requestRejection(req)
      const developer = await isDeveloperCaller(req, config)
      if (rejection !== undefined && !developer) {
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
      try {
        sendJson(res, 200, { ok: true, value: await run(envelope.params ?? {}) })
      } catch (error) {
        // A rejected method is a request-level outcome, not a transport fault.
        sendJson(res, 400, {
          ok: false,
          code: 'method-failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), `wsl-desktop: POST ${config.routePath}`)
  // Preset generation is best-effort at boot: the route reports the outcome
  // instead of failing the whole composition when the roster is unavailable.
  // `inject` waits for the registry rather than racing boot order.
  ctx.inject(['agentPresets'], (scope) => {
    void defaultDistro().then(
      (distro) => refreshPresets(scope, distro),
      () => refreshPresets(scope, undefined),
    )
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
