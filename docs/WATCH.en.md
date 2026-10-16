# File watching (WSL workspaces) — dsh-wsl-desktop

This is the full record of file-change watching in a WSL workspace: why polling is the only thing that works here, what each strategy promises, its measured cost, what was not measured and which boundaries are accepted, and why the native watcher is not kept as a fallback. The README keeps only the conclusion and the entry point.

## Why polling is necessary

The consumer chain is `WorkspaceChangeFeed.follow` → `ctx.fs.watch` → `LocalFileSystem.watch` → chokidar → `fs.watch`, and it breaks at the share's first link: **`fs.watch` throws `EISDIR` at construction on `\\wsl.localhost\…` — for a directory target and for a file target alike** (measured). `LocalFileSystem.watch` (`packages/fs/fs-local/src/index.ts:69-89`) watches a **directory** in both branches: a directory target is watched itself, a file target through its `dirname`; so EISDIR blocks every WSL target, and `packages/api/workspace-files/src/changes.ts:79-89` wraps it as `workspace-file/watch-unsupported`. The consumer (the sidebar file tree) does not report that error as a failure; it keeps manual refresh available (`packages/client/ui-sidebar-files/src/client/directory-node.ts:124-131`). The user-visible effect is therefore: **a WSL workspace's sidebar file tree loses its live refresh while manual refresh remains** — a declared degradation, neither a crash nor a silent failure.

> **Mechanism note (measured 2026-10-15)**: the break happens **inside chokidar** — it does **not** throw `EISDIR` at its caller, it **emits an `error` event** (measured here: the native `fs.watch` throws synchronously, chokidar emits the event 12ms later, and a local NTFS control reaches `ready` in 4ms). `LocalFileSystem.watch`'s `await once(watcher, 'ready')` therefore **never sees `ready`**: the provider's `watch()` **neither resolves nor rejects**, the error arrives only through the `changed(error)` callback, and that is what `changes.ts` wraps as `watch-unsupported`. "Throws at construction" is true of the native primitive only, **not of the provider path**; when debugging "a watcher is not working", keep three things apart — whether the primitive throws synchronously, whether the library turns that into an event, and whether the caller's promise therefore hangs forever.

This line's fix is to give that world a strategy the share supports: **user-space polling on `node:fs` alone**. `lib/wsl/watch.js` is the single owner (the two strategies + the pure strategy choice + `startWatch` with its injectable io), and `lib/wsl/fs.js` overrides `watch` to wire it into `ctx.fs.watch`.

## The two strategies

`watchStrategyFor` is pure: `directory` → `dir-entries`, `file` and `absent` → `path-stat`. "Absent → poll the stat" satisfies the base `watch` contract's own wording, *an absent path to observe for creation*: the path appearing invalidates.

**`dir-entries` (a directory target)**: one `readdir` per tick, comparing the set of entry **names** as a key (sorted, NUL-joined) against the previous tick; only a difference notifies, once.

- **The invalidation condition is the entry set**: adds / removes / renames are seen; the CONTENT change of a child is not (see "Not measured and known limitations").
- The first reading only establishes the baseline and **does not notify** — mirroring the host backend's `ignoreInitial: true`. Without it, every watch would report a false change the moment it opens.
- `ENOENT` is not an error but an **absence sentinel with a key of its own**: deleting and re-creating the directory both notify, and so do the creation and removal of an **empty** directory — absence and an empty entry set are two different keys (see "Not measured and known limitations").
- Ticks do not stack (a tick is skipped while the previous one is still running), and **there is at most one notification per tick**. The merge is not an optimization: the frame in `packages/api/workspace-files/src/changes.ts:95-102` is built from that target, so per-child notification would produce N identical frames about **the same directory** — the polling structure dissolves that storm.

**`path-stat` (a file, and a path that does not exist yet)**: `fs.watchFile(hostPath, { interval, persistent: true }, listener)`; any change of mtime / size / ino invalidates. **An existing file stays silent until it changes**; **a path that does not exist yet reports once immediately when armed** (measured Node semantics: the first comparison has no previous stat to compare against and is read as a change — and the path is still absent when that lands), **then again when the path appears**. That decides how the live evidence has to be written: the file row must create its probe file first, or `notified > 0` would be satisfied by the arming notification (see "Where the pins are"). The disposer removes **its own** registration only (`unwatchFile` with the listener): Node refcounts one StatWatcher per path, so `unwatchFile(path)` without a listener would drop other consumers of that same path as well.

The watched path is `target.targetKey` (the host spelling), **not** `processPath` — the latter returns the Linux spelling, and resolving it on the host side would watch something else entirely (`/home/…` becoming `E:\home\…`), usually silently: that path mostly does not exist.

`WATCH_INTERVAL_MS = 300` is a constant rather than a config field: both strategies that ship measured 0ms CPU / 3s, so there is no lever to hand an operator; if a deployment ever needs tuning, that constant is the single place.

## Measured numbers

Conditions: distribution `debian-dev`, 200 entries in the directory, interval 300ms (measured on this machine, 2026-10-14).

| Strategy | Idle CPU (this process) | Child content change | Add / remove | Latency |
|---|---|---|---|---|
| Directory `readdir` name set (**shipped**) | **0ms CPU / 3s** | invisible | seen / seen | **2–3ms** |
| File `fs.watchFile` (**shipped**) | **0ms CPU / 3s** | seen | — | **52ms** |
| Control: `readdir` + one `stat` per entry | 594ms / 3s | seen | seen / seen | 247–655ms |
| Control: chokidar `usePolling` (**cannot ship**: the plugin has no `dependencies`) | 624ms / 3s | seen | seen / seen | 37–168ms |

mtime is updated promptly across the share (measured: `advanced`) — that is the premise any polling fix rests on: polling only sees a change when the timestamps on the share actually move.

## Not measured and known limitations

- **The cost of `readdir` is paid on the 9P server side, not in this process**: one round trip per tick, linear in the entry count. 0ms CPU / 3s in this process is **not** the whole machine's cost being zero; a very large directory (>10k entries) was not quantified.
- **Measured on `debian-dev` only**: every other distribution shares the same WSL2 kernel and 9P stack, but was not re-measured one by one.
- **A directory target is blind to its children's content changes** (by design, not a defect): to follow one file's content, watch that **file's own path**. The only active directory consumer (the sidebar file tree) re-lists the directory on any frame and does not need content awareness anyway.
- **`readdir` on a file throws `ENOTDIR`, and it reaches the consumer as an error rather than as absence** (measured). There is exactly one way to reach it: the target stopped being a directory between the `watch` call's stat and some later tick — a race in the `dir-entries` branch; the `path-stat` branch never calls `readdir` and cannot hit it. The consequence is that notification arrives as a reported failure (through `changed(error)`), not as "the directory is gone".
- **An absent directory and an existing empty directory used to share one key — fixed**: `readEntryKey` now maps `ENOENT` to a sentinel key `'\0'` that `readdir` cannot produce. Its unreachability is **by construction, not by convention**: POSIX file names cannot contain NUL and `entrySetKey` only uses NUL BETWEEN names, so every real reading's key starts with a non-empty name; producing `'\0'` would need an empty file name, which cannot exist. **Current semantics**: creating and removing an empty directory both notify (previously the same key before and after, read as no change), and either direction of the empty ↔ absent transition is a change; `scripts/verify-watch.mjs` pins it through the injected io in **both directions** (an `ENOENT` reading followed by `[]`, and `[]` followed by `ENOENT`), and its measured red variant is the sentinel back at `''` — **both direction rows redden together** while the other 38 stay green (the two rows read one key pair in its two directions, so that mutant is shared input rather than an isolating one).
- **`inotify` inside the distribution sees 0 events on `/mnt/c`** (4/4 event types on ext4 and tmpfs, while on `/mnt/c` not even the script's own write is seen) — that is why the "in-distro inotify bridge" (option 2) is deferred, and it is also its boundary. The trigger condition: when a consumer appears that **must** observe a child's content change inside a large directory, add a third strategy; `lib/wsl/watch.js` is already the single owner, so that is an addition rather than a structural change.

## Why the native watcher is not kept as a fallback

Two shortcuts are explicitly refused:

- **`process.env.CHOKIDAR_USEPOLLING = '1'`**: one line would turn chokidar into a poller, but it is a **process-wide** environment variable — the **Windows workspaces** in the same instance would start polling too, a side effect that leaves this plugin's boundary (invariant: Windows workspace behavior is not changed). And without that switch, chokidar does not switch to polling for a UNC path by itself (its only automatic polling branch in 4.0.3 is IBM i), so "let chokidar handle the share natively" was never an option.
- **`import 'chokidar'`**: the plugin's `package.json` has **no `dependencies`**; chokidar is only a transitive dependency of the host's `@deepseek-ai/dsh-fs-local`, and reaching a transitive dependency from a plugin does not even resolve under pnpm's strict layout — exactly the kind of resolution fragility recorded in `docs/UPSTREAM-PROPOSALS.md`.

The host side's native watching is **left exactly as it is**: this plugin replaces nothing in a Windows workspace. So this line's polling is not a "fallback for native watching" — it is the WSL world's own watching strategy.

## Where the pins are

`scripts/verify-watch.mjs` (offline, **with no precondition, so it never skips**; the list and the single-suite commands are in `docs/VERIFICATION.md`) pins: strategy choice, the entry-set difference and its first-reading baseline, absence versus a real failure (absence and an empty entry set each get their own key, so either direction of the transition is a change), a tick that does not stack, an idempotent disposer and a late abort, and a stat strategy that removes only its own registration. It drives ticks by hand through `startWatch`'s **injectable io seam** — no sleeping, no racing, so it measures behavior rather than this machine's speed. Its last two sections are the deliberate exception: they pass **no io**, so the module's own default seam runs against a real temp directory for the directory strategy and the stat strategy, and pins the Node semantics that decide how the live file row must be armed — a path that does not exist yet reports once at arming and again when it appears; an injected fake is blind to a default that is wrong — a callback-style `readdir` would reject every WSL directory target during the baseline read while every row through the injected seam stayed green (measured in this series).

The three live rows in `scripts/verify-post-restart.mjs` (they need the installed plugin and a running host): `fs.watch.file` (change a file from inside the distribution → a notification arrives), `fs.watch.dir` (create an entry from inside the distribution → a notification arrives), and `fs.watch.native` (the **honest status row**: the native `fs.watch` still throws `EISDIR` on the share). The first two assert that **a notification actually arrived** (`notified > 0` and `watchError === null`), not that the call returned — a row that never armed reads as `notified: 0` and looks like nothing happened; that is why the file row **creates its probe file before it arms the watch** — a path that does not exist yet reports once at arming (see "The two strategies"), so without the pre-created file `notified > 0` would be satisfied by that baseline. The wait window is 5 × `WATCH_INTERVAL_MS` in `lib/index.js:688` (1500ms): roughly 28.8x headroom over the measured 2–52ms (1500/52), and it still reddens if the poll never runs. The third row records "the override still has a reason to exist" as evidence: the day the share stops throwing EISDIR, it reddens and tells the maintainer the override can go.

The document itself is pinned too: `docs/WATCH.md` and `docs/WATCH.en.md` are checked by `scripts/verify-docs.mjs`'s **declared-pair table** — the two language editions must name the same repository artifacts, and an undeclared pair is not merely unchecked, it is unchecked without saying so.
