/**
 * Whether this machine can spawn `wsl.exe` at all.
 *
 * A suite that needs the WSL world cannot evaluate anything on a host that has no
 * `wsl.exe`. That is a machine fact, not a defect, so every such suite asks this
 * before its first assertion and reports the SKIP instead of crashing on ENOENT.
 * @module scripts/wsl-available
 */
import { execFileSync } from 'node:child_process'

/**
 * Probe for `wsl.exe`.
 * @returns {{ available: boolean, detail: string }} whether it can be spawned, and why not.
 */
export function wslAvailable() {
  try {
    execFileSync('wsl.exe', ['--version'], { timeout: 20_000, stdio: 'pipe' })
    return { available: true, detail: '' }
  } catch (error) {
    return { available: false, detail: `${error?.code ?? error?.status ?? 'error'}: ${String(error?.message ?? error).slice(0, 120)}` }
  }
}

/**
 * Report the SKIP and exit 2 when `wsl.exe` is missing.
 *
 * Exits the process; call it only when the suite cannot run a single assertion.
 * @param {{ skip: (count?: number) => void, skipped: number }} checker - the suite's checker.
 * @param {string} subject - what could not be asserted, for the SKIP line.
 * @param {string} detail - the probe failure.
 */
export function skipWithoutWsl(checker, subject, detail) {
  checker.skip(1)
  console.log(`  SKIP  ${subject} — 1 check(s) not evaluated, wsl.exe cannot run here (${detail});`)
  console.log('        install WSL2 with a distribution, or run this suite on a Windows host with WSL2')
  console.log(`\nEVERY CHECK THAT COULD RUN PASSED, ${checker.skipped} CHECK(S) SKIPPED — exit 2, so verify-all reports this suite as SKIP`)
  process.exit(2)
}
