/**
 * The plugin's module-level state, named and grouped.
 *
 * The route dispatcher calls `METHODS` without carrying the plugin's config, so
 * the context, the configured `wsl.exe` path and the preset lifecycle cannot be
 * parameters. They were five loose `let`s in `lib/index.js`; this module gives
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
export const bindingTape = {
  /** @type {object[]} */
  log: [],
  /**
   * Record one decision, dropping the oldest past the cap.
   * @param {object} entry - the decision to record.
   */
  record(entry) {
    this.log.push(entry)
    if (this.log.length > BINDING_LOG_LIMIT) this.log.splice(0, this.log.length - BINDING_LOG_LIMIT)
  },
}
