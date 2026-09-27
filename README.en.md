# dsh-wsl-desktop

English | [简体中文](README.md)

> **Production status: usable in production under controlled single-machine operation** (see the scope boundaries below). Requires **DSH Desktop 0.1.7+** (presets are registered at runtime rather than loaded from directories; an outdated host explicitly rejects at activation). Core capabilities have passed live acceptance; security audits run-1 (5 candidates, closed loop) and run-2 (4 confirmed fixed + 1 rejected, converted to hardening) are complete, with reports in `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`. Per-item evidence strength is annotated in the capability table below.
>
> **Scope boundaries**:
> - ✅ **Suitable**: the plugin author themselves or operators of the same trust level, for long-term use on explicitly supported distros (see "Distro support matrix") and a 0.1.7+ desktop.
> - ⚠️ **Conditional**: the confined-mode trust boundary depends on NO_NEW_PRIVS (modern debian-family setpriv satisfies it; on old setpriv builds without support, the fence can be pierced by the model's own sudo grant, see caveats).
> - ❌ **Not yet suitable**: distribution to third-party users (missing desktop version gating and distro matrix — see the production roadmap and `docs/DISTRO-SUPPORT.md`), or unattended high-value environments (the unconfined subprocess surface is a disclosed design; the two API proposals to the harness upstream are in `docs/UPSTREAM-PROPOSALS.md`).

## Desktop update discipline (mandatory)

After every DSH Desktop update, the plugin may break because of harness internal API changes (0.1.6→0.1.7 broke four places at once). **Discipline: update the desktop → run `node scripts/verify-post-restart.mjs` → only keep going when everything is green; any red gets fixed before anything else.** That suite covers preset registration, the execution world, session binding, Windows isolation, and dialog contracts; breakage from a new host shows up on these assertions instead of silently degrading into the host world.

## Target capabilities

**Honest state after live acceptance** (`verify-post-restart.mjs` all green + 10 offline suites; each item below notes its evidence strength):

| # | Capability | Status |
|---|---|---|
| ① | The workspace can pick a Linux directory inside a WSL distro | Dialog and host calls implemented and live-verified (listDir/checkPath/resolveHome/workspace registration and cleanup); **in-browser interaction manually confirmed by the operator** (gating flow, directory browsing, and terminal panel all normal) |
| ② | shell / file tools / subprocess / terminal inside that workspace work in WSL, and host commands can be invoked from WSL | **Live acceptance PASS**: binding (the create request names the preset), shell inside the distro, fs tools addressing Linux paths, out-of-bounds write rejection, subprocess POSIX environment, bash tool, tool-layer constraints; terminal transport covered by the PTY suite |
| ③ | Windows and WSL workspaces coexist in the same instance | **Live acceptance PASS**: Windows workspaces stay on the host preset (PowerShell available, no bash); WSL sessions run the confined realm in parallel |
| ④ | Linux-side sandbox constraints on the WSL side | **Shell side fixed and live-verified**: at runtime, all `rw` mounts are enumerated and remounted read-only one by one (observed `/mnt/c`, `/dev/shm`, `/run/user/<uid>` going WRITABLE → READONLY); any failure rejects (exit code 97 preserved); `enforcement` honestly reports `partial`. **fs-side fence implemented and live-verified** (out-of-bounds write rejected, PASS — see "The fs tool fence") |

## Session binding: name the execution world in the create request

The harness fixes the preset at session **creation** (`SessionCreateRequest.agentPreset` → `composeAgent`'s `setup: presets.mount(...)`; the mount happens before the session is published). Calling `agentPresets.select` after the fact only works on sessions that "have not run any turn yet"; once a session has had a turn it is rejected with `agent-preset/locked` — and that rejection is only written to an in-memory log, never reported to the user.

**The current implementation is built around exactly this fact**:

- When creating a session in the W dialog, the browser half first calls the host's `wslPresetFor` to resolve the variant id, then puts `agentPreset` into the **create request** (`commit()` in `lib/client.js`). This is the only race-free seam: the preset is composed together with the session, so there is no window of "first run in the Windows world, then switch".
- The host half keeps an `api-session/added` listener (`bindWslSession` in `lib/index.js`) as a **fallback**: it only handles sessions whose "cwd is a WSL path but the creation carried no preset" (for example, sessions created from another entry point). It attempts a post-hoc `select`; on success it binds retroactively, on failure it writes `bindingLog` and warns in the host log — such entries are now **anomaly signals**, no longer part of the normal path.
- The binding section of `verify-post-restart.mjs` therefore reads: a non-selftest `bindingLog` entry = someone created a WSL session while bypassing the creation seam; zero entries = every session bound through the create request is fine. Final GUI-side confirmation has been done by the operator (session preset shows WSL · PTC mode; tools execute inside the distro).

## UI entry point

In the sidebar workspace title bar, to the right of the built-in "+" (add workspace), there is an extra **W** button; clicking it opens this plugin's workspace dialog: pick a distro → enter the user → browse or type a Linux directory → create and open a session.

After a distro is selected, the dialog **first asks for the user to enter that distro with** (leave empty = the distro's default user); only after confirmation does browsing begin: the path lands directly in that user's home directory (the host resolves the user database inside the distro with `getent passwd`, method `resolveHome`). If the entered user does not exist, the error is shown in place in the popup, without entering browse mode. Switching distros — including re-clicking the currently selected one — re-prompts for the user, prefilled with the previously confirmed name. While a session creation is in flight, distro buttons are temporarily unclickable (the outcome of a submit belongs to that submit). Once inside browse mode, the home directory is an ordinary path — the input box, go-to, breadcrumbs, and directory clicks all work as usual. To be precise about the boundary: this step only decides "whose home gets browsed", **not the session identity** — the session always executes inside the distro as the distro's default user (`username` is plugin configuration and is not passed along with session creation).

"+" keeps the deployment's own behavior (the Electron directory picker on Desktop); this plugin does not override it:

- `sidebar.workspaces.directoryFlow` is `kind: 'single'`, and the placeholder would **shadow** the deployment's own directory picker, so this plugin does not register that slot;
- The sidebar title bar has no extension point, so the W button attaches as a companion node right after the "+" button: it locates itself by the SVG path geometry of the "add workspace" icon (language-independent; this icon is rendered in exactly one place in the app) and reuses that button's class to inherit the same size and hover states. The desktop once rebuilt that icon (`IconProjectAddOutline16` → `ProjectAddOutlineArtwork`, geometry completely changed), so the trigger carries a **known list of both old and new geometry generations** and prefix-matches either one — a desktop update will not make W silently disappear. When React replaces that subtree, a MutationObserver re-attaches W.
- **Hiding must use `display`, never `remove()`.** The observer watches `childList`, and `remove()` is itself the next trigger; the two feed each other at refresh rate (measured: 52 times in 2.6s, each with two forced layouts). When there is no room, set `display: none` — it is not a childList mutation, so it converges.
- **Never use a timer as a fallback.** A past `setInterval(sync, 2000)` was the seed of exactly this loop; remounts/portals are childList mutations on the observed subtree, and a timer solves no real situation.
- The companion button only shows while "+" is visible (when inline search expands, it hides together with the official action cluster); when a second control carries the same icon geometry, the one inside the `*_headerActions` cluster wins; when nothing can be recognized, the button stands down entirely rather than guessing.

## Terminal (PTY bridge)

`wsl.exe` has only three pipes — it is not a terminal; meanwhile `SubprocessTerminalHandle` also demands `resize` / `inspectForeground` / `signalForeground`. So the PTY is allocated **inside the distro**, and the host side drives it with two processes:

```
data process    wsl.exe -e python3 -c <bridge> <fifo> <cols> <rows> <shell…>
                stdin/stdout = terminal bytes           stderr = one JSON control reply per line
control process wsl.exe -e bash -c 'exec 3>"$fifo"; while read -r l; do printf "%s\n" "$l" >&3; done'
```

The bridge allocates a PTY with `pty.fork()`, pumps the master and the pipe pair, and implements `resize`/`foreground`/`activity`/`signal`/`terminate` as a JSON line protocol over the FIFO. **Every control request carries an id, and the bridge echoes the same id in its reply**; the host pairs by id: on timeout the entry is removed first, and late or unowned replies are dropped outright — otherwise, after one timeout, a late reply gets consumed by the next request and the whole control channel is misaligned from then on (this is exactly one of the mechanisms behind the old `verify-terminal.mjs` flakiness). Host-side cleanup contract: on announce timeout or control-process start failure, terminate the two already-spawned processes and wait for their exit (the old version leaked the data process and PTY session here); once the bridge exits, pending and subsequent control requests fail immediately instead of waiting out the full control timeout. **Zero install inside the distro** (python3 standard library only).

Residual limitation: when the host process is hard-killed (SIGKILL-level), the bridge's `finally` never runs and `/tmp/dsh-pty-*.fifo` survives until the distro restarts; on the next allocation the bridge unlinks a same-named FIFO first, so this is temporary garbage only and does not affect behavior.

Two measured preconditions:

- **The control process must start only after the bridge reports the session**, because `open` fails outright before the bridge creates the FIFO. The bridge creates the FIFO before `_spawn()` and makes this timing observable via the `started` reply.
- **Programs that query the terminal from rc hang the whole session.** Some distro users' `~/.bashrc` ends by launching programs that query the terminal (e.g. `fastfetch`); they wait for a reply that only a terminal emulator would give, and in headless verification there is no replier, so the prompt never appears. In the real web terminal, xterm.js does reply, so this is a problem of the verification environment, not a bridge defect — the verification shell is therefore pinned to `bash --noprofile --norc -i`, so that verification tests the bridge, not the user's rc.

PTC's `stdio.control` (fd channel) remains explicitly rejected: `wsl.exe` cannot forward arbitrary descriptors.

## Known limitation: the grep / glob tools

`tool-fs-search` is launched via `ctx.subprocess.spawn()` (`search-core.ts:238`), but its argv[0] is the **bundled Windows rg.exe** from `@vscode/ripgrep` (`search-core.ts:174-178`) — it does not exist inside the distro and cannot work with Linux arguments. So the WSL preset removes it from the execution world, and the model in a WSL session can only use bash's `grep` / `find` (both present in the distro). This is a capability regression, not an omission — making it equivalent would require giving the WSL world its own search implementation.

**The preset needs no terminal registry lines.** The sidebar terminal panel goes through `agent.ctx.get('subprocess').spawnTerminal(...)` (`packages/api/terminal-controller/src/index.ts:333,346`) — session-scoped, so the realm's `subprocess-wsl` automatically puts the PTY inside the distro. An isolated `terminals` group would only serve the model's persistent shell tool, and this preset does not mount it; one more registry + backend pair only adds mount-failure surface, so it is not added.

## Architecture

**The execution world is decided by the session's agent preset.** `ctx.shell` / `ctx.fs` / `ctx.subprocess` are process-level singletons, and the Windows and WSL tool dialects differ (pwsh vs bash), so coexistence is achieved not by "a global provider that routes by path" but by the preset's `isolate` realm:

```
Windows workspace session                 WSL workspace session
  preset: standard                          preset: wsl-standard
  ctx.shell = pwsh-sandbox (host)           isolate: { shell, fs }
  ctx.fs    = fs-sandbox (host)             ├─ shell-wsl  → ctx.shell
                                            ├─ fs-wsl     → ctx.fs
                                            ├─ tool-bash / tool-fs
                                            └─ ctx.subprocess inherits the host's subprocess-local
```

`wsl.exe` itself is an ordinary Windows process, so the WSL executors launch it through the **inherited** `ctx.subprocess` — the realm isolates only `shell` and `fs`; managed-process termination, output overflow, and reaping still belong to the local provider.

**The execution world is named in the create request.** When the browser half creates a WSL session, it writes the variant id into `agentPreset` via `wslPresetFor`; the host half only does fallback + warning in `api-session/added` for "WSL-path sessions without a preset" (see "Session binding"). The browser half therefore depends on nothing beyond the preset client API.

## Confinement (Linux side, M2)

The host's `ctx.sandbox` cannot wrap `wsl.exe` (the child runs on the Linux kernel side), so confinement happens **inside the distro**: within a mount namespace, `/` is made read-only, leaving only the workspace and a private `/tmp` writable.

```
workspace-write:  bind <workspace>  →  tmpfs /tmp  →  remount,ro,bind /
read-only:        tmpfs /tmp        →  remount,ro,bind /
```

The order is load-bearing: **bind the writable paths first, then remount the root read-only**. The other way around, new binds inherit the read-only state (verified: workspace writes fail).

Two preconditions established by measurement:

- **Must be root.** The WSL kernel refuses bind mounts inside a user namespace: `unshare -Ur --mount` starts, but `mount --bind` reports "wrong fs type". So `sudo -n unshare …` is used; without passwordless sudo, confined mode **fails explicitly** (`SandboxUnavailableError`) instead of running bare.
- **sudo grants retained after dropping privileges are a known boundary of the fence — two closing paths.** The session user keeps the passwordless sudo grant that the runner itself depends on — a confined command can re-invoke it (open a fresh `sudo -n unshare --mount` without the fence script, or run `sudo -n mount -o remount,rw /` inside the fence), thereby bypassing the file fence. Closing paths (by priority):
  1. **Dedicated helper (recommended, one-time install)**:
     ```bash
     # run as root inside the distro (adjust the path to the actual install location)
     install -m 0755 -o root -g root /mnt/c/Users/<you>/.dsh/profiles/desktop/plugins/dsh-wsl-desktop-*/lib/wsl/dsh-wsl-confine.sh /usr/local/sbin/dsh-wsl-confine
     echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *" > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
     ```
     As root, the helper **always applies the full fence first**, then drops privileges and executes the command — re-invocation just re-fences from an already-fenced context, and parameter games (workspace='/') are defeated by the `/ is not read-only` postcondition. The plugin auto-detects and prefers the helper (the sudoers file authorizes only this one file).
  2. **NO_NEW_PRIVS (automatic; the mitigation when no helper exists)**: when dropping privileges, the runtime probes for `setpriv --no-new-privs` support (modern debian-family setpriv satisfies it; verified `noNewPrivs: true` active) — setuid escalation inside the fence fails loudly. On old setpriv builds without that flag, this boundary still exists — honestly recorded in the `enforcement: 'partial'` caveats.
- **The `\xNN` escapes from `findmnt` are decoded.** `findmnt -r` encodes spaces/tabs/newlines/backslashes in TARGET as `\x20` etc. — before the fix, the sweep remounted the literal escaped name (ENOENT swallowed by `|| true`) and the postcondition tested a fake name, so mount points containing spaces stayed writable under read-only mode and exit code 97 never triggered. Both pipelines now decode before matching, with a regression that asserts read-only on a real bind target containing spaces (verify-confinement).
- **After entering the namespace, drop back to the original user.** Entering via `sudo` leaves euid as root; using it directly would leave root-owned files in the workspace; `setpriv --reuid --regid --init-groups` drops back to the session user (ownership covered by an assertion).
- **Every probe whose output gets parsed is non-login.** `resolveIdentity` / `detectRunner` / `listLinuxDir` / `checkLinuxPath` / `resolveDistroHome` / `resolveExecutable`, and the pty's python3 probe, all use `loginShell: false` — a login shell's rc prints before the probe command's output, and positional parsing would treat whatever the profile printed as uid/gid/home (with model-writable dotfiles, that equals handing setpriv's uid to an attacker). `resolveIdentity` additionally brackets the output with a `__DSH_IDENTITY__` sentinel line + an exact four-line check; a parse failure throws an error **carrying the probe's actual output** (no more silent null). Probe timeout is 60s + one transparent retry after timeout: the first cold start of wsl.exe after a desktop restart can exceed a short limit.
- **wsl.exe option values pass syntax validation before spawn.** At the top of `runWslShell` / `buildWslExecArgv`, distro (`DISTRO_NAME`) and username (`LINUX_USER`) reject separator characters — the safety of the exec path does not depend on wsl.exe's external, undocumented tokenization rules; checkPath also does UNC validation before any wsl.exe side effect (regression pinned in verify-world).

## Key constraints (all measured, none inferred)

1. **Workspace paths must be in UNC spelling.** `packages/workspace/workspace/src/paths.ts:16-23` rejects POSIX paths `/home/...` as illegal on win32 (root === '/'); only `C:\…` and `\\server\share` pass.
2. **The plugin must live inside the profile directory.** The profile's module resolver routes `@deepseek-ai/*` to the installed generation only for modules inside the profile prefix; with `link:` outside the profile, all 7 harness packages report `Cannot find package`.
3. **Host plugin code cannot hot-reload.** Node caches modules by URL; reinstalling into the same directory still serves old code; hence the core logic is written as pure modules independent of the harness, verified by standalone Node scripts.
4. **9P sharing has no hard links.** `link()` reports `ENOTSUP`; `ReplaceFileW` / `SetFileSecurityW` are local-volume Win32 APIs, meaningless on a network share — all three are covered by `WslFileSystem`.
5. **`appendWindowsPath = false` is a common default.** Host programs are not on PATH; absolute `/mnt/c/Windows/System32/*.exe` paths are required (`hostExecutable()`).
6. **At client-plugin apply time, `<body>` may not exist yet.** The client half applies during document parsing, where `document.body` is `null`; `MutationObserver.observe(document.body, …)` then throws outright and the whole apply fails, leaving the UI silently unresponsive (the first W-button version tripped exactly here). The observation root must be `document.documentElement`, with a timer fallback in addition — relying on the observer alone assumes "there will always be a childList mutation", an assumption that does not hold.
7. **Client-half changes hot-update; host-half changes do not.** Rewriting the currently deployed generation's `lib/client.js` in place changes the delivery rev and pushes it to the page via `/plugins/events`, **no restart needed**; changing `lib/index.js` requires a restart. `scripts/inspect-live-client.mjs` reads the bundle the host actually delivers (in-memory cache; the on-disk file is not evidence).

## Layout

```
lib/index.js            Host: routes, preset generation, session preset binding
lib/client.js           Browser: the W button next to the sidebar "+" + the add-WSL-workspace dialog
lib/wsl/paths.js        UNC ↔ Linux ↔ drive-letter translation (pure functions)
lib/wsl/world.js        Distro discovery, the wsl.exe execution core, directory facts
lib/wsl/shell.js        ShellExecutor implementation (WSL bash + confinement hookup)
lib/wsl/fs.js           LocalFileSystem subclass (9P backend + path dialects)
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

## Verification

```powershell
node scripts/verify-all.mjs          # all offline suites (equivalent to the ones below)
node scripts/verify-all.mjs --live   # additionally the suites needing the installed plugin + a running host
```

Run a single item:

```powershell
node scripts/verify-world.mjs        # path translation + executing commands in the distro + directory facts + exec boundary rejection
node scripts/verify-preset.mjs       # preset rewriting (run against the bundled standard preset)
node scripts/verify-fs-fence.mjs     # fs fence pure logic: containment, cross-distro, writable-root derivation
node scripts/verify-9p.mjs           # 9P sharing primitive profiling + identity mapping (a load-bearing fence assumption)
node scripts/verify-confinement.mjs  # confinement fence: workspace writable, outside rejected, ownership correct, spaces in paths
node scripts/verify-terminal.mjs     # PTY bridge: resize / foreground process group / signals / terminate
node scripts/verify-pty-handle.mjs   # the JS terminal handle (run against the real bridge)
node scripts/verify-client-ui.mjs    # browser-half static checks (no slot registration, locator geometry, host calls)
node scripts/verify-client-dom.mjs   # browser-half behavior checks: the real factory run in jsdom (mount location / convergence when out of room / hiding follows)
node scripts/inspect-live-client.mjs # reads the client bundle the host actually delivers (accepts marker strings)
.\scripts\sync.ps1                   # stage into the profile (then installed by plugin_manager)
```

Distro and user are no longer hardcoded: `DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` can override, with defaults read live from `wsl.exe`.

## Install / Update / Release

**User install (production channel)**: this plugin ships as an npm package, shaped like mature plugins such as dsh-better-sidebar (an exact `files` manifest + `cordis.patch.yml` bundle patch + `dsh.client.inject` client wiring + `manifestVersion`).

- Plugin market / plugin manager: install `dsh-wsl-desktop@<version>` — the desktop automatically completes the pnpm wiring and the bundle patch mount; restart and it works.
- CLI equivalent: `plugin_manager install_bundle dsh-wsl-desktop@<version>`.
- **Install prerequisites**: WSL2 + the target distro meeting the support matrix (`docs/DISTRO-SUPPORT.md`) — NOPASSWD sudo for the session user, bash, python3; installing the dsh-wsl-confine helper per the "Confinement" section is recommended (closes the retained-grant boundary).
- **Update**: installing a new version number is enough; after a desktop major update, run `verify-post-restart.mjs` first per "Desktop update discipline".
- **Uninstall**: uninstalling via the plugin manager also withdraws the wsl-* presets registered by this plugin (guaranteed by the disposer lifecycle).

**Maintainer release**: semantic versioning — patch = defect fixes; minor = compatible desktop-major adaptation (each harness break adaptation bumps minor, e.g. the 0.1.7 adaptation in 0.1.x); major = boundary semantics or support-matrix changes. Flow: bump the `package.json` version → full suites + `verify-post-restart.mjs` all green → `npm publish --access public` → git tag. The `files` manifest already includes `lib/wsl/dsh-wsl-confine.sh` (the helper ships with the package).

**Code install (development mode)**:

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # full offline run
.\scripts\sync.ps1                 # stage into the profile (developer mode: developerTools enabled)
# restart DSH Desktop → verify-post-restart.mjs
```

**Previously flaky → fixed, stable across many rounds**: `verify-terminal.mjs` used to fail intermittently (measured 1 in 6). The root cause was host-side `lib/wsl/pty.js`, not the bridge: the allocation-failure path did not terminate the already-spawned data process, and the leaked bridge interfered with later runs; control replies carried no request id, so after one timeout a late reply was consumed by the next request and the whole control channel misaligned from then on. Fix: the failure path terminates and waits for both processes to exit; every request carries an id, the bridge echoes the same id, timeout removes the entry first, and late replies are dropped outright. After the fix, a dozen-plus full-suite rounds today (including several back-to-back) reproduced nothing; the conclusion is stable.

Host-code changes require **restarting DSH Desktop** to load; after a restart, run `verify-post-restart.mjs` first — when old modules are still in effect it reports "please restart" directly instead of giving a false green. **Browser-half changes need no restart**: rewriting the current generation's `lib/client.js` in place changes the delivery rev, and the change is pushed to open pages via `/plugins/events` (`patchReload: live`). `verify-post-restart.mjs` reads the live module graph from `/plugins/events` and fetches back the bundle actually delivered, to assert exactly this.

`sync.ps1` stages into a fresh timestamped directory each time (Node caches modules by URL; reinstalling into the same directory still serves old code), but **keeps the generation the current profile links to**: the presets generated by the running host carry absolute module paths inside its own directory; deleting that directory breaks all WSL sessions until the next restart.

## The fs tool fence

`WslFileSystem` carries its own fence: it declares `sandboxMode`, and both mutation entries, `writeText`/`editText`, go through `checkedTarget` first (rejections throw structured `FS_SANDBOX_DENIED`, which the tool layer maps into a model-visible `[sandbox: …]` marker plus an escalation hint); the containment comparison and writable-root derivation are pure functions in `lib/wsl/fence.js`. It does **not** inherit the official sandbox backend — the official backend would wrap this class inside a second backend, adding a layer of composition dependency for nothing, while the fence is, at bottom, "a policy check inside trusted code" and belongs in this class. (The original attribution — "the realm cannot see `sandboxPolicy`, so it cannot inherit" — was wrong; see lesson 1 below: `shell.js` in the same realm had been injecting that service all along.)

**Writable roots and the comparison namespace**: the `workspace-write` allow set = the session cwd (the workspace root) + **the distro's** `/tmp` (on the 9P share, `\\wsl.localhost\<distro>\tmp` — where a Linux-side `/tmp/…` request resolves in this world; the host POSIX `/tmp` from the official derivation is meaningless on Windows) + the Windows temp directory (reachable via `/mnt/<drive>`). The comparison happens in the **host namespace**: targetKey is in Windows spelling, and the UNC prefix carries the distro identity, so "a Linux path that happens to spell the same in another distro" cannot escape the boundary; unknown modes get an empty allow set, i.e. deny (fail-closed). `checkedTarget`'s re-normalization also starts from **targetKey**, not displayPath — displayPath is in Linux spelling without a distro, and re-resolving from it pins the path onto this class's fixed distro, silently rewriting cross-distro UNC requests (live-tripped: written into debian-dev, read from debian reported not found); now cross-distro requests get `FS_SANDBOX_DENIED` directly.

**Why the fence must exist**: `LocalFileSystem` never overrides `FileSystem.sandboxMode`. A backend that claims nothing leaves `tool-fs`'s `FsSandboxController` unable to resolve a policy for every call (`tool-fs/src/sandbox.ts:43-50`: `defaultMode === undefined` ⇒ `escalationModes = []`, `policy = undefined`), so `write`/`edit` are entirely unmanaged and can write anywhere the share reaches — including `/mnt/c` — and `toHostPath` also accepts direct `C:\…` spelling, so the actual exposure while unfenced is the entire Windows filesystem, not just the share.

**Lessons from two failed attempts** (recorded here to avoid repeating them):

1. Inheriting the official backend → the whole class never activated. At the time I attributed it to "the realm cannot see `sandboxPolicy`", **but the real cause was that I had deleted the `LocalFileSystem` import** (`node --check` parses syntax only; it cannot see undefined identifiers). Symptom matching is not attribution.
2. The first version of the built-in fence **denied everything** when it "could not get the workspace root", including the plugin's own `/tmp` writes. Only after tracing the mechanism did it become clear: the official backend's fallback is the same `sandboxPolicy.resolve()` (no arguments), **which itself cannot produce the workspace root either** — the root is always passed in by `tool-fs` on every call (`resolvePolicy` stamps it with the calling session's cwd).

**The selftest changed accordingly**: it now passes the policy explicitly, like a real caller: `{ mode: 'workspace-write', workspaceRoot: <session cwd> }`. It previously passed nothing — "calling fs in a way no real caller would ever use" — which is why it got rejected last time, not because the fence was too strict.

**Two pins + live acceptance**: `scripts/verify-modules.mjs` pins the fence's existence (declares `sandboxMode`, both mutation entries go through `checkedTarget`, rejections use `FS_SANDBOX_DENIED`, the containment comparison has separator boundaries); `scripts/verify-fs-fence.mjs` verifies the pure logic offline (separator boundaries, casing, **same-spelling cross-distro paths rejected**, writable-root derivation, unknown modes fail-closed); `verify-9p.mjs` gained identity-mapping probes (distinct files have distinct (dev,ino); the wsl.localhost/wsl$ spellings are stable — the fence's identity fallback is load-bearing on this). The class wiring is live-accepted by `verify-post-restart.mjs` (out-of-bounds write rejected, PASS).

## License

This project is released under the [MIT License](LICENSE).
