/**
 * Offline checks for the preset object pipeline (0.1.7-native).
 *
 * Presets are registered programmatically with entry OBJECTS; the suite
 * verifies the object transform (world-row removal, persona amendment,
 * relative-name rewrite, the wsl-world isolate group).
 * Run: node scripts/verify-preset.mjs
 */
import { buildVariantPlugins, buildWorldGroup, isHostWorldModule, WORLD_ROWS, WSL_PERSONA_SENTENCE } from '../lib/wsl/preset.js'

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log(`  PASS  ${name}`); return }
  failed += 1
  console.log(`  FAIL  ${name}`)
  if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 300)}`)
}

const MODULES = {
  subprocessPath: 'file:///live/lib/wsl/subprocess.js',
  shellPath: 'file:///live/lib/wsl/shell.js',
  fsPath: 'file:///live/lib/wsl/fs.js',
}
console.log('\nwsl-minimal persistent-shell group (shipped-prevalence regression)')
// The shipped minimal preset nests ENABLED host PowerShell persistent rows
// with non-canonical ids inside a `persistent-shell` group — the exact shape
// the id-keyed top-level removal leaked into wsl-minimal.
const minimalBase = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
  { id: 'persistent-shell', name: 'cordis:group', group: true, isolate: { terminals: true }, config: [
    { id: 'persistent-bash', name: '@deepseek-ai/dsh-tool-bash-persistent', disabled: '!!js process.platform !== "linux"' },
    { id: 'persistent-pwsh', name: '@deepseek-ai/dsh-tool-pwsh-persistent' },
    { id: 'terminal-bash', name: '@deepseek-ai/dsh-terminal-bash' },
    { id: 'pty', name: '@deepseek-ai/dsh-terminal' },
  ] },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
]
const minOut = buildVariantPlugins(minimalBase, MODULES)
const hostModuleLeak = (rows) => rows.some((row) => (typeof row?.name === 'string' && isHostWorldModule(row.name)) || (Array.isArray(row?.config) && hostModuleLeak(row.config)))
check('the persistent-shell group is pruned empty and dropped', !minOut.plugins.some((row) => row.id === 'persistent-shell'), minOut.plugins.map((row) => row.id))
check('no host-world module survives anywhere in the variant', !hostModuleLeak(minOut.plugins), minOut.plugins)
check('non-world rows survive the group prune', minOut.plugins.some((row) => row.id === 'tool-web'), minOut.plugins.map((row) => row.id))
check('the removal log names the pruned rows', minOut.removed.includes('persistent-pwsh') && minOut.removed.includes('pty') && minOut.removed.includes('persistent-shell'), minOut.removed)

const basePlugins = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'You are a coding agent.' } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { backend: 'fs-local' } },
  { id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
]

console.log('\nobject transform')
const { plugins, removed } = buildVariantPlugins(basePlugins, { ...MODULES, distro: 'debian-dev' })
check('host world rows removed', removed.includes('tool-pwsh') && removed.includes('tool-fs-search'), removed)
check('non-world rows survive', plugins.some((row) => row.id === 'tool-web'), plugins.map((row) => row.id))
check('wsl-world group appended', plugins.at(-1)?.id === 'wsl-world', plugins.at(-1)?.id)
check('group isolates shell/fs/subprocess', JSON.stringify(plugins.at(-1)?.isolate) === '{"shell":true,"fs":true,"subprocess":true}', plugins.at(-1)?.isolate)
check('group carries the three providers', ['subprocess-wsl', 'shell-wsl', 'fs-wsl'].every((id) => plugins.at(-1).config.some((row) => row.id === id)), plugins.at(-1).config.map((row) => row.id))
check('distro pinned on the three providers', ['subprocess-wsl', 'shell-wsl', 'fs-wsl'].every((id) => plugins.at(-1).config.find((row) => row.id === id)?.distro === 'debian-dev'), plugins.at(-1).config.map((row) => [row.id, row.distro]))
check('tool rows carry no distro pin', plugins.at(-1).config.filter((row) => row.id.startsWith('tool') || row.id === 'str-replace-editor').every((row) => row.distro === undefined), plugins.at(-1).config.map((row) => [row.id, row.distro]))
check('editor re-mounted inside the group', plugins.at(-1).config.some((row) => row.id === 'str-replace-editor'), plugins.at(-1).config.map((row) => row.id))
check('persona amended with the path-dialect sentence', plugins[0].config.suffix.includes('wsl.localhost'), plugins[0].config.suffix?.slice(0, 80))
check('provider modules are absolute file paths', [MODULES.subprocessPath, MODULES.shellPath, MODULES.fsPath].every((p) => plugins.at(-1).config.some((row) => row.name === p)))

console.log('\ntransform purity (the registry shares row objects by reference)')
const sharedBase = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'Base.' } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
]
const first = buildVariantPlugins(sharedBase, MODULES)
const second = buildVariantPlugins(sharedBase, MODULES)
const baseUntouched = sharedBase[0].config.suffix === 'Base.'
const sentenceCount = (suffix) => (suffix.match(new RegExp(WSL_PERSONA_SENTENCE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
check('base definition not polluted by the transform', baseUntouched, sharedBase[0].config.suffix)
check('re-registration does not compound the persona sentence', sentenceCount(second.plugins[0].config.suffix) === 1, second.plugins[0].config.suffix)
check('both variants carry exactly one sentence', sentenceCount(first.plugins[0].config.suffix) === 1 && sentenceCount(second.plugins[0].config.suffix) === 1)
check('world-row removal does not mutate the base array', sharedBase.length === 2 && sharedBase.some((row) => row.id === 'tool-pwsh'), sharedBase.map((row) => row.id))

console.log('\ngroup rows survive the clone (config arrays stay arrays)')
const withGroup = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'Base.' } },
  { id: 'team', name: 'cordis:group', group: true, config: [{ id: 'inner', name: '@deepseek-ai/dsh-tool-web' }] },
]
const groupOut = buildVariantPlugins(withGroup, MODULES)
const carried = groupOut.plugins.find((row) => row.id === 'team')
check('group row kept with its child list intact', carried !== undefined && Array.isArray(carried.config) && carried.config.some((child) => child.id === 'inner'), carried)
check('group child was cloned, not shared', carried.config[0] !== withGroup[1].config[0])
check('group row passes the entry-list shape rules', carried.group === true && Array.isArray(carried.config))

console.log('\nrelative name rewrite')
const rel = buildVariantPlugins(
  [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} }, { id: 'custom', name: './tool-bootstrap.mjs' }],
  { ...MODULES, distro: undefined, sourceDir: 'E:/src/preset' },
)
check('relative row name rewritten to a file URL under sourceDir', rel.plugins.some((row) => row.name === 'file:///E:/src/preset/tool-bootstrap.mjs'), rel.plugins.map((row) => row.name))
check('distro omitted when unpinned', rel.plugins.at(-1).config.every((row) => row.distro === undefined))

console.log('\nbuildWorldGroup direct')
const group = buildWorldGroup({ ...MODULES, distro: undefined, includeEditor: false })
check('group shape', group.group === true && group.name === 'cordis:group' && Array.isArray(group.config), group)

console.log('\nworld rows constant')
check('world rows exclude the WSL tool ids', !WORLD_ROWS.has('tool-bash-wsl') && WORLD_ROWS.has('tool-pwsh'))
check('persona sentence names the UNC spelling', WSL_PERSONA_SENTENCE.includes('wsl.localhost'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
