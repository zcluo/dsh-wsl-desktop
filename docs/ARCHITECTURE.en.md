# The execution world: session binding, the UI entry point, and the architecture — dsh-wsl-desktop

This is the deep material behind the README's architecture section: how the execution world is decided by the session's agent preset, where the session-binding seam is, and why the UI entry point works the way it does. The README keeps only what a reader needs to act.

## Session binding: name the execution world in the create request

The harness fixes the preset at session **creation** (`SessionCreateRequest.agentPreset` → `composeAgent`'s `setup: presets.mount(...)`; the mount happens before the session is published). Calling `agentPresets.select` after the fact only works on sessions that "have not run any turn yet"; once a session has had a turn it is rejected with `agent-preset/locked` — and that rejection is only written to an in-memory log, never reported to the user.

**The current implementation is built around exactly this fact**:

- When creating a session in the W dialog, the browser half first calls the host's `wslPresetFor` to resolve the variant id, then puts `agentPreset` into the **create request** (`createBoundSession()` in `lib/client.js`). This is the only race-free seam: the preset is composed together with the session, so there is no window of "first run in the Windows world, then switch".
  - **That field crosses two API layers, and one of them drops it.** The host's `SessionCreateRequest.agentPreset` is a real contract, but the client service wrapper `ctx.sessions.create` rebuilds its payload from `workspaceId | cwd | sessionId` alone — `agentPreset` is silently discarded, the session lands on the default preset, and only the fallback below rescues it. Creation therefore goes through the **generated remote contract** `ctx.remote.session.create({ workspaceId, agentPreset })` (with `remote` / `remote.session` injected to match), and `ctx.sessions.create` is kept only as the retreat for a host whose remote surface is unavailable. `scripts/verify-client-ui.mjs` pins both halves.
- The host half keeps an `api-session/added` listener (`bindWslSession` in `lib/index.js`) as a **fallback**: it only handles sessions whose "cwd is a WSL path but the creation carried no preset" (for example, sessions created from another entry point). It attempts a post-hoc `select`; on success it binds retroactively, on failure it writes `bindingLog` and warns in the host log — such entries are now **anomaly signals**, no longer part of the normal path.
- The binding section of `verify-post-restart.mjs` therefore reads: a non-selftest `bindingLog` entry = someone created a WSL session while bypassing the creation seam; zero entries = every session bound through the create request is fine. Final GUI-side confirmation has been done by the operator (session preset shows WSL · PTC mode; tools execute inside the distro).

## UI entry point (why it happens at the DOM level)

In the sidebar workspace list, **a workspace whose path is under a WSL UNC root shows a ☁️ icon instead of the folder**. Detection goes through the workspace list (`ctx.workspaces.list.getSnapshot().items` and their `path` — **the `list` hop is not optional: written as `ctx.workspaces.path` the lookup yields undefined and silently does nothing**), because the row's DOM carries only the workspace NAME, never its path; the row key `workspace:<id>` holds the workspace id itself, so the mapping is reliable. The icon is this plugin's own vector cloud, not an emoji: the harness icon set ships no cloud, and there is **no per-row icon slot** (only the whole `sidebar.workspaces` section, which would shadow the shipped list), so the swap happens at the DOM level and rides the same sync pass as the W button.

Two details measured while building it: **the cloud follows the row's weight** — collapsed renders `IconFolderCloseRegular` (a 1px stroke) while expanded renders `IconFolderOpenRegular` (fill-only), so one closed path is rendered both ways (stroked = outline, filled = solid) and the cloud is rebuilt when the row expands, so a stroke is never shown beside a fill. And **the shipped `<svg>` is hidden, never removed**: React owns that node, and pulling its child out is how a `removeChild` exception starts; `display` is also not a childList mutation, so the swap does not feed the observer it runs from (0 childList records in 2.6 s, measured). `scripts/verify-client-dom.mjs` covers all of it.

After a distro is selected, the dialog **first asks for the user to enter that distro with** (leave empty = the distro's default user); only after confirmation does browsing begin: the path lands directly in that user's home directory (the host resolves the user database inside the distro with `getent passwd`, method `resolveHome`). If the entered user does not exist, the error is shown in place in the popup, without entering browse mode. Switching distros — including re-clicking the currently selected one — re-prompts for the user, prefilled with the previously confirmed name. While a session creation is in flight, distro buttons are temporarily unclickable (the outcome of a submit belongs to that submit). Once inside browse mode, the home directory is an ordinary path — the input box, go-to, breadcrumbs, and directory clicks all work as usual. To be precise about the boundary: this step only decides "whose home gets browsed", **not the session identity** — the session always executes inside the distro as the distro's default user (`username` is plugin configuration and is not passed along with session creation).

"+" keeps the deployment's own behavior (the Electron directory picker on Desktop); this plugin does not override it:

- `sidebar.workspaces.directoryFlow` is `kind: 'single'`, and the placeholder would **shadow** the deployment's own directory picker, so this plugin does not register that slot;
- The sidebar title bar has no extension point, so the W button attaches as a companion node right after the "+" button: it locates itself by the SVG path geometry of the "add workspace" icon (language-independent; this icon is rendered in exactly one place in the app) and reuses that button's class to inherit the same size and hover states. The desktop once rebuilt that icon (`IconProjectAddOutline16` → `ProjectAddOutlineArtwork`, geometry completely changed), so the trigger carries a **known list of both old and new geometry generations** and prefix-matches either one — a desktop update will not make W silently disappear. When React replaces that subtree, a MutationObserver re-attaches W.
- **Hiding must use `display`, never `remove()`.** The observer watches `childList`, and `remove()` is itself the next trigger; the two feed each other at refresh rate (measured: 52 times in 2.6s, each with two forced layouts). When there is no room, set `display: none` — it is not a childList mutation, so it converges.
- **Never use a timer as a fallback.** A past `setInterval(sync, 2000)` was the seed of exactly this loop; remounts/portals are childList mutations on the observed subtree, and a timer solves no real situation.
- The companion button only shows while "+" is visible (when inline search expands, it hides together with the official action cluster); when a second control carries the same icon geometry, the one inside the `*_headerActions` cluster wins; when nothing can be recognized, the button stands down entirely rather than guessing.

## Terminal registry lines

**This realm mounts the group: the registry, the backend, and the model's persistent tool.** The sidebar terminal panel itself still goes through `agent.ctx.get('subprocess').spawnTerminal(...)` (`packages/api/terminal-controller/src/index.ts:333,346`) — session-scoped, so the realm's `subprocess-wsl` automatically puts the PTY inside the distro, and that path is unrelated to the terminal group. The group serves **the model's persistent `bash`**: `@deepseek-ai/dsh-terminal` provides the `terminals` service, `@deepseek-ai/dsh-terminal-bash` registers the PTY mechanism into it and spawns **through the realm's own `ctx.subprocess`** (that is, the terminal primitive in `lib/wsl/subprocess.js`), and `@deepseek-ai/dsh-tool-bash-persistent` registers the model-facing `bash`.

That brings one hard rule: **the group must isolate `terminals`**. A service-providing plugin whose group does not declare `isolate: { terminals: true }` has that mount **refused outright** by the loader — not silently degraded. Everything beyond the diagrams (why those three rows cannot be copied from the harness, the gap list, the limits and the manual checklist) is in [The persistent shell](PERSISTENT-SHELL.en.md).

## The contract layer and degradation

The 0.1.6 → 0.1.7 break and the silent removal of `serviceForAgent` in 0.2.1-alpha.1 turned host-API drift into this plugin's first maintenance risk. Since 0.6 the host surface is declared first and probed second:

- `lib/host/contract.js` declares every runtime symbol (`agentPresets.readDocument`, `tools.register`, `subprocess.spawnTerminal`, ...) and every statically imported host package in one manifest; `probeHost` aggregates by feature, a feature with no host symbol answers `unknown`, and `lib/client.js` merges it with its own injected-service probe.
- `lib/protocol.js` is the browser's single vocabulary: codes, zh/en copy, remedies and `SAFE_PARAMS`. `bootstrap` in `lib/index.js` serves the catalog and the capability state in one call; `lib/client.js` caches it and enters the "degraded" card when any of the picker's three required features is missing, instead of letting W disappear silently.
- `lib/wsl/doctor.js` answers the read-only `health`: one batch collects the userland facts, the cached runner/NNP probes are reused, and the result is advisory — it never disables creation.

Browser responses carry only `{code, params}`; the message, stderr and host paths stay on the host. The details and the code table are in [Diagnostics](DIAGNOSTICS.en.md).

## Architecture

**The execution world is decided by the session's agent preset.** `ctx.shell` / `ctx.fs` / `ctx.subprocess` are process-level singletons, and the Windows and WSL tool dialects differ (pwsh vs bash), so coexistence is achieved not by "a global provider that routes by path" but by the preset's `isolate` realm:

```
Windows workspace session                 WSL workspace session
  preset: standard                          preset: wsl-standard
  ctx.shell = pwsh-sandbox (host)           isolate: { shell, fs, subprocess,
  ctx.fs    = fs-sandbox (host)                         terminals, sandbox }
                                            ├─ shell-wsl    → ctx.shell
                                            ├─ fs-wsl       → ctx.fs
                                            ├─ subprocess-wsl → ctx.subprocess
                                            ├─ sandbox-wsl  → ctx.sandbox
                                            ├─ pty + terminal-bash
                                            └─ persistent-bash / tool-fs
```

The realm's `isolate` has **five** keys, not three: `terminals` and `sandbox` are required for the same reason, because plugins in the group **provide** those services and a service-providing plugin cannot sit in an unisolated group (the loader refuses the mount). `tool-bash` is not in the group: the single owner of the model-facing name `bash` is the `persistent-bash` row.

`wsl.exe` itself is an ordinary Windows process, so the WSL executors still end up launching it through the **host's** subprocess provider. The realm isolates `shell`, `fs`, `subprocess`, `terminals` AND `sandbox`, so `ctx.subprocess` inside the realm resolves to the realm's own provider; the host row captures the root provider in the root composition (`lib/wsl/host-refs.js`) and the realm rows read it back — managed-process termination, output overflow, and reaping still belong to the local provider. Isolating `sandbox` is **observable**: once isolated, the terminal stack can no longer reach the host's sandbox provider, and therefore not its Windows ACL runner, which fails on this realm's UNC workspace (see [The persistent shell](PERSISTENT-SHELL.en.md)).

**The execution world is named in the create request.** When the browser half creates a WSL session, it writes the variant id into `agentPreset` via `wslPresetFor`; the host half only does fallback + warning in `api-session/added` for "WSL-path sessions without a preset" (see "Session binding" above). The browser half therefore depends on nothing beyond the preset client API.
