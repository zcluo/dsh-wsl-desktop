/**
 * Offline checks for the preset object pipeline (0.1.7-native).
 *
 * Presets are registered programmatically with entry OBJECTS; the suite
 * verifies the object transform (world-row removal, persona amendment,
 * relative-name rewrite, the wsl-world isolate group).
 * Run: node scripts/verify-preset.mjs
 */
import { buildVariantPlugins, buildWorldGroup, isHostWorldModule, WORLD_MODULE_NAMES, WORLD_ROWS, WSL_PERSONA_SENTENCE } from '../lib/wsl/preset.js'

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
// The fixture declares what must SURVIVE it and the assertion compares the whole
// kept list against that declaration. The previous form re-asked the matcher —
// `hostModuleLeak` called isHostWorldModule on the output — so the assertion was
// blind to exactly the spellings the matcher misses and could not fail on the
// defect it existed to catch (D6).
const minimalKept = ['persona', 'tool-web', 'wsl-world']
const minOut = buildVariantPlugins(minimalBase, MODULES)
check('the persistent-shell group is pruned empty and dropped', !minOut.plugins.some((row) => row.id === 'persistent-shell'), minOut.plugins.map((row) => row.id))
check('the variant keeps exactly the rows the fixture declares safe', JSON.stringify(minOut.plugins.map((row) => row.id)) === JSON.stringify(minimalKept), minOut.plugins.map((row) => row.id))
check('non-world rows survive the group prune', minOut.plugins.some((row) => row.id === 'tool-web'), minOut.plugins.map((row) => row.id))
check('the removal log names the pruned rows', minOut.removed.includes('persistent-pwsh') && minOut.removed.includes('pty') && minOut.removed.includes('persistent-shell'), minOut.removed)

console.log('\nhost-world spellings (D6 — the matcher missed a subpath of the same package)')
// What the variant must do with a specifier is a fact about the SPECIFIER, so it is
// declared here beside the spelling instead of asked of isHostWorldModule: a suite
// that asks the code under test what the answer is has no oracle at all, which is
// how the old leak assertion came to be blind to this exact defect.
// `survives: true` entries are the controls — a matcher that answered `true` for
// everything would pass every hostile row below and fail these.
const SPELLINGS = [
  // Live misses. The package's './src/*' subpath IS exported by the installed
  // @deepseek-ai packages measured here (dsh-tool-pwsh, dsh-tool-fs,
  // dsh-tool-fs-search, dsh-tool-bash, dsh-terminal, dsh-terminal-bash export
  // './src/*'; dsh-tool-str-replace-editor and the persistent pair do not), and the
  // harness's own tests name dsh-terminal-bash this way.
  { name: '@deepseek-ai/dsh-tool-pwsh/src/index.ts', survives: false },
  { name: '@deepseek-ai/dsh-tool-fs-search/src/glob.ts', survives: false },
  { name: '@deepseek-ai/dsh-terminal-bash/src/config.ts', survives: false },
  // Not loadable today, and asserted anyway: the predicate runs offline over
  // arbitrary, future and user-authored presets and cannot consult an exports map,
  // so its rule is package IDENTITY. A rule keyed to today's './src/*' map would be
  // blind to a future './lib/*' export — the same class of miss it is fixing.
  { name: '@deepseek-ai/dsh-tool-pwsh/lib/index.js', survives: false },
  { name: '@deepseek-ai/dsh-tool-pwsh-persistent/src/index.ts', survives: false },
  // Path and URL spellings. The exports map governs BARE subpath resolution only,
  // so a URL into the package's own directory is loadable whatever the map says.
  { name: 'file:///opt/x/@deepseek-ai/dsh-tool-pwsh/lib/index.js', survives: false },
  { name: 'file:///opt/x/@deepseek-ai/dsh-tool-pwsh.js', survives: false },
  { name: 'file:///opt/x/%40deepseek-ai/dsh-terminal/lib/index.js', survives: false },
  { name: 'E:\\node_modules\\@deepseek-ai\\dsh-tool-str-replace-editor\\lib\\index.js', survives: false },
  { name: '/opt/x/@deepseek-ai/dsh-terminal-bash/src/config.ts', survives: false },
  // Controls: the same shapes, naming packages that are NOT host-world. tool-bash
  // and tool-fs are deliberately absent from WORLD_MODULE_NAMES (their WSL forms
  // are re-mounted inside the wsl-world group), so a fix that widened the set
  // instead of resolving the package would redden here.
  { name: './tool-bootstrap.mjs', survives: true },
  { name: 'file:///E:/src/preset/tool-bootstrap.mjs', survives: true },
  { name: '@deepseek-ai/dsh-tool-web/src/index.ts', survives: true },
  { name: '@deepseek-ai/dsh-tool-bash/src/index.ts', survives: true },
  { name: '@deepseek-ai/dsh-tool-fs/src/index.ts', survives: true },
  { name: '@deepseek-ai/dsh-tool-pwsh-persistent-extra/src/index.ts', survives: true },
  { name: 'cordis:group', survives: true },
]
const spellingOut = buildVariantPlugins(SPELLINGS.map((entry, index) => ({ id: `spelling-${index}`, name: entry.name })), MODULES)
const keptSpellings = new Set(spellingOut.plugins.map((row) => row.name))
for (const { name, survives } of SPELLINGS) {
  check(`a ${survives ? 'non-world' : 'host-world'} row spelled as ${name} ${survives ? 'survives' : 'is pruned'}`,
    keptSpellings.has(name) === survives,
    { spelling: name, survives, kept: keptSpellings.has(name) })
}
// The rule forms a scoped package name from two adjacent path segments, which is
// only sound while every name it matches against IS one: an unscoped member added
// later would be silently unmatched.
check('every host-world module name is a scoped pair the rule can form',
  [...WORLD_MODULE_NAMES].every((name) => /^@[^/]+\/[^/]+$/u.test(name)), [...WORLD_MODULE_NAMES])

console.log('\nrows the classifier cannot read are reported, not assumed safe')
// `name` is typed as a plain string and the loader's expression nodes (`JsExpr`,
// `{ __jsExpr }`) appear on `id`/`disabled` — so this input is malformed rather
// than normal. It is still the one input the classifier has no verdict for, and a
// row kept WITHOUT a verdict is the leak shape D6 is about: reported, not assumed
// safe. Keeping it is deliberate — the transform must not guess a row out of a
// preset whose specifier it cannot read.
const unreadable = buildVariantPlugins([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
  { id: 'expression-row', name: { __jsExpr: "process.platform === 'win32'" } },
], MODULES)
check('a row whose name is not a specifier is recorded as unclassified',
  Array.isArray(unreadable.unclassified) && unreadable.unclassified.length === 1 && unreadable.unclassified[0]?.id === 'expression-row',
  unreadable.unclassified)
check('the unclassified row is kept rather than guessed away',
  unreadable.plugins.some((row) => row.id === 'expression-row'), unreadable.plugins.map((row) => row.id))
check('a fully readable preset reports nothing unclassified',
  Array.isArray(minOut.unclassified) && minOut.unclassified.length === 0, minOut.unclassified)
// The predicate is exported, so a throw here is a caller-visible failure of its
// own contract; caught so the suite reports it instead of dying mid-run.
let nonStringVerdict
try { nonStringVerdict = isHostWorldModule({ __jsExpr: 'x' }) } catch (error) { nonStringVerdict = error }
check('a non-string specifier is answered false, not thrown on', nonStringVerdict === false, nonStringVerdict)

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
// Under `config`, where the loader actually delivers it: a sibling `distro` key
// is read by nobody, so pinning THAT certified an inert shape while every
// provider silently ran with config.distro === undefined.
check('distro pinned under config on the three providers', ['subprocess-wsl', 'shell-wsl', 'fs-wsl'].every((id) => plugins.at(-1).config.find((row) => row.id === id)?.config?.distro === 'debian-dev'), plugins.at(-1).config.map((row) => [row.id, row.config?.distro]))
check('no provider carries a bare row-level distro', ['subprocess-wsl', 'shell-wsl', 'fs-wsl'].every((id) => plugins.at(-1).config.find((row) => row.id === id)?.distro === undefined), plugins.at(-1).config.map((row) => [row.id, row.distro]))
check('tool rows carry no distro pin', plugins.at(-1).config.filter((row) => row.id.startsWith('tool') || row.id === 'str-replace-editor').every((row) => row.config?.distro === undefined && row.distro === undefined), plugins.at(-1).config.map((row) => [row.id, row.config?.distro]))
check('editor re-mounted inside the group', plugins.at(-1).config.some((row) => row.id === 'str-replace-editor'), plugins.at(-1).config.map((row) => row.id))
check('persona amended with the path-dialect sentence', plugins[0].config.suffix.includes('wsl.localhost'), plugins[0].config.suffix?.slice(0, 80))
check('provider modules are absolute file paths', [MODULES.subprocessPath, MODULES.shellPath, MODULES.fsPath].every((p) => plugins.at(-1).config.some((row) => row.name === p)))

// The re-mounted tool rows must carry the operator's own config. Re-declaring
// them bare silently dropped whatever the base preset had set — a value honoured
// in the host world simply vanished in the WSL world — and nothing pinned it.
{
  const withConfig = [
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', config: { enableRunInBackground: false } },
    { id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor', config: { maxOutputChars: 16000 } },
  ]
  const carried = buildVariantPlugins(withConfig, { ...MODULES, distro: 'debian-dev' }).plugins.at(-1)
  const bashRow = carried.config.find((row) => row.id === 'tool-bash')
  const editorRow = carried.config.find((row) => row.id === 'str-replace-editor')
  check('the re-mounted tool rows keep the operator config',
    bashRow?.config?.enableRunInBackground === false && editorRow?.config?.maxOutputChars === 16000,
    carried.config.map((row) => [row.id, row.config]))
  check('the carried config is a copy, not the base preset object',
    bashRow !== undefined && bashRow.config !== withConfig[0].config,
    'the registry shares the base preset rows by reference, so the variant must not alias them')
}

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
