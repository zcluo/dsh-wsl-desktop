/**
 * Terminal transport for the WSL execution world.
 *
 * A `wsl.exe` pipe is not a terminal, so a real PTY is allocated inside the
 * distribution by `terminal-bridge.py`. This module owns the two host-side
 * processes that drive it and assembles the seam's terminal handle:
 *
 * - the **data** process runs the bridge; its stdin/stdout carry terminal bytes
 *   and its stderr carries one JSON control reply per line;
 * - the **control** process holds the bridge's FIFO open so resize, foreground
 *   inspection, signalling and termination can be requested at any time.
 *
 * Byte-level transport stays with the host subprocess provider, so managed
 * termination and disposal keep their owner.
 * @module dsh-wsl-desktop/wsl/pty
 */

import { appendFileSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shellQuote } from './paths.js'
import { buildWslExecArgv, runWslShell } from './world.js'

/** How long a control round trip may take before it is reported as failed. */
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000

/** Ceiling for the host-side FIFO cleanup: a teardown must not hang on it. */
const DEFAULT_FIFO_UNLINK_TIMEOUT_MS = 10_000

/** Prefix the bridge puts on every control reply line. */
const REPLY_PREFIX = '#dsh-pty '

/**
 * Largest terminal dimension the bridge can carry.
 *
 * `struct.pack('HHHH', ...)` in `terminal-bridge.py` holds an unsigned short, so
 * this is the wire format's own ceiling — not a second opinion on how large a
 * terminal may be.
 */
const MAX_DIMENSION = 65_535

/** Size framed when a caller supplies no dimension the PTY can carry at all. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** Distributions already confirmed to carry the bridge's runtime. */
const verifiedDistros = new Set()

/**
 * Ceiling for the opt-in terminal debug log, and the size at which it rotates.
 *
 * The doc comment on `termLog` used to call the sink "bounded" while the body was a
 * bare `appendFileSync` with no cap, no rotation and no redaction: a host that left
 * `WSL_DESKTOP_TERMINAL_DEBUG=1` set grew the file without limit. Rotation is
 * one-generation (`.1`), which bounds the pair at ~2x this figure and needs no
 * bookkeeping beyond a `statSync`.
 */
const TERMINAL_LOG_MAX_BYTES = 5 * 1024 * 1024

/**
 * Append one diagnostic line to the terminal debug log (bounded and rotated).
 * Temporary instrumentation for the live GUI-path terminal failure; harmless if
 * the file cannot be written.
 *
 * Callers must NOT hand this full argv vectors. A command line can carry a secret
 * (`tool --token=…`), and this file is plaintext under `$DSH_HOME`, readable by any
 * host-side reader of the profile. Describe the argv by its length and program
 * name instead — see `describeArgv`.
 * @param {string} message - the diagnostic line.
 */
export function termLog(message) {
  // Debug instrumentation: opt-in via env, because an always-on log grows
  // without bound on every terminal allocation.
  if (process.env.WSL_DESKTOP_TERMINAL_DEBUG !== '1') return
  try {
    const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'wsl-desktop-terminal-debug.log')
    // Rotate BEFORE appending, so the file cannot cross the ceiling even by one
    // line: the check is "would this write exceed it", not "has it already".
    try {
      const { size } = statSync(path)
      if (size >= TERMINAL_LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // Absent (first write) or unreadable: appending is still safe.
    }
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Diagnostics must never break allocation.
  }
}

/**
 * Describe an argv vector without reproducing it.
 *
 * The program name (argv[0]) and the element count are enough to tell "the bridge
 * got the right shape" from "it got a different one", which is what these log lines
 * exist for. The remaining elements are where secrets live, so they are never
 * written: the count preserves the shape evidence and nothing else is lost that the
 * log was actually used for.
 * @param {readonly string[] | undefined} argv - the vector to describe.
 * @returns {string} a redacted description, e.g. `bash (3 args)`.
 */
export function describeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '(no argv)'
  const program = String(argv[0])
  // The program itself may be a full path; its basename is the informative part.
  const name = program.split(/[\\/]/).pop() ?? program
  return `${name} (${argv.length - 1} args)`
}

/**
 * Report a diagnostic that must be VISIBLE without the opt-in debug log.
 *
 * `termLog` above is opt-in, so anything reported only through it is silent by default. That
 * is how a FIFO sat on disk at 2026-10-19 17:23 with nothing, anywhere, saying the `rm -f` had
 * not landed (ruling R57): the failure diagnostic existed but only in a log nobody had turned
 * on. A removal that did not land is a fact an operator needs in the ordinary case, so it goes
 * to the host's stderr as well as to the debug log.
 *
 * Deliberately unconditional and deliberately dumb: it never throws and never rejects, because
 * the caller is a teardown path and a diagnostic must not fail the teardown it describes.
 * @param {string} message - the diagnostic line.
 */
function reportAlways(message) {
  termLog(message)
  try {
    process.stderr.write(`dsh-wsl-desktop: ${message}\n`)
  } catch {
    // A failed diagnostic is not a failed teardown.
  }
}

/**
 * Bound one terminal dimension to what the bridge can carry.
 *
 * The harness terminal controller already validates dimensions before it calls
 * this provider (`Number.isSafeInteger` plus its configured limits, at both create
 * and resize), so a value outside 1..65535 is a caller bug rather than a value to
 * guess at. It is bounded here anyway, for two reasons that guard cannot cover.
 *
 * The bound is the WIRE FORMAT's — the widest range the PTY ioctl can carry at
 * all — and not a second opinion on the deployment's size policy. It sits above
 * every limit the controller applies by default, so no dimension a working
 * deployment uses is rewritten by it; a deployment that configured a limit past
 * 65535 would be asking for a size the ioctl cannot carry, and it gets the
 * fallback rather than a bridge that dies at spawn.
 *
 * The spawn path is the one that makes this mandatory rather than tidy: it frames
 * a dimension into the bridge's argv, and the first resize runs inside
 * `Bridge.__init__` BEFORE its control dispatcher exists — so a value the ioctl
 * cannot carry there is fatal with no guard able to answer it.
 * @param {number} value - the requested dimension.
 * @param {number} fallback - the dimension to keep when this one cannot be carried.
 * @returns {number} a dimension the bridge can carry.
 */
function clampDimension(value, fallback) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DIMENSION ? value : fallback
}

/**
 * Bound a requested size, reporting every value that had to be replaced.
 *
 * `fallback` is the size this handle last had accepted, so a value that cannot be
 * carried leaves the terminal where it is instead of inventing one.
 * @param {number} cols - requested columns.
 * @param {number} rows - requested rows.
 * @param {{ cols: number, rows: number }} fallback - the size to keep.
 * @returns {{ cols: number, rows: number }} the size to frame.
 */
function boundSize(cols, rows, fallback) {
  const bounded = { cols: clampDimension(cols, fallback.cols), rows: clampDimension(rows, fallback.rows) }
  if (bounded.cols !== cols || bounded.rows !== rows) {
    // Not silent: a dimension the PTY cannot carry means the caller's own guard
    // was bypassed, and this log is the only place that can be seen.
    termLog(`size bounded: cols=${String(cols)}->${String(bounded.cols)} rows=${String(rows)}->${String(bounded.rows)}`)
  }
  return bounded
}

/**
 * Confirm the distribution can run the bridge before allocating anything.
 *
 * The bridge is Python standard library only, so the runtime is the one real
 * dependency. Checking once per distribution turns a confusing mid-spawn
 * failure into a clear message.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {object} options - probe inputs.
 * @param {string} [options.username] - Linux user for the probe.
 * @param {string} [options.wslPath] - the configured `wsl.exe` path; this probe
 *   spawns it like every other site, or a deployment without wsl.exe on PATH
 *   would allocate through one path and probe through another.
 * @returns {Promise<void>} settlement.
 * @throws Error naming the missing runtime.
 */
async function requireBridgeRuntime(plan, options) {
  if (verifiedDistros.has(plan.distro)) return
  const failures = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const probe = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      ...options.username !== undefined && options.username !== '' ? { username: options.username } : {},
      ...options.wslPath !== undefined && options.wslPath !== '' ? { wslPath: options.wslPath } : {},
      command: 'command -v python3 >/dev/null 2>&1 && echo yes || echo no',
      // Non-login + strict equality: profile output can neither skew the answer
      // nor get substring-matched into a false positive. The 60s ceiling matches
      // the confinement identity probe: the desktop's first wsl.exe spawn after
      // a restart can outlive a short ceiling on a cold VM.
      loginShell: false,
      timeoutMs: 60_000,
    })
    const answer = probe.stdout.trim()
    if (answer === 'yes') {
      verifiedDistros.add(plan.distro)
      termLog(`requireBridgeRuntime: distro=${plan.distro} python3 ok`)
      return
    }
    // 'no' is an ANSWER — the interpreter really is absent. Anything else is a
    // probe that could not RUN, and reporting that as "no python3" sends the
    // reader after the wrong thing entirely. This conflation is the same defect
    // checkLinuxPath had (a failed probe read as "the path is missing"); it was
    // measured here as a whole suite dying under load, with the distro's python3
    // present the entire time.
    if (answer === 'no') {
      throw new Error(`wsl-pty: 发行版 ${plan.distro} 里没有 python3，无法分配终端`)
    }
    failures.push(`退出码 ${String(probe.exitCode)}${probe.timedOut ? '（超时）' : ''} stderr=${JSON.stringify(probe.stderr.trim().slice(0, 120))}`)
    termLog(`requireBridgeRuntime: distro=${plan.distro} probe did not run: ${failures[failures.length - 1]}`)
  }
  throw new Error(`wsl-pty: python3 探针在发行版 ${plan.distro} 里无法运行（${failures.join('；')}）——这是发行版级别的失败，不是缺少解释器`)
}

/**
 * Unlink one session's control FIFO from the HOST side.
 *
 * The bridge's own finally (terminal-bridge.py) unlinks it, but that block does
 * not run when the bridge is KILLED — and the host kills it: terminate() calls
 * data.terminate() straight after the bridge's own terminate reply, racing its
 * clean exit, and the provider's grace escalates to a kill. A killed bridge
 * leaves a 0-byte /tmp/dsh-pty-<uuid>.fifo inside the distribution.
 *
 * TWO owners cover that residue, and neither is this function alone (this comment
 * used to claim "nothing else ever removes it", measured false — ruling R45):
 *   - the SWEEP (`sweepOrphanFifos` below) owns collection of any name whose
 *     teardown never ran: branch 2 collects this process's own ended sessions and
 *     branch 3 collects a previous generation's, both by GENERATION rather than by
 *     age. So the uuid in the name is not a reason to expect it to sit there
 *     forever, which is what the old sentence assumed;
 *   - this host-side rm -f is the only cleanup that runs at TEARDOWN time and
 *     survives a SIGKILL, which is the property it exists for. It is bounded and
 *     best effort, and it is a BACKSTOP on the ordinary-close path: there the
 *     bridge's finally removed the name already.
 *
 * Measured: hard-killing the data process of a live session left the FIFO behind
 * on every run, which is why the teardown-time removal exists at all. Measured
 * after the sweep landed: an allocation collects such a name on a later run
 * (artifacts/t2r1-red-* / the sweep's own suite rows), and the sweep reports a
 * removal that did not land rather than claiming it.
 *
 * Hence a host-side rm -f, which is the only cleanup that survives a SIGKILL.
 * Best effort and bounded (a distribution that is going down must not hang a
 * teardown) and idempotent (safe on every path that ends a session). The cost is
 * one wsl.exe spawn per closed session, memoized in cleanupFifo() so the two end
 * paths cannot each pay it; the alternative — inferring from
 * the session outcome whether the bridge's finally ran — is not portable: on
 * Windows a killed process reports no signal, and a non-zero exit code is also
 * the ordinary shape of a session whose command failed.
 *
 * IT ANSWERS WHETHER THE REMOVAL LANDED, which is not the same question as
 * whether the spawn succeeded. `runWslShell` resolves for ANY exit code
 * (`world.js:611-613`), so an `await` that is not followed by an `exitCode` check
 * reports success when the distribution is stopped, the user may not remove the
 * entry, or `rm` itself failed — measured at 2026-10-19 17:23 as a FIFO still on
 * disk with nothing saying otherwise (ruling R57). The command therefore asserts
 * the postcondition inside the SAME spawn (`rm -f` and then "not there"), and the
 * exit code is inspected as well, so:
 *   - `exitCode === 0` → the name is gone. This is the ONLY path that answers true.
 *   - a non-zero exit, a spawn rejection, or a `null` exit (the child was killed) →
 *     false, reported through `reportAlways` so it is visible WITHOUT the opt-in
 *     terminal debug log.
 * A TIMEOUT IS NOT ITS OWN ARM, and the rule above is the whole rule: the answer is
 * decided by `exitCode` alone, so a run whose timer fired late — after the child had
 * already exited 0 — still answers TRUE. That is not a loophole in the postcondition:
 * the postcondition was `rm -f … && test ! -e …`, so exit 0 means the name is gone in
 * the distribution's own view, which is exactly what `true` claims. The timer firing
 * means the bound expired before the child settled, and `timedOut` is reported in the
 * failure line when it accompanies a non-zero ending. (This paragraph used to say a
 * timeout yields false; the code never had that arm. Ruling on debt 6.)
 * It still never throws: a teardown must not fail because a distribution is
 * unreachable. Fail-safe means "the teardown keeps going", not "the failure is
 * unobservable".
 * @param {{ distro: string }} plan - the execution plan.
 * @param {string} fifo - the FIFO path inside the distribution.
 * @param {{ wslPath?: string, username?: string }} select - distribution/user selection.
 * @param {number} [timeoutMs] - ceiling for the cleanup.
 * @returns {Promise<boolean>} whether the name is confirmed gone; false means it may still be on disk.
 */
async function removeFifo(plan, fifo, select, timeoutMs = DEFAULT_FIFO_UNLINK_TIMEOUT_MS) {
  try {
    // The postcondition travels with the command, so one spawn answers both halves: `rm -f`
    // cannot report a partial success on its own, and `test -e` is the distribution's own view
    // of the directory entry (not a host-side guess).
    const result = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: `rm -f ${shellQuote(fifo)} && test ! -e ${shellQuote(fifo)}`,
      loginShell: false,
      timeoutMs,
      ...select,
    })
    if (result.exitCode === 0) return true
    // ANY other ending is a removal that did not land: a non-zero exit is the ordinary refusal
    // (no such distribution is a 258, a permission failure is 1), `null` is a killed child, and
    // `timedOut` covers the bound expiring before the distribution answered.
    reportAlways(`removeFifo FAILED: distro=${plan.distro} fifo=${fifo} exit=${String(result.exitCode)} timedOut=${String(result.timedOut)} stderr=${JSON.stringify(String(result.stderr ?? '').trim().slice(0, 200))}`)
    return false
  } catch (error) {
    // The session is over and the distribution may be unreachable; there is nothing better to do
    // than leave it, and this must not fail a teardown.
    //
    // But it must not be SILENT either (R57). Swallowing the error made a failed removal
    // indistinguishable from a successful one. The return value is the success/failure half —
    // the caller below reports it — and this line is the diagnostic half, so the next occurrence
    // leaves a trace even if no caller reads the value.
    reportAlways(`removeFifo FAILED: distro=${plan.distro} fifo=${fifo} error=${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * The FIFO name pattern every session of this plugin uses, as a full path.
 *
 * The name carries a fresh uuid per allocation, so no later allocation reuses a name. It
 * ALSO carries the pid of the host process that allocated it (see `fifoNameFor`) — the
 * generation marker the sweep is built on.
 *
 * Kept as one literal beside the allocation below: a second spelling of the pattern is how
 * a sweep comes to delete the names it does not own, or to miss the ones it does.
 */
const FIFO_PREFIX = '/tmp/dsh-pty-'

/** The glob the sweep uses — the same prefix, widened to any session name and the .fifo suffix. */
const FIFO_GLOB = `${FIFO_PREFIX}*.fifo`

/**
 * The line that separates the sweep's two listing halves in ONE command's output.
 *
 * Not a path and not a candidate name — it carries no prefix and no `.fifo` suffix, so the
 * pair of filters that decides what is "a name this plugin allocates" rejects it even if the
 * split below were ever read wrong.
 */
const LEGACY_CUT_MARKER = '---dsh-pty-aged-cut---'

/**
 * The prefix one session's name must carry for the sweep to consider it this plugin's.
 * @param {string} name - a FIFO path.
 * @returns {boolean} whether the path is a name this plugin allocates.
 */
function isPluginFifoName(name) {
  return name.startsWith(FIFO_PREFIX) && name.endsWith('.fifo')
}

/**
 * The name one session allocates, WITH ITS GENERATION IN IT.
 *
 * The generation is the host process that allocated the session: `process.pid`. Embedding it
 * is what lets a sweep answer "is the host that owns this name still running?" instead of
 * guessing from the file's age.
 *
 * Age cannot answer that question. MEASURED on this machine: a FIFO's mtime is set by
 * `mkfifo` and never advances afterwards (nothing writes to the NAME; the control writer
 * opens it and writes through the descriptor), so every live session's name becomes "old"
 * two minutes after it starts, and an age rule unlinks live sessions' names. The names a
 * previous host generation left behind, meanwhile, are still held open by its bridges —
 * measured: two reparented-to-`/init` `terminal-bridge.py` processes an hour after the host
 * died, each holding its read end — so "no holder" is not the discriminator either.
 *
 * `process.pid` is the discriminator this host can actually observe: the owner's liveness.
 * PID reuse is possible, and the direction it errs in is SAFE — a reused pid makes an old
 * orphan look live, so its file survives and a later generation collects it. The unsafe
 * direction (a live session's name judged dead) would need the LIVE owner's own pid to
 * answer ESRCH, which is the one case the liveness probe does not produce.
 * @param {number} pid - the allocating host process's pid.
 * @param {string} [token] - the session token; a uuid slice unless a caller names one.
 * @returns {string} the FIFO path this session owns.
 */
function fifoNameFor(pid, token = randomUUID().slice(0, 12)) {
  return `${FIFO_PREFIX}${String(pid)}-${token}.fifo`
}

/**
 * The grammar of a name THIS version allocates.
 *
 * A name that does not match is a LEGACY name: written by a version that recorded no
 * generation — the shape the previous host generation left on this machine measured as
 * `/tmp/dsh-pty-6dfb5d61-157.fifo`. A legacy name has no owner field to test, so age
 * (`LEGACY_PROTECTION_MINUTES`) is the only protection its creation window can have.
 */
const GENERATION_NAME = /^\/tmp\/dsh-pty-(\d+)-[0-9a-f-]{12}\.fifo$/u

/**
 * Session names THIS host process allocated and has not finished tearing down.
 *
 * The authoritative "live" set of this module INSTANCE, and the reason a sweep cannot
 * unlink a live session's name: membership is checked BEFORE any other rule, so no age,
 * no pid test and no concurrent allocation can reach a name in here.
 *
 * The scope is the INSTANCE, and saying so is the point: a plugin reload evaluates this
 * module again, so the new instance's set starts empty, and its first sweep classifies the
 * previous instance's live names as "this generation, not live" (branch 2) and unlinks
 * them. That is residue, not damage — those sessions keep working through the descriptors
 * they already hold, and their own end-of-session `rm -f` is a no-op on a name that is
 * already gone — but "never removed" above holds within one instance's lifetime, not
 * across a reload. Sharing the set through a process global to make it reload-proof would
 * trade this stated residue for state that outlives every instance that could have owned
 * it; the narrower truth is the one this host can defend.
 */
const liveFifoNames = new Set()

/**
 * When each live name was registered, on THIS process's clock.
 *
 * The live set was an unbounded claim: a name entered it and left only through
 * `cleanupFifo().finally`. Measured consequence (live gate, 2026-10-19 17:23): a session
 * whose cleanup never ran left its name in the set for the rest of the process's life, so
 * branch 2 of the sweep — "this generation, not live" — could never classify it, and the
 * orphan was uncollectable by the very mechanism built to collect orphans (ruling R58).
 *
 * The bound is what makes the claim falsifiable. A live session re-registers nothing, so
 * this is NOT a heartbeat and must not be read as one: it is the moment the session began,
 * and the entry stops speaking for the session once a session has had long enough that its
 * continued existence is better explained by a missed cleanup than by a long shell.
 *
 * WHY THE BOUND CANNOT HIT A LIVE SESSION, stated as the two facts it rests on:
 *   1. The sweep only ever consults this set from INSIDE a new allocation, which is the one
 *      moment a fresh session is registered (see the registration site below). So the
 *      distance between "a name was registered" and "the sweep looks at it" is the distance
 *      between two ALLOCATIONS in one process, not the lifetime of a session.
 *   2. A name is removed from the set by its own `cleanupFifo()` whether the `rm -f` landed
 *      or not — that is the `finally` this bound backstops. So an expired entry is one whose
 *      cleanup never RAN AT ALL, which is the pathology, not the normal end.
 * The residual case is declared rather than hidden: a session older than the bound whose
 * cleanup genuinely has not run yet, and a second allocation in the same process inside the
 * same window, would let branch 2 unlink a name a LIVE session still holds. That costs the
 * name, not the session — the bridge and its control writer hold descriptors, and a FIFO's
 * inode outlives its directory entry (the same fact the sweep's own header relies on) — and
 * the failed control path is the only thing it can break, which is why the bound is measured
 * in hours rather than minutes.
 */
const liveFifoRegisteredAt = new Map()

/**
 * How long a live-set entry may claim its name is live without cleanup having run.
 *
 * Twelve hours: longer than any session this plugin is expected to hold open across a
 * working day, and short enough that a leaked entry is collectable within the next day's
 * first allocation. Deliberately NOT derived from any session timeout — the plugin has
 * none to derive from, and inventing a relationship would be a second, silent bound.
 */
const LIVE_FIFO_CLAIM_MS = 12 * 60 * 60 * 1000

/**
 * Whether a live-set entry still speaks for a session that is alive.
 *
 * Membership alone used to answer this, which is exactly the defect R58 names: an entry
 * whose cleanup never ran answered "live" forever. Now an entry answers "live" only while
 * it is both present AND younger than the claim bound; the sweep's branch 2 asks this
 * instead of asking the set directly.
 * @param {string} name - a FIFO path.
 * @param {number} now - the current host time, injectable so a test can age an entry.
 * @returns {boolean} whether this generation still claims the name for a live session.
 */
function isLiveFifoName(name, now = Date.now()) {
  if (!liveFifoNames.has(name)) return false
  const registeredAt = liveFifoRegisteredAt.get(name)
  // An entry with no timestamp is one a caller registered without the map (impossible through
  // `claimFifoName`, which is the only writer) — read it as expired rather than as eternal, so
  // the failure direction is "collectable", never "uncollectable forever".
  if (typeof registeredAt !== 'number') return false
  return now - registeredAt < LIVE_FIFO_CLAIM_MS
}

/**
 * Register one session's name as live, and release it.
 *
 * The pair exists so the two pieces of state — membership and registration time — can never
 * drift apart: a caller that remembered to add the name but not the timestamp would leave an
 * entry `isLiveFifoName` reads as expired, and a caller that released only the set would leak
 * the timestamp. `release` is the one place both are dropped.
 * @param {string} name - the FIFO path this session owns.
 * @returns {() => void} the release for exactly this registration.
 */
function claimFifoName(name) {
  liveFifoNames.add(name)
  liveFifoRegisteredAt.set(name, Date.now())
  return () => {
    liveFifoNames.delete(name)
    liveFifoRegisteredAt.delete(name)
  }
}

/**
 * The live-set entries the claim bound has expired, dropped before a sweep classifies.
 *
 * Dropping them is what turns the bound into recovery: an expired name becomes "this
 * generation, not live", which is precisely the branch that collects it. Bounded by the set
 * size, no clock read beyond one, and it only ever REMOVES claims — it cannot condemn a name
 * the set would otherwise protect.
 * @param {number} now - the current host time.
 * @returns {string[]} the names whose claims were dropped.
 */
function expireStaleLiveFifoClaims(now = Date.now()) {
  const dropped = []
  for (const name of [...liveFifoNames]) {
    if (isLiveFifoName(name, now)) continue
    liveFifoNames.delete(name)
    liveFifoRegisteredAt.delete(name)
    dropped.push(name)
  }
  return dropped
}

/**
 * Whether a host pid names a process that is still running.
 *
 * Signal 0 is the liveness probe: it delivers nothing and fails only when there is no such
 * process. ESRCH is the one answer that means "gone"; EPERM (a pid this process may not
 * signal) still names a LIVE process, so every other error is read as alive. That is the
 * conservative direction — an unreadable owner keeps its file.
 * @param {number} pid - a host process id.
 * @returns {boolean} whether that process is still running.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * The window a LEGACY name is protected for, expressed in the DISTRIBUTION's own clock.
 *
 * Not a lifetime, and not a guess about sessions: it is the width of the one WINDOW that
 * makes a name safe to remove. A session's FIFO is created by its bridge (`mkfifo`) and
 * opened by the control writer a moment later; between those two events the NAME is the only
 * thing connecting them, so a sweep inside that window would delete a name a session is
 * about to open. The window is a few hundred milliseconds of local work and two minutes is
 * two orders of magnitude above it.
 *
 * It is a number of MINUTES handed to `find -mmin`, deliberately: an earlier version read
 * the distro's mtimes with `-printf '%T@'` and compared them against the HOST's `Date.now()`
 * in this process, which is one comparison across two clocks. A distribution whose clock
 * lags the host by more than this window then made a name inside its own creation window
 * look old, and the sweep removed it — the exact damage the window exists to prevent (the
 * fixtures could not see it: `touch -t` sets the time explicitly, so no fixture depends on
 * the two clocks agreeing). `-mmin` keeps the whole comparison inside the distribution,
 * where both sides of it live.
 *
 * This applies to LEGACY names ONLY — names written by a version that recorded no generation.
 * A name carrying a generation is protected structurally: its owner is asked whether it is
 * alive, so its AGE is irrelevant and, deliberately, not consulted. Applying the age rule
 * there is exactly the defect this replaced: a FIFO's mtime never advances after `mkfifo`,
 * so every live session older than two minutes looked sweepable.
 */
const LEGACY_PROTECTION_MINUTES = 2

/**
 * Remove the FIFOs a PREVIOUS host generation left in this distribution.
 *
 * `removeFifo()` covers every session THIS host ends, on every path it can take, and the
 * live suites prove it. The gap it cannot cover is the host that never got to end a
 * session: a restart is not a teardown, so a session's bridge dies with the host and its
 * own `finally` (terminal-bridge.py) never runs. Measured on this machine after a restart:
 * two 0-byte `/tmp/dsh-pty-*.fifo` files from the previous generation, nothing responsible
 * for them — and, measured while this sweep was being written, the bridges that still held
 * them open inside the distribution outlived the host as well (their Windows parent was
 * gone, `/init` had reparented them).
 *
 * That second measurement is what rules out the obvious ownership test. "A FIFO no process
 * holds open is an orphan" sounds safe and collects NOTHING here: the previous generation's
 * bridge is still alive holding its read end, so every real orphan looks live.
 *
 * The rule is therefore a GENERATION rule, in three branches, each resting on a fact this
 * host can observe rather than on an assumption about what a name means:
 *
 *   1. the name carries THIS process's pid and is in `liveFifoNames` — a live session of this
 *      generation. NEVER removed, whatever its age (a FIFO's mtime never advances, so every
 *      session older than two minutes looks ancient);
 *   2. the name carries this process's pid and is NOT live — a session of this generation
 *      that has ended, whose own cleanup either ran (name gone) or failed. Removed;
 *   3. the name carries ANOTHER pid — that owner is asked, with signal 0, whether it still
 *      runs. Alive: left alone. Gone: the previous generation's orphan. Removed.
 *
 * A LEGACY name (no pid in it, written by a version that recorded no generation) has no owner
 * to ask, so `LEGACY_PROTECTION_MINUTES` is the only protection its creation window can have —
 * the rule the whole sweep used to apply, now narrowed to the only names still needing it, and
 * EVALUATED INSIDE THE DISTRIBUTION (`find -mmin`) rather than against this process's clock.
 *
 * Unlinking a name does NOT disturb a session that has already opened it: the bridge and its
 * control writer hold FILE DESCRIPTORS, and a FIFO's inode outlives its directory entry for
 * as long as any descriptor refers to it. That is why the failures here are leaks rather than
 * broken sessions. It is NOT what makes the rule safe — branches 1 and 3 are — and it is not
 * relied on as if it were.
 *
 * Fail-safe by construction, in `removeFifo()`'s own style — a sweep must never fail a
 * session that otherwise works:
 *   - BEST EFFORT: the whole probe is wrapped, and a throw is swallowed;
 *   - BOUNDED and CANCELLABLE: both wsl.exe spawns carry a ceiling AND the allocation's own
 *     AbortSignal, so a cancelled allocation cancels the sweep instead of waiting it out;
 *   - CONSERVATIVE: only this plugin's own prefix, only names this process can classify as
 *     dead, and an unreadable owner counts as alive;
 *   - IDEMPOTENT: `rm -f` on a name a concurrent sweep already removed is a no-op.
 *
 * PORTABLE ON PURPOSE. The listing is `find ... -print`, one of the predicates every `find`
 * carries; it is deliberately NOT `-printf '%T@ %p'`, which is a GNU extension whose failure
 * is silent once stderr is discarded (a busybox `find` answered the old command with nothing,
 * so the sweep collected nothing at all and looked like a clean distribution). The age half
 * is `-mmin`, which busybox carries too — and if a future `find` refuses it, the aged list
 * comes back empty, every legacy name is KEPT, and the failure is a leak rather than a
 * deletion. That is the direction this sweep is allowed to err in.
 *
 * COST, declared rather than hidden: one `wsl.exe` spawn to list, plus one more only when
 * something is actually removed — 1–2 per allocation. This host has no cheaper way to learn
 * what the distribution holds.
 *
 * The name list comes back to THIS process, which decides what to remove: a glob handed to
 * a shell would delete whatever matched at the moment it ran.
 *
 * ONE SPAWN, NOT TWO, and not because two are expensive: a LISTING and an AGED LISTING of the
 * same directory taken by two separate `find`s are two views of a directory a live allocation
 * is writing to. Both halves here come from one command, so a name can be in the listing
 * without the age answer having raced it — the only names the age half can silently omit are
 * ones that did not exist when it looked, which is the creation window itself.
 * @param {{ distro: string }} plan - the execution plan.
 * @param {{ wslPath?: string, username?: string }} select - distribution/user selection.
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - ceiling and cancellation.
 * @returns {Promise<string[]>} the orphan names it removed (empty when there were none).
 */
export async function sweepOrphanFifos(plan, select, options = {}) {
  const { timeoutMs = DEFAULT_FIFO_UNLINK_TIMEOUT_MS, signal } = options
  // A cancelled allocation has nothing to sweep FOR: answer before spawning wsl.exe.
  if (signal?.aborted === true) return []
  const pattern = FIFO_GLOB.slice(FIFO_GLOB.lastIndexOf('/') + 1)
  try {
    // ONE listing, TWO answers: every name, then — past a marker line — the subset the
    // distribution itself considers older than the legacy window. Both finds run inside the
    // distribution, so the age comparison never crosses a clock domain. The marker cannot be
    // mistaken for a name: it does not carry this plugin's path prefix.
    const listing = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: [
        `find /tmp -maxdepth 1 -name ${shellQuote(pattern)} -print 2>/dev/null`,
        `echo ${shellQuote(LEGACY_CUT_MARKER)}`,
        `find /tmp -maxdepth 1 -name ${shellQuote(pattern)} -mmin +${String(LEGACY_PROTECTION_MINUTES)} -print 2>/dev/null`,
      ].join('\n'),
      loginShell: false,
      timeoutMs,
      signal,
      ...select,
    })
    const allNames = []
    const agedNames = new Set()
    let inAgedHalf = false
    for (const raw of String(listing.stdout ?? '').split('\n')) {
      const line = raw.trim()
      if (line === LEGACY_CUT_MARKER) {
        inAgedHalf = true
        continue
      }
      if (!isPluginFifoName(line)) continue
      if (inAgedHalf) agedNames.add(line)
      else allNames.push(line)
    }
    const names = []
    // Drop expired live claims BEFORE classifying: that is what turns the bound into
    // recovery rather than a rule the loop merely consults (R58). A name whose cleanup
    // never ran is in here, and expires here, instead of being protected forever.
    const expiredClaims = expireStaleLiveFifoClaims()
    if (expiredClaims.length > 0) {
      termLog(`sweepOrphanFifos: expired ${String(expiredClaims.length)} live claim(s) in ${plan.distro}: ${expiredClaims.join(' ')}`)
    }
    for (const name of allNames) {
      const generation = GENERATION_NAME.exec(name)
      if (generation === null) {
        // LEGACY name: no owner to ask. Age is the only protection its creation window has,
        // and the DISTRIBUTION answered the age question (see LEGACY_PROTECTION_MINUTES).
        if (agedNames.has(name)) names.push(name)
        continue
      }
      const pid = Number(generation[1])
      if (pid === process.pid) {
        // Branches 1 and 2: this generation. The live set speaks here — but only through
        // `isLiveFifoName`, which bounds how long any entry may claim to be live (R58).
        // Asking the SET was the defect: an entry whose cleanup never ran answered "live"
        // forever, so this branch skipped the name on every sweep for the life of the
        // process and the orphan was uncollectable.
        if (!isLiveFifoName(name)) names.push(name)
        continue
      }
      // Branch 3: another generation owns the name; only its own liveness may condemn it.
      if (!isProcessAlive(pid)) names.push(name)
    }
    if (names.length === 0) return []
    if (signal?.aborted === true) return []
    // One rm for the whole set, each name QUOTED: the name grammar cannot carry a separator,
    // but the quoting keeps that a property of the command rather than of the generator.
    //
    // THE EXIT CODE IS INSPECTED HERE TOO, because the same blindness `removeFifo` had lives at
    // this call site: `runWslShell` resolves for any exit code, so returning `names` after an
    // `rm` that failed would report removals that never happened — and the names would be
    // claimed by the sweep's log while still sitting in the directory. Answering `[]` is the
    // honest value when the rm did not SUCCEED, and the caller treats the sweep as housekeeping
    // that may do nothing. It stays fail-safe: the failure is reported, never thrown.
    //
    // "[]" means "this sweep cannot claim these names", NOT "none of them was removed": `rm -f`
    // over a set reports ONE exit code, so a partial failure (say the first name refused, the
    // rest unlinked) is indistinguishable from a total one here. The names it could not account
    // for stay in the directory and the failure line names the whole set as still-claimed
    // orphans — the conservative direction, since a name that really was removed is simply gone
    // and the next sweep will not see it. (This comment used to read "(nothing was removed)",
    // which over-claimed for the partial case. Ruling on debt 7.)
    const removed = await runWslShell({
      distro: plan.distro,
      linuxCwd: '/',
      command: `rm -f ${names.map((name) => shellQuote(name)).join(' ')}`,
      loginShell: false,
      timeoutMs,
      signal,
      ...select,
    })
    if (removed.exitCode !== 0) {
      reportAlways(`sweepOrphanFifos: removal FAILED in ${plan.distro} exit=${String(removed.exitCode)} timedOut=${String(removed.timedOut)}; still claimed as orphans: ${names.join(' ')}`)
      return []
    }
    termLog(`sweepOrphanFifos: removed ${String(names.length)} orphan(s) in ${plan.distro}: ${names.join(' ')}`)
    return names
  } catch (error) {
    // A distribution that refuses the probe is not a reason to refuse the session: the
    // sweep's subject is housekeeping from a previous generation.
    termLog(`sweepOrphanFifos: skipped in ${plan.distro}: ${String(error?.message ?? error)}`)
    return []
  }
}

/**
 * Start one PTY session inside a distribution.
 * @param {object} options - spawn inputs.
 * @param {object} options.local - the host subprocess provider.
 * @param {{ distro: string, linuxCwd: string, windowsCwd: string }} options.plan - the execution plan.
 * @param {string} options.bridgeSource - the bridge program's source text.
 * @param {readonly string[]} options.argv - the program to run on the PTY.
 * @param {number} options.cols - initial columns, bounded to what the bridge can carry.
 * @param {number} options.rows - initial rows, bounded to what the bridge can carry.
 * @param {number} options.graceMs - kill escalation grace.
 * @param {Record<string, string>} [options.env] - environment for the spawn.
 * @param {AbortSignal} [options.signal] - allocation cancellation.
 * @param {string} [options.wslPath] - `wsl.exe` path.
 * @param {string} [options.username] - Linux user.
 * @param {number} [options.controlTimeoutMs] - control round-trip bound.
 * @returns {Promise<object>} the terminal handle.
 */
export async function spawnWslTerminal({
  local,
  plan,
  bridgeSource,
  argv,
  cols,
  rows,
  graceMs,
  env,
  signal,
  wslPath,
  username,
  controlTimeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
}) {
  // The size this handle frames, and the fallback every later request falls back
  // to: the last size the PTY was actually asked to take.
  let size = boundSize(cols, rows, { cols: DEFAULT_COLS, rows: DEFAULT_ROWS })
  // The name AND its generation, from one helper: a second spelling of either is how a sweep
  // comes to miss the names this process owns, or to own names it did not allocate.
  const fifo = fifoNameFor(process.pid)
  // The name is NOT in `liveFifoNames` yet: the registration sits below the sweep (see the
  // comment there). Registering it here would outlive the ONE await that can refuse this
  // allocation before anything exists (`requireBridgeRuntime`), leaving a live-set entry for a
  // FIFO that was never created and that no `cleanupFifo()` would ever remove.
  const select = { ...(wslPath !== undefined ? { wslPath } : {}), ...(username !== undefined ? { username } : {}) }
  /**
   * The session's ONE host-side FIFO removal, shared by every path that can end it.
   *
   * Both end paths reach here — the data-done handler (a bridge that exited or
   * was killed) and terminate()/the failed-allocation catch — and each used to
   * call removeFifo itself. Measured with a call counter across a full
   * verify-pty-handle run: EVERY one of the five sessions it drives called
   * removeFifo exactly TWICE, so "one extra wsl.exe spawn per closed session"
   * was wrong by a factor of two, on the killed and failed paths as much as on
   * terminate. Memoizing the promise makes the first caller the owner and every
   * other caller await the same settlement: one rm per session, no end path left
   * uncovered, and a path that throws before its own call still gets the
   * handler's.
   * @returns {Promise<boolean>} whether the single removal is confirmed to have landed.
   */
  let fifoCleanup
  /**
   * Release this session's live claim, once, whichever path gets here.
   *
   * Separate from `cleanupFifo` on purpose: the claim is about "a session of this instance
   * may hold this name", and it must stop being true when the session ENDS — not only when
   * the `rm -f` settles. Tying the release to the removal is what let a slow or failed
   * removal keep the name live (R58). The release is idempotent.
   */
  let releaseFifoClaim = () => {}
  const cleanupFifo = () => (fifoCleanup ??= removeFifo(plan, fifo, select).then(
    (removed) => {
      releaseFifoClaim()
      if (!removed) reportAlways(`cleanupFifo: the removal did NOT land for fifo=${fifo}; the name is released so a later sweep can collect it`)
      return removed
    },
    (error) => {
      // `removeFifo` answers rather than throwing, so this arm is unreachable through it —
      // kept so a future edit inside it cannot strand the claim.
      releaseFifoClaim()
      reportAlways(`cleanupFifo THREW for fifo=${fifo}: ${String(error?.message ?? error)}`)
      return false
    },
  ))
  termLog(`allocate: distro=${plan.distro} linuxCwd=${JSON.stringify(plan.linuxCwd)} windowsCwd=${JSON.stringify(plan.windowsCwd)} argv=${describeArgv(argv)} cols=${String(size.cols)} rows=${String(size.rows)} fifo=${fifo}`)
  await requireBridgeRuntime(plan, select)
  termLog('allocate: bridge runtime ok')
  // The other generation's orphans, swept at the one moment this process can classify them:
  // before it has allocated anything, so every name here belongs either to a previous host
  // generation or to this one's own earlier, ended session. AWAITED, so an allocation never
  // races its own sweep — and it cannot fail the allocation: sweepOrphanFifos swallows every
  // failure and answers the names it removed. The allocation's OWN signal goes with it, so a
  // cancelled allocation does not wait out two bounded wsl.exe spawns before noticing.
  await sweepOrphanFifos(plan, select, { signal })
  // Registered AFTER the sweep and BEFORE the bridge exists — the only window that satisfies
  // both halves. The sweep classifies this process's own pid too (branch 2 removes this
  // generation's ENDED sessions), so this name must not be in the set while it runs; and the
  // bridge creates the FIFO before it announces, so the name must be in the set before the data
  // spawn. It USED to sit before `requireBridgeRuntime`, which put a permanent entry in the live
  // set for a FIFO nobody created whenever that probe threw — an entry no `cleanupFifo()` runs to
  // remove, because no session ever existed. Nothing between here and the spawn can throw: the
  // sweep swallows its own failures.
  releaseFifoClaim = claimFifoName(fifo)

  const pending = new Map()
  let requestSeq = 0
  let replyBuffer = ''
  /** Last stderr lines from the data process — diagnostics for a dead bridge. */
  const stderrLines = []
  /** Set once the data process (the bridge) has settled; further requests fail fast. */
  let bridgeDown = false
  let started
  const startedPromise = new Promise((resolve, reject) => { started = { resolve, reject } })

  /**
   * Settle every outstanding control request with a failure. Used when the
   * bridge exits, so a pending request fails with the real cause instead of
   * burning its whole timeout, and after termination.
   * @param {string} message - the failure text.
   */
  function failPending(message) {
    const waiters = [...pending.values()]
    pending.clear()
    for (const waiter of waiters) waiter.reject(new Error(message))
  }

  const dataSpec = {
    argv: buildWslExecArgv(plan, ['python3', '-c', bridgeSource, fifo, String(size.cols), String(size.rows), ...argv], select),
    cwd: plan.windowsCwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    ...signal !== undefined ? { signal } : {},
    ...env !== undefined ? { env } : {},
  }
  const data = local.spawn(dataSpec)
  // EPIPE arrives as an ASYNC 'error' event on the stdin stream, not as a
  // synchronous throw — swallow it so a dead bridge's late write cannot become
  // an unhandled error event on the host process.
  data.stdin?.on?.('error', () => {})

  /**
   * Hand one parsed reply to its request, matched by the id the request wrote.
   * A reply whose request already timed out — or one the host never sent —
   * finds no entry and is dropped: id pairing is what keeps a late reply from
   * being consumed by the NEXT request and desyncing every later control op.
   * @param {object} reply - the decoded reply.
   */
  function deliver(reply) {
    if (reply.event === 'started') {
      started.resolve(reply)
      return
    }
    const waiter = typeof reply.id === 'string' ? pending.get(reply.id) : undefined
    if (waiter === undefined) return
    pending.delete(reply.id)
    waiter.resolve(reply)
  }

  const stderr = data.stderr
  if (stderr === undefined) {
    // This guard throws BEFORE the allocation try below, so it used to escape with
    // the data process still running — the very leak that try's catch exists to
    // prevent. Same cleanup, minus `control`: it is not spawned yet at this point,
    // and `control` is not even in scope here.
    try {
      data.terminate()
    } catch {
      // Already gone.
    }
    await Promise.allSettled([waitForHandle(data)])
    // The bridge may already have created its FIFO before this check; rm -f is a
    // no-op when it did not.
    await cleanupFifo()
    throw new Error('wsl-pty: 数据进程没有 stderr，无法承载控制应答')
  }
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk) => {
    replyBuffer += chunk
    while (replyBuffer.includes('\n')) {
      const index = replyBuffer.indexOf('\n')
      const line = replyBuffer.slice(0, index)
      replyBuffer = replyBuffer.slice(index + 1)
      // Bounded diagnostics: keep every data-process stderr line (bridge
      // tracebacks included), not only the prefixed control replies.
      const trimmed = line.trim()
      if (trimmed !== '') stderrLines.push(trimmed.length > 300 ? trimmed.slice(0, 300) : trimmed)
      if (stderrLines.length > 40) stderrLines.shift()
      if (!line.startsWith(REPLY_PREFIX)) continue
      try {
        deliver(JSON.parse(line.slice(REPLY_PREFIX.length)))
      } catch {
        // A malformed reply is dropped; the pending request times out instead.
      }
    }
  })

  // Declared before the settlement handler below, which terminates it: the
  // control writer must not outlive the bridge that answers its requests.
  let control = null

  data.done.then(
    (outcome) => {
      bridgeDown = true
      termLog(`data done: exit=${String(outcome.exitCode)} timedOut=${String(outcome.timedOut)} stderrTail=${JSON.stringify(stderrLines.slice(-8).join(' | ').slice(0, 600))}`)
      started.reject(new Error(`wsl-pty: 桥在报告会话之前退出（exit=${String(outcome.exitCode)}）`))
      failPending(`wsl-pty: 桥已退出（exit=${String(outcome.exitCode)}），控制请求不再有应答`)
      // Nothing can answer control requests any more, and the control writer
      // blocks on `read` with a host pipe that only terminate() closes — so
      // without this every finished terminal leaked one wsl.exe plus its
      // distribution-side bash, holding the FIFO.
      control?.terminate()
      // The bridge is gone, so its own finally either ran or was preempted by a
      // kill — and only this side can answer that by looking. Reaches the shared
      // removal on every session end, which is what covers the killed case.
      //
      // The claim is released HERE, not only inside `cleanupFifo`. This handler cannot
      // await (R57): it is a `.then` callback whose settlement nobody observes, so the
      // removal it starts is fire-and-forget by construction. The release is the part that
      // must not wait for it — a name held "live" by a removal that is still in flight (or
      // that failed) is exactly the residue R58 describes. `cleanupFifo` releases again;
      // the release is idempotent.
      releaseFifoClaim()
      void cleanupFifo()
    },
    (error) => {
      bridgeDown = true
      termLog(`data failed: ${String(error)}`)
      started.reject(error instanceof Error ? error : new Error(String(error)))
      failPending(`wsl-pty: 桥进程失败：${String(error)}`)
      control?.terminate()
      // Same host-side cleanup as the exited-bridge branch above: a FAILED data
      // process is the case where the bridge's own finally is least likely to
      // have run. Same release reasoning too.
      releaseFifoClaim()
      void cleanupFifo()
    },
  )

  try {
    // The bridge creates the FIFO before announcing the session, so the control
    // writer can safely be started only after that announcement.
    const announce = await withTimeout(startedPromise, controlTimeoutMs, 'wsl-pty: 桥没有报告会话')
    termLog(`announce ok: pid=${String(announce.pid)} pgrp=${String(announce.pgrp)} fifo=${fifo}`)

    control = local.spawn({
      // The writer must NOT be able to outlive the reader it exists for.
      //
      // Measured defect (2026-10-24, twice on one host): when the bridge died, the
      // data-done handler below called `control.terminate()`, which kills this
      // wsl.exe CLIENT — but the writer runs inside the distribution and was
      // reparented to /init, where its blocking `exec 3>"$1"` never returned. It
      // then held the FIFO forever, and because every allocation mints a fresh
      // random name no later session could reclaim it. The next terminal send
      // waited for a readiness signal that never came and surfaced as
      // `PTY send aborted before write`.
      //
      // A `bash` formulation CANNOT fix this, and that was measured rather than
      // assumed: `test -w` on a FIFO reports the permission BITS, not a live
      // reader, so a `[ -w ]` liveness loop passes immediately and then blocks
      // forever in `exec 3>"$fifo"` (measured: hung until an outer timeout at
      // 12004ms). Shell has no non-blocking open.
      //
      // So the open goes through python3, which IS already a hard prerequisite of
      // this path — requireBridgeRuntime refuses an allocation without it, so
      // using it here adds no new dependency. O_WRONLY|O_NONBLOCK turns "no reader
      // yet" and "no reader any more" into an ENXIO/CleanIO failure instead of an
      // indefinite block, which is exactly the property the orphan lacked.
      //
      // Measured on the shipped formulation: no reader -> exits in 15ms; live
      // reader -> both control lines delivered; reader vanishing mid-stream ->
      // exits within ~3.5s. The FIFO is also 0600 and created before the announce,
      // so a reader normally exists before this process starts.
      argv: buildWslExecArgv(plan, [
        'python3', '-c',
        'import os,sys\n'
          + 'try:\n'
          + '    fd=os.open(sys.argv[1],os.O_WRONLY|os.O_NONBLOCK)\n'
          + 'except OSError:\n'
          + '    sys.exit(0)\n'
          + 'try:\n'
          + '    for line in sys.stdin:\n'
          + '        os.write(fd,line.encode())\n'
          + 'finally:\n'
          + '    os.close(fd)\n',
        fifo,
      ], select),
      cwd: plan.windowsCwd,
      stdio: { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
      graceMs,
      // Wire the allocation signal to the control writer too: an abort after
      // the announce would otherwise leak the control process blocked on FIFO.
      ...signal !== undefined ? { signal } : {},
      ...env !== undefined ? { env } : {},
    })
    // Same async-EPIPE guard as the data process's stdin.
    control.stdin?.on?.('error', () => {})
    termLog('control spawned')

    /**
     * Send one control request and await its id-matched reply.
     * @param {object} payload - the control request.
     * @returns {Promise<object>} the bridge's reply.
     */
    function request(payload) {
      // A dead bridge can never answer: fail now instead of burning the whole
      // control timeout (the pre-fix symptom was a ~15s stall per op).
      if (bridgeDown) return Promise.reject(new Error(`wsl-pty: 桥已退出，${String(payload.op)} 无法执行`))
      return new Promise((resolve, reject) => {
        const id = `ctl-${requestSeq += 1}`
        const waiter = {
          resolve: (reply) => { clearTimeout(timer); resolve(reply) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        }
        const timer = setTimeout(() => {
          // Removed before rejecting: a late reply must find no entry, or it
          // would be mispaired with a later request.
          if (pending.delete(id)) waiter.reject(new Error(`wsl-pty: 控制请求超时（${String(payload.op)}）`))
        }, controlTimeoutMs)
        pending.set(id, waiter)
        try {
          control.stdin?.write(`${JSON.stringify({ ...payload, id })}\n`)
        } catch (error) {
          // The control writer died (EPIPE): fail this request now instead of
          // leaving it to the timeout.
          if (pending.delete(id)) waiter.reject(error)
        }
      })
    }

    return {
      pid: typeof announce.pid === 'number' ? announce.pid : 0,
      output: data.stdout,
      done: data.done,
      write: async (chunk) => {
        // A dead bridge's stdin pipe throws EPIPE on write — the caller
        // should see the rejection, not an unhandled error event.
        try {
          data.stdin?.write(chunk)
        } catch {
          // The bridge is gone; the terminal is already flagged disconnected.
        }
      },
      resize: async (nextCols, nextRows) => {
        const next = boundSize(nextCols, nextRows, size)
        const reply = await request({ op: 'resize', cols: next.cols, rows: next.rows })
        // Only a size the bridge accepted becomes the fallback: a rejected or
        // timed-out request must not rewrite what a later impossible value falls
        // back to.
        if (reply.ok === true) size = next
      },
      inspectForeground: async () => {
        const reply = await request({ op: 'foreground' })
        if (typeof reply.pgrp !== 'number') return undefined
        // A pipe gives no input-waiting signal; the group is reported as not waiting.
        return { processGroupId: reply.pgrp, inputWaiting: false }
      },
      inspectActivity: async () => {
        // 'dead' is outside the seam's union ('idle' | 'busy' | 'unknown'), and
        // the retention policy acts only on 'idle' — so an exited terminal was
        // never reclaimed: its record, xterm screen and control process stayed
        // for the host lifetime. The reference provider reports a finished
        // terminal as idle, and this one now says the same.
        if (bridgeDown) return { state: 'idle', revision: 0 }
        const reply = await request({ op: 'activity' })
        return {
          state: reply.state === 'idle' || reply.state === 'busy' ? reply.state : 'unknown',
          revision: typeof reply.revision === 'number' ? reply.revision : 0,
        }
      },
      signalForeground: async (name) => {
        const reply = await request({ op: 'signal', signal: name })
        return typeof reply.pgrp === 'number' ? reply.pgrp : 0
      },
      terminate: async () => {
        try {
          await request({ op: 'terminate' })
        } catch {
          // A bridge that already died needs no termination request.
        }
        control.terminate()
        data.terminate()
        failPending('wsl-pty: 会话已终止')
        await Promise.allSettled([waitForHandle(data), waitForHandle(control)])
        // AFTER both processes have settled, from the host side: the bridge's
        // own finally lost this race often enough to leave orphans behind.
        await cleanupFifo()
      },
    }
  } catch (error) {
    termLog(`allocate failed: ${error.message} stderrTail=${JSON.stringify(stderrLines.slice(-8).join(' | ').slice(0, 600))}`)
    // A failed allocation must not leak the processes it already started: an
    // abandoned bridge would sit on its PTY until wsl.exe tears the whole
    // session down, and repeated failures would accumulate such processes.
    try {
      control?.terminate()
    } catch {
      // Already gone.
    }
    try {
      data.terminate()
    } catch {
      // Already gone.
    }
    await Promise.allSettled([
      waitForHandle(data),
      control !== null ? waitForHandle(control) : Promise.resolve(),
    ])
    // A session that never came up can still have created its FIFO (the bridge
    // makes it before it announces), so the failed-allocation path cleans up too:
    // rm -f is a no-op when it was never created.
    await cleanupFifo()
    throw error
  }
}

/**
 * Bound one promise, reporting a named failure on expiry.
 * @param {Promise<any>} promise - the work to bound.
 * @param {number} timeoutMs - the bound.
 * @param {string} message - failure text.
 * @returns {Promise<any>} the result, or a rejection naming the timeout.
 */
function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Await a subprocess handle's exit, tolerating providers without the method.
 *
 * DELIBERATELY UNBOUNDED (review finding N5, ruling R76 - do not add a timeout). The awaits
 * that use it sit on paths whose contract is ORDERED: both processes must have settled before
 * `cleanupFifo()` runs, and that order is exactly what scenarios E2 and E1 pin. A ceiling here
 * would let the cleanup run while a process is still alive, which reintroduces the race those
 * rows exist to rule out - the removal would race a bridge that is about to create or hold the
 * name again. The bound this lacks is supplied ABOVE it: every caller has already signalled the
 * process, and every session carries its own grace and control timeouts, so the handles settle
 * on their own; a provider that never settles one is the case where waiting is the correct
 * behaviour rather than a hang to route around.
 * @param {object} handle - a host subprocess handle.
 * @returns {Promise<void>} settlement.
 */
async function waitForHandle(handle) {
  if (typeof handle.waitForExit === 'function') {
    await handle.waitForExit()
    return
  }
  await handle.done.catch(() => undefined)
}
