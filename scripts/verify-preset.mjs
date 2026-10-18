/**
 * Offline checks for the preset object pipeline (0.1.7-native).
 *
 * Presets are registered programmatically with entry OBJECTS; the suite
 * verifies the object transform (world-row removal, persona amendment,
 * relative-name rewrite, the wsl-world isolate group).
 * Run: node scripts/verify-preset.mjs
 */
import { makeChecker } from './suite-shell.mjs'
import { detailText } from './detail.mjs'
import { buildVariantPlugins, buildWorldGroup, hasClassifierVerdict, isHostWorldModule, isToolFamilyModule, VERDICTED_KEPT_MODULES, WORLD_MODULE_NAMES, WORLD_ROWS, WSL_PERSONA_SENTENCE } from '../lib/wsl/preset.js'

const checker = makeChecker({
  pass: 'PASS',
  detail: (value) => detailText(value).slice(0, 300),
})
const { check } = checker

const MODULES = {
  subprocessPath: 'file:///live/lib/wsl/subprocess.js',
  shellPath: 'file:///live/lib/wsl/shell.js',
  fsPath: 'file:///live/lib/wsl/fs.js',
  searchPath: 'file:///live/lib/wsl/search-tool.js',
  sandboxPath: 'file:///live/lib/wsl/sandbox.js',
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
  // The other half of that pair, and the reason it is asserted HERE rather than only in
  // the object transform below: the host's search package is pruned by identity, and the
  // realm's replacement is a module of THIS plugin — a spelling the classifier has no
  // verdict for and must therefore keep. A rule that widened WORLD_MODULE_NAMES to the
  // search family (instead of re-mounting a row of our own) would redden exactly here.
  { name: 'file:///E:/src/dsh-wsl-desktop/lib/wsl/search-tool.js', survives: true },
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
  // Controls: the same shapes, naming packages that are NOT host-world. `tool-bash` and
  // `tool-fs` are deliberately absent from WORLD_MODULE_NAMES, and the reason is NOT that a
  // WSL form is re-mounted under the same package name: `tool-fs` is re-mounted from
  // `@deepseek-ai/dsh-tool-fs`, but the realm's shell owner is
  // `@deepseek-ai/dsh-tool-bash-persistent`, so a base row naming
  // `@deepseek-ai/dsh-tool-bash` under a NON-canonical id survives the transform (it is
  // reported as unclassified, not removed) and would register a second `bash`. What keeps the
  // realm's single owner is the row set in `lib/wsl/preset.js`, pinned by the module-keyed
  // owner check above; the transform's removal list is a separate, narrower decision. A fix
  // that widened this set instead of resolving the package would redden these controls.
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

console.log('\ntool-family rows without a verdict are reported, not copied in silence')
// The removal rule is a closed list, so before this branch a tool row this plugin
// had never seen was neither removed NOR reported — copied into the WSL variant in
// silence. That is the shape a NEW upstream tool row would take, and the reason the
// live gate can now assert on the report instead of trusting the removal log.
const novel = buildVariantPlugins([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
  { id: 'tool-newshell', name: '@deepseek-ai/dsh-tool-newshell' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
], MODULES)
check('a tool-family row with no verdict is recorded as unclassified',
  novel.unclassified.length === 1 && novel.unclassified[0]?.id === 'tool-newshell',
  novel.unclassified)
check('the unverdicted tool row is kept rather than guessed away',
  novel.plugins.some((row) => row.id === 'tool-newshell'), novel.plugins.map((row) => row.id))
check('a verdicted-kept tool row is NOT reported',
  !novel.unclassified.some((row) => row.id === 'tool-web'), novel.unclassified)
check('the subpath spelling of an unverdicted tool row is caught too',
  isToolFamilyModule('@deepseek-ai/dsh-tool-newshell/src/index.ts'),
  'the package identity has to be derived, not the basename')
check('a world row is verdicted by the removal set',
  hasClassifierVerdict('@deepseek-ai/dsh-tool-pwsh') && hasClassifierVerdict('@deepseek-ai/dsh-terminal-bash'),
  'WORLD_MODULE_NAMES is a verdict too')
check('a verdicted-kept row is verdicted by the kept set',
  hasClassifierVerdict('@deepseek-ai/dsh-tool-web')
  && [...VERDICTED_KEPT_MODULES].every((module) => hasClassifierVerdict(module)),
  'every kept verdict resolves through the predicate')
check('a non-tool module needs no verdict',
  !isToolFamilyModule('@deepseek-ai/dsh-persona') && !isToolFamilyModule('@deepseek-ai/dsh-compaction-basic'),
  'the family is narrow on purpose: a wide one would redden the gate over rows never in question')
check('a non-string specifier is answered false by the family predicate, not thrown on',
  (() => { try { return isToolFamilyModule({ __jsExpr: 'x' }) === false } catch { return false } })(),
  'same contract as isHostWorldModule')

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
check('group isolates shell/fs/subprocess/terminals/sandbox', JSON.stringify(plugins.at(-1)?.isolate) === '{"shell":true,"fs":true,"subprocess":true,"terminals":true,"sandbox":true}', plugins.at(-1)?.isolate)
check('group carries the four providers', ['subprocess-wsl', 'shell-wsl', 'fs-wsl', 'sandbox-wsl'].every((id) => plugins.at(-1).config.some((row) => row.id === id)), plugins.at(-1).config.map((row) => row.id))
// Under `config`, where the loader actually delivers it: a sibling `distro` key
// is read by nobody, so pinning THAT certified an inert shape while every
// provider silently ran with config.distro === undefined.
check('distro pinned under config on the four providers', ['subprocess-wsl', 'shell-wsl', 'fs-wsl', 'sandbox-wsl'].every((id) => plugins.at(-1).config.find((row) => row.id === id)?.config?.distro === 'debian-dev'), plugins.at(-1).config.map((row) => [row.id, row.config?.distro]))
check('no provider carries a bare row-level distro', ['subprocess-wsl', 'shell-wsl', 'fs-wsl', 'sandbox-wsl'].every((id) => plugins.at(-1).config.find((row) => row.id === id)?.distro === undefined), plugins.at(-1).config.map((row) => [row.id, row.distro]))
check('tool rows carry no distro pin', plugins.at(-1).config.filter((row) => row.id.startsWith('tool') || row.id === 'str-replace-editor').every((row) => row.config?.distro === undefined && row.distro === undefined), plugins.at(-1).config.map((row) => [row.id, row.config?.distro]))
check('editor re-mounted inside the group', plugins.at(-1).config.some((row) => row.id === 'str-replace-editor'), plugins.at(-1).config.map((row) => row.id))
check('persona amended with the path-dialect sentence', plugins[0].config.suffix.includes('wsl.localhost'), plugins[0].config.suffix?.slice(0, 80))
check('provider modules are absolute file paths', [MODULES.subprocessPath, MODULES.shellPath, MODULES.fsPath, MODULES.sandboxPath].every((p) => plugins.at(-1).config.some((row) => row.name === p)))
// The realm's searching is re-mounted the way bash and fs are: two rows in the SAME group,
// named by a module of THIS plugin. Both halves of the claim are one assertion because they
// are one decision — a row pointed at the host's package would be a row the transform
// REMOVES (`@deepseek-ai/dsh-tool-fs-search` is in WORLD_MODULE_NAMES), so "names our
// module" and "is not a host-world module" can only be true together.
//
// The tool NAME is what Task 4 invokes, and a row id is free to differ from it; here the id
// and the name coincide, and `config.tool` is what the single shared module reads to know
// which of the two tools this instance registers (two rows naming one module would
// otherwise register the same tool twice).
{
  const group = plugins.at(-1)
  const searchRows = ['grep', 'glob'].map((id) => group.config.find((row) => row.id === id))
  check('the realm re-mounts grep and glob as rows of this plugin, not of the host search package',
    searchRows.every((row) => row?.name === MODULES.searchPath && !isHostWorldModule(row.name)),
    group.config.map((row) => [row.id, row.name]))
  check('each search row names the tool its own instance registers',
    searchRows.every((row) => row !== undefined && row.config?.tool === row.id),
    searchRows.map((row) => [row?.id, row?.config]))
}

// The realm's OWN confinement provider. Two facts, measured separately because they
// became true for different reasons:
//
//   - the row exists, and it is a module of THIS plugin (not a host sandbox package —
//     the host's is `@deepseek-ai/dsh-sandbox-local`, whose win32 rung ACLs the
//     workspace path and cannot do that for a 9P UNC spelling);
//   - the group isolates `sandbox`, which is what makes the row's service land in the
//     REALM instead of the root realm. The loader refuses a preset whose subtree
//     publishes a service into the root (`mount.ts:213`, the same rule the `terminals`
//     key above satisfies), and an unisolated `sandbox` is also what made the backend
//     reach the HOST provider: `ctx.get('sandbox')` inside the realm resolved to
//     sandbox-local, whose workspace-write grant fails on a UNC workspace.
{
  const group = plugins.at(-1)
  const sandboxRow = group.config.find((row) => row.id === 'sandbox-wsl')
  check('the realm mounts its own sandbox provider inside the group',
    sandboxRow?.name === MODULES.sandboxPath, group.config.map((row) => [row.id, row.name]))
  check('the group declares the sandbox isolation its own provider requires',
    group.isolate?.sandbox === true, group.isolate)
}

// The realm's own terminal stack: three rows mounted INSIDE the group, and the isolation a
// service provider requires (F11). `dsh-terminal` PROVIDES `terminals`; a provider that
// would land in the ROOT realm is refused at mount
// (`packages/preset/agent-preset-registry/src/mount.ts:213`
// "Preset services require isolate realms: terminals"). The suite can only pin the
// DECLARATION here; the refusal itself is the loader's, and Task 1's probe observes it live.
{
  const group = plugins.at(-1)
  const terminalRows = ['pty', 'terminal-bash', 'persistent-bash']
    .map((id) => group.config.find((row) => row.id === id))
  check('the realm mounts its own terminal stack inside the group',
    terminalRows.every((row) => row !== undefined),
    group.config.map((row) => [row.id, row.name]))
  check('the realm mounts the registry, the bash backend and the persistent shell, in that order',
    JSON.stringify(terminalRows.map((row) => row?.name)) === JSON.stringify([
      '@deepseek-ai/dsh-terminal',
      '@deepseek-ai/dsh-terminal-bash',
      '@deepseek-ai/dsh-tool-bash-persistent',
    ]),
    terminalRows.map((row) => row?.name))
  check('the group declares the terminals isolation a service provider requires',
    group.isolate?.terminals === true, group.isolate)
}

// The harness's own text and timeout for the persistent shell, restated here VERBATIM. It
// has to be restated in the realm because nothing carries it: the host row is removed by
// MODULE NAME (`WORLD_MODULE_NAMES`), while `prune()` records `toolConfig` only for the five
// canonical WORLD_ROWS ids plus the editor (`lib/wsl/preset.js:442-466` — `prune` starts at
// `:442`, and its two `toolConfig.set` sites are `:449` and `:466`). Source:
// `packages/bundle/web-app/presets/minimal.patch.yml:50-59`.
const PERSISTENT_BASH_DESCRIPTION = [
  'Run commands in a bash shell',
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
  '* State is persistent across command calls and discussions with the user.',
  "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  '* Please avoid commands that may produce a very large amount of output.',
  "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join('\n')

{
  const group = plugins.at(-1)
  const persistent = group.config.find((row) => row.id === 'persistent-bash')
  check('the persistent shell row restates the harness config literally',
    JSON.stringify(persistent?.config) === JSON.stringify({ timeoutMs: 300_000, description: PERSISTENT_BASH_DESCRIPTION }),
    persistent?.config)
  // ONE owner of the model-facing name `bash`. The registered NAME is a property of the
  // MODULE, not of the row id: the persistent module registers `bash`
  // (`tool-bash-persistent/src/index.ts:415`) and the one-shot module did too
  // (`tool-bash/src/index.ts:369`), whatever id either row carries. So this pins the module
  // set, AND that no row re-declares the one-shot module under a non-canonical id — an
  // id-keyed check would pass while a `{ id: 'bash-two', name: '@deepseek-ai/dsh-tool-bash' }`
  // row re-owned the name. The harness's own minimal preset settles the same question the same
  // way: it mounts no one-shot shell row BECAUSE it mounts the persistent stack
  // (`apps/cli/tests/windows-shell.spec.ts:127-134`).
  //
  // WHICH one actually answered was MEASURED, not assumed: the live probe read M1 = P2 — the
  // persistent shell completed `tools.bashPersist.b` and read back the cwd the first call made
  // (the ledger's 活体验证 section, ruling R29, and `artifacts/live-M1-M3-c1.txt:1550`). What
  // that does NOT license: the pre-change inventory showed BOTH bash rows `fiberState: 2` with
  // no `broken`, so re-registration did not throw here (ruling R33 — the store's duplicate
  // contract is not this realm's observed mount). The one-shot row was a second, still-live
  // registrant of the name, not a row that had already lost — which is exactly why removing it
  // is a change rather than a tidy-up.
  const bashOwners = group.config.filter((row) => (
    row.name === '@deepseek-ai/dsh-tool-bash-persistent' || row.name === '@deepseek-ai/dsh-tool-bash'
  ))
  check('the group mounts exactly one owner of the model-facing name `bash`',
    bashOwners.length === 1 && bashOwners[0]?.id === 'persistent-bash',
    group.config.map((row) => [row.id, row.name]))
  // The stated NON-GOAL has a pin too, or it drifts silently: the distribution has no
  // PowerShell, so the pwsh persistent tool must never appear in this group.
  check('no PowerShell persistent tool is mounted inside the realm',
    !group.config.some((row) => typeof row.name === 'string' && row.name.includes('pwsh-persistent')),
    group.config.map((row) => row.name))
}

// Design §3's two directions, pinned together because they pull in OPPOSITE directions.
{
  const group = plugins.at(-1)
  const terminalRows = ['pty', 'terminal-bash', 'persistent-bash']
    .map((id) => group.config.find((row) => row.id === id))
  // Direction ②: the three rows are present AND their modules are names the removal rule
  // OWNS — presence therefore proves the prune pass never saw them (the group is appended
  // after it), not that the rule is lenient.
  check('the realm’s terminal rows survive under names the removal rule owns',
    terminalRows.every((row) => row !== undefined && isHostWorldModule(row.name)),
    group.config.map((row) => [row.id, row.name]))
  // Direction ①: the same names arriving from the BASE preset are still pruned — including
  // the host-only pwsh twin, whose absence from the realm is a stated non-goal.
  const baseTerminals = buildVariantPlugins([
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {} },
    { id: 'host-persistent-shell', name: 'cordis:group', group: true, isolate: { terminals: true }, config: [
      { id: 'host-pty', name: '@deepseek-ai/dsh-terminal' },
      { id: 'host-terminal-bash', name: '@deepseek-ai/dsh-terminal-bash' },
      { id: 'host-persistent-bash', name: '@deepseek-ai/dsh-tool-bash-persistent' },
      { id: 'host-persistent-pwsh', name: '@deepseek-ai/dsh-tool-pwsh-persistent' },
    ] },
  ], MODULES)
  check('a base preset’s host terminal group is still pruned away, row for row and group with it',
    !baseTerminals.plugins.some((row) => row.id === 'host-persistent-shell')
    && baseTerminals.removed.includes('host-persistent-shell'),
    baseTerminals.removed)
}

// The re-mounted tool rows must carry the operator's own config. Re-declaring
// them bare silently dropped whatever the base preset had set — a value honoured
// in the host world simply vanished in the WSL world — and nothing pinned it.
{
  const withConfig = [
    { id: 'str-replace-editor', name: '@deepseek-ai/dsh-tool-str-replace-editor', config: { maxOutputChars: 16000 } },
  ]
  const carried = buildVariantPlugins(withConfig, { ...MODULES, distro: 'debian-dev' }).plugins.at(-1)
  const editorRow = carried.config.find((row) => row.id === 'str-replace-editor')
  // The one-shot `bash` row is NOT re-mounted any more (one owner of the name, above), so the
  // only row left carrying operator config is the editor — kept because dropping a setting
  // the base preset had set is exactly the failure this block was written for.
  check('the editor row keeps the operator config',
    editorRow?.config?.maxOutputChars === 16000,
    carried.config.map((row) => [row.id, row.config]))
  check('the carried config is a copy, not the base preset object',
    editorRow !== undefined && editorRow.config !== withConfig[0].config,
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

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
