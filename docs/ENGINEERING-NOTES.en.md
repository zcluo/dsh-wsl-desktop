# Engineering notes and measured constraints — dsh-wsl-desktop

This collects the engineering record the README does not carry: constraints that were all measured rather than inferred, a fatal delivery incident, and the sync script's retention rule. Since the README was rewritten as a user-facing entry document, the maintainer material that used to live only there — the install shape, the repository layout, the desktop update discipline, the release procedure and the capability evidence table — moved here as well. These are what a maintainer reads, not what a user reads.

## Key constraints (all measured, none inferred)

1. **Workspace paths must be in UNC spelling.** `packages/workspace/workspace/src/paths.ts:16-23` rejects POSIX paths `/home/...` as illegal on win32 (root === '/'); only `C:\…` and `\\server\share` pass.
2. **The plugin must live inside the profile directory.** The profile's module resolver routes `@deepseek-ai/*` to the installed generation only for modules inside the profile prefix; with `link:` outside the profile, all 7 harness packages report `Cannot find package`.
3. **Host plugin code cannot hot-reload.** Node caches modules by URL; reinstalling into the same directory still serves old code; hence the core logic is written as pure modules independent of the harness, verified by standalone Node scripts.
4. **9P sharing has no hard links.** `link()` reports `ENOTSUP`; `ReplaceFileW` / `SetFileSecurityW` are local-volume Win32 APIs, meaningless on a network share — all three are covered by `WslFileSystem`.
5. **`appendWindowsPath = false` is a common default.** Host programs are not on PATH; absolute `/mnt/c/Windows/System32/*.exe` paths are required (`hostExecutable()`).
6. **At client-plugin apply time, `<body>` may not exist yet.** The client half applies during document parsing, where `document.body` is `null`; `MutationObserver.observe(document.body, …)` then throws outright and the whole apply fails, leaving the UI silently unresponsive (the first W-button version tripped exactly here). The observation root must be `document.documentElement`, with a timer fallback in addition — relying on the observer alone assumes "there will always be a childList mutation", an assumption that does not hold.
7. **Client-half changes hot-update; host-half changes do not.** Rewriting the currently deployed generation's `lib/client.js` in place changes the delivery rev and pushes it to the page via `/plugins/events`, **no restart needed**; changing `lib/index.js` requires a restart. `scripts/inspect-live-client.mjs` reads the bundle the host actually delivers (in-memory cache; the on-disk file is not evidence).

## Delivery incident: the whole `exports["./client"]` block deleted

> ⚠️ **`exports["./client"]` is a hard contract and the easiest thing to delete while editing metadata.** The host's client-modules plugin is REQUIRED: one package that declares `dsh.client` without `exports["./client"]` refuses to compose, and the **whole desktop fails to start** (not just this plugin):
> ```
> DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate
>   client-modules: dsh-wsl-desktop declares dsh.client but exports no "./client" bundle
> ```
> The v0.2.0 "release readiness" metadata rewrite (`38e6356`) deleted the whole `exports` block, which is why 0.2.0 and 0.2.1 **cannot start at all once installed**; `main` is not a substitute — Node ignores it when resolving the `./client` subpath. `scripts/verify-modules.mjs` now pins this (`./client` and `.` both present, client entry distinct from the host entry, file present on disk, platform web), so running it before a release catches the regression. **`package.json` is part of the deployed surface** alongside `cordis.patch.yml` and `lib/`: `verify-post-restart.mjs` compares the running manifest against the checkout byte for byte.

## A fixed intermittent failure: verify-terminal

**Previously flaky → fixed, stable across many rounds**: `verify-terminal.mjs` used to fail intermittently (measured 1 in 6). The root cause was host-side `lib/wsl/pty.js`, not the bridge: the allocation-failure path did not terminate the already-spawned data process, and the leaked bridge interfered with later runs; control replies carried no request id, so after one timeout a late reply was consumed by the next request and the whole control channel misaligned from then on. Fix: the failure path terminates and waits for both processes to exit; every request carries an id, the bridge echoes the same id, timeout removes the entry first, and late replies are dropped outright. After the fix, a dozen-plus full-suite rounds today (including several back-to-back) reproduced nothing; the conclusion is stable.

## When a change takes effect: restart, hot reload, and the delivery rev

Host-code changes require **restarting DSH Desktop** to load; after a restart, run `verify-post-restart.mjs` first — when old modules are still in effect it reports "please restart" directly instead of giving a false green. **Browser-half changes need no restart**: rewriting the current generation's `lib/client.js` in place changes the delivery rev, and the change is pushed to open pages via `/plugins/events` (`patchReload: live`). `verify-post-restart.mjs` reads the live module graph from `/plugins/events` and fetches back the bundle actually delivered, to assert exactly this. **The rev is not updated instantly, though**: the host rebuilds a client bundle lazily, so reading `/plugins/events` immediately after an in-place rewrite still returns the OLD rev (measured: it changes a few seconds later). "The file changed" is therefore not "the served bytes changed" — a verification has to wait for the new rev, or it reaches the wrong "already deployed" conclusion.

## `sync.ps1`'s generation-retention rule

`sync.ps1` stages into a fresh timestamped directory each time (Node caches modules by URL; reinstalling into the same directory still serves old code; the stamp is second-resolution, so a second run inside the same second is bumped to a free name — the loader silently ignores a row id it has already mounted), and it **re-points the profile link at the generation it just staged**, rewriting the profile's `package.json` and `pnpm-lock.yaml` with it — otherwise the next `pnpm install` reconciles the link back to the manifest and "already staged" becomes a fiction. **The retention rule is "keep the two newest"**: the moment the link moves, "the linked generation" is the one nobody is running, while the running host resolves the one staged before it; keeping only the link would delete the generation in use on the next stage and break every WSL session until the next restart. When the link **cannot identify a generation** (the profile has no link at all, or its target is already gone) `sync.ps1` **keeps every generation and warns**, and a profile that has **never been staged into** (no `plugins/` directory at all) gets the same warning — with the link path spelled out, because that path is the only fact the reader needs. In that case it has merely put the files in place: nothing takes effect until the profile has this plugin installed (a first install is wired up by plugin_manager). The link is deleted through .NET rather than `Remove-Item`: Windows PowerShell 5.1 throws NullReferenceException on a junction, which aborted the re-point midway with the old generation still linked. `scripts/verify-sync.mjs` exercises all of this by running the real script against a throwaway profile (four scenarios: a link that resolves, a dangling link, no link, and never staged into — the last pinning that the warning names the link path).

## Install shape (what the published package looks like)

The plugin ships as an npm package shaped like mature plugins such as dsh-better-sidebar: `package.json`'s `files` is an **exact manifest** (`lib`, `cordis.patch.yml`, both READMEs, LICENSE), `cordis.patch.yml` is the bundle patch, `dsh.client.inject` names the host services the client half injects, and `manifestVersion` marks the metadata version. Installing `dsh-wsl-desktop@<version>` through the desktop's plugin market / plugin manager completes the pnpm wiring and the bundle-patch mount automatically; the CLI equivalent is `plugin_manager install_bundle dsh-wsl-desktop@<version>`.

The `dsh-wsl-confine` helper script, `lib/wsl/dsh-wsl-confine.sh`, ships with the package (it sits under `lib`, which `files` includes); install steps and the exact-version-match requirement are in [Confinement](CONFINEMENT.en.md).

The `wsl-*` presets this plugin registers are held by the plugin's own disposer lifecycle, which is why uninstalling through the plugin manager withdraws them along with it and leaves no workspace pointing at a plugin that no longer exists (this used to be only the README's uninstall line).

## Repository layout

```
lib/index.js            Host: routes, preset generation, session preset binding
lib/client.js           Browser: the W button next to the sidebar "+" + the add-WSL-workspace dialog
lib/wsl/paths.js        UNC ↔ Linux ↔ drive-letter translation (pure functions)
lib/wsl/world.js        Distro discovery, the wsl.exe execution core, directory facts
lib/wsl/shell.js        ShellExecutor implementation (WSL bash + confinement hookup)
lib/wsl/fs.js           LocalFileSystem subclass (9P backend + path dialects)
lib/wsl/publish.js      The overwrite publication's wait bound (retry + measured tail; pure module, independently testable)
lib/wsl/watch.js        Polling strategies for file watching (pure module, independently testable)
lib/wsl/subprocess.js   SubprocessRuntime implementation (pipes + terminal; delegates to the host subprocess)
lib/wsl/pty.js          Terminal handle: two processes driving the in-distro PTY bridge
lib/wsl/terminal-bridge.py  The PTY bridge running inside the distro (python3 stdlib, zero install)
lib/wsl/host-refs.js    Cross-module references to the host subprocess provider (required after realm isolation)
lib/wsl/confinement.js  Mount-namespace confinement (pure functions + probing, independently testable)
lib/wsl/fence.js        Containment comparison and writable-root derivation for the fs fence (pure functions, independently testable)
lib/wsl/preset.js       Preset rewriting (pure text, independently testable)
scripts/sync.ps1        Stages the plugin into the profile (then installed by plugin_manager)
scripts/env.mjs         Distro/user/home resolution for verification (no hardcoded machine identity)
scripts/verify-*.mjs    Standalone verification (no harness needed)
scripts/verify-all.mjs  Aggregates and runs all suites (--live adds the suites needing a running host)
```

## Desktop update discipline (mandatory)

After every DSH Desktop update the plugin may break, because harness internal APIs can change (0.1.6 → 0.1.7 broke four places in one go). The discipline: **update the desktop → run `node scripts/verify-post-restart.mjs` → only keep going when everything is green; any red gets fixed before anything else.** That suite covers preset registration, the execution world, session binding, Windows isolation and dialog contracts, so breakage from a new host shows up on these assertions instead of silently degrading into the host world. Per-suite responsibilities are in [Verification](VERIFICATION.en.md).

## Development loop

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # full offline run
.\scripts\sync.ps1                 # stage into the profile and re-point (developer mode: developerTools enabled; a first install needs the wiring first)
# restart DSH Desktop → verify-post-restart.mjs
```

Host-code changes require restarting DSH Desktop to load, and `verify-post-restart.mjs` runs first after the restart; browser-half changes need no restart, but "the file changed" is not "the served bytes changed" — see "When a change takes effect" below.

## Release procedure

Semantic versions mean something specific here: `patch` = defect fixes; `minor` = a compatible desktop-major adaptation (each harness-break adaptation bumps minor, e.g. the 0.1.7 adaptation inside 0.1.x); `major` = boundary semantics or support-matrix changes. **So when the desktop major changes, check first whether a matching minor exists.** Flow: bump the `package.json` version → full suites + `verify-post-restart.mjs` all green → `npm publish --access public` → git tag.

## Capabilities and evidence strength

The honest state after live acceptance (`verify-post-restart.mjs`, latest real run: **58 PASS / 0 FAIL**, tail `NO AUTOMATED FAILURES; 3 manual step(s) pending`, `EXIT=0`, including the two live search rows and the persistent-shell rows; **3 browser-only manual steps remain**, listed in [The persistent shell](PERSISTENT-SHELL.en.md#manual-verification-checklist-browser-only-not-automatable); plus 20 offline suites):

| # | Capability | Status |
|---|---|---|
| ① | The workspace can pick a Linux directory inside a WSL distro | Dialog and host calls implemented and live-verified (listDir/checkPath/resolveHome/workspace registration and cleanup); **in-browser interaction manually confirmed by the operator** (gating flow, directory browsing, and terminal panel all normal) |
| ② | shell / file tools / subprocess / terminal inside that workspace work in WSL, and host commands can be invoked from WSL | **Live acceptance PASS**: binding (the create request names the preset), shell inside the distro, fs tools addressing Linux paths, out-of-bounds write rejection, subprocess POSIX environment, bash tool, tool-layer constraints; terminal transport covered by the PTY suite. **The model's `bash` is a persistent PTY shell inside the distribution, keeping cwd and environment variables across calls** (live-verified: two calls read back the same state; the gap list is in [The persistent shell](PERSISTENT-SHELL.en.md)) |
| ③ | Windows and WSL workspaces coexist in the same instance | **Live acceptance PASS**: Windows workspaces stay on the host preset (PowerShell available, no bash); WSL sessions run the confined realm in parallel |
| ④ | Linux-side sandbox constraints on the WSL side | **Shell side fixed and live-verified**: at runtime, all `rw` mounts are enumerated and remounted read-only one by one (observed `/mnt/c`, `/dev/shm`, `/run/user/<uid>` going WRITABLE → READONLY); any failure rejects (exit code 97 preserved); `enforcement` honestly reports `partial`. **fs-side fence implemented and live-verified** (out-of-bounds write rejected, PASS — see [The fs tool fence](FS-FENCE.en.md)) |

**Which capabilities are qualified**: the evidence strength is the wording of the status column above. The terminal has no `stdio.control` — it is stated in [Terminal (PTY bridge)](PTY-BRIDGE.en.md) and in the README's "what will surprise you", not left out. The persistent shell's gaps are stated in the README too, with the authoritative list in [The persistent shell](PERSISTENT-SHELL.en.md).
