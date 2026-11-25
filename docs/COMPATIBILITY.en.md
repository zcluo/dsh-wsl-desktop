# Compatibility and upgrades — dsh-wsl-desktop

This answers two questions: **which desktop versions this plugin can run on**, and **in what order to upgrade (and roll back) the desktop and the plugin**. It does not repeat the [distro support matrix](DISTRO-SUPPORT.md), which is the Linux side.

## How versions relate

The plugin decides whether a host is usable by probing capabilities at runtime, not by comparing version numbers: `bootstrap` returns `capabilities` (host probe plus client probe), `health` returns the distro checklist, and `verify-post-restart` compares the running manifest against the checkout byte for byte. A version number is a release label, not the contract.

| Plugin | Desktop | Status | Evidence |
|---|---|---|---|
| 0.8.2 | 0.2.2-rc.5 (both the npm/tag build and the master build) | source-verified; **the live gate was not run against a tag-built desktop** | `inject` declares only `['webServer','connection']`, both of which a top-level plugin provides on either generation; admission goes through `admit` with a `requestRejection` fallback; `auth: 'anonymous'` takes effect on the new generation and is ignored on the published one. The offline gate pins the inject allowlist and the behaviour of all four admission-handle shapes |
| 0.8.1 | 0.2.2-rc.5 (master build only) | **withdrawn (defect)** | its `inject` named `'connection.authentication'`, a service only a master build provides; on every npm/tag host the plugin stays `pending` forever and `apply()` never runs. See "The fatal 0.8.1 defect" below |
| 0.8.0 | 0.2.2-rc.5 (npm/tag build) | source-verified; **the last release of this plugin that activates on a published host** | `inject = ['webServer','connection']` (provided by both generations) and admission calls `requestRejection` (every published generation still has it), so it is usable **only on the published generation**; the route declares no `auth`, and the master generation defaults an omitted one to `required`, so on a master-built desktop 0.8.0 is refused before the handler runs (that is exactly why 0.8.1 added `auth: 'anonymous'`). Downgrading is the right first aid only for a published-generation desktop |
| 0.7.6 | 0.2.2-rc.1 | measured | the contract surface is green: `verify-host-contract` 48/48 (all 10 `HOST_IMPORTS` exports resolve against the 0.2.2-rc.1 packages), `verify-modules` loads the entry against the real dependencies, `verify-client-ui` 48 + `verify-client-dom` 86, and the live host serves the client bundle with all 4 required markers (HTTP 200). Two host drifts are on record: `ui-primitives` moved its icons into `artwork.ts` (the `project-add-outline` and `folder-open(-outline)` symbol names are still there, and the trigger plus row icons accept both generations); and `fs-local`'s `writeFileAtomic` now wraps its first `mkdir` in a rethrow-only try (`8f798da97d`), for which the publication-sequence pin accepts both generations. The live gate did not run to completion: this profile has `developerTools: false`, `bootstrap` answers 401, so `verify-route` / `verify-post-restart` were not executed |
| 0.7.2 | 0.2.1-rc.3 | measured | 0.2.1-rc3's icon-sprite refactor (`ui-primitives` `c3eead771d`) made the W button disappear; this version identifies the trigger by sprite glyph and restores it. `verify-client-dom` / `verify-client-ui` green |
| 0.7.0 | 0.2.1-rc.2 | measured | this machine's live gate (`verify-all --live`) and `verify-post-restart`, all green |
| 0.6.0 | 0.2.1-rc.2 | measured | the full live gate at the 0.6.0 release |
| 0.7.2 / 0.7.0 / 0.6.0 | >= 0.1.7 | declared floor, not measured version by version here | 0.1.7 introduced runtime registration of the `wsl-*` presets; older hosts explicitly reject the plugin at activation (code behavior) |
| 0.7.2 / 0.7.0 / 0.6.0 | < 0.1.7 | unsupported | same: no runtime registration |

**A version number is not a build provenance.** The same `0.2.2-rc.5` label can name a package built from the release tag or one built from master, and the two have different host internals (see the next section). `engines.dsh` cannot express that difference and tightening the semver range does not catch it; the only durable rule is to depend on **nothing a published host does not provide**, and to record the measured binary's provenance next to every measurement.

Also: `engines.node >= 22.19` is the host Node floor; `manifestVersion: 1` is the plugin metadata version, not the desktop version.

## 9P workspaces on Windows

On a Windows host a session workspace can be spelled as the UNC path `\\wsl.localhost\<distro>\…`. That is a **9P** mount, and 9P **provides no Windows security descriptor** (measured: `Get-Acl` succeeds on local NTFS and on an SMB UNC `\\localhost\C$`, but returns Win32 1 for both local distros' 9P paths; reading and writing file contents in the same directory works normally).

The host-side Windows ACL sandbox therefore cannot run on such a workspace. The handling:

| Case | Behavior |
|---|---|
| `workspace-write` + 9P | Commands run, the tool result carries `enforcement: unconfined`, and it says plainly that this workspace has no fence and writes are ungoverned |
| `read-only` + 9P | Unaffected (read-only adds no capability ACE, so it never needs a descriptor) |
| `danger-full-access` | Unaffected (it does not go through the sandbox's `confine()` at all) |
| Non-9P local paths | Unchanged |

This is **not** a silent pass: the sandbox seam's contract forbids silent unconfined passthrough, so the downgrade must be declared as `unconfined`, visible to both the model and the user.

For a real fence, open the session with the WSL preset — there the fence runs **inside the distribution** and does not depend on Windows ACLs. If the host-side ACL runner is pointed at a 9P workspace directly, it refuses with an error that names the cause (exit 127) instead of a bare Win32 code.

## Upgrade order

**Desktop first, plugin second.** Reversing this produces a "plugin newer than host" intermediate: the host's module graph may lack a service the plugin injects, `bootstrap` lists the missing symbol under `capabilities.missing`, and the UI drops to the degraded card.

1. Upgrade DSH Desktop, restart.
2. Upgrade the plugin (plugin market / `plugin_manager install_bundle dsh-wsl-desktop@<version>`).
3. **Restart** the desktop. The host half caches modules by URL, so a reinstall without a restart keeps serving old code; a page refresh is enough for the client half.
4. Run `node scripts/verify-post-restart.mjs` (from the repository), or at least open the W dialog once and confirm:
   - `bootstrap` reports the target `pluginVersion`;
   - `capabilities.status` is not `degraded`;
   - the health strip renders and there is no `host-plugin-stale`.
5. For a development generation (a `sync.ps1` staged generation), also run `verify-all --live`.

**When "installed but nothing happens", read that one warning first.** If startup printed `warning: 1 entry did not activate` together with `pending (waiting for service: …)`, the plugin is waiting for a service this host never provides. That is not a WSL setup problem and not a distro problem: it means **this plugin version does not match this host**, and the only remedy is the plugin version that does match (the service named in `pending` is the clue). That is exactly how 0.8.1 died — it waited for `connection.authentication`, which no npm/officially-released desktop provides.

## Rollback

**Reverse order: plugin first, desktop second.**

- Plugin rollback: `plugin_manager remove_bundle dsh-wsl-desktop` → `install_bundle dsh-wsl-desktop@<older>` → restart.
- Desktop rollback: install the older desktop → restart → then downgrade the plugin to the version that matches it. The reverse (older desktop + newer plugin) usually surfaces as the degraded card or `host-plugin-stale`, not a usable intermediate.
- After rolling back, run `verify-post-restart` again: it trusts the running manifest and module graph, not any version claim.

## Host-drift history

0.1.6 → 0.1.7 broke four places in one go (preset registration, service access, module import, client injection); that is why this plugin requires `>= 0.1.7` and insists on runtime probing. Every later desktop-major adaptation raised the plugin minor: `0.5.1 → 0.6.0` (error catalog / health / contract) and `0.6.0 → 0.7.0` (full bilingual dialog, accessibility, release preflight). **When the desktop major changes, look for the matching plugin minor first**; do not upgrade the plugin blindly.

0.2.1-rc.2 → 0.2.1-rc.3 was a **field-level** host drift, not a major: `ui-primitives` moved the product icons into a document sprite (`c3eead771d`), so the "add workspace" button went from inline geometry

```html
<svg><path d="M5.54492 2.06738…"/></svg>
```

to a reference with no `<path>` child at all:

```html
<svg data-icon="dsw-icon-project-add-outline-regular"><use href="#…"/></svg>
```

The plugin identified that button by a **path-data prefix**, so it found no anchor and the W button stood down entirely (the degraded entry only appeared five seconds later). The same change also cost the workspace rows their folder-icon weight, because row icons no longer carry an inline `path` either — a collapsed row painted the solid cloud. From 0.7.2 the client recognises **both generations**: the geometry prefix (old) and the sprite glyph name `project-add-outline` (new), and reads the row's weight off the **symbol artwork** the row icon references. The lesson: a second identity for a host control must not merely cover the generations seen so far — `verify-client-dom` now runs the inline and sprite fixtures side by side.

### Two generations of route admission, and one "master read as a release" misjudgement

The host has **two** route-admission implementations, and the version string **cannot tell them apart**:

| Generation | `webServer` routes | Credential verification on `connection` | Found in |
|---|---|---|---|
| Published (old) | `WebRoute` carries only `kind`/`path`/`handler` — **no `auth` field**, no `webserver/authorize` event | a constructor-bound `BrowserAuth`; `admit()` and `requestRejection()` **coexist** | the **npm packages and tag builds** of every 0.2.1-rc.x and 0.2.2-rc.1…rc.5 |
| Master (new) | adds the `auth` field (**omitted ⇒ `required`**) and the `webserver/authorize` event | authentication moved into its own service, `connection.authentication`; `requestRejection()` removed | desktop binaries **built from master but still labelled `0.2.2-rc.x`**, and `0.2.3-alpha.*` |

This divergence comes from harness commit `71753fdf91` (2026-11-12, "centralize route admission with required policy"). It is **not** an ancestor of any of the tags `dsh-v0.2.2-rc.3`, `rc.4`, `rc.5` — on those tags `packages/client/connection/src/authentication.ts` does not exist at all. But the Desktop packaging workflow accepts master as its source, so this machine's `0.2.2-rc.5` desktop carries the **new** generation while the same version number downloaded from npm/the official site carries the **old** one. Same version, different code.

**Published-generation samples actually inspected** (reading `lib/types/rpc-host.d.ts` + `lib/index.js` from npm): `@deepseek-ai/dsh-client-connection` `0.2.1-rc.3`, `0.2.2-rc.1`, `0.2.2-rc.3`, `0.2.2-rc.4` and `0.2.2-rc.5` are **all** "constructor-bound `BrowserAuth` + `admit()` and `requestRejection()` coexisting + `inject = ['credentials']`", and none of them provides `connection.authentication`; `@deepseek-ai/dsh-host-webserver` `0.2.2-rc.3` and `rc.5` have neither the `auth` field nor the `webserver/authorize` event. That is the evidence base for 0.8.1's failure on every published host, and the reason 0.8.2 depends only on `admit` (present on both generations) with a `requestRejection` fallback for the older one.

**This was this repository's most expensive misjudgement.** A GUI check that failed on 2026-11-14 was recorded as "the rc.3 route-admission refactor", and 0.8.1 was written against that conclusion: declare `auth: 'anonymous'`, switch to `admit`, and **add `'connection.authentication'` to `inject`**. The first two hold on both generations; the third is pure loss — see the next section.

**The parts that DO hold (kept in 0.8.2)**: the route declares `auth: 'anonymous'` (hands admission back to the plugin's own fence on the new generation, ignored on the published one); admission goes through `rejectRequest()` in `lib/host/http.js` (`admit` first, `requestRejection` as the fallback); the admission section of the handler is wrapped so a throw can no longer escape as an empty-bodied 400 but answers JSON carrying a `step`; the stack is written to `$DSH_HOME/wsl-desktop-route-error.log`.

**Lesson 1 (evidence)**: the new-generation host turns an escaping throw into an **empty-bodied 400** (`webserver/src/index.ts`: `dispatch().catch(() => res.writeHead(400)`), and the browser can only report it as `internal`. During diagnosis, three successive reasoning-based edits each targeted the wrong place; only writing the exception to disk produced the answer in one step. **Changing code without evidence changes what you believe the bug is.**

**Lesson 2 (the more expensive one)**: **"it passes on this machine" is evidence only when you can name the build the measured binary came from.** Nobody recorded whether the desktop binary was built from the tag or from master, so generation A's behaviour was written down as generation B's compatibility verdict — and then became "fact" in the code, the comments and the verification pins. The way to establish it is to read the `lib/index.js` of the two host packages inside `app.asar`: on the `connection` package, `this.authentication = ctx["connection.authentication"]` or `new ConnectionAuthentication(ctx)` means the new generation while `browserAuth` means the published one; on the `webServer` package, `authPolicy(auth, request)` means the new generation. Both packages have to agree before the generation is decided.

### The fatal 0.8.1 defect: `inject` named a service no published host provides (fixed in 0.8.2)

0.8.1's `export const inject = ['webServer', 'connection', 'connection.authentication']` made the plugin **not activate on any published host** — not just on one version:

- Cordis treats `inject` as a **wish**, not a version gate: a service name nothing ever provides leaves the plugin fiber **permanently `pending`** — no error, `apply()` never runs, the route is never registered, and no `wsl-*` preset is registered;
- a published host keeps its credential verifier inside `connection` (a constructor-bound `BrowserAuth`), so **no 0.1.x/0.2.1/0.2.2 published package** provides `connection.authentication` (the only npm packages that do are `0.2.3-alpha.1` and `0.2.3-alpha.2` — the new generation listed above, which is exactly why 0.8.1 looked fine on a master-built desktop and was dead on every 0.2.2 published host);
- the only trace is one line — `warning: 1 entry did not activate` / `pending (waiting for service: connection.authentication)` — so the user sees a dead W button and `Unknown agent preset: wsl-standard`.

**Why the "must inject the sub-service" theory was wrong — and why it was also half right** (the second round of this correction, and an expensive one): the **mechanism** of `connection.admit()` really does go through the caller's context. The master generation stores `this.authentication` as a service and re-reads it inside `admit()`, and Cordis's traceable proxy rewrites that `this` into a shadow so the read **resolves against the calling fiber**. On the master generation the caller's own `inject` therefore **must** carry `connection.authentication`, or `admit()` throws `cannot get property "connection.authentication" without inject` from inside itself (reproduced on the real Cordis build: throwing every time when the module-level inject names only `connection`).

What was wrong was **where that requirement has to live**: it cannot go in the MODULE-LEVEL `inject` (that makes the plugin permanently `pending` on the published generation) but it must go in a FUNCTION-LEVEL `ctx.inject([...], fn)` — which starts a child fiber, where a missing service leaves only that child pending: the parent still runs `apply()`, still registers its route, and emits **no log noise at all** (measured: zero lines). Both generations are then satisfied at once:

| Generation | How `admit()` reads the verifier | Caller inject needed | What this plugin does |
|---|---|---|---|
| Published | a constructor-bound `BrowserAuth` field | no | the child fiber stays pending; the plugin's own `connection` handle is used |
| Master | the `connection.authentication` service (through the caller's context) | **yes** | the child fiber resolves and its own handle calls `admit()` |

**Handling in 0.8.2**:

- the module-level `inject` stays `['webServer', 'connection']` — only top-level services a **published** host really provides;
- `openAdmission(ctx)` (in `lib/host/http.js`) opens a `ctx.inject(['connection','connection.authentication'], …)` child fiber and, at request time, **prefers the child's handle** and falls back to the plugin's own only when the child never resolved; both paths end in `rejectRequest()`, so the accessor choice and the failure direction still live in one place;
- `rejectRequest()`: `admit` first (both generations), `requestRejection` as the fallback (published only), and an explicit throw when a handle exposes neither; an `admit` that answers anything outside `{ peer } | { rejection }` throws too — the failure direction is closed;
- `verify-modules`' regression guards: the `inject` allowlist (parsed with **both quote styles**; an element it cannot read reddens), `rejectRequest` driven behaviourally across the four handle shapes, every malformed `admit` answer required to throw, and `openAdmission` exercised in all three situations (child resolved / child never resolves / fallback handle has no accessor).

**Preventing a repeat**: the names in `inject` are now an **allowlist**, so anything "only master has" reddens immediately; and a live-gate measurement must record the **provenance of the binary under test**, otherwise the conclusion may only be stated as "this binary on this machine behaved so" and never as "this version behaves so".

### 0.2.2-rc.5: the module graph moved from an HTTP stream to a Remote service (2026-11-20)

The `/plugins/events` HTTP SSE endpoint was removed and the module graph is now served by `pluginEvents`, a `TypertRemoteService` (harness commit `bd1d6dcd0c`). **The plugin itself is unaffected**: on rc.5 `verify-route` passes and 56 of `verify-post-restart`'s host checks pass — preset generation, session binding, confinement, PTY, the Windows world staying unchanged, and the contract probe. What broke was **this repository's verification tooling**: `scripts/live-client.mjs` still read the path that no longer exists, so three suites reported "the plugin is not in the graph" when the truth was "no graph was read".

**Handling**: three outcomes, and only the middle one reddens.

| Outcome | Meaning | Behaviour |
|---|---|---|
| Graph readable, plugin present | normal | PASS |
| Graph readable, plugin absent | **a defect of this plugin** | FAIL |
| Graph unreadable (404 / refused / stream ended) | this host publishes no graph | **unmeasurable** — counted as neither a pass nor a failure |

`verify-live-env` (whose entire subject is the served client) and `inspect-live-client` therefore exit 2, each with a `DECLARED_SKIPS` entry naming that host's precondition; `verify-post-restart` marks only that group of six as unevaluated and prints why, leaving its other fifty-one checks to speak. **"Cannot measure" must not be reported as "is broken"** — the exact lie this repository keeps having to remove.

**Measured on rc.5 (2026-11-20)**: the offline gate 25/27 with no failures; the live gate 27/31 with four declared skips and no failures; the sidebar's W button confirmed working by hand. **The provenance has to travel with the verdict**: the measured desktop binary's version string was `0.2.2-rc.5`, but its host packages were the **master** generation (`this.authentication = ctx["connection.authentication"]` and `new ConnectionAuthentication(ctx)` in `dsh-client-connection/lib/index.js`; `authPolicy(auth, request)` in `dsh-host-webserver/lib/index.js`). So this record proves the plugin works on the **new-generation** host — it does **not** prove compatibility with the npm/tag rc.5, which is precisely what 0.8.1's `inject` killed and what issue #3 reports.

## Release preflight

`node scripts/release-check.mjs` at the repository root checks, before publishing: npm auth, the registry latest, whether the target version is already taken, local/remote tags, the working tree, pnpm's `minimumReleaseAge` window, and a privacy scan (secrets and machine paths in tracked files, test artifacts in the `npm pack` manifest). It is read-only and prints the next commands.

When `pnpm` is not on PATH (this machine's DSH ships only `pnpm.mjs`, with no `.cmd` shim) the preflight says exactly that instead of blaming the configuration; point `DSH_PNPM` at a shim or at `pnpm.mjs`, so no machine's path has to enter the repository.

**It also demands a live-gate receipt.** The reason is this repository's most expensive defect: on 2026-11-14 a host change broke every route method of the plugin while the **offline gate stayed green at 25/27** — `verify-route.mjs` had asserted exactly that all along, but the suite sits in `LIVE` and had never run. **The test was never missing; what was missing is a release path that required it.**

A release now needs the receipt produced by `node scripts/verify-all.mjs --live --receipt`, satisfying all three of: `liveRan === true`, `counts.failed === 0`, and a `version` equal to the target — the last one stops an older build's receipt from vouching for new code. Any missing condition blocks, and the blocker names the seam left uncovered.

### Reinstall order (do not uninstall outside the window)

When switching the profile back to a registry build after a release, **confirm the registry copy is installable before removing the installed one**:

1. Run `node scripts/release-check.mjs --version <target>`; it computes the `minimumReleaseAge` `readyAt`.
2. If the window is closed (`ready === false`), do **not** run `remove_bundle` — that leaves the profile with no plugin for up to an hour.
3. Once the window is open, do `remove_bundle` → `install_bundle <target>` → restart.

**`verify-post-restart` has to run BEFORE the switch, not after.** It and the whole live group call the route with the development token, and **the published package's `cordis.patch.yml` carries no `config` block, so `developerTools` is off** — after switching to the registry shape the token is refused with 401 and `presetStatus` and friends are not in the browser namespace at all. Measured on 0.8.1 (2026-11-15): running it right after the switch gives `HTTP 401（围栏拒绝或方法被移出浏览器命名空间）`.

The correct order is therefore: **run the live gate on the dev generation and keep its receipt, then switch to the registry shape**. Afterwards the only automatable claim left is "the bundle is installed and enabled"; the rest is manual — click W once and confirm the dialog lists the distributions. That is not a compromise but a difference between the two shapes: the dev generation opens a token surface the published one does not have.

The window is pnpm's supply-chain policy, not a bug; bypassing it means explicitly changing the profile's `minimumReleaseAge`, which lowers supply-chain protection and is a separate decision.

**Measured for 0.8.1 (2026-11-15)**: this profile does **not** configure `minimumReleaseAge` (`pnpm config get` prints `undefined`), yet pnpm still applied an age check — installing the freshly published 0.8.1 made it write `minimumReleaseAgeExclude: [dsh-wsl-desktop@0.8.1]` into `pnpm-workspace.yaml`. So an **effective default** exists, and its behaviour is **permissive**: without `minimumReleaseAgeStrict: true` it records the exclusion and proceeds instead of blocking (pnpm's own message: "set minimumReleaseAgeStrict to true to gate these updates with a prompt"). "Unset" is therefore neither "no window" nor a reason to block — `release-check` now reports `unset (pnpm default, permissive)` and lets the release through.
