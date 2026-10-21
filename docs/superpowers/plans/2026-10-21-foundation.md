# Foundation 0.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship A1 (readable failures), A2 (distro doctor), and C1 (host-contract layer) for dsh-wsl-desktop 0.6.0, with the repo's offline/live verification gates green.

**Architecture:** A pure protocol catalog + route-error classifier feed the host route and the browser dialog; a declarative contract manifest drives a runtime capability probe, feature-level degradation, an offline verifier, and a live post-restart probe; a read-only `health` method batches distro facts and reuses the cached runner/NNP probes. The browser gets both new methods via `bootstrap`/`health` and renders codes, remedies, a degraded phase, and an advisory health strip.

**Tech Stack:** Node >=22.19 ESM, zero runtime dependencies, custom `scripts/verify-*.mjs` suites, jsdom for browser behavior, `wsl.exe` for live rows.

**Spec:** `docs/superpowers/specs/2026-10-21-foundation-design.md`

## Global Constraints

- No new dependencies; `dsh.client.inject` unchanged; host floor stays 0.1.7.
- Browser responses: only `{ ok:false, code, params }`; never `error`/`message`/`stack`/stderr/host paths. `params` filtered by `SAFE_PARAMS`.
- New browser methods are read-only: `bootstrap`, `health`.
- All new user-facing copy is zh/en; default `en` when `navigator.language` is not `zh*`.
- Doctor is advisory: it never blocks creation.
- No change to fence/preset/provider execution semantics.
- TDD: the new suite/assertion fails first, then the implementation; every suite has at least one mutation proof (red on the named mutation, green after restore).
- Suites that can skip must exit 2 and be declared in `scripts/verify-all.mjs` `DECLARED_SKIPS` with a citation that resolves.
- Commits: `type(scope): sentence` in English, one task per commit range.
- Run suites serially (the repo's suites share machine state).

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `lib/protocol.js` | 1 | Pure catalog: codes, labels, remedies, safe params. |
| `lib/route-errors.js` | 1 | `WslRouteError`, classifier, browser envelope filter. |
| `lib/wsl/errors.js` | 1 | Typed domain errors carrying a semantic code. |
| `lib/wsl/world.js` | 1 | List/check/home probes use typed errors + missing marker. |
| `lib/host/contract.js` | 2 | Manifest + `probeHost` / `probeClient` + TTL cache. |
| `lib/index.js` | 3, 4, 7 | Route mapping, `bootstrap`, `health`, version/readiness. |
| `lib/wsl/doctor.js` | 4 | Batch script, parser, health assembly, cache. |
| `lib/client.js` | 5, 6, 7 | Catalog cache, degraded phase, health strip, floating entry, i18n. |
| `scripts/verify-protocol.mjs` | 1 | Catalog/classifier/params assertions. |
| `scripts/verify-world-errors.mjs` | 1 | Typed-error mapping with injected `run` (no WSL). |
| `scripts/verify-host-contract.mjs` | 2 | Manifest/code/import checks. |
| `scripts/verify-doctor.mjs` | 4 | Parser/cache/assembly; optional live row. |
| `scripts/verify-client-ui.mjs` / `verify-client-dom.mjs` | 5, 6 | Client source and jsdom behavior. |
| `scripts/verify-route.mjs` / `verify-post-restart.mjs` | 3, 7 | Live method reachability and post-restart probe. |
| `scripts/verify-all.mjs` | 1, 2, 4, 7 | Suite list and declared skips. |
| `scripts/verify-modules.mjs` | 1, 2, 7 | PURE/ALL module lists. |
| `scripts/verify-docs.mjs` | 7 | `DIAGNOSTICS` pair. |
| `docs/DIAGNOSTICS.md` / `.en.md` | 7 | User-facing error/doctor/degradation docs. |
| `README*`, `docs/ARCHITECTURE*`, `docs/UPSTREAM-PROPOSALS.md` | 7 | Pointers and stale-claim fix. |

---

### Task 1: A1 pure layer — protocol, classifier, typed world errors

**Files:**
- Create: `lib/protocol.js`, `lib/route-errors.js`, `lib/wsl/errors.js`
- Modify: `lib/wsl/world.js` (`listLinuxDir`, `checkLinuxPath`, `resolveDistroHome`)
- Create: `scripts/verify-protocol.mjs`, `scripts/verify-world-errors.mjs`
- Modify: `scripts/verify-all.mjs` (`STANDALONE`), `scripts/verify-modules.mjs` (`PURE`/`ALL`)

**Interfaces:**
- Produces `ERROR_CODES: Record<code, { zh, en, remedy, doc }>`, `FEATURE_IDS: string[]`, `FEATURE_LABELS: Record<id,{zh,en}>`, `CHECK_IDS: string[]`, `CHECK_LABELS: Record<id,{zh,en}>`, `CHECK_REMEDIES: Record<id, remedy>`, `SAFE_PARAMS: Record<code,string[]>`.
- Produces `class WslRouteError extends Error { code; params }`, `classifyRouteFailure(error, { discovery, ref })`, `browserFailure(error, { discovery, ref })`.
- Produces `WslDomainError { code }` used by `world.js`; codes: `distro-unreachable`, `user-unknown`, `path-not-found`, `path-not-directory`.

- [ ] **Step 1: Write `scripts/verify-protocol.mjs` (failing first).**

Assertions (use `makeChecker()` from `./suite-shell.mjs`, `pass:'PASS'`, exit 1 on failures):

1. every `ERROR_CODES` entry has non-empty `zh`, `en`, `doc`; `doc` starts `DIAGNOSTICS.md#`.
2. every `remedy` has a valid kind (`command` with non-empty `value` or valid `families` keys; `link` with `https://` or repo-relative `docs/`; `text` with non-empty `value`).
3. `FEATURE_IDS` equals the six ids `picker`, `preset-generation`, `session-create`, `terminal`, `search`, `selftest`; every id has both labels.
4. `CHECK_IDS` equals `bash, python3, util-linux, getent, runner, helper, nnp`; `CHECK_LABELS` and `CHECK_REMEDIES` cover every id and no extras.
5. `SAFE_PARAMS` keys are all real codes; unknown code in `new WslRouteError('nope')` becomes `internal` with a `ref`.
6. params filtering: `browserFailure(new WslRouteError('user-unknown', { user:'me', path:'/x', extra:1 }))` returns `{code:'user-unknown', params:{user:'me'}}` — no `path`, no `extra`.
7. classifier: `{timedOut:true}` → `distro-unreachable`; `{code:'ENOENT'}` with `discovery:true` → `wsl-not-available`; `{code:'ENOENT'}` without discovery → `internal` with `ref`; a `WslDomainError('user-unknown')` → `user-unknown`; a `WslDomainError('path-not-found')` → `path-not-found`; an unknown throw → `internal`.
8. `browserFailure` never returns `error`, `message`, or `stack` keys.

- [ ] **Step 2: Run it red.**

`node scripts/verify-protocol.mjs` → FAIL/throw: `lib/protocol.js` missing.

- [ ] **Step 3: Write `lib/protocol.js`.**

Use the 13 codes from spec §6.2 (`wsl-not-available`, `distro-unknown`, `distro-unreachable`, `user-unknown`, `path-invalid`, `path-not-found`, `path-not-directory`, `preset-not-ready`, `host-capability-missing`, `host-plugin-stale`, `too-busy`, `internal`, `transport`, `catalog-unavailable`). Freeze deeply. `SAFE_PARAMS`: `distro-unknown:['distro']`, `user-unknown:['user']`, `path-invalid:['path']`, `path-not-found:['path']`, `path-not-directory:['path']`, `preset-not-ready:['preset']`, `host-capability-missing:['feature']`, `host-plugin-stale:['method']`, `internal:['ref']`, everything else `[]`.

`CHECK_REMEDIES` per spec §6.1/§8.4; command remedies carry `families` for `bash`, `python3`, `util-linux` (debian/fedora/arch/alpine/suse).

- [ ] **Step 4: Write `lib/route-errors.js`.**

```js
export class WslRouteError extends Error {
  constructor(code, params = {}, options = {}) {
    const known = Object.hasOwn(ERROR_CODES, code)
    const finalCode = known ? code : 'internal'
    super(`route failure: ${finalCode}`, options)
    this.name = 'WslRouteError'
    this.code = finalCode
    this.params = finalCode === 'internal' && options.ref === undefined ? { ref: newRef() } : params
  }
}
```
`newRef()` = 6 lowercase hex chars from `Math.random` (not security-sensitive).
`classifyRouteFailure(error, { discovery = false, ref } = {})`:
- `error instanceof WslRouteError` → `error`.
- `error?.timedOut === true || error?.code === 'ETIMEDOUT'` → `new WslRouteError('distro-unreachable', {}, { cause: error })`.
- `error?.code === 'ENOENT' && discovery` → `new WslRouteError('wsl-not-available', {}, { cause: error })`.
- `error instanceof WslDomainError` → map `error.code` 1:1 (all four domain codes are protocol codes).
- default → `new WslRouteError('internal', { ref: ref ?? newRef() }, { cause: error })`.
`browserFailure(error, options)` classifies then filters params via `SAFE_PARAMS[code]`, stringifies and truncates values to 200 chars, returns only `{ code, params }`.

- [ ] **Step 5: Write `lib/wsl/errors.js` + modify `world.js`.**

`lib/wsl/errors.js`: `export class WslDomainError extends Error { constructor(code, message, options) { ... this.code = code } }`.

`listLinuxDir`: prepend `cd <path> 2>/dev/null || { printf '__DSH_LIST_MISSING__\\n'; exit 3; }`; if `exitCode === 3 && stdout.includes('__DSH_LIST_MISSING__')` throw `new WslDomainError('path-not-found', ...)`; other non-zero throw `WslDomainError('distro-unreachable', ...)`.
`checkLinuxPath`: keep returning facts; the route maps `exists:false` to `path-not-found` and `exists && !isDirectory` to `path-not-directory`.
`resolveDistroHome`: when `username` was supplied and the `getent` home is empty/invalid → `WslDomainError('user-unknown', ...)`; when the default user probe fails → `WslDomainError('distro-unreachable', ...)`.

- [ ] **Step 6: Write `scripts/verify-world-errors.mjs`.**

Use injected `run` (no WSL) to assert:
1. `listLinuxDir('d','/x',{run: async () => ({exitCode:3, stdout:'__DSH_LIST_MISSING__\n', stderr:''})})` rejects with `WslDomainError` code `path-not-found`.
2. non-zero without the marker → `distro-unreachable`.
3. success output `d\ta\0f\tb\0` → entries `[{name:'a',kind:'directory'},{name:'b',kind:'file'}]`.
4. `resolveDistroHome('d','ghost',{run: ...})` with empty getent stdout → `user-unknown`.
5. default-user probe failure (`id -un` empty) → `distro-unreachable`.
6. a normal user/home answer returns `{user,home}`.

- [ ] **Step 7: Run both suites green; add to the aggregator and module lists.**

`node scripts/verify-protocol.mjs && node scripts/verify-world-errors.mjs`.
Add both to `STANDALONE` in `scripts/verify-all.mjs`. Add `lib/protocol.js`, `lib/route-errors.js`, `lib/wsl/errors.js` to `PURE` and `ALL` in `scripts/verify-modules.mjs` (world.js is touched but already in `ALL`).

- [ ] **Step 8: Mutation proofs (record command + output in the report).**

- Delete one `en` field → `verify-protocol` red; restore.
- Add `extra` to `SAFE_PARAMS['user-unknown']` → param filter check red; restore.
- Remove the `__DSH_LIST_MISSING__` branch in `world.js` → `verify-world-errors` red; restore.

- [ ] **Step 9: Commit.**

`git add lib/protocol.js lib/route-errors.js lib/wsl/errors.js lib/wsl/world.js scripts/verify-protocol.mjs scripts/verify-world-errors.mjs scripts/verify-all.mjs scripts/verify-modules.mjs`
`git commit -m "feat(protocol): browser failures carry a catalog code and an actionable remedy"`

---

### Task 2: C1 pure layer — contract manifest, probe, verifier

**Files:**
- Create: `lib/host/contract.js`, `scripts/verify-host-contract.mjs`
- Modify: `scripts/verify-all.mjs` (`STANDALONE`, `DECLARED_SKIPS`), `scripts/verify-modules.mjs` (`PURE`/`ALL`)

**Interfaces:**
- Produces `FEATURES`, `HOST_SYMBOLS`, `HOST_IMPORTS`, `CLIENT_SYMBOLS`, `probeHost(ctx)`, `probeClient(ctx, symbols?)`, `resetContractCache()`, `resolveSymbol(root, entry)`.
- `probeHost` → `{ status:'ok'|'degraded'|'pending', features:{[id]:'ok'|'degraded'|'unknown'}, missing:[{id,feature,reason}], checkedAt }`.
- `probeClient` → same shape without `status:'pending'`.

- [ ] **Step 1: Write `scripts/verify-host-contract.mjs` red.**

Static checks (always):
1. `FEATURES` ids are unique; every `required`/`optional` id resolves in `HOST_SYMBOLS` or `CLIENT_SYMBOLS`.
2. every symbol has `id`, `feature`, `kind`, `path`; `id` unique; `feature` exists.
3. `HOST_IMPORTS` entries have `id`, `module`, `export`.
4. source usage: every `HOST_SYMBOLS` id appears in `lib/` source (read via `blankLiterals`); every `hostCtx.get('x')` and `serviceFor(agent, 'x')` in `lib/` source has a matching symbol (curated allowlist for `agents`, `agentPresets` in selftest).
5. `verify-client-ui.mjs` source check will pin client symbols later; here assert `CLIENT_SYMBOLS` covers `workspaces.list`, `workspaces.create`, `uiWorkspace.openSession`, `remote.session.create`.

Behavioral (fake ctx):
6. `probeHost(fake)` with all required present → `status:'ok'`, all features `ok`.
7. remove `agentPresets.readDocument` → `preset-generation` degraded, `status:'degraded'`, missing names the symbol.
8. `probeHost` called twice within TTL → same promise/result and one resolution count (use a getter counter).
9. unknown feature state: an `unprobeable` symbol does not degrade its feature.

Import checks when `DSH_WSL_DEPS`/`node_modules` resolves: for each `HOST_IMPORTS`, `await import(module)` and assert the export exists; otherwise `skip(n)` + exit 2, with a named precondition in `DECLARED_SKIPS`.

- [ ] **Step 2: Run red.**

`node scripts/verify-host-contract.mjs` → fails: module missing.

- [ ] **Step 3: Write `lib/host/contract.js`.**

Manifest exactly per spec §7.1. Add `kind: 'service'|'method'|'member'|'unprobeable'`. `api-session/added` is `unprobeable`.
`resolveSymbol(root, { path })`: first segment resolved as `root.get?.(seg) ?? root[seg]`; walk the rest; `present` requires every hop non-null; `function` check for `kind:'method'`.
`probeHost(ctx)`: 5s TTL, in-flight dedupe, `resetContractCache()` for tests. Compute required-feature status only for `picker`, `preset-generation`, `session-create`.
`probeClient(ctx, symbols)`: same walk without TTL.

- [ ] **Step 4: Run green; wire into aggregator/module list.**

Add to `STANDALONE`; add a `DECLARED_SKIPS` entry for the deps-missing precondition, citing the skip branch text (the table's stale check re-resolves it). Add `lib/host/contract.js` to `PURE`/`ALL`.

- [ ] **Step 5: Mutation proofs.**

Remove `agentPresets.readDocument` from `HOST_SYMBOLS` → the usage check red; add a fake `hostCtx.get('ghost')` to a temp copy → red; restore.

- [ ] **Step 6: Commit.**

`git commit -m "feat(contract): the host surface is declared, probed, and verified offline"`

---

### Task 3: Host wiring — route mapping, bootstrap, live gates

**Files:**
- Modify: `lib/index.js`
- Modify: `scripts/verify-route.mjs`, `scripts/verify-post-restart.mjs`
- Test: `scripts/verify-protocol.mjs` (envelope), live suites

**Interfaces:**
- `bootstrap()` returns `{ pluginVersion, catalog, capabilities }`; `catalog` = `{ codes, features, featureLabels, checks, checkLabels, checkRemedies, clientSymbols }`.
- `pluginVersion()` reads `../package.json` with `readFileSync(new URL('../package.json', import.meta.url), 'utf8')`.
- `presetReady` promise resolves after `materializePresets`; `probeHostWhenReady()` races it at 5s and returns `{status:'pending', features:{}, missing:[]}` on timeout.

- [ ] **Step 1: Extend `verify-protocol.mjs` with the envelope mapping test (red).**

Assert `browserFailure(new WslRouteError('too-busy'))` → `{code:'too-busy', params:{}}`; `browserFailure(new Error('boom'), {ref:'abc123'})` → `{code:'internal', params:{ref:'abc123'}}`; the result has no `error` key. (Classifier exists from Task 1; this locks the envelope.)

- [ ] **Step 2: Modify `lib/index.js`.**

- Import `browserFailure`, `WslRouteError`, `ERROR_CODES`, `FEATURE_IDS`, labels/remedies, `probeHost`, `CLIENT_SYMBOLS`.
- Add `BROWSER_METHODS`: `bootstrap`.
- Add `pluginVersion()` and `probeHostWhenReady()`.
- Route dispatch catch: `const envelope = browserFailure(error, { discovery: DISCOVERY_METHODS.has(method), ref: ... })`; browser → `{ok:false, code, params}`; dev → add `error`.
- `DISCOVERY_METHODS = new Set(['listDistros','defaultDistro','listDir','checkPath','resolve','resolveHome','wslPresetFor'])`.
- `wslPresetFor`: missing `agentPresets` → `WslRouteError('host-capability-missing',{feature:'preset-generation'})`; missing/broken variant → `WslRouteError('preset-not-ready',{preset})`.
- `checkPath`: `exists:false` → `WslRouteError('path-not-found',{path})`; `exists && !isDirectory` → `WslRouteError('path-not-directory',{path})`.
- `resolveHome`: let `WslDomainError('user-unknown')` classify.
- `bootstrap`: `{ pluginVersion: pluginVersion(), catalog: {...}, capabilities: await probeHostWhenReady() }`.

- [ ] **Step 3: Extend the live suites.**

`verify-route.mjs`: add browser-reachable rows for `bootstrap` (200, `ok:true`, has `catalog.codes`), and assert a browser caller still cannot call `execInWsl`/`selftest` (existing behavior). No new dev-token surface.
`verify-post-restart.mjs`: after the binding section, call `bootstrap` with the dev token; assert method present, version equals `package.json.version`, `capabilities.status==='ok'` and the host-scope required feature (`preset-generation`) `ok` (client-scope features are the browser probe's to answer), and the seven pinned codes exist. Missing preset-generation = FAIL naming it; terminal/search missing = WARN line (no red).

- [ ] **Step 4: Run offline suites green; run live only if a staged host is available.**

`node scripts/verify-protocol.mjs`, `node scripts/verify-all.mjs`. Live rows require the staged plugin + running host; if unavailable, note the exact commands for the operator and keep the offline gate as the task's evidence.

- [ ] **Step 5: Commit.**

`git commit -m "feat(route): browser failures return catalog codes and bootstrap exposes the probe"`

---

### Task 4: A2 — doctor probe, `health` method, suite

**Files:**
- Create: `lib/wsl/doctor.js`, `scripts/verify-doctor.mjs`
- Modify: `lib/index.js`, `scripts/verify-all.mjs`

**Interfaces:**
- `parseDoctorOutput(stdout)` → `Record<key,string>`; malformed line ignored; duplicate key last-wins.
- `healthFor({distro, username, run, wslPath, now})` → the spec §8.1 shape with `checks`, `ok`, `restricted`, `runner`, `cached`, `checkedAt`.
- `clearHealthCache()`.
- Route: `health({distro, username})` browser-reachable.

- [ ] **Step 1: Write `scripts/verify-doctor.mjs` red.**

Pure assertions:
1. parser: all seven keys with values; missing key omitted; malformed line ignored; duplicate last-wins.
2. `healthFor` with a fake `run` returning all commands present, `python3 3.10`, `nnp 1`, plus fake runner helper → `ok:true`, `restricted:true`, `bash` pass, `python3` pass, `util-linux` pass, `runner` pass.
3. missing bash → `ok:false`, `bash` fail.
4. missing python3 → `python3` warn, `ok:true`.
5. `nnp 0` → warn, `restricted:false`.
6. `detectRunner` null (fake run returns `no`) → runner warn, `restricted:false`.
7. cache: two calls same key within 60s → one `run` invocation; `clearHealthCache()` → two.
8. remedy per check is a valid shape and comes from `CHECK_REMEDIES`; no path/stderr in `detail` (test a fake `command -v` path string does not appear in the returned JSON).
9. malformed stdout (no keys) → checks `unknown`, `ok:true`, not a throw.

Live row (optional, exit 2 via `skip()` when `DSH_WSL_DISTRO` unreachable): call `healthFor` against the real distro and assert `checks.length === CHECK_IDS.length`.

- [ ] **Step 2: Run red.**

`node scripts/verify-doctor.mjs` → module missing.

- [ ] **Step 3: Write `lib/wsl/doctor.js`.**

Batch script exactly per spec §8.2 with `loginShell:false`, `timeoutMs:15_000`, one retry on `timedOut`. Reuse `detectRunner`/`detectNoNewPrivs` with `Promise.race` at 20s; resolved null semantics per spec. Compose checks in `CHECK_IDS` order; `restricted` = util-linux && runner && nnp pass. Cache key `${distro}\0${username??''}`, 60s, in-flight dedupe.

- [ ] **Step 4: Wire `health` in `lib/index.js`.**

Add to `BROWSER_METHODS`; validate distro/user grammar; map invalid distro/user to `WslRouteError`; call `healthFor`.

- [ ] **Step 5: Runner green + aggregator.**

Add suite to `STANDALONE`; add a `DECLARED_SKIPS` entry for the live-row precondition (only if the suite can exit 2; make the live row skip, not the whole suite).

- [ ] **Step 6: Mutation proofs.**

Remove the `bash` row from the assembly → suite red; make the cache key constant → cache assertion red; restore.

- [ ] **Step 7: Commit.**

`git commit -m "feat(doctor): a read-only health check reports the distro's prerequisites"`

---

### Task 5: Client — catalog rendering and degraded phase

**Files:**
- Modify: `lib/client.js`
- Modify: `scripts/verify-client-ui.mjs`, `scripts/verify-client-dom.mjs`

**Interfaces:**
- `bootstrap()` client call; `catalogCache` (5 min); `renderFailure(code, params)`.
- New phase `degraded`; `featureStatus` merged host+client.
- `clientCheck(symbols)` resolves `ctx` paths.

- [ ] **Step 1: Add static assertions (red).**

`verify-client-ui.mjs`: source contains `call('bootstrap'`; contains `degraded` phase; does not render `envelope.error` (assert the failure path reads `code`); contains `FEATURE_LABELS`-driven names or a `featureLabel(` helper; contains both zh/en catalogs (a `zh`/`en` pair in client copy).

- [ ] **Step 2: Add jsdom scenarios (red).**

In `verify-client-dom.mjs`, stub `dom.window.fetch` before `apply`:
- case A: bootstrap returns `{ok:true, value:{pluginVersion:'0.6.0', catalog:{...}, capabilities:{status:'degraded', features:{picker:'ok','preset-generation':'degraded','session-create':'ok'}, missing:[{id:'agentPresets.readDocument',feature:'preset-generation'}]}}}`; click the W button → a `[data-wsl-degraded]` card is present; record `fetch` bodies and assert no `listDistros` call.
- case B: bootstrap fails (reject) → clicking W shows a fallback error containing the code and still opens the dialog.
- case C: bootstrap returns an unknown code for a later failure → `internal` copy + the code text.
- The existing `apply` stub gains `remote.session`, `sessions`, `uiWorkspace.openSession`, `workspaces.create`, and a getter counter.

- [ ] **Step 3: Implement in `lib/client.js`.**

- `call()` unchanged; add `bootstrapOnce()` with cache + one retry.
- On W click: open dialog immediately; start bootstrap; if ready and picker required features degraded → `degraded` phase; else normal.
- `renderFailure(code, params)` uses the catalog; fallback table for `transport`, `catalog-unavailable`, `unknown-method`+bootstrap→`host-plugin-stale`; never reads `envelope.error`.
- Merge client feature status: `probeClient` over `catalog.clientSymbols` (path walk), same rule as host.
- zh/en copy table; `locale()` = `navigator.language` starts with `zh` ? `zh` : `en`.

- [ ] **Step 4: Run both client suites green; mutation proofs.**

Remove the `bootstrap` call → static red; render `envelope.error` → static red; force `degraded` false → dom red; restore.

- [ ] **Step 5: Commit.**

`git commit -m "feat(client): failures render from the catalog and a degraded host stays visible"`

---

### Task 6: Client — health strip, floating entry, a11y

**Files:**
- Modify: `lib/client.js`
- Modify: `scripts/verify-client-dom.mjs`, `scripts/verify-client-ui.mjs`

- [ ] **Step 1: Add assertions (red).**

- Browse phase renders a `[data-wsl-health]` strip; `health` called after home resolution with `{distro, username}`; summary shows pass/warn counts; a fail does not set the confirm button disabled.
- `health` failure renders `renderFailure` + a retry control; create remains enabled.
- Missing anchor after the 5s grace → `[data-wsl-fallback-entry]` button exists; click opens the dialog; its close removes it and it does not return after a re-sync; dispose removes it and clears the timer.
- Error container has `role="alert"`; loading line has `role="status"`; close restores focus to the W button.

- [ ] **Step 2: Implement.**

- `healthState`; fetch in parallel with `listDir` after `resolveHome`; abort/stale token.
- Strip: collapsed summary, expandable list, copy-remedy buttons.
- Floating entry: reuse the existing 5s anchor timer; `data-wsl-fallback-entry`; dismiss in memory; remove when the real anchor appears; clear timer on teardown.
- Focus restore: store the trigger element; on close, `trigger.focus()`.
- i18n for all new copy.

- [ ] **Step 3: Green + mutation proofs.**

Remove the health call → dom red; remove `role=alert` → static red; remove the timer clear → dispose test red; restore.

- [ ] **Step 4: Commit.**

`git commit -m "feat(client): the health strip is advisory and a missing anchor has a visible fallback"`

---

### Task 7: Docs, version, aggregator, full gate

**Files:**
- Create: `docs/DIAGNOSTICS.md`, `docs/DIAGNOSTICS.en.md`
- Modify: `README.md`, `README.en.md`, `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.en.md`, `docs/UPSTREAM-PROPOSALS.md`
- Modify: `package.json` (0.6.0), `scripts/verify-docs.mjs` (`DOC_PAIRS`), `scripts/verify-all.mjs` (final lists)

- [ ] **Step 1: Write `docs/DIAGNOSTICS.md` and its English pair.**

Sections: error code table (code, when, params, remedy), doctor checks and statuses, degradation matrix, privacy boundary, common fixes. Keep the paired files naming the same artifacts (verify-docs).

- [ ] **Step 2: Update pointers.**

README "会意外的地方": failures carry codes; the dialog has an advisory health check; link DIAGNOSTICS. ARCHITECTURE: a short "contract layer + degradation" paragraph. UPSTREAM-PROPOSALS: correct the A2 stale wording (the `serviceFor` wrapper is now in use).

- [ ] **Step 3: Version + pairs.**

`package.json` version `0.6.0`; `DOC_PAIRS` add `['docs/DIAGNOSTICS.md', 'docs/DIAGNOSTICS.en.md']`.

- [ ] **Step 4: Full offline gate.**

`node scripts/verify-all.mjs` → all suites green (declared skips allowed). Fix any red at its owner; do not weaken a check.

- [ ] **Step 5: Live gate where the environment permits.**

If the plugin is staged and the host is running current code: `node scripts/verify-all.mjs --live` and `node scripts/verify-post-restart.mjs`. If the running host still serves the previous generation, stage via `scripts/sync.ps1`, record that a desktop restart is required, and do not claim the live gate passed.

- [ ] **Step 6: Commit + tag.**

`git commit -m "docs(release): 0.6.0 explains codes, the doctor, and degradation"`
Do not tag or publish without the operator; record the release commands in the report.

---

## Verification Matrix

| Suite | Task | Offline? | Skip precondition |
|---|---|---|---|
| `verify-protocol.mjs` | 1 | yes | never |
| `verify-world-errors.mjs` | 1 | yes | never |
| `verify-host-contract.mjs` | 2 | static yes; imports need deps | `DSH_WSL_DEPS`/`node_modules` missing |
| `verify-doctor.mjs` | 4 | parser/cache yes; live row | no reachable distro |
| `verify-client-ui.mjs` | 5–6 | yes | existing icon-source skip |
| `verify-client-dom.mjs` | 5–6 | yes | existing jsdom skip |
| `verify-route.mjs` | 3 | live only | n/a (live list) |
| `verify-post-restart.mjs` | 3 | live only | n/a (live list) |
| `verify-all.mjs` | all | aggregate | declared skips only |

## Self-Review

- Spec coverage: A1 (§6) → Tasks 1/3/5; C1 (§7) → Tasks 2/3/5/6; A2 (§8) → Task 4/6; privacy (§6.7/§10) → Tasks 1/3/5; docs/version (§12) → Task 7; verification (§11) → Tasks 1/2/4 + Task 7 aggregate.
- No placeholders: each step names the file, assertion, or command; copy comes from the spec.
- Type consistency: `probeHost` returns `{status, features, missing}` in Tasks 2/3; `bootstrap.catalog` uses the same names; `healthFor` returns `restricted` in Tasks 4/6; `CHECK_REMEDIES` is the only source for doctor remedies.
