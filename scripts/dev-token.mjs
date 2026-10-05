/**
 * Mint the development token the acceptance suites present to the route.
 *
 * The token only gates the plugin's acceptance surface on loopback. The suite
 * WRITES it rather than reading the one the host may have minted, so a
 * verification run never has to read a secret value: both processes are the same
 * user on the same machine, and the host re-reads the file on every request.
 *
 * Run: not directly — imported by the live suites.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The harness home the token lives under.
 * @returns {string} the resolved `$DSH_HOME`.
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Where this installation's development token lives.
 *
 * ONE spelling of the path: the mock host used to read its own copy of these two
 * literals, and a rename in either file silently desynchronized the token writer
 * from the token reader.
 * @returns {string} the token file's absolute path.
 */
export function devTokenPath() {
  return join(dshHome(), 'wsl-desktop-dev-token')
}

/** Header name, mirrored from the host half. */
export const DEV_TOKEN_HEADER = 'x-dsh-wsl-dev-token'

/**
 * Write a fresh token where the host reads it.
 * @returns {Promise<string>} the token to present.
 */
export async function ensureDevToken() {
  const path = devTokenPath()
  const token = randomBytes(32).toString('hex')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  return token
}
