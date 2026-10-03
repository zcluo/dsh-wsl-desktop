# dsh-wsl-desktop

English | [简体中文](README.md)

> **Production status: usable in production under controlled single-machine operation** (see the scope boundaries below). Requires **DSH Desktop 0.1.7+** (presets are registered at runtime rather than loaded from directories; an outdated host explicitly rejects at activation). Core capabilities have passed live acceptance; security audits run-1 (5 candidates, closed loop) and run-2 (4 confirmed fixed + 1 rejected, converted to hardening) are complete, with reports in `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`. Per-item evidence strength is annotated in the capability table below.
>
> **Scope boundaries**:
> - ✅ **Suitable**: the plugin author themselves or operators of the same trust level, for long-term use on explicitly supported distros (see "Distro support matrix") and a 0.1.7+ desktop.
> - ⚠️ **Conditional**: the confined-mode trust boundary depends on NO_NEW_PRIVS (modern debian-family setpriv satisfies it; where setpriv has no `--no-new-privs`, confined mode does NOT run at all — the direct runner refuses once it measures `false`, and the helper's drop passes the same flag and fails closed, see caveats).
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
  2. **NO_NEW_PRIVS (automatic; the mitigation when no helper exists)**: when dropping privileges, the runtime probes for `setpriv --no-new-privs` support (modern debian-family setpriv satisfies it; verified `noNewPrivs: true` active) — setuid escalation inside the fence fails loudly. That probe has **three** outcomes: `false` (this setpriv lacks the flag) refuses with `NO_NEW_PRIVS_UNSUPPORTED`; no measured answer (the probe did not run) also refuses, with `NO_NEW_PRIVS_UNMEASURED`; only a measured `true` drops with `--no-new-privs`. A distribution whose setpriv lacks the flag therefore **never runs a confined command at all**, and installing the helper is not a way around it: the helper's own drop passes the same flag, so it fails closed too (setpriv exits 1 on the unknown option, measured) — the fix is a newer util-linux. `enforcement: 'partial'` is not this item's caveat: it holds for **every** confined run and names what the mount namespace does not govern (/dev, /proc, /sys and interop) plus the retained-sudo boundary above.
- **The `\xNN` escapes from `findmnt` are decoded.** `findmnt -r` encodes spaces/tabs/newlines/backslashes in TARGET as `\x20` etc. — before the fix, the sweep remounted the literal escaped name (ENOENT swallowed by `|| true`) and the postcondition tested a fake name, so mount points containing spaces stayed writable under read-only mode and exit code 97 never triggered. Both pipelines now decode before matching, with a regression that asserts read-only on a real bind target containing spaces (verify-confinement).
- **After entering the namespace, drop back to the original user.** Entering via `sudo` leaves euid as root; using it directly would leave root-owned files in the workspace; `setpriv --reuid --regid --init-groups` drops back to the session user (ownership covered by an assertion).
- **Every probe whose output gets parsed is non-login.** `resolveIdentity` / `detectRunner` / `detectNoNewPrivs` / `listLinuxDir` / `checkLinuxPath` / `resolveDistroHome` / `resolveLoginShell` / `resolveExecutable`, and the pty's python3 probe, all use `loginShell: false` — a login shell's rc prints before the probe command's output, and positional parsing would treat whatever the profile printed as uid/gid/home (with model-writable dotfiles, that equals handing setpriv's uid to an attacker). `resolveIdentity` additionally brackets the output with a `__DSH_IDENTITY__` sentinel line + an exact four-line check; a parse failure throws an error **carrying the probe's actual output** (no more silent null). Probe timeout is 60s + one transparent retry after timeout: the first cold start of wsl.exe after a desktop restart can exceed a short limit.
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
lib/wsl/publish.js      The overwrite publication's wait bound (retry + measured tail; pure module, independently testable)
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

**How the aggregate reads a SKIP (commit `2d44dd6`)**: a suite's exit code 2 is its own SKIP (a check it could not evaluate on this machine), and the aggregate reads exit codes — it cannot see the suite's own `SKIP` block — so a skip counts **only** where `scripts/verify-all.mjs`'s `DECLARED_SKIPS` names the suite together with the **precondition** that allows it. The summary therefore reads `N/M suites passed (K declared skip: <name>)`, and each `SKIP` prints the precondition it declared; an **undeclared** skip fails the aggregate (`FAIL (undeclared skip) <suite>`, plus the block naming the fix — add an entry to `DECLARED_SKIPS`, or remove the precondition that forced the skip) and the run exits 1 — so exit 0 can no longer coexist with "one suite never ran". A declaration whose precondition does not hold here is **dormant**: the suite runs, one extra `NOTICE` line is printed, nothing reddens. A **dead** declaration (the suite was renamed / its source no longer has an exit-2 branch / it is not in the suite list) fails **before any suite runs**, because that rot is the repository's own and an operator can clear it on the spot. The whole ruling is pinned by `scripts/verify-all-skip.mjs`, which builds copies of the aggregate over fixture suites (outside the repository) and reads real processes' real exit codes and summaries. It also re-derives both directions of the table from the real `STANDALONE` list and the suites' own exit-2 **shape**: a suite that can skip without a declaration is named, and so is a declaration whose suite no longer carries that shape.

Run a single item:

```powershell
node scripts/verify-world.mjs        # path translation + executing commands in the distro + directory facts + exec boundary rejection
node scripts/verify-preset.mjs       # preset rewriting (run against the bundled standard preset)
node scripts/verify-fs-fence.mjs     # fs fence pure logic: containment, cross-distro, writable-root derivation
node scripts/verify-fs-fence-skip.mjs # the fence suite’s report when the machine has one distribution: the precondition, every unevaluated assertion, the remedy, exit 2 — and all four assertions still run with a second
node scripts/verify-9p.mjs           # 9P sharing primitive profiling + identity mapping (a load-bearing fence assumption)
node scripts/verify-9p-skip.mjs      # the 9P probe's report when the machine has one distribution: its content, exit 2, and that it does not skip early
node scripts/verify-confinement.mjs  # confinement fence: workspace writable, outside rejected, ownership correct, spaces in paths
node scripts/verify-terminal.mjs     # PTY bridge: resize / foreground process group / signals / terminate
node scripts/verify-pty-handle.mjs   # the JS terminal handle (run against the real bridge)
node scripts/verify-client-ui.mjs    # browser-half static checks (no slot registration, locator geometry, host calls)
node scripts/verify-client-dom.mjs   # browser-half behavior checks: the real factory run in jsdom (mount location / convergence when out of room / hiding follows)
node scripts/verify-modules.mjs      # host-half structural pins: the distro seam + the `exports` map (`./client` is a hard contract)
node scripts/verify-sync.mjs         # runs the real sync.ps1 against a disposable profile: four generation-retention scenarios (link resolves / dangling / no link / never staged into)
node scripts/verify-all-skip.mjs     # the aggregate's ruling on a SKIP: an undeclared skip fails / a declared one is reported with its precondition / a dead declaration fails before any suite runs
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

**Two pins + live acceptance**: `scripts/verify-modules.mjs` pins the fence's existence (declares `sandboxMode`, both mutation entries go through `checkedTarget`, rejections use `FS_SANDBOX_DENIED`, the containment comparison has separator boundaries); `scripts/verify-fs-fence.mjs` verifies the pure logic offline (separator boundaries, casing, **same-spelling cross-distro paths rejected**, **components that exist but cannot be canonicalized refused** (Task 2: a self-built link fixture plus five controls, the write key as the world-independent subject, and an NTFS-junction arm so the blind-arm expectations are not constants — see the next subsection), writable-root derivation, unknown modes fail-closed); `verify-9p.mjs` gained identity-mapping probes (distinct files have distinct (dev,ino); the wsl.localhost/wsl$ spellings are stable — the fence's identity fallback is load-bearing on this) and now ASSERTS the fence's refusal of the escaping spelling where it used to record a HAZARD. The class wiring is live-accepted by `verify-post-restart.mjs` (out-of-bounds write rejected, PASS). Task 2's rule, and the two suites' SKIP families, each have ONE owner below: the rule — why the final component is exempt, where it lives (`lib/wsl/fence.js`'s `isUnderHost`), its measured zero cost, the check-to-publication residue, **the two arms and the write key** the expectations are relations against, and the structural pin on `fs-local`'s publication sequence with its six mutants — in *The fence's new rule (Task 2)*; the SKIP families, with the reports that pin them and the `CROSS_DISTRO_CHECKS` list they print, in *The three share facts verify-9p records (Task 10)*.

### Measured fence facts

Several of the fence's open records cannot be settled by reading source: the 9P share's case semantics, whether `realpath` crosses a Linux symlink, whether two distributions' shares report the same `(dev,ino)`, whether the fs-fence fixture root exists — these are properties of **this machine**, not of the repository. Writing a fix for a guessed answer is writing a fix for another machine, so measure first and record after. This table is the ruling input for D8 and the four pending records (token / argv / FIFO / budget).

`scripts/probe-fence-facts.mjs` is read-only: every probe is a stat / realpath, it creates nothing and writes nothing; the second distribution is passed as argv[2], and when it is absent F3/F5 report `UNMEASURED` honestly — **UNMEASURED is a result, not a failure**. When argv[2] names the same distribution as the primary (case-insensitively) they likewise report `UNMEASURED` and say why: comparing one share against itself gives every F3 row a vacuous `COLLIDES`, and F5 would even report `true` — that is the lexical fast path containing itself, not the walk's verdict, while the annotation beside it would falsely claim the walk had short-circuited on the missing root.

Measured **2026-10-01**; primary distribution `debian`, second distribution `debian-dev`:

```powershell
node scripts/probe-fence-facts.mjs debian-dev
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 identity <share root>                             dev 0 vs 0, ino 2 vs 2 -> COLLIDES
F3 identity /tmp                                     dev 0 vs 0, ino 1 vs 1 -> COLLIDES
F3 identity /home                                    dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 false (root absent, so the walk short-circuits; see F4)

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 identity <share root>",
    "value": "dev 0 vs 0, ino 2 vs 2 -> COLLIDES"
  },
  {
    "label": "F3 identity /tmp",
    "value": "dev 0 vs 0, ino 1 vs 1 -> COLLIDES"
  },
  {
    "label": "F3 identity /home",
    "value": "dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "false (root absent, so the walk short-circuits; see F4)"
  }
]
```

With no second distribution passed:

```powershell
node scripts/probe-fence-facts.mjs
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 cross-share identity                              UNMEASURED - pass a second distribution as argv[2]
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 UNMEASURED - pass a second distribution as argv[2]

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 cross-share identity",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  }
]
```

**How to read this table** (every row is measured, none inferred):

- **F1 case-sensitive (Linux semantics)**: `/TMP` does not fold onto `/tmp` and reports ENOENT. The share itself answers (in the same table F2's control resolves and F3's stat succeeds), so this ENOENT means "the share distinguishes case", not "the share did not answer".
- **F2 realpath does not cross a Linux symlink**: realpath of `/lib` (→ `usr/lib`) reports ENOENT, while the link's own target `/usr/lib` resolves normally on the same share (the control is written into the probe and into this row). Per `lib/wsl/fence.js:31-37`, `canonicalHostPath` takes the catch branch for such a path and returns it unchanged.
- **F3 cross-distribution (dev,ino) collision**: the shares of `debian` and `debian-dev` report a **completely identical** pair for the same spelling (`/`=2, `/tmp`=1, `/home`=16386, dev 0 on both sides). The fence's identity fallback tests equality as `dev === dev && ino === ino` (`lib/wsl/fence.js:87`), so that equality test cannot tell the two distributions apart. A spelling that compared only dev would always report COLLIDES on this machine and could never ask the ino half, so the probe compares and prints the whole pair.
- **F4 the fixture root does not exist**: `<home>/proj` reports ENOENT, and `verify-fs-fence.mjs` never creates it.
- **F5 the identity walk did not run**: when the root does not exist, `isUnderHost` short-circuits to false at the stat of the root (`lib/wsl/fence.js:82-83`), so this row's `false` means "the root does not exist", not "the walk refused a cross-distribution target". **F3's collision and F5's false must not be read together as "cross-distribution containment is safe".**

**Correction (Task 4, commit `850e104`)**: F4/F5 record the state **before** Task 4 — at that time the fixture root was `<home>/proj`. `verify-fs-fence.mjs` now builds its own fixture root: a one-off `dsh-fence-fixture-<pid>-<rand>` under the distribution's `/tmp`, removed as soon as it is done (normal exit, assertion failure, `process.exit`, uncaught exception, SIGINT/SIGTERM all clean up), and it **no longer references `<home>/proj`**, so the cross-distribution pin really runs the identity walk on any machine that has two distributions. The table's numbers are **not** changed: they are that time's measurement, and the probe's output is reproducible word for word to this day — `<home>/proj` still reports ENOENT, and the suite still never creates **that** path.

**Correction (Task 9)**: F3's collision was not merely "on record" — it was a **live hole**, and the fence now closes it. The lexical fast path is the only comparison that carries the distribution, and once it fails (which is exactly the cross-distribution case) the identity walk re-stats every ancestor against **the target's own share**, so a foreign target's ancestors are compared with the local root's `(dev,ino)`. The distribution's `/tmp` is a writable root `workspace-write` **always** grants (`writableHostRootsFor`), and both shares report the same pair for it — measured `isUnderHost('\\wsl.localhost\debian-dev\tmp\x', '\\wsl.localhost\debian\tmp') === true`: a cross-distribution write judged "contained". The fix binds the walk to the distribution (the same rule as `contains()`: if **both** sides resolve to a WSL UNC and the distributions differ, refuse — the distribution segment compared case-insensitively in Windows spelling), and after the fix that call is `false`. The rule is deliberately kept **narrow**: a drive-letter path carries no distribution, so drive-letter targets and drive-letter roots keep the identity verdict they had (the suite pins both directions), and a drive letter and a share are measured to be unable to collide (the Windows temp directory's dev is the NTFS volume serial number 3764601112, while every 9P share reports 0). `verify-fs-fence.mjs` gains two pins: a cross-distribution target under a share-identity root must be refused (this one **can only** pass when the walk did not run — running it means authorization, so it is the proof that "the walk was not reached"), and a case-variant spelling of the same distribution (`wsl$` plus an upper-case distribution) must still be contained (the binding must not refuse a legitimate target in the other direction).

### The three share facts verify-9p records (Task 10)

Task 1's `probe-fence-facts.mjs` is a **one-off measurement**: it records the answers in the table above, but it does not enter the aggregate. The three share facts the fence actually depends on — symlinks, cross-distribution identity, case — are now also measured by `scripts/verify-9p.mjs`, which **is in `verify-all.mjs`'s `STANDALONE` list**: the offline aggregate runs it every time, so these three facts are re-measured on every full run.

**But on a machine with only one distribution only two of them are re-measured.** The three cross-distribution identity `FACT` rows need a **second** distribution; with only one, the suite **skips** those three: the `SKIP` line names the missing precondition, **lists the three facts one by one**, gives the remedy (install a second distribution, or point `DSH_WSL_OTHER_DISTRO` at one already on this machine), and **ends with exit code 2** — this skip is declared in `DECLARED_SKIPS` (that entry carries the precondition above, alongside "the link fixture cannot be built"), so `verify-all` reports it as `SKIP` and prints that precondition instead of counting it as `PASS`; a green aggregate cannot say these three facts are established, and an undeclared skip is judged red (see the "Verification" section). This is the owner's ruling: a single distribution is a **missing precondition**, not a bad profile. The skip is **limited to that family** — the facts that do not need a second share (symlinks, case) are still measured and printed, so what the reader loses is exactly the three that are named. The **content** of that `SKIP` is pinned by `scripts/verify-9p-skip.mjs`: it forces the precondition out through the probe's own override, runs a real process and reads real output (so every assertion runs on **every** machine), and pins the control as well — with a second distribution the suite still measures all three and exits 0.

**The same family has one more member.** When the link fixture cannot be built (wsl.exe fails, or a cold start exceeds its own 30s ceiling) the suite skips not only the three symlink facts but **also that assertion** — "the fence refuses the target spelling its own canonicalization produces", the product of turning the HAZARD into an assertion, which no other check in this suite covers. This family counts too (3 facts + 4 checks) and **exits 2**: disclosing it while staying green is exactly the class this round removes.

**The fence suite has the same family.** `scripts/verify-fs-fence.mjs` carries a family of **four cross-distribution assertions** that likewise need a second share: three with across-share subjects plus a **control** (a case-variant spelling of the same distribution must still be contained — a distribution binding that compared the segment case-sensitively would refuse a legitimate target, which is worse than the defect it closes). With only one distribution not one of the four can be evaluated, and this used to be **the precondition check FAILing, exit 1** — the owner ruled for a SKIP: the `SKIP` line names the precondition (no second distribution / the override pointed at itself / an empty override / a resolved share that does not answer), **lists the original label of each of the four unevaluated assertions**, says what is therefore unestablished, gives the remedy, **counts 4** and **exits 2** — this skip is likewise declared in `DECLARED_SKIPS` (that entry lists this precondition), so `verify-all` reports `SKIP` and prints the precondition instead of counting it as `PASS`; an undeclared skip is judged red. Those four labels are no longer described by prose but come from the **single list `CROSS_DISTRO_CHECKS`**: the checks print it and the `SKIP` prints it, so the words cannot drift from "what actually did not run" (the old text, "the two cross-distribution assertions", both miscounted and named none of them). This family's **content and both machine classes** are pinned by `scripts/verify-fs-fence-skip.mjs` (in `STANDALONE`, so it runs on every aggregate): it forces the precondition through the suite's override (pointed at the selected distribution / empty), simulates the owner's machine with a copy of the tree whose `listDistros()` reports one distribution, and reads a real child's stdout and exit code; the **control** proves that with a second distribution the suite still exits 0, prints no `SKIP` of this family, and prints all four assertions **PASS one by one**; and if the **distribution binding is removed** from `lib/wsl/fence.js` in the copy, that share-identity assertion must redden — an assertion is not a constant, and that is a proof rather than a claim.

**Division of labour: one owner per thing.** `verify-9p.mjs` records **how the share answers** (`FACT` rows, not assertions); **how the fence answers** is pinned in `scripts/verify-fs-fence.mjs` — the case row asserts adaptively against the share's own answer (`isUnderHost(case variant) === foldsCase`), and the cross-distribution row asserts that a foreign target under a share-identity root must be refused. Asserting the share's answer again in the profiling probe would redden on a machine whose **answers differ but which is healthy**, the same class of defect as "a check that can never fail".

**But a fact row cannot be "print a sentence and be done"**: beside every fact it first asserts the two things that make it a measurement — **the subject exists** and **the control answers** (the link the probe itself built appears in the share's listing, the link's own target is readable, `/lib` is in the share's listing, `/tmp` exists). Without those two, an ENOENT from a path that never existed would be read as "the share refused the link" — exactly the hollow pin this plan removes (D2). The falsifiability of these three assertions is proven with mutants (a wrong link name / a wrong control file name / replacing the creation with a rename primitive the share **does** resolve): each mutant reddens **only** its own row, exit code 1.

Measured (2026-10-01, primary distribution `debian`, second distribution `debian-dev`):

```powershell
node scripts/verify-9p.mjs
```

```
  FACT    realpath(/lib), a merged-/usr symlink — ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
  FACT    realpath / read of the link (the file behind it exists) — realpath ENOENT; read ENOENT -> the link is exposed but NOT followed
  FACT    a rename whose destination traverses the link — rename accepted without error and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\renamed-dst.txt exists: true -> the file landed AT the link's target (the SHARE resolves the destination spelling; the fence refuses it — the assertion below — and the provider never reaches this primitive anyway: the mkdir below aborts first, fs-local/src/fsio.ts:598)
  FACT    mkdir through the link, at a spelling the share resolves elsewhere — mkdir reported EINVAL and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\dsh-link-dir exists: true; isUnderHost(the raw spelling) === false
  OK    the fence refuses the target its own canonicalization produces for that spelling
  FACT    cross-share identity <share root> — debian (0,2) vs debian-dev (0,2) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /tmp — debian (0,1) vs debian-dev (0,1) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /home — debian (0,16386) vs debian-dev (0,16386) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    case-variant path /TMP (control: /tmp exists) — ENOENT -> CASE-SENSITIVE (Linux semantics)

THE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES
8 share fact(s) recorded above — NOT assertions: the fence's answers to them are pinned in verify-fs-fence.mjs
```

**F2's full answer: what the share actually does with a symlink.** Task 1's F2 measured only `realpath`. The same probe now builds its own link in the fixture root with `ln -s` (the target lies **outside** the fixture root; both directories belong to the probe and are removed afterwards), so every answer has a subject that is **definitely a link**:

- `realpath` / `stat` / `read` / `readdir` / plain creation (`open` without `O_EXCL`) **all fail to cross the link** (ENOENT) — that is the half the fence assumes.
- `rename` (destination under the link) and `mkdir` (creating a new directory under the link) **are resolved by the server**: the rename really lands at the link's target; mkdir reports `EINVAL` on the client while **the directory is created at the link's target**.
- A final-component symlink is **safe**: the rename replaces the link entry itself inside the root (measured: the link's target file content is unchanged), and exclusive creation reports `EEXIST`.
- The Windows side cannot even delete the link entry itself: `unlink` → ENOENT, `rm` → EISDIR, `rm -r` on a directory containing a link → ENOTEMPTY. So the fixture must be cleaned up with `wsl.exe ... rm -rf`, which is why `exit`/`SIGINT`/`SIGTERM` handlers are attached (what the Windows side cannot delete must not be left for the user) — that is not fastidiousness, it is a direct consequence of this fact.

### The fence's new rule (Task 2): a component that exists but cannot be canonicalized is refused

**The rule (one sentence, falsifiable)**: a target's containment verdict is true if and only if **every path component** between the "writable root" and "the target's own file name" either **does not exist** on the share (`lstat` reports ENOENT/ENOTDIR) or **can be canonicalized** (`realpathSync.native` succeeds); a component that **exists but cannot be canonicalized** (measured on this machine: a Linux symlink where `lstat` reports EISDIR and both `realpath` and `stat` report ENOENT) refuses the target outright. The target's **own file name is not inside the rule**.

**That HAZARD is therefore closed**: the original record was "the fence authorizes a spelling the share resolves elsewhere, and the publication's first action, `mkdir(directory, {recursive:true})` (`fs-local/src/fsio.ts:598`), creates the missing directory level at the link's target — outside the writable root". After the rule landed, the same spelling's measurement in `verify-9p.mjs` went from `isUnderHost(...) === true` to `false`, and that HAZARD row became a real assertion ("the fence refuses the target its own canonicalization produces"). **The FACT row is still true**: the share-side mkdir still creates the directory at the link's target (that is the share's behaviour); what changed is only the fence's answer to it.

**Why (b) and not (a)**: the candidate rule (a), "refuse a target whose path **component** exists but does not resolve", literally includes the **final component**, and a final component that is a link is **measured safe** — the publication's rename replaces the link entry itself inside the root, the link's target file content is unchanged (F2's third row above), and it **works today** (`verify-fs-fence.mjs`'s control pin "a final-component file link / directory link is still authorized"). Refusing it would refuse a legitimate write that works, and "a rule that refuses legitimate same-root writes is worse than the gap it closes". Rule (a) also draws no root boundary, and read literally it would refuse everything because some component **above the root** cannot resolve. The chosen (b) pins the scope to "between the root and the target's file name" — exactly the set of components line 598's `mkdir` walks, and would create.

**Where the rule lives**: in `lib/wsl/fence.js`'s `isUnderHost` (new helpers `canonicalizationOf` / `componentsCanonicalize`), **not** in `checkedTarget`. Three reasons: one, the authorization verdict *is* `isUnderHost`'s answer (`checkedTarget` merely calls it for every writable root and treats it as the authorization), so putting the rule elsewhere would leave `isUnderHost('<root>\<link>\...', root)` returning `true` — and that expression is exactly the measured subject of the original HAZARD, so that would only "comment out" the gap, not close it; two, the rule needs a root boundary and `isUnderHost` already has one (lexical prefix plus identity walk); three, both paths (the lexical fast path and the identity fallback) must pass through it, otherwise the `wsl$` alias spelling would bypass the rule — the alias pin exists for exactly that. `checkedTarget` and the two mutation entries are unchanged word for word.

**The cost (measured, not reasoned)**: canonicalization cannot tell a link pointing **inside** from one pointing **outside**, so both are refused. The cost is **zero** — a write through a link **cannot publish on this share anyway**: `mkdir(directory, {recursive:true})` reports ENOENT for a path through a link (measured, including when the intermediate directories already exist), so the write never reaches the rename; the fence's refusal only replaces "leave an out-of-bounds directory behind and report ENOENT" with "refuse before creating anything". `readlink` does not help either: it reports EISDIR for a link entry (measured) and cannot obtain the link's target.

**Residue**: the **race between the check and the publication**. The rule can only refuse components that **already exist**; a link planted by a bash tool after `checkedTarget` passes and before line 598's `mkdir` is still invisible (canonicalization is blind to such a component by construction, and no check can see it). The window is sub-millisecond and the payoff is still only an out-of-bounds directory creation with no content leak.

**Pins and mutants**: `verify-fs-fence.mjs` builds its own link fixture (`escape` pointing out of bounds, `inside-link` pointing in bounds, `dangling` pointing at a nonexistent target, `file-link` pointing at an out-of-bounds file; built with the distribution's `ln -s` and removed with `wsl.exe rm -rf`, because the Windows side can neither create nor delete link entries), asserts the rejection matrix (an out-of-bounds ancestor, **the key the write is actually handed**, the target's own parent, an in-bounds link, a dangling link, the `wsl$` alias spelling) **plus 5 controls** (a missing component under a real directory, a directly missing component under the root, an existing directory, a final-component file link, a final-component directory link — all of which must still be allowed); when the fixture cannot be built it **FAILs first and only then skips**, and does not permit "the link does not exist, so the assertion passes vacuously".

**"The key the write hands over" is not `canonicalHostPath`**: it is the key fs-local's own resolution walk produces (`resolveLocalTarget`, `fs-local/src/fsio.ts:161-210`), mirrored in the suite as `writeTargetKey`. `canonicalHostPath` runs `realpathSync.native` over the **whole path** with a fall-back to the input, and every target in this section has a nonexistent tail — so on **any** share it returns its input unchanged, and "are the two spellings the same" is simply not a function of blindness (R=1 wrote a pin from that reasoning that **would red falsely**: a true proposition written as a false failure). With the write key the relation holds: under the **blind arm** the walk stops at the fixture root and the key is the raw spelling; under the **resolving arm** the walk crosses the link and the key is the link's target; both arms are refused by containment.

**Two arms, and neither may be reddened**: what the fence answers depends on whether its canonicalization can see through the link, so the expectations above are **not constants** — they are written as relations against the measured `blindTo(link)` (`=== !blind`, the same shape as the case row's `=== foldsCase`). The other arm (canonicalization **can** see through the link) is buildable on this machine too: an NTFS directory junction is a reparse point `realpathSync.native` **does** resolve (measured), needs no privilege, and `rmSync` removes only the link itself (measured: the target is unaffected), so it is **pinned** rather than argued — under that arm the fence refuses the write key (containment, not blindness), while the raw spelling **is** in bounds: this is exactly where "writing the blind-arm expectation as a constant" would redden on a healthy machine.

**The cost row has a pin too**: `fs-local`'s publication sequence is "first `mkdir(directory, {recursive:true})`, and that step is outside **any** try/catch that could catch it" (structural, not incidental), so when it fails the staging directory, the temp file and the rename have not happened yet — which is also why that out-of-bounds trip left only a directory and nothing else. It is pinned **structurally** in `verify-fs-fence.mjs`: it reads the harness checkout's `packages/fs/fs-local/src/fsio.ts` (comments and string bodies blanked with the shared `blankLiterals` first, so a mention of the call in a doc comment does not count; located with `--checkout=` / `DSH_CHECKOUT`, defaulting to the checkout beside this repository) and asserts that the call is a **bare await statement** with all four criteria holding: what immediately precedes the call must be `await` (`head`), what follows it on the same line may only be blank or `;` (`tail`, comments being blanked to whitespace so a trailing comment does not count), there must be no try/catch from the **start of the function** to the call (`beforeCreate`, the window measured from the **function's opening**, not from the `const directory` line — otherwise "open a try before the call, put the catch after it" would slip through), and none between the call and the next `try {` (`toNextTry`). It does **not** claim: that this `mkdir` is the real binding (shadowing is a different defect), or that the caller will not swallow the function's own rejection — both are outside the structural pin's boundary. It also asserts that the try being guarded **is** the staging sequence (the boundary is limited to that try through the end of the function; it does **not** claim no other code path can reach those two calls). When the checkout is unreadable it **counts a skip and makes the whole suite report SKIP with exit code 2** (as its sibling suites do; the suite declares the precondition "the harness checkout is unreadable (or no second distribution's share answers)" in `DECLARED_SKIPS`, so `verify-all` reports `SKIP` and prints it instead of counting it as a pass) and does not let a green aggregate hide an unrun pin. **All six mutants** were run on **copies** (the real file must stay green): moving the call inside the guarded try → 2 red; wrapping it in its own try → 1 red; opening a try before the call with the catch after it → 1 red; **holding the promise and awaiting it later** (`const p = mkdir(…)` followed by `try { await p } catch {}`) → 1 red (caught only by `head`); a **`.catch(() => {})` chain** (no try/catch keyword anywhere) → 1 red (caught only by `tail`); a **late-registered catch** → 1 red; the harness checkout is byte-identical (`D7CC70E0…`).

That line in `verify-9p.mjs` was changed to a real assertion. Fence-side mutants: removing only the lexical fast path half → `verify-fs-fence.mjs` reddens only its 5 lexical pins (the alias row stays green), `verify-9p.mjs` reddens 1, exit 1; removing only the identity walk half → only the alias row reddens; removing both halves = the state before the change → 6 red. After every mutation the file is restored byte-identically (blob `3a353748…`).

## License

This project is released under the [MIT License](LICENSE).
