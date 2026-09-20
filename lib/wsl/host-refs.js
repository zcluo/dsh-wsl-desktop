/**
 * References the host-side plugin captures for the realm-side providers.
 *
 * A preset realm that isolates `subprocess` cannot reach the host's provider
 * through `ctx.subprocess` — that resolves to the realm's own provider. The
 * host row runs in the root composition, so it captures the root provider here
 * and the realm rows read it back. Both modules resolve to the same absolute
 * URL, so they share one instance.
 *
 * The captured provider is the primitive that starts a *Windows* process, which
 * is what every WSL provider ultimately needs: `wsl.exe` is an ordinary Windows
 * executable, and starting it through the local provider keeps managed-range
 * termination, output spill and disposal with its owner.
 * @module dsh-wsl-desktop/wsl/host-refs
 */

/** The root `ctx.subprocess` provider, once the host row has captured it. */
let localSubprocess

/**
 * Record the host's subprocess provider.
 * @param {object} provider - the root `ctx.subprocess` service.
 */
export function setLocalSubprocess(provider) {
  localSubprocess = provider
}

/**
 * Read the host's subprocess provider.
 * @returns {object} the root `ctx.subprocess` service.
 * @throws Error when the host row has not captured it yet.
 */
export function requireLocalSubprocess() {
  if (localSubprocess === undefined) {
    throw new Error('wsl-subprocess: 宿主 subprocess provider 尚未捕获')
  }
  return localSubprocess
}
