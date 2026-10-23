# dsh-wsl-desktop

English | [简体中文](README.md)

## What this is

A plugin for DSH Desktop. It turns your WSL distribution into a place where work actually happens:
put a workspace inside the distro and the AI's shell commands, file reads and writes, searches and
terminals all run inside the distribution instead of on Windows.

## Why you would want it

The plugin gives every WSL session a "preset" — the set of tools a session gets when it starts. That
preset points the shell, file reading and writing, search and terminal at the distribution. So:

- **Your Linux tools really work.** With the workspace inside the distro, the AI uses the distro's
  own `bash`, `grep`, `find`, interpreters and packages.
- **Calls stop being strangers to each other.** The model's `bash` is a persistent shell, so the
  directory and environment variables left by one call are still visible to the next.
- **Two kinds of workspace can be open at once.** In the same window, Windows workspaces keep
  running on the host's own sandbox backends while WSL workspaces run inside the distro, without
  interfering with each other.
- **You can still reach the Windows side.** From inside the distro you can invoke host commands; WSL
  calls this feature interop, and it is on by default.

## What you need first

- **WSL2.** Not WSL1.
- **A supported distribution.** Debian, Ubuntu, Fedora/RHEL and Arch are measured and pass; Alpine
  works once `bash` and `util-linux-misc` are installed. The list and each distro's install commands
  are in the [distro support matrix](docs/DISTRO-SUPPORT.md).
- **DSH Desktop 0.1.7 or newer.** An older host rejects the plugin at activation.
- **Passwordless sudo for the session user, plus `bash` and `python3`.** This is the one people trip
  on. Confined mode builds a mount namespace — a Linux mechanism that gives a process its own view of
  the mount table — and makes the file system read-only inside it. The WSL kernel refuses bind mounts
  inside a user namespace, so this needs `sudo -n`. Without passwordless sudo, confined mode **fails
  explicitly** instead of falling back to running bare.
- **A helper is recommended.** The helper is a small script installed inside the distro,
  `dsh-wsl-confine`, that closes the "retained sudo grant" boundary. Install commands are in
  [Confinement](docs/CONFINEMENT.md). It is optional, but recommended.

## How to install it

**Plugin market / plugin manager (recommended)**: install `dsh-wsl-desktop@<version>`. The desktop
wires the package into pnpm and mounts its bundle patch — the configuration that hooks a plugin into
the desktop — automatically; restart and it works.

**CLI equivalent**:

```
plugin_manager install_bundle dsh-wsl-desktop@<version>
```

**Update**: install a new version number. After a desktop-major update, run `verify-post-restart.mjs`
once first; the "what will surprise you" section says why.

**Uninstall**: uninstall through the plugin manager. The `wsl-*` presets this plugin registers are
withdrawn with it, so no workspace is left pointing at a plugin that no longer exists.

## How to use it

In the sidebar workspace title bar there is an extra **W** button to the right of the built-in "+"
(add workspace). Click it, then go in order:

1. **Pick a distribution.** The installed WSL distributions are listed.
2. **Enter a user.** This is the user to enter that distro with, and it decides whose home you browse.
   **Leave it empty for the distro's default user.** If the user does not exist, the error appears in
   place in the popup and browse mode is not entered.
3. **Pick a directory.** Browse, or type a Linux path. You land in that user's home directory; the
   host resolves the user database inside the distro with `getent passwd`.
4. **Create and open the session.**

A few details you will run into:

- **Switching distributions asks for the user again**, including re-clicking the one already selected;
  the field starts from the name you confirmed last time.
- **While a session creation is in flight, the distribution buttons are unclickable**, so a submission
  cannot change target halfway.
- **This step only decides whose home is browsed, not the session identity.** The session always runs
  inside the distro as the distro's default user; the plugin's configured `username` is not passed
  along with session creation.
- In the sidebar workspace list, **a workspace whose path is under a WSL UNC root shows a ☁️ icon
  instead of a folder**. UNC is Windows' spelling for a subsystem or network path, of the form
  `\\wsl.localhost\<distro>\home\...`.
- The built-in "+" keeps the deployment's own behaviour (the Electron directory picker on Desktop);
  this plugin does not override it.
- Inside an open WSL workspace, the file list and the terminal are the distro's. PowerShell in Windows
  workspaces is unaffected.

## What will surprise you

These are real boundaries, not a disclaimer list. Each one tells you where to read further.

- **The search tools behave differently from the host.** `grep` / `glob` in a WSL session use the
  distro's own `grep` / `find`, so: the regex dialect is POSIX ERE, which means `\d` and `(?i)` do
  not work · `.gitignore` is not parsed, only the six VCS directories are skipped · dotted
  directories are searched · `include` matches the base name only and has no brace expansion · a
  record whose path contains `:` may be dropped or mis-attributed · binary files never match · a
  capped result is not saved anywhere. The eight differences and the limits are in
  [Search inside the distribution](docs/SEARCH.md).
- **The terminal goes through a PTY bridge and does not support `stdio.control`.** A terminal needs a
  real pseudo-terminal (PTY) inside the distro, but `wsl.exe` only carries three pipes, so the plugin
  runs a small bridge inside the distro and drives it from two host-side processes. The terminal's
  `stdio.control` fd channel is explicitly rejected because `wsl.exe` cannot forward arbitrary
  descriptors. How the bridge is driven is in [Terminal (PTY bridge)](docs/PTY-BRIDGE.md).
- **The file fence governs the model, not you.** The GUI's web terminal is **unfenced by design** —
  what you type in the terminal panel is the same as opening a shell in the distro yourself; what is
  confined is the model's `bash`. Also, **the terminal path has no PID namespace** — the Linux
  mechanism that lets a group of processes see only themselves and not the rest of the system —
  while the one-shot command path keeps it. Both boundaries are written out in
  [The persistent shell](docs/PERSISTENT-SHELL.md).
- **`/dev`, `/proc`, `/sys` and interop are outside the fence.** They are not file storage, so the
  plugin reports its own `enforcement` field as `partial` (partial coverage) instead of calling it
  "sandboxed".
- **The subprocess surface is not fenced.** The host's own subprocess surface — terminating managed
  processes, output overflow, reclaiming them — is not bound by the file fence; that is a design
  decision, not an omission. See [Security and trust boundaries](SECURITY.md).
- **The retained passwordless sudo grant can bypass the file fence.** The session user keeps the grant
  the plugin itself needs to build the fence, so a confined command can re-invoke it. There are two
  closing paths — the helper, and NO_NEW_PRIVS, a kernel flag that stops a process from ever gaining
  privileges — and their real reachability is in [Security and trust boundaries](SECURITY.md).
- **File-change watching polls; it is not event-driven.** 9P is the share WSL uses to expose the
  distro's files to Windows, and `fs.watch` throws `EISDIR` on it. So the plugin polls on the host
  side: a directory checks its entry set every 300ms, a file gets a `stat` every 300ms. **A directory
  target is invalidated by entry changes only** — adds, removes and renames are seen, a content change
  of a file inside it is not; watch that file's own path to follow content. Mechanisms and
  measurements are in [WSL file watching](docs/WATCH.md).
- **A desktop update can break the plugin.** The plugin depends on the desktop framework's APIs — the
  harness — and changes to them interrupt it (0.1.6 → 0.1.7 broke four places in one go). So after
  updating the desktop, run `node scripts/verify-post-restart.mjs` once and only keep going when
  everything is green.
- **Failures now carry a code, so you can diagnose first.** The browser receives a stable code and
  the whitelisted params, never the host message, stderr or resolved paths; after the user is
  confirmed, the W dialog shows an advisory health check whose failed rows carry the fix. Codes,
  checks and degradation are in [Diagnostics](docs/DIAGNOSTICS.md).
- **The W dialog is bilingual and keyboard-contained.** Copy follows `navigator.language` between
  Chinese and English; the dialog traps Tab, closes on Escape and returns focus to the W button,
  and copy feedback goes through a screen-reader live region. Details in
  [Diagnostics](docs/DIAGNOSTICS.md#copy-language).
- **Who it is for.** For now it suits the plugin author or an operator of the same trust level, for
  long-term use. Distribution to third-party users, or unattended high-value environments, are not
  suitable yet — the reasoning is in [SECURITY.md](SECURITY.md).

## Where to read more

- [Security and trust boundaries](SECURITY.md) — trust boundaries, disclosed unconfined surfaces, audit results
- [Architecture and the execution world](docs/ARCHITECTURE.md) — how a session binds its execution world, and why the UI does what it does
- [Confinement (Linux side)](docs/CONFINEMENT.md) — the mount-namespace fence, the helper, measured preconditions
- [The fs tool fence](docs/FS-FENCE.md) — how out-of-bounds file access is decided
- [Terminal (PTY bridge)](docs/PTY-BRIDGE.md) — how the terminal gets inside the distro
- [The persistent shell](docs/PERSISTENT-SHELL.md) — the model's `bash`: gap list, limits, manual checklist
- [Search inside the distribution](docs/SEARCH.md) — the eight semantic differences, the limits, how to verify yourself
- [WSL file watching](docs/WATCH.md) — the polling strategy and its boundaries
- [Verification](docs/VERIFICATION.md) — what each suite is responsible for, and how a SKIP is ruled
- [Diagnostics](docs/DIAGNOSTICS.md) — error codes, the health check, degradation and the privacy boundary
- [Engineering notes](docs/ENGINEERING-NOTES.md) — measured constraints, repository layout, release flow, install shape
- [Distro support matrix](docs/DISTRO-SUPPORT.md) — which distros were verified, and what each one needs
- [Compatibility and upgrades](docs/COMPATIBILITY.md) — plugin/desktop version relation, upgrade order, rollback steps
- [Upstream API proposals](docs/UPSTREAM-PROPOSALS.md) — the two proposals to the harness upstream
- [Architecture and flow diagrams](docs/diagrams.md) — interactive architecture, sequence and lifecycle diagrams

Three of the linked documents — the distro support matrix, the upstream proposals and the diagram
index — are **Chinese-only**, because no English text for them exists. Translating them is a separate
piece of work, not a rename.

## For maintainers

This section is for people changing this repository; if you only want to use the plugin, the above is
enough.

- `README.md` and this file are a declared bilingual pair: `scripts/verify-docs.mjs` requires both
  sides to name the same repository artifacts.
- Self-check: `node scripts/verify-all.mjs` runs every offline suite; add `--live` for the suites that
  need the installed plugin and a running host. Per-suite responsibilities and the SKIP ruling are in
  [Verification](docs/VERIFICATION.md).
- The repository layout, the install shape and the release flow are in
  [Engineering notes](docs/ENGINEERING-NOTES.md). What semantic versions mean in this repository,
  and the `npm publish` steps, are documented there too.
- ⚠️ **`exports["./client"]` is a hard contract.** One package that declares `dsh.client` without
  `exports["./client"]` makes the host refuse to compose, and the **whole desktop fails to start**.
  `scripts/verify-modules.mjs` pins this, so running it before a release catches the regression. The
  incident is in [Engineering notes](docs/ENGINEERING-NOTES.md).
- Distribution and user are not hardcoded: `DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` can
  override, with defaults read live from `wsl.exe`.

## License

This project is released under the [MIT License](LICENSE).
