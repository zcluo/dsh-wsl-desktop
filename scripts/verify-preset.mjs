/**
 * Verify the WSL preset transform against the shipped `standard` preset.
 *
 * The transform is pure text, so it runs under plain Node outside the profile.
 * Run: node scripts/verify-preset.mjs
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { renderWslPreset, renderPresetMetadata, splitBlocks, sweepDecision, WORLD_ROWS } from '../lib/wsl/preset.js'

const SHIPPED = process.env.DSH_SHIPPED_PRESET
  ?? 'E:\\projects\\deepseek-harness\\apps\\desktop\\.desktop-build\\targets\\win-x64\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-presets\\presets\\standard\\agent.cordis.yml'

let failures = 0

/**
 * Record one assertion.
 * @param {string} label - what was checked.
 * @param {boolean} ok - the outcome.
 * @param {unknown} [detail] - evidence shown on failure.
 */
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n        ${String(detail)}`}`)
  if (!ok) failures += 1
}

if (!existsSync(SHIPPED)) {
  console.error(`shipped preset not found: ${SHIPPED}`)
  process.exit(2)
}
const source = await readFile(SHIPPED, 'utf8')

console.log('source preset')
const blocks = splitBlocks(source)
const ids = blocks.map((block) => block.id).filter((id) => id !== null)
check('the shipped preset has top-level entries', ids.length > 5, ids.length)
const presentWorldRows = ids.filter((id) => WORLD_ROWS.has(id))
check('the shipped preset mounts host execution-world rows', presentWorldRows.length >= 2, presentWorldRows)
console.log(`        ids: ${ids.join(', ')}`)

console.log('\ntransform')
const result = renderWslPreset(source, {
  subprocessPath: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\plugins\\dsh-wsl-desktop\\lib\\wsl\\subprocess.js',
  shellPath: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\plugins\\dsh-wsl-desktop\\lib\\wsl\\shell.js',
  fsPath: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\plugins\\dsh-wsl-desktop\\lib\\wsl\\fs.js',
  distro: 'debian',
})
const yaml = result.yaml

check('every host world row was removed', presentWorldRows.every((id) => result.removed.includes(id)), result.removed)
check('removal is limited to world rows', result.removed.every((id) => WORLD_ROWS.has(id)), result.removed)
check('no removed row survives as a top-level entry', !splitBlocks(yaml).some((block) => block.id !== null && WORLD_ROWS.has(block.id)))

const rendered = splitBlocks(yaml)
const worldBlock = rendered.find((block) => block.id === 'wsl-world')
check('a wsl-world group was appended', worldBlock !== undefined)
const worldText = worldBlock?.lines.join('\n') ?? ''
check('the group isolates shell, fs and subprocess', /isolate:\n {4}shell: true\n {4}fs: true\n {4}subprocess: true\n/.test(worldText), worldText.slice(0, 260))
check('no terminal registry row is added', !worldText.includes('- id: pty') && !worldText.includes('terminal-bash'), worldText.slice(0, 400))
check('the group mounts the WSL subprocess provider first', worldText.indexOf('- id: subprocess-wsl') !== -1 && worldText.indexOf('- id: subprocess-wsl') < worldText.indexOf('- id: shell-wsl'), worldText.slice(0, 260))
check('the group mounts the WSL shell executor', worldText.includes('- id: shell-wsl'))
check('the group mounts the WSL filesystem provider', worldText.includes('- id: fs-wsl'))
check('the group mounts the bash tool', /- id: tool-bash\n\s+name: '@deepseek-ai\/dsh-tool-bash'/.test(worldText))
check('the group mounts the file tools', /- id: tool-fs\n\s+name: '@deepseek-ai\/dsh-tool-fs'/.test(worldText))
check('the distribution is pinned in the fs row', worldText.includes("distro: 'debian'"))
check('Windows paths survive YAML quoting', worldText.includes("'C:\\Users\\x\\.dsh\\profiles\\desktop\\plugins\\dsh-wsl-desktop\\lib\\wsl\\fs.js'"))

check('the persona tells the model the WSL path mapping', yaml.includes('Windows spellings of directories inside that WSL distribution'), yaml.slice(yaml.indexOf('- id: persona'), yaml.indexOf('- id: persona') + 400))

console.log('\nstructural sanity')
check('the transform emits no tabs', !yaml.includes('\t'))
const duplicateKeys = []
for (const block of rendered) {
  const seen = new Map()
  for (const line of block.lines) {
    // A sequence item opens a fresh mapping, so keys legitimately repeat across
    // sibling entries; only a repeat *within* one mapping is a defect.
    if (/^\s*- /.test(line)) { seen.clear(); continue }
    const match = /^(\s*)([A-Za-z_][\w-]*):/.exec(line)
    if (match === null) continue
    const key = `${match[1].length}:${match[2]}`
    if (seen.has(key)) duplicateKeys.push(`${block.id ?? 'preamble'}:${match[2]}`)
    seen.set(key, true)
  }
}
check('no mapping key is emitted twice at the same indent', duplicateKeys.length === 0, duplicateKeys)
check('every top-level entry keeps a name line', rendered.every((block) => block.id === null || block.lines.some((line) => /^ {2}name:/.test(line))))
check('the source length is preserved minus the dropped rows', yaml.length > source.length / 2)
const preserved = ids.filter((id) => !WORLD_ROWS.has(id))
check('every non-world row is nested inside the realm', preserved.every((id) => new RegExp(`^ {4}- id: ${id}$`, 'm').test(yaml)), preserved.filter((id) => !new RegExp(`^ {4}- id: ${id}$`, 'm').test(yaml)))
check('no original row survives at the top level', !/^- id: persona$/m.test(yaml) && !/^- id: tool-skill$/m.test(yaml))
check('the realm is the only top-level entry', splitBlocks(yaml).filter((block) => block.id !== null).length === 1, splitBlocks(yaml).map((block) => block.id))
check('the persona section survives', /persona/.test(yaml))
check('the chat nodes or tools survive', /tool-skill|skill-filesystem/.test(yaml))

console.log('\nmetadata')
const meta = renderPresetMetadata({ name: 'WSL', description: '在 WSL 发行版里执行' })
check('metadata carries a name and description', meta.startsWith('name: WSL\n') && meta.includes('description:'))

console.log('\norphan sweep')
// The namespace is a name prefix, so it is shared with anything a user calls
// `wsl-…`. Only a directory this plugin marked may be withdrawn.
const sweep = (over) => sweepDecision({ name: 'wsl-standard', prefix: 'wsl-', expected: false, marked: false, ...over })
check('an unmarked directory in the namespace is left alone', sweep({}) === 'unmanaged')
check('a marked orphan is withdrawn', sweep({ marked: true }) === 'withdraw')
check('a marked current output is kept', sweep({ marked: true, expected: true }) === 'keep')
check('an unmarked current output is still kept', sweep({ expected: true }) === 'keep')
check('a directory outside the namespace is ignored', sweep({ name: 'standard' }) === 'ignore')
check('the decision does not depend on the marker for an expected directory',
  sweep({ expected: true, marked: false }) === sweep({ expected: true, marked: true }))

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
