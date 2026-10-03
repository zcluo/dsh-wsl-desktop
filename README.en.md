# dsh-wsl-desktop

English | [简体中文](README.md)

Turns a WSL distribution into a **first-class execution world** inside DSH Desktop: a workspace can live inside the distro, and shell, file tools, subprocess and terminal then all run inside the distro — while Windows workspaces in the same instance keep using the host's own sandbox backends. The two coexist.

> **Production status: usable in production under controlled single-machine operation** (see the scope boundaries below). Requires **DSH Desktop 0.1.7+** (presets are registered at runtime rather than loaded from directories; an outdated host explicitly rejects at activation). Core capabilities have passed live acceptance; security audits run-1 (5 candidates, closed loop) and run-2 (4 confirmed fixed + 1 rejected, converted to hardening) are complete, with reports in `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`. Per-item evidence strength is annotated in the capability table below.
>
> **Scope boundaries**:
> - ✅ **Suitable**: the plugin author themselves or operators of the same trust level, for long-term use on explicitly supported distros (see the [distro support matrix](docs/DISTRO-SUPPORT.md)) and a 0.1.7+ desktop.
> - ⚠️ **Conditional**: the confined-mode trust boundary depends on NO_NEW_PRIVS (modern debian-family setpriv satisfies it; where setpriv has no `--no-new-privs`, confined mode does NOT run at all — the direct runner refuses once it measures `false`, and the helper's drop passes the same flag and fails closed, see [Security and trust boundaries](SECURITY.md)).
> - ❌ **Not yet suitable**: distribution to third-party users (missing desktop version gating and distro matrix), or unattended high-value environments (the unconfined subprocess surface is a disclosed design; the two API proposals to the harness upstream are in [docs/UPSTREAM-PROPOSALS.md](docs/UPSTREAM-PROPOSALS.md)).

## Contents

- **This page**: [Target capabilities](#target-capabilities) · [Install / Update / Uninstall](#install--update--uninstall) · [Quick start](#quick-start) · [Desktop update discipline](#desktop-update-discipline-mandatory) · [Security and trust boundaries](#security-and-trust-boundaries) · [Known limitations](#known-limitations) · [Verification](#verification) · [Development](#development) · [Release](#release)
- **In-depth material**: [Security and trust boundaries](SECURITY.md) · [Architecture and the execution world](docs/ARCHITECTURE.en.md) · [Confinement (Linux side)](docs/CONFINEMENT.en.md) · [The fs fence](docs/FS-FENCE.en.md) · [Terminal (PTY bridge)](docs/PTY-BRIDGE.en.md) · [Verification and the SKIP ruling](docs/VERIFICATION.en.md) · [Engineering notes](docs/ENGINEERING-NOTES.en.md) · [Distro support matrix](docs/DISTRO-SUPPORT.md) · [Upstream API proposals](docs/UPSTREAM-PROPOSALS.md) · [Architecture and flow diagrams](docs/diagrams.md)

> The six documents this restructure created have an English edition (linked above; the file names carry an `.en` marker) and the pair is enforced rather than trusted. The three older documents — the distro support matrix, the upstream proposals and the diagram index — are **Chinese-only**, because no English text for them exists: translating them is a separate piece of work, not a rename.

## Target capabilities

**Honest state after live acceptance** (`verify-post-restart.mjs` all green + 18 offline suites; each item below notes its evidence strength):

| # | Capability | Status |
|---|---|---|
| ① | The workspace can pick a Linux directory inside a WSL distro | Dialog and host calls implemented and live-verified (listDir/checkPath/resolveHome/workspace registration and cleanup); **in-browser interaction manually confirmed by the operator** (gating flow, directory browsing, and terminal panel all normal) |
| ② | shell / file tools / subprocess / terminal inside that workspace work in WSL, and host commands can be invoked from WSL | **Live acceptance PASS**: binding (the create request names the preset), shell inside the distro, fs tools addressing Linux paths, out-of-bounds write rejection, subprocess POSIX environment, bash tool, tool-layer constraints; terminal transport covered by the PTY suite |
| ③ | Windows and WSL workspaces coexist in the same instance | **Live acceptance PASS**: Windows workspaces stay on the host preset (PowerShell available, no bash); WSL sessions run the confined realm in parallel |
| ④ | Linux-side sandbox constraints on the WSL side | **Shell side fixed and live-verified**: at runtime, all `rw` mounts are enumerated and remounted read-only one by one (observed `/mnt/c`, `/dev/shm`, `/run/user/<uid>` going WRITABLE → READONLY); any failure rejects (exit code 97 preserved); `enforcement` honestly reports `partial`. **fs-side fence implemented and live-verified** (out-of-bounds write rejected, PASS — see [The fs tool fence](docs/FS-FENCE.md)) |

**Which capabilities are qualified**: the evidence strength is the wording of the status column above. The `grep` / `glob` tools do not exist in a WSL session and the terminal has no `stdio.control` — both are stated under "Known limitations" rather than left out.

## Install / Update / Uninstall

**User install (production channel)**: this plugin ships as an npm package, shaped like mature plugins such as dsh-better-sidebar (an exact `files` manifest + `cordis.patch.yml` bundle patch + `dsh.client.inject` client wiring + `manifestVersion`).

- Plugin market / plugin manager: install `dsh-wsl-desktop@<version>` — the desktop automatically completes the pnpm wiring and the bundle patch mount; restart and it works.
- CLI equivalent: `plugin_manager install_bundle dsh-wsl-desktop@<version>`.
- **Install prerequisites**: WSL2 + the target distro meeting the [support matrix](docs/DISTRO-SUPPORT.md) — NOPASSWD sudo for the session user, bash, python3; installing the dsh-wsl-confine helper to close the fence boundary is recommended (install commands in [docs/CONFINEMENT.md](docs/CONFINEMENT.md)).
- **Update**: installing a new version number is enough; after a desktop major update, run `verify-post-restart.mjs` first per "Desktop update discipline".
- **Uninstall**: uninstalling via the plugin manager also withdraws the wsl-* presets registered by this plugin (guaranteed by the disposer lifecycle).

> **Version correspondence**: the current `0.3.x` line requires DSH Desktop **0.1.7+**. See "Release" for what the semantic version means — `minor` is precisely "adapted to a new desktop major", so **when the desktop major changes, check here first for the matching minor**.

## Quick start

In the sidebar workspace title bar, to the right of the built-in "+" (add workspace), there is an extra **W** button. It opens this plugin's workspace dialog; the order is: pick a distro → enter the user to enter that distro with (**leave empty = the distro's default user**) → browse or type a Linux directory → create and open a session.

Once inside browse mode the path lands directly in that user's home directory (the host resolves the user database inside the distro with `getent passwd`). If the entered user does not exist, the error is shown in place in the popup and browse mode is not entered. Switching distros — **including re-clicking the currently selected one** — re-prompts for the user, prefilled with the previously confirmed name. While a session creation is in flight, distro buttons are temporarily unclickable.

To be precise about the boundary: this step only decides "whose home gets browsed", **not the session identity** — the session always executes inside the distro as the distro's default user (`username` is plugin configuration and is not passed along with session creation).

In the sidebar workspace list, **a workspace whose path is under a WSL UNC root shows a ☁️ icon instead of the folder**. "+" keeps the deployment's own behavior (the Electron directory picker on Desktop); this plugin does not override it.

Why the UI and its DOM layer work this way (measured conclusions such as "hiding must use `display`, never `remove()`" and "never use a timer as a fallback") is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Desktop update discipline (mandatory)

After every DSH Desktop update, the plugin may break because of harness internal API changes (0.1.6→0.1.7 broke four places at once). **Discipline: update the desktop → run `node scripts/verify-post-restart.mjs` → only keep going when everything is green; any red gets fixed before anything else.** That suite covers preset registration, the execution world, session binding, Windows isolation, and dialog contracts; breakage from a new host shows up on these assertions instead of silently degrading into the host world.

## Security and trust boundaries

- **Host side**: Windows workspaces keep running in DSH's own sandbox backends; this plugin does not replace them.
- **Shell side inside the distro**: `/` is made read-only inside a mount namespace, leaving only the workspace and a private `/tmp` writable; **a fence that cannot be established refuses to execute** — it never runs bare. Mechanism and measured preconditions: [docs/CONFINEMENT.md](docs/CONFINEMENT.md).
- **fs side inside the distro**: `WslFileSystem` carries its own fence, both mutation entries go through `checkedTarget`, and an out-of-bounds target is rejected with structured `FS_SANDBOX_DENIED`. See [The fs tool fence](docs/FS-FENCE.md).

**Disclosed unconfined surface**: the host subprocess surface being unconfined is a design decision, not an omission. **Known boundary of the fence**: the session user's retained passwordless sudo grant can be re-invoked to bypass the file fence; the two closing paths and their real reachability are in [SECURITY.md](SECURITY.md).

## Known limitations

**The grep / glob tools do not exist in a WSL session.** `tool-fs-search` is launched via `ctx.subprocess.spawn()` (`search-core.ts:238`), but its argv[0] is the **bundled Windows rg.exe** from `@vscode/ripgrep` (`search-core.ts:174-178`) — it does not exist inside the distro and cannot work with Linux arguments. So the WSL preset removes it from the execution world, and the model in a WSL session can only use bash's `grep` / `find` (both present in the distro). This is a capability regression, not an omission — making it equivalent would require giving the WSL world its own search implementation.

**The terminal goes through the PTY bridge, and PTC's `stdio.control` (fd channel) stays explicitly rejected** — `wsl.exe` cannot forward arbitrary descriptors. How the bridge is driven, and its measured preconditions, are in [docs/PTY-BRIDGE.md](docs/PTY-BRIDGE.md).

**Confinement does not cover `/dev`, `/proc`, `/sys` or interop**, which is reported honestly in `enforcement: 'partial'`; and the session user's retained passwordless sudo grant can bypass the file fence — see [SECURITY.md](SECURITY.md).

## Verification

```powershell
node scripts/verify-all.mjs          # all offline suites (18)
node scripts/verify-all.mjs --live   # additionally the suites needing the installed plugin + a running host
```

Per-suite responsibilities, the single-suite commands, and **how the aggregate reads a SKIP** (exit code 2 is a suite's own SKIP; only a skip `DECLARED_SKIPS` names counts, and it prints the precondition it declared; an undeclared skip fails, and a dead declaration fails before any suite runs) are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

Distro and user are no longer hardcoded: `DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` can override, with defaults read live from `wsl.exe`.

## Development

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # full offline run
.\scripts\sync.ps1                 # stage into the profile and re-point (developer mode: developerTools enabled; a first install needs the wiring first)
# restart DSH Desktop → verify-post-restart.mjs
```

Repository layout:

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

Host-code changes require **restarting DSH Desktop** to load; after a restart, run `verify-post-restart.mjs` first — when old modules are still in effect it reports "please restart" directly instead of giving a false green. **Browser-half changes need no restart**, but "the file changed" is not "the served bytes changed" — the full boundary of hot reload, together with `sync.ps1`'s "keep the two newest" retention rule, is in [docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md).

How the execution world is decided by the session's agent preset, where the session-binding seam is, and the DOM-layer implementation of the UI entry point are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Release

**Maintainer release**: semantic versioning — patch = defect fixes; minor = compatible desktop-major adaptation (each harness break adaptation bumps minor, e.g. the 0.1.7 adaptation in 0.1.x); major = boundary semantics or support-matrix changes. Flow: bump the `package.json` version → full suites + `verify-post-restart.mjs` all green → `npm publish --access public` → git tag. The `files` manifest already includes `lib/wsl/dsh-wsl-confine.sh` (the helper ships with the package).

> ⚠️ **`exports["./client"]` is a hard contract and the easiest thing to delete while editing metadata.** One package that declares `dsh.client` without `exports["./client"]` refuses to compose, and the **whole desktop fails to start** (not just this plugin) — which is why 0.2.0 and 0.2.1 **cannot start at all once installed**. `scripts/verify-modules.mjs` now pins this, so running it before a release catches the regression; the incident is recorded in [docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md).

## License

This project is released under the [MIT License](LICENSE).
