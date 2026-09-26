/**
 * Build the WSL agent preset from a shipped one.
 *
 * A session's execution world is chosen by its preset, not by a global router:
 * the model also needs a different tool dialect (bash rather than PowerShell),
 * and one process-wide provider could not vary that per session. This module
 * therefore rewrites a shipped preset's plugin entry OBJECTS — it removes the
 * rows that name the host execution world (by canonical id at the top level
 * and by module name at every depth) and appends one `isolate` group that
 * mounts the WSL world plus the tools that consume it.
 *
 * The transform is pure over the loader's entry objects, so it is unit
 * testable without the harness (`scripts/verify-preset.mjs`). The historical
 * 0.1.6 YAML-text renderer lived and died with the disk-generation pipeline:
 * since 0.1.7 variants are registered programmatically via
 * `agentPresets.register({ id, name, plugins })` and the registry, not a
 * generated directory, is the source of truth.
 * @module dsh-wsl-desktop/wsl/preset
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Rows that name the host execution world and must not survive in a WSL preset. */
export const WORLD_ROWS = new Set([
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'str-replace-editor',
])

/**
 * Host-execution-world MODULE names, matched against a row's `name` at every
 * depth. Beyond the five canonical rows, the persistent/terminal family ships
 * NESTED in the minimal preset's `persistent-shell` group with non-canonical
 * ids — an enabled host PowerShell persistent tool inside a preset whose name
 * and persona assert distro-contained execution. `tool-bash`/`tool-fs` are
 * deliberately absent: those names are re-mounted in their WSL form inside
 * the wsl-world group; their host-world forms are removed by id.
 */
export const WORLD_MODULE_NAMES = new Set([
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-terminal',
])

/**
 * Whether one row `name` loads a host-execution-world module. Matches the
 * bare package specifier and file-URL/path spellings ending in the package
 * basename (with or without .js).
 * @param {string} name - the row's module name.
 * @returns {boolean} true when the module belongs to the host execution world.
 */
export function isHostWorldModule(name) {
  if (WORLD_MODULE_NAMES.has(name)) return true
  const base = name.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.js$/u, '')
  return WORLD_MODULE_NAMES.has(stem)
}

/**
 * Build the `wsl-world` isolate group as a plugin-entry OBJECT.
 *
 * 0.1.7 presets are registered programmatically
 * (`agentPresets.register({ id, name, plugins })`) with entry objects rather
 * than written as YAML files — the group's shape mirrors the loader's entry
 * options: `{ id?, name, group?, isolate?, config? }`.
 * @param {object} options - generation options.
 * @param {string} options.subprocessPath - module specifier of the WSL subprocess provider.
 * @param {string} options.shellPath - module specifier of the WSL shell executor.
 * @param {string} options.fsPath - module specifier of the WSL filesystem provider.
 * @param {string | undefined} options.distro - distribution for paths that do not name one.
 * @param {boolean} options.includeEditor - whether the source preset mounted the string-replace editor.
 * @returns {object} the group entry.
 */
export function buildWorldGroup({ subprocessPath, shellPath, fsPath, distro, includeEditor }) {
  const distroConfig = distro === undefined ? {} : { distro }
  const config = [
    { id: 'subprocess-wsl', name: subprocessPath, ...distroConfig },
    { id: 'shell-wsl', name: shellPath, ...distroConfig },
    { id: 'fs-wsl', name: fsPath, ...distroConfig },
    // No terminal registry row: the Web terminal controller spawns through
    // `agent.ctx.get('subprocess').spawnTerminal(...)`, so the realm's
    // subprocess provider already puts the PTY inside the distribution.
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    ...(includeEditor ? [{ id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor' }] : []),
  ]
  return {
    id: 'wsl-world',
    name: 'cordis:group',
    group: true,
    isolate: { shell: true, fs: true, subprocess: true },
    config,
  }
}

/**
 * The sentence appended to the preset's persona.
 *
 * A session's recorded cwd is the UNC spelling (`\\wsl.localhost\<distro>\…`)
 * because that is the only form the Windows-side harness accepts, while the
 * shell in that session reports a Linux path. Without this the model is told one
 * spelling and observes another.
 */
export const WSL_PERSONA_SENTENCE = 'Paths under \\\\wsl.localhost\\<distro> are Windows spellings of directories inside that WSL distribution — \\\\wsl.localhost\\<distro>\\home\\me is /home/me there. Every command runs in the distribution, so use Linux paths, and reach Windows files as /mnt/<drive>/…'

/**
 * Append the WSL path-dialect sentence to a persona row OBJECT.
 * @param {object} row - the persona entry.
 * @returns {boolean} whether the row was amended.
 */
function appendPersonaSuffixObject(row) {
  const config = row.config ?? (row.config = {})
  for (const field of ['suffix', 'text', 'prefix']) {
    if (typeof config[field] === 'string' && config[field].length > 0) {
      config[field] = `${config[field]} ${WSL_PERSONA_SENTENCE}`
      return true
    }
  }
  config.suffix = WSL_PERSONA_SENTENCE
  return true
}

/**
 * Clone one entry row deeply enough to transform it safely. Group rows carry
 * their children under `config` as an ARRAY (recursive tree), so the clone
 * must preserve arrays as arrays — a naive `{...config}` spread would turn a
 * group's child list into an index-keyed object and the entry-list validator
 * would refuse the row ("must hold a list of plugin rows").
 * @param {object} row - the row to clone.
 * @returns {object} the cloned row.
 */
function cloneRow(row) {
  const clone = { ...row }
  if (Array.isArray(clone.config)) {
    clone.config = clone.config.map((child) => (child !== null && typeof child === 'object' ? cloneRow(child) : child))
  } else if (clone.config !== null && typeof clone.config === 'object') {
    clone.config = { ...clone.config }
  }
  return clone
}

/**
 * Transform a base preset's plugin ENTRY OBJECTS into the WSL variant's list.
 *
 * Drop the rows that name the host execution world (id fast path, module-name
 * match at every depth), amend the persona with the path-dialect sentence,
 * rewrite relative row names against the source directory, and append the
 * `wsl-world` isolate group.
 * @param {readonly object[]} basePlugins - the base preset's plugin rows.
 * @param {object} options - generation options.
 * @param {string} options.subprocessPath - module specifier of the WSL subprocess provider.
 * @param {string} options.shellPath - module specifier of the WSL shell executor.
 * @param {string} options.fsPath - module specifier of the WSL filesystem provider.
 * @param {string | undefined} options.distro - distribution for paths that do not name one.
 * @param {string | undefined} options.sourceDir - directory the source preset lives in.
 * @returns {{ plugins: object[], removed: string[] }} the variant rows and what was dropped.
 */
export function buildVariantPlugins(basePlugins, { subprocessPath, shellPath, fsPath, distro, sourceDir }) {
  const kept = []
  const removed = []
  let includeEditor = false

  /**
   * Recursively prune host-execution-world rows from one entry. Classified by
   * module name at EVERY depth (row ids are optional and arbitrary — the
   * shipped minimal preset nests enabled host PowerShell rows with
   * non-canonical ids inside a group), with the id fast path kept for
   * canonical rows. A group whose children are all pruned is dropped: it
   * holds nothing. Returns the cloned+pruned row, or null when removed.
   */
  const prune = (row) => {
    if (row === null || typeof row !== 'object') return row
    if (row.id !== undefined && WORLD_ROWS.has(row.id)) {
      removed.push(row.id)
      if (row.id === 'str-replace-editor') includeEditor = true
      return null
    }
    if (typeof row.name === 'string' && isHostWorldModule(row.name)) {
      removed.push(row.id ?? row.name)
      if (typeof row.name === 'string' && row.name.includes('str-replace-editor')) includeEditor = true
      return null
    }
    // The registry stores the caller's objects BY REFERENCE — mutating a row
    // here would pollute the shared base definition. Clone per row;
    // structuredClone is not safe: loader rows may carry JsExpr nodes.
    const clone = cloneRow(row)
    if (clone.group === true && Array.isArray(clone.config)) {
      const children = []
      for (const child of clone.config) {
        const prunedChild = prune(child)
        if (prunedChild !== null) children.push(prunedChild)
      }
      if (children.length === 0) {
        removed.push(clone.id ?? clone.name ?? 'empty group')
        return null
      }
      clone.config = children
    }
    if (clone.id === 'persona') appendPersonaSuffixObject(clone)
    if (sourceDir !== undefined && typeof clone.name === 'string' && clone.name.startsWith('./')) {
      // The loader imports row names as URLs / bare specifiers; a relative
      // row resolves to a file:// URL spelling of its absolute location.
      clone.name = pathToFileURL(join(sourceDir, clone.name.slice(2))).href
    }
    return clone
  }

  for (const row of basePlugins) {
    const pruned = prune(row)
    if (pruned !== null) kept.push(pruned)
  }
  kept.push(buildWorldGroup({ subprocessPath, shellPath, fsPath, distro, includeEditor }))
  return { plugins: kept, removed }
}
