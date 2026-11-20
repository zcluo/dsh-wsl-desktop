# Compatibility and upgrades — dsh-wsl-desktop

This answers two questions: **which desktop versions this plugin can run on**, and **in what order to upgrade (and roll back) the desktop and the plugin**. It does not repeat the [distro support matrix](DISTRO-SUPPORT.md), which is the Linux side.

## How versions relate

The plugin decides whether a host is usable by probing capabilities at runtime, not by comparing version numbers: `bootstrap` returns `capabilities` (host probe plus client probe), `health` returns the distro checklist, and `verify-post-restart` compares the running manifest against the checkout byte for byte. A version number is a release label, not the contract.

| Plugin | Desktop | Status | Evidence |
|---|---|---|---|
| 0.7.6 | 0.2.2-rc.1 | measured | the contract surface is green: `verify-host-contract` 48/48 (all 10 `HOST_IMPORTS` exports resolve against the 0.2.2-rc.1 packages), `verify-modules` loads the entry against the real dependencies, `verify-client-ui` 48 + `verify-client-dom` 86, and the live host serves the client bundle with all 4 required markers (HTTP 200). Two host drifts are on record: `ui-primitives` moved its icons into `artwork.ts` (the `project-add-outline` and `folder-open(-outline)` symbol names are still there, and the trigger plus row icons accept both generations); and `fs-local`'s `writeFileAtomic` now wraps its first `mkdir` in a rethrow-only try (`8f798da97d`), for which the publication-sequence pin accepts both generations. The live gate did not run to completion: this profile has `developerTools: false`, `bootstrap` answers 401, so `verify-route` / `verify-post-restart` were not executed |
| 0.7.2 | 0.2.1-rc.3 | measured | 0.2.1-rc3's icon-sprite refactor (`ui-primitives` `c3eead771d`) made the W button disappear; this version identifies the trigger by sprite glyph and restores it. `verify-client-dom` / `verify-client-ui` green |
| 0.7.0 | 0.2.1-rc.2 | measured | this machine's live gate (`verify-all --live`) and `verify-post-restart`, all green |
| 0.6.0 | 0.2.1-rc.2 | measured | the full live gate at the 0.6.0 release |
| 0.7.2 / 0.7.0 / 0.6.0 | >= 0.1.7 | declared floor, not measured version by version here | 0.1.7 introduced runtime registration of the `wsl-*` presets; older hosts explicitly reject the plugin at activation (code behavior) |
| 0.7.2 / 0.7.0 / 0.6.0 | < 0.1.7 | unsupported | same: no runtime registration |

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

### The 0.2.2-rc.3 route-admission refactor (2026-11-12, `71753fdf91`) — the most expensive one

That commit changed three things at once. Any one of them would have broken this plugin; together they took down the **entire W dialog**:

| # | Change | Consequence for this plugin |
|---|---|---|
| 1 | Route registration gained an `auth` field whose **omitted default is `required`** | The webserver refuses before the handler; the development-token arm (`fenceRejection` lets it replace a 401) becomes **unreachable** |
| 2 | `connection.requestRejection()` was **removed** | The method the plugin called no longer exists — a `TypeError` even once admission passes |
| 3 | Authentication became its own service, `connection.authentication`, read *inside* `connection.admit()` | Cordis resolves a service property against the **calling** context, so a plugin that never injected the sub-service makes `admit()` throw from inside: `cannot get property "connection.authentication" without inject` |

**Why it was the most expensive**: the failure was **silent**. The host webserver's last-resort listener turns an escaping throw into an **empty-bodied 400** (`webserver/src/index.ts`: `dispatch().catch(() => res.writeHead(400)`), and the browser half's failed `json()` can only report that as `internal` with empty params. The dialog showed "plugin internal error" and **nothing anywhere pointed at the real cause**.

**Handling (from 0.8.1)**: the route declares `auth: 'anonymous'` so admission returns to the plugin's own fence; `connection.admit()` replaces `requestRejection` (it predates the change, so it works on both host generations); `inject` gains `'connection.authentication'`; the admission section of the handler is wrapped so a throw can no longer escape as an empty 400 but answers JSON carrying a `step`; the stack is written to `$DSH_HOME/wsl-desktop-route-error.log` (the browser never receives host messages, so that file is the only diagnostic channel); and `verify-modules` gained three source pins.

**The lesson matters more than the fix**: this path is **structurally invisible to the offline gate** — `verify-route` needs the development token, and the token path was itself blocked by defect #1, while `verify-post-restart` only compares client-bundle markers. It took a human clicking the W button once. During diagnosis, three successive reasoning-based edits each targeted the wrong place; only writing the exception to disk produced the answer in one step. **Changing code without evidence changes what you believe the bug is.**

### 0.2.2-rc.5: the module graph moved from an HTTP stream to a Remote service (2026-11-20)

The `/plugins/events` HTTP SSE endpoint was removed and the module graph is now served by `pluginEvents`, a `TypertRemoteService` (harness commit `bd1d6dcd0c`). **The plugin itself is unaffected**: on rc.5 `verify-route` passes and 56 of `verify-post-restart`'s host checks pass — preset generation, session binding, confinement, PTY, the Windows world staying unchanged, and the contract probe. What broke was **this repository's verification tooling**: `scripts/live-client.mjs` still read the path that no longer exists, so three suites reported "the plugin is not in the graph" when the truth was "no graph was read".

**Handling**: three outcomes, and only the middle one reddens.

| Outcome | Meaning | Behaviour |
|---|---|---|
| Graph readable, plugin present | normal | PASS |
| Graph readable, plugin absent | **a defect of this plugin** | FAIL |
| Graph unreadable (404 / refused / stream ended) | this host publishes no graph | **unmeasurable** — counted as neither a pass nor a failure |

`verify-live-env` (whose entire subject is the served client) and `inspect-live-client` therefore exit 2, each with a `DECLARED_SKIPS` entry naming that host's precondition; `verify-post-restart` marks only that group of six as unevaluated and prints why, leaving its other fifty-one checks to speak. **"Cannot measure" must not be reported as "is broken"** — the exact lie this repository keeps having to remove.

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
