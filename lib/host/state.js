/**
 * The plugin's module-level state, named and grouped.
 *
 * The route dispatcher calls `METHODS` without carrying the plugin's config, so
 * the context, the configured `wsl.exe` path and the preset lifecycle cannot be
 * parameters. They were loose module-level `let`s in `lib/index.js` (seven of them,
 * counting the binding log and its cap); this module gives
 * each group one owner, so a reader can see what is shared and why.
 *
 * Nothing here is a getter/setter pair: the objects are mutable, and every call
 * site reads a field. That keeps the move mechanical — `hostCtx.get(x)` became
 * `hostSession.ctx.get(x)`.
 * @module dsh-wsl-desktop/host/state
 */

/** The plugin context and the config it was applied with, as route methods see them. */
export const hostSession = {
  /** @type {import('@deepseek-ai/cordis').Context | undefined} */
  ctx: undefined,
  /** The configured `wsl.exe` path; the default a fresh install runs with. */
  wslPath: 'wsl.exe',
  /** Whether the preset registry has been reached; `bootstrap` waits briefly for it. */
  ready: false,
}

/** The preset registration lifecycle. */
export const presetRun = {
  /** @type {{ status: string } & Record<string, unknown>} */
  state: { status: 'pending' },
  /** @type {{ disposed: boolean, disposers: Map<string, Function> } | null} */
  generation: null,
  /** Serialises refreshes so boot-time and developer-token calls cannot interleave. */
  mutex: Promise.resolve(),
}

/** Most binding decisions kept for inspection. */
export const BINDING_LOG_LIMIT = 50

/** The bounded record of preset-binding decisions, reported through the route. */
export const bindingTape = (() => {
  /** @type {object[]} */
  const log = []
  return {
    log,
    /**
     * Record one decision, dropping the oldest past the cap.
     *
     * The log is captured by the closure rather than read off `this`: a caller that
     * destructures the method (`const { record } = bindingTape`) would otherwise get
     * `TypeError: this.log is undefined` at the first write.
     * @param {object} entry - the decision to record.
     */
    record(entry) {
      log.push(entry)
      if (log.length > BINDING_LOG_LIMIT) log.splice(0, log.length - BINDING_LOG_LIMIT)
    },
  }
})()
