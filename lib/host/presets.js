/**
 * Preset derivation helpers: variant ids, base rows, and the shell-spec seam.
 *
 * Extracted verbatim from `lib/index.js` (C3). Only the PURE helpers moved: the
 * two that materialise and refresh presets stay in the entry file because they
 * read and write the plugin's module-level state (`presetState`, `currentGeneration`,
 * `hostCtx`, `hostReady`). Moving those would mean shipping that state or injecting
 * it, which is a rewrite, not a move — see the plan's "Out of Scope".
 * @module dsh-wsl-desktop/host/presets
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './http.js'

/**
 * The prefix every generated variant id carries.
 *
 * Not exported from `index.js` by accident: the same literal is what the route
 * filters on, so a change here is a wire-visible change.
 */
export const GENERATED_PREFIX = 'wsl-'

/**
 * The stable id for one base preset's WSL variant.
 * @param {{ id: string }} preset - the resolved base preset.
 * @returns {string} the variant id.
 */
export function variantIdFor(preset) {
  return preset.id.startsWith(GENERATED_PREFIX) ? preset.id : `${GENERATED_PREFIX}${preset.id}`
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
export function sourceDirFor(id) {
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
export function basePluginsOf(presets, id) {
  const plugins = presets.definitions?.get?.(id)?.config?.plugins
  return Array.isArray(plugins) ? plugins : null
}

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
export function runShellSpec(shell, spec) {
  if (typeof shell.execute === 'function') return shell.execute(spec)
  return shell.run(spec).then((settled) => ({ result: async () => settled }))
}
