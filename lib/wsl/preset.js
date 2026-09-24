/**
 * Build the WSL agent preset from a shipped one.
 *
 * A session's execution world is chosen by its preset, not by a global router:
 * the model also needs a different tool dialect (bash rather than PowerShell),
 * and one process-wide provider could not vary that per session. This module
 * therefore rewrites a shipped preset's entry list — it removes the rows that
 * name the host execution world and appends one `isolate` group that mounts the
 * WSL world plus the tools that consume it.
 *
 * The transform is pure text over the loader's entry list, so it is unit
 * testable without the harness. Rows are matched by their top-level `- id:`
 * boundary; only top-level (two-space indented) keys are rewritten, so a nested
 * entry inside a group's `config:` is never touched.
 * @module dsh-wsl-desktop/wsl/preset
 */

import { join } from 'node:path'

/**
 * Decide what happens to one directory inside this plugin's preset namespace.
 *
 * The namespace is a name prefix, so it is shared with anything a user chooses
 * to call `wsl-…`. Only a directory this plugin wrote — one carrying its marker
 * — may be withdrawn; an unmarked one is the user's and is reported instead of
 * deleted.
 * @param {{ name: string, prefix: string, expected: boolean, marked: boolean }} entry - one directory.
 * @returns {'ignore' | 'keep' | 'withdraw' | 'unmanaged'} the disposition.
 */
export function sweepDecision({ name, prefix, expected, marked }) {
  if (!name.startsWith(prefix)) return 'ignore'
  if (expected) return 'keep'
  return marked ? 'withdraw' : 'unmanaged'
}

/** Rows that name the host execution world and must not survive in a WSL preset. */
export const WORLD_ROWS = new Set([
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'str-replace-editor',
])

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
 * Transform a base preset's plugin ENTRY OBJECTS into the WSL variant's list.
 *
 * Same semantics as the historical YAML rewrite: drop the rows that name the
 * host execution world, amend the persona with the path-dialect sentence,
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

export function buildVariantPlugins(basePlugins, { subprocessPath, shellPath, fsPath, distro, sourceDir }) {
  const kept = []
  const removed = []
  let includeEditor = false
  for (const row of basePlugins) {
    if (row === null || typeof row !== 'object') {
      kept.push(row)
      continue
    }
    if (row.id !== undefined && WORLD_ROWS.has(row.id)) {
      removed.push(row.id)
      if (row.id === 'str-replace-editor') includeEditor = true
      continue
    }
    // The registry stores the caller's objects BY REFERENCE — mutating a row
    // here would pollute the shared base definition (the persona sentence
    // would compound on every re-registration). Clone per row; structuredClone
    // is not safe: loader rows may carry JsExpr nodes.
    const clone = cloneRow(row)
    if (clone.id === 'persona') appendPersonaSuffixObject(clone)
    if (sourceDir !== undefined && typeof clone.name === 'string' && clone.name.startsWith('./')) {
      clone.name = join(sourceDir, clone.name.slice(2)).replace(/\\/g, '/')
    }
    kept.push(clone)
  }
  kept.push(buildWorldGroup({ subprocessPath, shellPath, fsPath, distro, includeEditor }))
  return { plugins: kept, removed }
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
 * Append the WSL sentence to a persona row's text field.
 *
 * Handles the three shapes a preset may use: an inline `suffix`, a block-scalar
 * `suffix`, and a persona that carries only `text`. A row with none of them
 * gains a `suffix` under `config:`.
 * @param {{ id: string | null, lines: string[] }} block - the persona block.
 * @returns {boolean} whether the block was amended.
 */
export function appendPersonaSuffix(block) {
  const lines = block.lines
  const configIndex = lines.findIndex((line) => /^(\s*)config:\s*$/.test(line))
  if (configIndex === -1) return false
  const configIndent = (/^(\s*)config:\s*$/.exec(lines[configIndex])?.[1] ?? '').length
  const childIndent = configIndent + 2
  const child = new RegExp(`^ {${childIndent}}(suffix|text|prefix):(.*)$`)
  for (const field of ['suffix', 'text', 'prefix']) {
    const index = lines.findIndex((line, at) => at > configIndex && child.test(line) && new RegExp(`^ {${childIndent}}${field}:`).test(line))
    if (index === -1) continue
    const value = (new RegExp(`^ {${childIndent}}${field}:(.*)$`).exec(lines[index])?.[1] ?? '').trim()
    // A block scalar (`>-`, `|`, `|-`, …) continues on the following lines.
    if (value === '' || /^[|>][-+]?\d*$/.test(value)) {
      lines.splice(index + 1, 0, `${' '.repeat(childIndent + 2)}${WSL_PERSONA_SENTENCE}`)
    } else if ((value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      || (value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      // A quoted scalar must grow INSIDE its quotes; appending after a closing
      // quote would produce invalid YAML.
      const quote = value[0]
      const sentence = quote === "'" ? WSL_PERSONA_SENTENCE.replace(/'/g, "''") : WSL_PERSONA_SENTENCE
      lines[index] = `${lines[index].slice(0, -1)} ${sentence}${quote}`
    } else {
      lines[index] = `${lines[index]} ${WSL_PERSONA_SENTENCE}`
    }
    return true
  }
  // No text field of its own: gain one as the first key under `config:`.
  lines.splice(configIndex + 1, 0, `${' '.repeat(childIndent)}suffix: ${WSL_PERSONA_SENTENCE}`)
  return true
}

/**
 * Quote one scalar for a YAML single-quoted value.
 * @param {string} value - the raw value.
 * @returns {string} the quoted scalar.
 */
function quote(value) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Split an entry list into top-level blocks.
 * @param {string} source - the loader entry list.
 * @returns {Array<{ id: string | null, lines: string[] }>} the blocks in order.
 */
export function splitBlocks(source) {
  const blocks = []
  let current = { id: null, lines: [] }
  for (const line of source.split('\n')) {
    const match = /^- id:\s*(.+?)\s*$/.exec(line)
    if (match !== null) {
      if (current.lines.length > 0 || current.id !== null) blocks.push(current)
      // Normalise the captured id so every YAML spelling of the same row
      // resolves to one canonical id for world-row removal: strip trailing
      // comments, YAML anchors (`&a name`), and surrounding quotes.
      let id = match[1].replace(/\s+#.*$/, '').trim()
      if (id.startsWith('&')) id = id.replace(/^&\S+\s+/, '')
      id = id.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      current = { id, lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  blocks.push(current)
  return blocks
}

/**
 * Build the `wsl-world` group that carries the WSL execution world.
 *
 * The group isolates every service a row inside it publishes, so one session
 * can run in a distribution while the process keeps serving Windows sessions.
 * `subprocess-wsl` precedes the consumers that inject it: the shell executor
 * hands it a Linux argv and lets the provider own the `wsl.exe` wrapper.
 * @param {object} options - generation options.
 * @param {string} options.subprocessPath - module specifier of the WSL subprocess provider.
 * @param {string} options.shellPath - module specifier of the WSL shell executor.
 * @param {string} options.fsPath - module specifier of the WSL filesystem provider.
 * @param {string | undefined} options.distro - distribution for paths that do not name one.
 * @param {boolean} options.includeEditor - whether the source preset mounted the string-replace editor.
 * @returns {string[]} the group's YAML lines.
 */
function worldGroup({ subprocessPath, shellPath, fsPath, distro, includeEditor }) {
  const distroConfig = distro === undefined ? [] : ['      config:', `        distro: ${quote(distro)}`]
  return [
    '- id: wsl-world',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    shell: true',
    '    fs: true',
    '    subprocess: true',
    '  config:',
    '    - id: subprocess-wsl',
    `      name: ${quote(subprocessPath)}`,
    ...distroConfig,
    '    - id: shell-wsl',
    `      name: ${quote(shellPath)}`,
    ...distroConfig,
    '    - id: fs-wsl',
    `      name: ${quote(fsPath)}`,
    ...distroConfig,
    // No terminal registry row: the Web terminal controller spawns through
    // `agent.ctx.get('subprocess').spawnTerminal(...)`
    // (packages/api/terminal-controller/src/index.ts:333,346), so the realm's
    // subprocess provider already puts the PTY inside the distribution. A
    // `terminals` realm would only serve the model's persistent-shell tool,
    // which this preset does not mount.
    '    - id: tool-bash',
    "      name: '@deepseek-ai/dsh-tool-bash'",
    '    - id: tool-fs',
    "      name: '@deepseek-ai/dsh-tool-fs'",
    ...includeEditor
      ? ['    - id: str-replace-editor', "      name: '@deepseek-ai/dsh-tool-str-replace-editor'"]
      : [],
  ]
}

/**
 * Rewrite relative row names so they still resolve from the variant directory.
 *
 * A preset may name a row by a path relative to its own directory
 * (`./tool-bootstrap.mjs`). The variant lives in a different directory, so the
 * relative spelling would resolve against the wrong base and the preset would
 * fail to mount.
 * @param {{ lines: string[] }} block - one top-level entry.
 * @param {string} sourceDir - directory of the preset being derived from.
 * @returns {number} how many names were rewritten.
 */
export function rewriteRelativeNames(block, sourceDir) {
  let rewritten = 0
  block.lines = block.lines.map((line) => {
    const match = /^(\s*)name:\s*['"]?\.\/([^'"]+)['"]?\s*$/.exec(line)
    if (match === null) return line
    const absolute = join(sourceDir, match[2]).replace(/\\/g, '/')
    rewritten += 1
    return `${match[1]}name: '${absolute}'`
  })
  return rewritten
}

/**
 * Rewrite one shipped preset into its WSL variant.
 *
 * The whole preset is wrapped in the realm rather than sitting beside it. A
 * sibling group would leave every consumer outside it — a persistent-shell
 * group, a hand-written tool row — resolving the host's providers, which is the
 * Windows execution world; wrapping makes the realm the preset's own scope, so
 * every row resolves the WSL providers. Rows that hardcode Windows tooling are
 * dropped and re-mounted in their WSL form.
 * @param {string} source - the shipped preset's `agent.cordis.yml` text.
 * @param {object} options - generation options.
 * @param {string} options.subprocessPath - module specifier of the WSL subprocess provider.
 * @param {string} options.shellPath - module specifier of the WSL shell executor.
 * @param {string} options.fsPath - module specifier of the WSL filesystem provider.
 * @param {string} [options.distro] - distribution for paths that do not name one.
 * @param {string} [options.sourceDir] - directory the source preset lives in.
 * @returns {{ yaml: string, removed: string[], added: boolean }} the rewritten preset and what changed.
 */
export function renderWslPreset(source, options) {
  const blocks = splitBlocks(source)
  const kept = []
  const removed = []
  let includeEditor = false
  let personaAmended = false
  for (const block of blocks) {
    if (block.id !== null && WORLD_ROWS.has(block.id)) {
      removed.push(block.id)
      if (block.id === 'str-replace-editor') includeEditor = true
      continue
    }
    if (block.id === 'persona') personaAmended = appendPersonaSuffix(block)
    if (options.sourceDir !== undefined) rewriteRelativeNames(block, options.sourceDir)
    kept.push(block)
  }
  // `split('\n')` consumed the separators, so blocks rejoin with one newline;
  // joining with '' would glue the next `- id:` onto the previous line.
  const body = kept.map((block) => block.lines.join('\n')).join('\n')
  // One level down: the original entry list becomes the group's `config` list.
  const nested = body
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `    ${line}`))
    .join('\n')
  const group = worldGroup({
    subprocessPath: options.subprocessPath,
    shellPath: options.shellPath,
    fsPath: options.fsPath,
    distro: options.distro,
    includeEditor,
  })
  return {
    yaml: `${group.join('\n')}\n${nested}\n`,
    removed,
    added: true,
  }
}

/**
 * Render the preset's display metadata.
 * @param {{ name: string, description: string }} metadata - display name and description.
 * @returns {string} the `preset.yml` text.
 */
export function renderPresetMetadata(metadata) {
  // Quote only when the value contains characters that YAML would
  // misinterpret; plain alphanumeric + CJK + basic punctuation stays unquoted.
  const scalar = (value) => {
    const s = String(value)
    if (/^[\w.\-\u4e00-\u9fff\u3000-\u303f\u00b7(): ]+$/u.test(s) && !/^\s|\s$/.test(s) && !s.includes(': ') && !s.startsWith('#')) return s
    return `'${s.replace(/'/g, "''")}'`
  }
  return `name: ${scalar(metadata.name)}\ndescription: ${scalar(metadata.description)}\n`
}
