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

**Honest state after live acceptance** (`verify-post-restart.mjs` all green + 11 offline suites; each item below notes its evidence strength):

| # | Capability | Status |
|---|---|---|
| ① | The workspace can pick a Linux directory inside a WSL distro | Dialog and host calls implemented and live-verified (listDir/checkPath/resolveHome/workspace registration and cleanup); **in-browser interaction manually confirmed by the operator** (gating flow, directory browsing, and terminal panel all normal) |
| ② | shell / file tools / subprocess / terminal inside that workspace work in WSL, and host commands can be invoked from WSL | **Live acceptance PASS**: binding (the create request names the preset), shell inside the distro, fs tools addressing Linux paths, out-of-bounds write rejection, subprocess POSIX environment, bash tool, tool-layer constraints; terminal transport covered by the PTY suite |
| ③ | Windows and WSL workspaces coexist in the same instance | **Live acceptance PASS**: Windows workspaces stay on the host preset (PowerShell available, no bash); WSL sessions run the confined realm in parallel |
| ④ | Linux-side sandbox constraints on the WSL side | **Shell side fixed and live-verified**: at runtime, all `rw` mounts are enumerated and remounted read-only one by one (observed `/mnt/c`, `/dev/shm`, `/run/user/<uid>` going WRITABLE → READONLY); any failure rejects (exit code 97 preserved); `enforcement` honestly reports `partial`. **fs-side fence implemented and live-verified** (out-of-bounds write rejected, PASS — see "The fs tool fence") |

## Session binding: name the execution world in the create request

The harness fixes the preset at session **creation** (`SessionCreateRequest.agentPreset` → `composeAgent`'s `setup: presets.mount(...)`; the mount happens before the session is published). Calling `agentPresets.select` after the fact only works on sessions that "have not run any turn yet"; once a session has had a turn it is rejected with `agent-preset/locked` — and that rejection is only written to an in-memory log, never reported to the user.

**The current implementation is built around exactly this fact**:

- When creating a session in the W dialog, the browser half first calls the host's `wslPresetFor` to resolve the variant id, then puts `agentPreset` into the **create request** (`createBoundSession()` in `lib/client.js`). This is the only race-free seam: the preset is composed together with the session, so there is no window of "first run in the Windows world, then switch".
  - **That field crosses two API layers, and one of them drops it.** The host's `SessionCreateRequest.agentPreset` is a real contract, but the client service wrapper `ctx.sessions.create` rebuilds its payload from `workspaceId | cwd | sessionId` alone — `agentPreset` is silently discarded, the session lands on the default preset, and only the fallback below rescues it. Creation therefore goes through the **generated remote contract** `ctx.remote.session.create({ workspaceId, agentPreset })` (with `remote` / `remote.session` injected to match), and `ctx.sessions.create` is kept only as the retreat for a host whose remote surface is unavailable. `scripts/verify-client-ui.mjs` pins both halves.
- The host half keeps an `api-session/added` listener (`bindWslSession` in `lib/index.js`) as a **fallback**: it only handles sessions whose "cwd is a WSL path but the creation carried no preset" (for example, sessions created from another entry point). It attempts a post-hoc `select`; on success it binds retroactively, on failure it writes `bindingLog` and warns in the host log — such entries are now **anomaly signals**, no longer part of the normal path.
- The binding section of `verify-post-restart.mjs` therefore reads: a non-selftest `bindingLog` entry = someone created a WSL session while bypassing the creation seam; zero entries = every session bound through the create request is fine. Final GUI-side confirmation has been done by the operator (session preset shows WSL · PTC mode; tools execute inside the distro).

## UI entry point

In the sidebar workspace title bar, to the right of the built-in "+" (add workspace), there is an extra **W** button; clicking it opens this plugin's workspace dialog: pick a distro → enter the user → browse or type a Linux directory → create and open a session.

In the sidebar workspace list, **a workspace whose path is under a WSL UNC root shows a ☁️ icon instead of the folder**. Detection goes through the workspace list (`ctx.workspaces.list.getSnapshot().items` and their `path` — **the `list` hop is not optional: written as `ctx.workspaces.path` the lookup yields undefined and silently does nothing**), because the row's DOM carries only the workspace NAME, never its path; the row key `workspace:<id>` holds the workspace id itself, so the mapping is reliable. The icon is this plugin's own vector cloud, not an emoji: the harness icon set ships no cloud, and there is **no per-row icon slot** (only the whole `sidebar.workspaces` section, which would shadow the shipped list), so the swap happens at the DOM level and rides the same sync pass as the W button.

Two details measured while building it: **the cloud follows the row's weight** — collapsed renders `IconFolderCloseRegular` (a 1px stroke) while expanded renders `IconFolderOpenRegular` (fill-only), so one closed path is rendered both ways (stroked = outline, filled = solid) and the cloud is rebuilt when the row expands, so a stroke is never shown beside a fill. And **the shipped `<svg>` is hidden, never removed**: React owns that node, and pulling its child out is how a `removeChild` exception starts; `display` is also not a childList mutation, so the swap does not feed the observer it runs from (0 childList records in 2.6 s, measured). `scripts/verify-client-dom.mjs` covers all of it.

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
  ctx.shell = pwsh-sandbox (host)           isolate: { shell, fs, subprocess }
  ctx.fs    = fs-sandbox (host)             ├─ shell-wsl  → ctx.shell
                                            ├─ fs-wsl     → ctx.fs
                                            ├─ subprocess-wsl → ctx.subprocess
                                            └─ tool-bash / tool-fs
```

`wsl.exe` itself is an ordinary Windows process, so the WSL executors still end up launching it through the **host's** subprocess provider. The realm isolates `shell`, `fs` AND `subprocess`, so `ctx.subprocess` inside the realm resolves to the realm's own provider; the host row captures the root provider in the root composition (`lib/wsl/host-refs.js`) and the realm rows read it back — managed-process termination, output overflow, and reaping still belong to the local provider.

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
  1. **Dedicated helper (recommended; installed once, but re-installed after every plugin upgrade)**:
     ```bash
     # run as root inside the distro (adjust the path to the actual install location)
     install -m 0755 -o root -g root /mnt/c/Users/<you>/.dsh/profiles/desktop/plugins/dsh-wsl-desktop-*/lib/wsl/dsh-wsl-confine.sh /usr/local/sbin/dsh-wsl-confine
     echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *" > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
     ```
     As root, the helper **always applies the full fence first**, then drops privileges and executes the command — re-invocation just re-fences from an already-fenced context, and parameter games (workspace='/') are defeated by the `/ is not read-only` postcondition. The plugin auto-detects and prefers the helper (the sudoers file authorizes only this one file), but **accepts only the exact version this plugin requires (currently v1.2)**: v1.1 did not escape its exemption pattern, so a workspace path containing a metacharacter was swept read-only and a path containing `|` could make `/mnt/c` an exempt target (leaving the Windows filesystem writable inside a confined session). **Re-run the install above after upgrading the plugin**; a mismatched helper is simply not selected, and the plugin falls back to the direct sudo-unshare runner (whose in-process builder always escaped correctly) rather than silently keeping the old fence. The requirement is an **exact match, not a minimum**, so a future helper version bump must move `HELPER_VERSION` in `confinement.js` with it — `verify-confinement.mjs` pins the two together, so a mismatch goes red.

     **The helper pins its own PATH and does not depend on sudoers.** As root it calls twelve tools by bare name (getent/cut/sed/tr/mount/findmnt/grep/mountpoint/setpriv/env/bash/unshare); `env_reset` does not save it — `secure_path` replaces only the PATH the caller **exports**, while a PATH passed as a `sudo PATH=… <helper>` command-line assignment still reaches the helper when the policy permits it (measured on debian, debian-dev and arch; whether it is permitted at all is the sudoers `SETENV`/`ALL` decision — this deployment is `NOPASSWD: ALL`, for which sudo implies SETENV — which is exactly why the helper must not rely on it), and the NOPASSWD grant is argument-wildcarded. The identity gate is the worst case: it trusts the getent/cut output resolved through that PATH, so a forged answer satisfied `--uid 0 --gid 0`. The helper therefore pins PATH to `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` and `export`s it, as the **first statement it executes** (before the argument parse and the identity gate); keep your distribution's own `secure_path` as it is — the pin is the helper's own guarantee, not a replacement for it. The pin has **no fallback**: the twelve tools must resolve in those six directories, and if one does not, the helper **fails closed** (a missing getent leaves the caller record empty and the gate refuses it; a missing cut fails the pipeline under pipefail with 127, so the fence is never established; the `command -v` preflights exit 97 with the setup-failure marker). It never falls back to the caller's PATH — a fallback would restore exactly this hole.

     **The helper drops a caller-supplied BASH_ENV before it starts, and does not import functions from the environment.** bash sources a caller-supplied `BASH_ENV` file BEFORE the script's first line — as root, ahead of every control in the file (the PATH pin included, which is why the pin cannot close it). Measured (bash 5.2.37): `bash script`, a `#!/bin/bash` shebang under exec and `bash -c` all source it, while `bash -p script`, a `#!/bin/bash -p` shebang and `bash -p -c` do not. Three edits follow from that measurement. The shebang is `#!/bin/bash -p`. `-p` does not remove the variable, and every descendant inherits it — the drop-side `bash -lc` is not privileged and does process it (measured: it sourced the caller's file as the session user, inside the fence) — so the exec tail drops it with `env -u BASH_ENV`, one removal on the one invocation every root-phase descendant hangs off. And because `-p` is a property of the SHELL, the fence body — a separate `bash -c` — still imported caller-exported functions: with a coordinated `mount`/`findmnt`/`mountpoint` override the sweep reported a confined system while `/mnt/c` stayed writable (measured: a silent fence bypass; faking `mount()` alone only failed closed at the postcondition by luck), so the fence body is launched with `-p` too, which makes such an override inert. `-p` on the helper's own bash also closes a second forging route that bypasses the PATH pin (measured: a forged `getent()` function made the identity gate accept `--uid 0 --gid 0`, running the command as uid 0 inside the fence; with `-p` the gate refuses it, exit 2). Severity: this is unconfined root code execution before line 1, ahead of the fence — it exceeds the root-inside-the-fence access the PATH pin closes (and root there is not a reader either — see the identity-gate paragraph below) — but its reachability is the sudoers policy's: a strictly NARROW rule does NOT imply SETENV, and an EXPORTED BASH_ENV is stripped by sudo's env_reset (measured), so the route needs the command-line-assignment spelling, which SETENV permits and an ALL match implies. The helper-side fix is unconditional on purpose: it must not depend on the deployment's sudoers either way. `HELPER_VERSION` stays v1.2, so **an un-reinstalled helper is still selected by the probe** — re-run the install above after upgrading the plugin, this time especially.

     **The identity gate is fail-closed, and it is a boundary only where the deployment's sudoers does not grant SETENV.** The gate judges the caller by SUDO_USER; an empty or unset value used to **skip the check**, and the caller controls that variable: measured, `sudo -n SUDO_USER= <helper> --uid 0 --gid 0 --home /root --cwd / -- '…'` and `sudo -n env -u SUDO_USER` both ran the command as uid 0 inside the fence with `/etc/shadow` readable. An empty or unset SUDO_USER is now **refused** (exit 2; root's own direct invocation passes `SUDO_USER=root` explicitly). The gate cannot stop **forgery**: `sudo SUDO_USER=root <helper> --uid 0 --gid 0 …` is still accepted — the variable is the only identity the gate has, and `SUDO_UID` is forgeable through the same route, so a cross-check buys nothing. The gate is therefore a boundary **only where the sudoers policy does not grant SETENV** (no `ALL` match, no command-line-assignment form); where SETENV is granted it stops unintentional misuse, not forgery, and the fence drops to the **forged uid** — root **write**, not a read primitive: the read-only state is a per-mount bind remount inside the private namespace, so the forged uid 0 can `mount -o remount,rw /` and `mount -o remount,rw /mnt/c` (both measured, and a write lands on each filesystem: a root-only path, and a file created under /mnt/c) and write to the distribution's filesystem and to the Windows filesystem; only the namespace and NO_NEW_PRIVS still apply — the file fence does not.
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
node scripts/verify-9p-skip.mjs      # the 9P probe's report when the machine has one distribution: its content, exit 2, and that it does not skip early
node scripts/verify-confinement.mjs  # confinement fence: workspace writable, outside rejected, ownership correct, spaces in paths
node scripts/verify-terminal.mjs     # PTY bridge: resize / foreground process group / signals / terminate
node scripts/verify-pty-handle.mjs   # the JS terminal handle (run against the real bridge)
node scripts/verify-client-ui.mjs    # browser-half static checks (no slot registration, locator geometry, host calls)
node scripts/verify-client-dom.mjs   # browser-half behavior checks: the real factory run in jsdom (mount location / convergence when out of room / hiding follows)
node scripts/verify-modules.mjs      # host-half structural pins: the distro seam + the `exports` map (`./client` is a hard contract)
node scripts/verify-sync.mjs         # runs the real sync.ps1 against a disposable profile: four generation-retention scenarios (link resolves / dangling / no link / never staged into)
node scripts/verify-route.mjs        # live: the acceptance route (needs a running host)
node scripts/inspect-live-client.mjs # reads the client bundle the host actually delivers (accepts marker strings)
.\scripts\sync.ps1                   # stage into the profile; an already-installed profile also gets its link re-pointed (a first install is still wired by plugin_manager)
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

> ⚠️ **`exports["./client"]` is a hard contract and the easiest thing to delete while editing metadata.** The host's client-modules plugin is REQUIRED: one package that declares `dsh.client` without `exports["./client"]` refuses to compose, and the **whole desktop fails to start** (not just this plugin):
> ```
> DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate
>   client-modules: dsh-wsl-desktop declares dsh.client but exports no "./client" bundle
> ```
> The v0.2.0 "release readiness" metadata rewrite (`38e6356`) deleted the whole `exports` block, which is why 0.2.0 and 0.2.1 **cannot start at all once installed**; `main` is not a substitute — Node ignores it when resolving the `./client` subpath. `scripts/verify-modules.mjs` now pins this (`./client` and `.` both present, client entry distinct from the host entry, file present on disk, platform web), so running it before a release catches the regression. **`package.json` is part of the deployed surface** alongside `cordis.patch.yml` and `lib/`: `verify-post-restart.mjs` compares the running manifest against the checkout byte for byte.

**Code install (development mode)**:

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # full offline run
.\scripts\sync.ps1                 # stage into the profile and re-point (developer mode: developerTools enabled; a first install needs the wiring first)
# restart DSH Desktop → verify-post-restart.mjs
```

**Previously flaky → fixed, stable across many rounds**: `verify-terminal.mjs` used to fail intermittently (measured 1 in 6). The root cause was host-side `lib/wsl/pty.js`, not the bridge: the allocation-failure path did not terminate the already-spawned data process, and the leaked bridge interfered with later runs; control replies carried no request id, so after one timeout a late reply was consumed by the next request and the whole control channel misaligned from then on. Fix: the failure path terminates and waits for both processes to exit; every request carries an id, the bridge echoes the same id, timeout removes the entry first, and late replies are dropped outright. After the fix, a dozen-plus full-suite rounds today (including several back-to-back) reproduced nothing; the conclusion is stable.

Host-code changes require **restarting DSH Desktop** to load; after a restart, run `verify-post-restart.mjs` first — when old modules are still in effect it reports "please restart" directly instead of giving a false green. **Browser-half changes need no restart**: rewriting the current generation's `lib/client.js` in place changes the delivery rev, and the change is pushed to open pages via `/plugins/events` (`patchReload: live`). `verify-post-restart.mjs` reads the live module graph from `/plugins/events` and fetches back the bundle actually delivered, to assert exactly this. **The rev is not updated instantly, though**: the host rebuilds a client bundle lazily, so reading `/plugins/events` immediately after an in-place rewrite still returns the OLD rev (measured: it changes a few seconds later). "The file changed" is therefore not "the served bytes changed" — a verification has to wait for the new rev, or it reaches the wrong "already deployed" conclusion.

`sync.ps1` stages into a fresh timestamped directory each time (Node caches modules by URL; reinstalling into the same directory still serves old code; the stamp is second-resolution, so a second run inside the same second is bumped to a free name — the loader silently ignores a row id it has already mounted), and it **re-points the profile link at the generation it just staged**, rewriting the profile's `package.json` and `pnpm-lock.yaml` with it — otherwise the next `pnpm install` reconciles the link back to the manifest and "already staged" becomes a fiction. **The retention rule is "keep the two newest"**: the moment the link moves, "the linked generation" is the one nobody is running, while the running host resolves the one staged before it; keeping only the link would delete the generation in use on the next stage and break every WSL session until the next restart. When the link **cannot identify a generation** (the profile has no link at all, or its target is already gone) `sync.ps1` **keeps every generation and warns**, and a profile that has **never been staged into** (no `plugins/` directory at all) gets the same warning — with the link path spelled out, because that path is the only fact the reader needs. In that case it has merely put the files in place: nothing takes effect until the profile has this plugin installed (a first install is wired up by plugin_manager). The link is deleted through .NET rather than `Remove-Item`: Windows PowerShell 5.1 throws NullReferenceException on a junction, which aborted the re-point midway with the old generation still linked. `scripts/verify-sync.mjs` exercises all of this by running the real script against a throwaway profile (four scenarios: a link that resolves, a dangling link, no link, and never staged into — the last pinning that the warning names the link path).

## The fs tool fence

`WslFileSystem` carries its own fence: it declares `sandboxMode`, and both mutation entries, `writeText`/`editText`, go through `checkedTarget` first (rejections throw structured `FS_SANDBOX_DENIED`, which the tool layer maps into a model-visible `[sandbox: …]` marker plus an escalation hint); the containment comparison and writable-root derivation are pure functions in `lib/wsl/fence.js`. It does **not** inherit the official sandbox backend — the official backend would wrap this class inside a second backend, adding a layer of composition dependency for nothing, while the fence is, at bottom, "a policy check inside trusted code" and belongs in this class. (The original attribution — "the realm cannot see `sandboxPolicy`, so it cannot inherit" — was wrong; see lesson 1 below: `shell.js` in the same realm had been injecting that service all along.)

**Writable roots and the comparison namespace**: the `workspace-write` allow set = the session cwd (the workspace root) + **the distro's** `/tmp` (on the 9P share, `\\wsl.localhost\<distro>\tmp` — where a Linux-side `/tmp/…` request resolves in this world; the host POSIX `/tmp` from the official derivation is meaningless on Windows) + the Windows temp directory (reachable via `/mnt/<drive>`). The comparison happens in the **host namespace**: targetKey is in Windows spelling, and the UNC prefix carries the distro identity, so "a Linux path that happens to spell the same in another distro" cannot escape the boundary; unknown modes get an empty allow set, i.e. deny (fail-closed). `checkedTarget`'s re-normalization also starts from **targetKey**, not displayPath — displayPath is in Linux spelling without a distro, and re-resolving from it pins the path onto this class's fixed distro, silently rewriting cross-distro UNC requests (live-tripped: written into debian-dev, read from debian reported not found); now cross-distro requests get `FS_SANDBOX_DENIED` directly.

**Why the fence must exist**: `LocalFileSystem` never overrides `FileSystem.sandboxMode`. A backend that claims nothing leaves `tool-fs`'s `FsSandboxController` unable to resolve a policy for every call (`tool-fs/src/sandbox.ts:43-50`: `defaultMode === undefined` ⇒ `escalationModes = []`, `policy = undefined`), so `write`/`edit` are entirely unmanaged and can write anywhere the share reaches — including `/mnt/c` — and `toHostPath` also accepts direct `C:\…` spelling, so the actual exposure while unfenced is the entire Windows filesystem, not just the share.

**Lessons from two failed attempts** (recorded here to avoid repeating them):

1. Inheriting the official backend → the whole class never activated. At the time I attributed it to "the realm cannot see `sandboxPolicy`", **but the real cause was that I had deleted the `LocalFileSystem` import** (`node --check` parses syntax only; it cannot see undefined identifiers). Symptom matching is not attribution.
2. The first version of the built-in fence **denied everything** when it "could not get the workspace root", including the plugin's own `/tmp` writes. Only after tracing the mechanism did it become clear: the official backend's fallback is the same `sandboxPolicy.resolve()` (no arguments), **which itself cannot produce the workspace root either** — the root is always passed in by `tool-fs` on every call (`resolvePolicy` stamps it with the calling session's cwd).

**The selftest changed accordingly**: it now passes the policy explicitly, like a real caller: `{ mode: 'workspace-write', workspaceRoot: <session cwd> }`. It previously passed nothing — "calling fs in a way no real caller would ever use" — which is why it got rejected last time, not because the fence was too strict.

**The canonicalization rule (Task 2)**: the containment verdict also refuses a target whose path traverses a component that EXISTS but cannot be canonicalized. Measured on this share: `realpathSync.native` — the fence's canonicalizer, and the call `resolveLocalTarget` makes (`fs-local/src/fsio.ts:161-210`) — answers ENOENT for a Linux symlink entry, while `lstat` answers EISDIR and `readdir` lists the entry; the share's own `mkdir(directory, {recursive:true})` (`fs-local/src/fsio.ts:598`) *does* resolve that spelling and creates the missing level AT THE LINK'S TARGET, outside the writable root. The rule: every component strictly between the writable root and the target's own name must either not exist (`lstat` ENOENT/ENOTDIR) or canonicalize. The target's own name is exempt — a final-component link is measured safe (the publication's rename replaces the link entry inside the root and the link's target file is untouched) and it works today, and a rule that refuses legitimate same-root writes is worse than the gap it closes. The rule lives in `lib/wsl/fence.js` (`isUnderHost`, through the new `canonicalizationOf` / `componentsCanonicalize`), on BOTH the lexical fast path and the identity walk, so the `wsl$` alias spelling cannot bypass it; `checkedTarget` and the two mutation entries are unchanged. The measured cost is zero: a write through either kind of link cannot publish on this share at all (the recursive `mkdir` reports ENOENT for a path through a link, even when the intermediate directories exist), so the refusal replaces a stray out-of-bounds directory followed by ENOENT with a refusal BEFORE anything is created. What remains is the check-to-publication race: a link planted between `checkedTarget` and that `mkdir` is invisible to any check, because the canonicalizer is blind to it.

**Two arms, and neither may be reddened**: what the fence answers depends on what its canonicalizer can DO with the link, so the blind-arm expectations are written as relations against the measured blindness (`=== !blind`, the shape the case-variant pin already used) rather than as constants. The resolving arm is pinned too: an NTFS directory junction is a reparse point `realpathSync.native` RESOLVES (measured), needs no privilege, and the suite removes it without following it (measured). The world-independent subject is the **WRITE KEY** — the key a write actually hands the fence, produced by fs-local's own resolution walk (`resolveLocalTarget`, mirrored in the suite as `writeTargetKey`); `canonicalHostPath` is NOT that key (it realpaths the whole path and falls back to the input, so a missing tail makes it return its own spelling on any share — using it as the write's key is what made a first-round claim unsound).

**Two pins + live acceptance**: `scripts/verify-modules.mjs` pins the fence's existence (declares `sandboxMode`, both mutation entries go through `checkedTarget`, rejections use `FS_SANDBOX_DENIED`, the containment comparison has separator boundaries); `scripts/verify-fs-fence.mjs` verifies the pure logic offline (separator boundaries, casing, **same-spelling cross-distro paths rejected**, **components that exist but cannot be canonicalized refused** (Task 2: a self-built link fixture plus five controls that must stay authorized, the write key as the world-independent subject, and an NTFS-junction arm so the blind-arm expectations are not constants), writable-root derivation, unknown modes fail-closed); `verify-9p.mjs` gained identity-mapping probes (distinct files have distinct (dev,ino); the wsl.localhost/wsl$ spellings are stable — the fence's identity fallback is load-bearing on this) and now ASSERTS the fence's refusal of the escaping spelling where it used to record a HAZARD. The zero-cost half of the rule is pinned STRUCTURALLY against the harness checkout's `packages/fs/fs-local/src/fsio.ts`: the call must be a BARE AWAITED statement — `await` immediately before it, nothing but blank (or `;`) after it on its line, no try/catch between the function's opening and the call (so a guard opened earlier cannot slip through), and none between the call and the next `try {` — and the guarded region must be the staging one. Six mutations run on copies redden it (the unmutated file must stay green) and the checkout is never touched; an unreadable checkout is a counted SKIP and the suite exits 2, so `verify-all` shows SKIP instead of a green suite with an unrun pin. The class wiring is live-accepted by `verify-post-restart.mjs` (out-of-bounds write rejected, PASS). And `verify-9p.mjs` SKIPS its three cross-share identity rows when the machine has only ONE distribution — the owner's ruling: a missing precondition, not a broken profile. The SKIP names the missing second share, the three facts that therefore went unmeasured and the remedy, and the suite exits 2, so `verify-all` reports SKIP instead of a pass: a green aggregate cannot imply those facts were established. Only that family is skipped (the symlink and case facts need no second share and are still measured and printed). The report's CONTENT is pinned by `scripts/verify-9p-skip.mjs`, which forces the precondition through the probe's own override and reads the real child's stdout and exit code, so its assertions run on every machine — and it pins the control too: with a second distribution present the probe still measures all three rows and exits 0.

## License

This project is released under the [MIT License](LICENSE).
