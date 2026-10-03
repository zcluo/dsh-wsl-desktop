/**
 * The probe policy docs/CONFINEMENT.md states, as a runner the suites can share.
 *
 * docs/CONFINEMENT.md:36 — 探针超时 60s + 超时后一次透明重试 — one probe at a 60s ceiling, repeated
 * ONCE when it TIMED OUT. The reason it exists is the MACHINE, not the command: every
 * distribution shares one WSL2 VM, so a sibling distribution's load can stall a probe that
 * answered in 300ms a moment earlier (measured on this host: ~300ms, then 30.4s and 30.5s on
 * two consecutive calls while the VM ran at load ~11 with its swap 95% full).
 *
 * Three modules implement a retry of this shape, and this is where each one lives:
 * `lib/wsl/world.js` for the four probes it owns (`listLinuxDir`, `checkLinuxPath`,
 * `resolveDistroHome`, `resolveLoginShell`),
 * `lib/wsl/confinement.js` inside `resolveIdentity`, `detectRunner` and the NO_NEW_PRIVS
 * probe, and `lib/wsl/pty.js` inside the bridge-runtime probe. The suites that run their OWN
 * `wsl.exe` probes had no such runner: `scripts/verify-confinement.mjs` reaches 35 `wsl.exe`
 * spawn statements, and ONE stalled probe reddened checks that were measuring something else
 * entirely — the class that made `verify-confinement-skip.mjs` report a count mutation the
 * suite had performed correctly.
 *
 * The count is RECOUNTABLE rather than remembered, because it was already wrong once: count the
 * two call forms in `scripts/verify-confinement.mjs`, one spawn per line — `await probe(`
 * (20 lines) and `await confined(` (15 lines), 35 together. Two traps, both of which the
 * number that stood here fell into, so a re-count must not fall into them either: the
 * `confined()` wrapper's own `probe(...)` call is ONE OF THE 20 (the 15 call sites reach that
 * same line, so counting the wrapper as a sixteenth site double-counts all of them), and the two
 * fixture probes (FIXTURE_SETUP at :1168, FIXTURE_CLEANUP at :1262) are likewise two more of the
 * same 20, not a third category. The SUDO_USER site sits in a loop, so one run issues more than
 * 35 spawns.
 *
 * THE TRIGGER IS NOT THE SAME IN ALL THREE, AND THIS RUNNER TAKES THE NARROWEST: `timedOut`
 * ALONE. `world.js`'s four probes (`probeWithRetry`, world.js:546) and `confinement.js`'s
 * `resolveIdentity` (:95) repeat on a timeout alone; `detectRunner` (:311) also repeats an
 * ANSWERED "no", because its `probeOnce` returns null both for "no" and for a probe that could
 * not run; `detectNoNewPrivs` (:400) and `pty.js`'s python3 probe (:132) repeat on ANY
 * non-answer — pty throws on an answered "no" rather than repeating it. The narrow trigger is
 * what makes THIS runner safe to put in front of a probe whose answer is a REFUSAL: a refusal is
 * an immediate answer carrying an exit code and stderr text, never a timeout, so no repeat here
 * can turn one into a pass. A path that is genuinely missing is likewise answered in ONE attempt
 * — a fast non-zero exit, which the ceiling must not double. What the repeat may not do is hide a
 * persistent stall: the SECOND attempt's result is what the caller sees, `timedOut` included.
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
