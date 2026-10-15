/**
 * Build the WSL agent preset from a shipped one.
 *
 * A session's execution world is chosen by its preset, not by a global router:
 * the model also needs a different tool dialect (bash rather than PowerShell),
 * and one process-wide provider could not vary that per session. This module
 * therefore rewrites a shipped preset's plugin entry OBJECTS — it removes the
 * rows that name the host execution world (by canonical id at the top level
 * and by PACKAGE NAME at every depth, whatever spelling the row uses) and appends
 * one `isolate` group that mounts the WSL world plus the tools that consume it.
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
 * Tool-family modules whose survival in a WSL preset is a RECORDED VERDICT.
 *
 * The complement of WORLD_MODULE_NAMES inside the tool family, and the reason it
 * exists: the removal rule is a closed list, so a tool-family row this plugin had
 * never seen was neither removed NOR reported — it was copied into the WSL variant
 * in silence, which is the leak shape this transform exists to prevent. A future
 * DSH release that adds a host-execution tool row would have leaked exactly there,
 * with every suite still green.
 *
 * Every name here was read off a shipped preset and judged world-agnostic: it
 * neither runs host commands nor reaches host files on the model's behalf. A row
 * outside BOTH sets is kept — the transform must not guess a row away from a preset
 * — but reported through `unclassified`, so the next upstream tool row is a
 * decision somebody makes rather than a leak nobody sees.
 */
export const VERDICTED_KEPT_MODULES = new Set([
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-command-goal',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-present',
])

/**
 * The tool / execution family, by package name.
 *
 * Narrow on purpose: it decides which rows need a VERDICT, and a family wide enough
 * to catch the persona, instruction, plan-mode or compaction rows would redden the
 * acceptance gate over rows whose survival was never in question.
 */
const TOOL_FAMILY = /^@deepseek-ai\/dsh-(?:tool-[a-z0-9-]+|terminal[a-z0-9-]*|skill-filesystem)$/u

/** Module extensions a specifier may carry where it names the package itself. */
const MODULE_SUFFIX = /\.(?:[cm]?js)$/u

/**
 * The path segments of one specifier, in every reading the loader accepts.
 *
 * A URL spelling is normalized by the loader (`new URL(name, base)`), which
 * percent-decodes it — `file:///x/%40deepseek-ai/…` and its literal-'@' twin name
 * the same file — so the decoded reading is searched too. A literal '%' that is
 * not a valid escape (a Windows directory may hold one) has no decoded reading,
 * and the raw spelling is then the only answer available: that is a reason to
 * search it, not a reason to give up on the row.
 * @param {string} specifier - the row's module name.
 * @returns {string[]} its segments, split on both path separators.
 */
function specifierSegments(specifier) {
  const readings = [specifier]
  if (specifier.includes('%')) {
    try {
      readings.push(decodeURIComponent(specifier))
    } catch {
      // Not an escape sequence: the raw spelling is the only reading.
    }
  }
  return readings.flatMap((reading) => reading.split(/[\\/]/u))
}

/**
 * Every `@scope/name` package reading a specifier carries.
 *
 * The one place the package identity is derived, shared by the removal predicate
 * and the verdict predicate so the two cannot disagree about which package a
 * spelling names — the drift that made the earlier basename match miss a subpath.
 * @param {unknown} specifier - the row's module name.
 * @returns {string[]} each scoped pair the specifier carries, in path order.
 */
function scopedPackages(specifier) {
  if (typeof specifier !== 'string' || specifier.length === 0) return []
  const segments = specifierSegments(specifier)
  const out = []
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (!segments[index].startsWith('@')) continue
    out.push(`${segments[index]}/${segments[index + 1].replace(MODULE_SUFFIX, '')}`)
  }
  return out
}

/**
 * Whether one row `name` loads a host-execution-world module.
 *
 * The identity that matters is the PACKAGE, not the file. Matching the path
 * basename (with `.js` stripped) missed a subpath spelling of the same package —
 * '@deepseek-ai/dsh-tool-pwsh/src/index.ts' has basename 'index.ts' — so the row
 * classified as safe and was copied into the WSL variant. For a SCOPED name that
 * branch could not fire at all: splitting on `/` leaves 'dsh-tool-pwsh', never the
 * '@scope/name' the set holds, so the doc comment above it claimed a file-URL and
 * path coverage the code never had. This resolves the package name instead — the
 * bare fast path first, then the '@scope/name' pair at any position of a path or
 * URL spelling.
 *
 * Every STRING gets a verdict derived from package identity, so there is no
 * "specifier I could not read -> keep" branch. A non-string is not a specifier at
 * all (the loader's `JsExpr` nodes appear on `id`/`disabled`; `name` is a string),
 * so it is answered `false` rather than thrown on — and `buildVariantPlugins`
 * records the rows it kept without a verdict instead of assuming them safe.
 * @param {unknown} name - the row's module name.
 * @returns {boolean} true when the module belongs to the host execution world.
 */
export function isHostWorldModule(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (WORLD_MODULE_NAMES.has(name)) return true
  return scopedPackages(name).some((pkg) => WORLD_MODULE_NAMES.has(pkg))
}

/**
 * Whether a row's module belongs to the family that needs a verdict.
 * @param {unknown} name - the row's module name.
 * @returns {boolean} true when the module is a tool-family package.
 */
export function isToolFamilyModule(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  return [name, ...scopedPackages(name)].some((candidate) => TOOL_FAMILY.test(candidate))
}

/**
 * Whether this plugin holds an explicit verdict for a row's module.
 *
 * True for both verdicts — removed (WORLD_MODULE_NAMES) and deliberately kept
 * (VERDICTED_KEPT_MODULES) — because the question it answers is "has this row been
 * decided?", not "is it dropped?".
 * @param {unknown} name - the row's module name.
 * @returns {boolean} true when the module carries a verdict.
 */
export function hasClassifierVerdict(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  return [name, ...scopedPackages(name)].some((candidate) => (
    WORLD_MODULE_NAMES.has(candidate) || VERDICTED_KEPT_MODULES.has(candidate)
  ))
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
 * @param {string} options.searchPath - module specifier of this plugin's WSL search tools.
 * @param {string | undefined} options.distro - distribution for paths that do not name one.
 * @param {boolean} options.includeEditor - whether the source preset mounted the string-replace editor.
 * @param {Map<string, object>} [options.toolConfig] - config the pruned host-world rows carried, keyed by row id.
 * @returns {object} the group entry.
 */
export function buildWorldGroup({ subprocessPath, shellPath, fsPath, searchPath, distro, includeEditor, toolConfig }) {
  // The pin belongs under `config`, NOT as a sibling row key. The loader hands a
  // plugin ONLY `options.config` (`registry.plugin(plugin, this.options.config, …)`),
  // and nothing relocates row keys into it — so as a bare `distro` key every
  // provider read `config.distro === undefined`. The consequences were silent:
  // a Linux-only workdir fell back to the machine's DEFAULT distribution, and the
  // fs fence derived its distro `/tmp` writable root from the literal string
  // "undefined" (joinWslUnc(undefined, '/tmp') does not throw), so a write the
  // docs/FS-FENCE.md grants was refused.
  const distroConfig = distro === undefined ? {} : { config: { distro } }
  /** Re-mount one host-world tool row, keeping the operator's own config for it. */
  const toolRow = (id, name) => {
    const carried = toolConfig?.get(id)
    return carried === undefined ? { id, name } : { id, name, config: carried }
  }
  const config = [
    { id: 'subprocess-wsl', name: subprocessPath, ...distroConfig },
    { id: 'shell-wsl', name: shellPath, ...distroConfig },
    { id: 'fs-wsl', name: fsPath, ...distroConfig },
    // No terminal registry row: the Web terminal controller spawns through
    // `agent.ctx.get('subprocess').spawnTerminal(...)`, so the realm's
    // subprocess provider already puts the PTY inside the distribution.
    // The operator's config for these rows travels with them: re-declaring them
    // bare silently dropped settings the base preset had set (a non-default
    // maxOutputChars on the editor, enableRunInBackground on tool-bash, …), so a
    // value honoured in the host world vanished in the WSL world.
    toolRow('tool-bash', '@deepseek-ai/dsh-tool-bash'),
    toolRow('tool-fs', '@deepseek-ai/dsh-tool-fs'),
    ...(includeEditor ? [toolRow('str-replace-editor', '@deepseek-ai/dsh-tool-str-replace-editor')] : []),
    // Searching is re-mounted the same way bash and fs are: the two NAMES the model already
    // knows, over a module of THIS plugin. It cannot be a carried host row — the host's
    // search package is removed by WORLD_MODULE_NAMES, so naming it back would recreate the
    // row the transform exists to drop (its argv[0] is a packaged Windows ripgrep binary).
    //
    // Both rows name ONE module, so the row's config is what tells that instance which tool
    // to register: toolRow() is deliberately NOT used here — it would reapply the pruned
    // host search row's config (a `sampleOverCapGlobResults`/caps shape this module does not
    // read, and whose `tool` field would be absent), failing the row at mount time instead of
    // mounting it. The tool name is also exactly `grep`/`glob`: callers invoke tools by name,
    // and the row id is a separate thing that happens to spell the same.
    { id: 'grep', name: searchPath, config: { tool: 'grep' } },
    { id: 'glob', name: searchPath, config: { tool: 'glob' } },
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
 *
 * The row is ALWAYS amended — a string field is extended when one exists and `suffix`
 * is created when none does — so this returns nothing. It used to document and return
 * "whether the row was amended" (always true, and its only caller discards it).
 */
function appendPersonaSuffixObject(row) {
  const config = row.config ?? (row.config = {})
  for (const field of ['suffix', 'text', 'prefix']) {
    if (typeof config[field] === 'string' && config[field].length > 0) {
      config[field] = `${config[field]} ${WSL_PERSONA_SENTENCE}`
      return
    }
  }
  config.suffix = WSL_PERSONA_SENTENCE
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
 * @param {string} options.searchPath - module specifier of this plugin's WSL search tools.
 * @param {string | undefined} options.distro - distribution for paths that do not name one.
 * @param {string | undefined} options.sourceDir - directory the source preset lives in.
 * @returns {{ plugins: object[], removed: string[], unclassified: { id: string | null, name: unknown }[] }} the variant rows, what was dropped, and the rows kept without a classifier verdict — an unreadable specifier, or a tool-family module that is neither removed nor verdicted-kept.
 */
export function buildVariantPlugins(basePlugins, { subprocessPath, shellPath, fsPath, searchPath, distro, sourceDir }) {
  const kept = []
  const removed = []
  /** Rows kept without a classifier verdict — both shapes the prune() branches record. */
  const unclassified = []
  let includeEditor = false
  /** Config carried by the pruned host-world tool rows, keyed by row id. */
  const toolConfig = new Map()

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
      // Cloned, not referenced: the registry shares the base preset's row
      // objects, and the variant must not alias the operator's config.
      if (row.config !== undefined) toolConfig.set(row.id, cloneRow({ config: row.config }).config)
      return null
    }
    if (typeof row.name !== 'string') {
      // The classifier has no verdict for this row's specifier, and a row kept
      // WITHOUT one is the leak shape this transform exists to prevent. Keeping it
      // is deliberate — the transform must not guess a row out of a preset whose
      // specifier it cannot read — but silence is not, so it is recorded and the
      // host can report it.
      unclassified.push({ id: row.id ?? null, name: row.name ?? null })
    } else if (isHostWorldModule(row.name)) {
      removed.push(row.id ?? row.name)
      // One evaluation, two uses: the predicate stood on adjacent lines, so a future
      // edit to one of them would silently leave the other behind.
      const isEditor = row.name.includes('str-replace-editor')
      if (isEditor) includeEditor = true
      if (isEditor && row.config !== undefined) {
        toolConfig.set('str-replace-editor', cloneRow({ config: row.config }).config)
      }
      return null
    } else if (isToolFamilyModule(row.name) && !hasClassifierVerdict(row.name)) {
      // Readable specifier, tool family, NO verdict: kept and reported. The removal
      // rule is a closed list, so without this branch a tool row this plugin has
      // never seen was copied into the WSL variant in silence — the leak shape this
      // transform exists to prevent, and the one a new upstream tool row would have
      // taken. Kept rather than removed for the same reason as the unreadable case
      // above: the transform must not guess a row away from a preset.
      unclassified.push({ id: row.id ?? null, name: row.name })
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
  kept.push(buildWorldGroup({ subprocessPath, shellPath, fsPath, searchPath, distro, includeEditor, toolConfig }))
  return { plugins: kept, removed, unclassified }
}
