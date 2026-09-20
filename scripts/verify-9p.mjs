/**
 * Probe the WSL 9P share for the filesystem primitives `fs-local` relies on.
 *
 * `LocalFileSystem` publishes an atomic write with a hard link (create-if-absent)
 * or a Win32 security-preserving replace, and derives target identity from
 * `realpath`. This asserts the profile the WSL provider is built for: everything
 * available except hard links, which the provider replaces with an exclusive copy.
 *
 * Run: node scripts/verify-9p.mjs [distro]
 */

import { mkdir, writeFile, link, rename, realpath, stat, rm, readFile, copyFile, chmod, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDistro } from './env.mjs'

const distro = resolveDistro(process.argv[2])
const root = `\\\\wsl.localhost\\${distro}\\tmp\\dsh-wsl-9p-probe`

let failures = 0

/**
 * Record one probe outcome against its expected availability.
 * @param {string} label - what was attempted.
 * @param {boolean} available - whether the primitive worked.
 * @param {'available' | 'unavailable'} expected - the outcome the provider is built for.
 * @param {unknown} [detail] - context shown when the outcome differs.
 */
function probe(label, available, expected, detail) {
  const matches = expected === 'available' ? available : !available
  console.log(`  ${matches ? 'OK  ' : 'FAIL'}  ${label} — ${available ? 'available' : 'unavailable'}${matches ? '' : ` (expected ${expected})`}`)
  if (!matches && detail !== undefined) console.log(`        ${String(detail)}`)
  if (!matches) failures += 1
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
console.log(`probing ${root}\n`)

const seed = join(root, 'seed.txt')
await writeFile(seed, 'hello\n', 'utf8')

try {
  const realpathed = await realpath(seed)
  probe('realpath resolves on the share', true, 'available')
  probe('realpath keeps the share spelling', realpathed.toLowerCase().includes('wsl'), 'available', realpathed)
} catch (error) {
  probe('realpath resolves on the share', false, 'available', error)
  probe('realpath keeps the share spelling', false, 'available')
}

try {
  const info = await stat(seed)
  probe('stat exposes mtime and size for the version basis', Number.isFinite(info.mtimeMs) && Number.isFinite(info.size), 'available', `${info.mtimeMs} / ${info.size}`)
} catch (error) {
  probe('stat exposes mtime and size for the version basis', false, 'available', error)
}

try {
  await link(seed, join(root, 'hardlink.txt'))
  probe('hard link (create-if-absent publication)', true, 'unavailable')
} catch (error) {
  probe('hard link (create-if-absent publication)', false, 'unavailable', `${error.code} ${error.message}`)
}

try {
  await writeFile(join(root, 'replace-me.txt'), 'old\n', 'utf8')
  await writeFile(join(root, 'replacement.txt'), 'new\n', 'utf8')
  await rename(join(root, 'replacement.txt'), join(root, 'replace-me.txt'))
  const after = await readFile(join(root, 'replace-me.txt'), 'utf8')
  probe('rename replaces an existing file (overwrite publication)', after === 'new\n', 'available', JSON.stringify(after))
} catch (error) {
  probe('rename replaces an existing file (overwrite publication)', false, 'available', `${error.code} ${error.message}`)
}

try {
  await copyFile(seed, join(root, 'copied.txt'), constants.COPYFILE_EXCL)
  probe('COPYFILE_EXCL copies (fallback publication)', true, 'available')
} catch (error) {
  probe('COPYFILE_EXCL copies (fallback publication)', false, 'available', `${error.code} ${error.message}`)
}

try {
  await chmod(seed, 0o600)
  probe('chmod is accepted', true, 'available')
} catch (error) {
  probe('chmod is accepted', false, 'available', `${error.code} ${error.message}`)
}

await rm(root, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'THE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES' : `${failures} PRIMITIVE(S) DIFFER FROM THE ASSUMED PROFILE`}`)
process.exitCode = failures === 0 ? 0 : 1