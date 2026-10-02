/**
 * The probe policy README.md states, as a runner the suites can share.
 *
 * README.md:132 — 探针超时 60s + 超时后一次透明重试 — one probe at a 60s ceiling, repeated
 * ONCE when it TIMED OUT. The reason it exists is the MACHINE, not the command: every
 * distribution shares one WSL2 VM, so a sibling distribution's load can stall a probe that
 * answered in 300ms a moment earlier (measured on this host: ~300ms, then 30.4s and 30.5s on
 * two consecutive calls while the VM ran at load ~11 with its swap 95% full).
 *
 * `lib/wsl/world.js` implements this for the probes it owns (`listLinuxDir`, `checkLinuxPath`,
 * `resolveDistroHome`, `resolveIdentity`, `detectRunner`, the NO_NEW_PRIVS probe). The suites
 * that run their OWN `wsl.exe` probes had no such runner: `scripts/verify-confinement.mjs`
 * makes ~25 of them, and ONE stalled probe reddened checks that were measuring something else
 * entirely — the class that made `verify-confinement-skip.mjs` report a count mutation the
 * suite had performed correctly.
 *
 * THE TRIGGER IS `timedOut` ALONE, and that is what makes it safe to put in front of a probe
 * whose answer is a REFUSAL: a refusal is an immediate answer carrying an exit code and stderr
 * text, never a timeout, so no repeat can turn one into a pass. A path that is genuinely
 * missing is likewise answered in ONE attempt — a fast non-zero exit, which the ceiling must
 * not double. What the repeat may not do is hide a persistent stall: the SECOND attempt's
 * result is what the caller sees, `timedOut` included.
 */

/** The documented probe ceiling: 60s, because a cold VM's first spawn can exceed 30s. */
export const PROBE_TIMEOUT_MS = 60_000

/**
 * One probe, repeated once when it timed out.
 *
 * The runner is a PARAMETER and not a module global, so a pin can hand this function a stub
 * and drive the policy without a distribution — the same seam `resolveIdentity` and
 * `detectRunner` expose. The ceiling is the request's own `timeoutMs` when it carries one (a
 * heavyweight setup that deliberately asks for more keeps it) and `PROBE_TIMEOUT_MS` otherwise.
 * @param {(request: object) => Promise<object>} run - the probe runner (injectable).
 * @param {object} request - the probe, without its ceiling.
 * @param {{ timeoutMs?: number, onRetry?: (request: object, first: object) => void }} [options] - the ceiling to force, and the hook a caller discloses the repeat with.
 * @returns {Promise<object>} the first conclusive attempt, or the second after a timeout.
 */
export async function probeWithRetry(run, request, { timeoutMs = request.timeoutMs ?? PROBE_TIMEOUT_MS, onRetry } = {}) {
  const first = await run({ ...request, timeoutMs })
  if (first.timedOut !== true) return first
  if (typeof onRetry === 'function') onRetry({ ...request, timeoutMs }, first)
  return await run({ ...request, timeoutMs })
}
