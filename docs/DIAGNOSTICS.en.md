# Diagnostics: error codes, the health check, and degradation — dsh-wsl-desktop

For operators on 0.6.0 and later. It explains the codes the browser sees, the environment check in the W dialog, and what happens when a host capability is missing. The execution-world mechanics live in [ARCHITECTURE.en.md](ARCHITECTURE.en.md); the fence and the distribution prerequisites live in [CONFINEMENT.en.md](CONFINEMENT.en.md) and [DISTRO-SUPPORT.md](DISTRO-SUPPORT.md).

## Copy language

The W dialog selects its copy between Chinese (`zh*`) and English from `navigator.language`, covering the error catalog, the health details and the older dialog buttons. Dynamic version strings (`Python x.y`, `dsh-wsl-confine v1.2`) and distribution, user and path values stay verbatim. There is no runtime language switch.

## Error codes

Every failure the browser half sees carries a stable `code` and a whitelisted set of `params`. The host message, `wsl.exe` stderr, resolved Windows paths and stacks never cross the wire; an unclassified internal failure returns only a `ref`, and the matching stack stays in the host log. A development-token caller still receives the human message — that is the debugging surface, not the product surface.

<!-- Code anchors: every doc link lands on the table below, not at the page top. -->
<a id="wsl-not-available"></a>
<a id="distro-unknown"></a>
<a id="distro-unreachable"></a>
<a id="user-unknown"></a>
<a id="path-invalid"></a>
<a id="path-not-found"></a>
<a id="path-not-directory"></a>
<a id="path-denied"></a>
<a id="preset-not-ready"></a>
<a id="host-capability-missing"></a>
<a id="host-plugin-stale"></a>
<a id="too-busy"></a>
<a id="internal"></a>
<a id="transport"></a>
<a id="catalog-unavailable"></a>

| code | When | Browser params | Fix |
|---|---|---|---|
| `wsl-not-available` | No executable `wsl.exe`, or WSL2 is unavailable | none | Install/enable WSL2; make sure `wsl.exe` is on PATH |
| `distro-unknown` | The requested distribution is gone or the name is invalid | `distro` | Refresh the list; reinstall or re-register it |
| `distro-unreachable` | The distribution exists but a probe timed out or cannot reach it | `distro` | Start it in a terminal, then retry |
| `user-unknown` | `getent passwd` does not know the user | `user` | Leave the field empty for the default user, or enter an existing one |
| `path-invalid` | The input is not an absolute path inside the distribution | `path` | Enter a Linux path that starts with `/` |
| `path-not-found` | The directory does not exist | `path` | Check the path, or pick it again from its parent |
| `path-not-directory` | The path exists but is not a directory | `path` | Choose a directory as the workspace |
| `path-denied` | The path exists but the current user cannot read it | `path` | Choose a readable directory, or fix its permissions |
| `preset-not-ready` | The WSL preset was not generated or cannot be mounted | `preset` | Restart the desktop; run the self-check if it persists |
| `host-capability-missing` | This desktop version lacks a host symbol the plugin needs | `feature` | Upgrade the desktop, or follow "Degradation" below |
| `host-plugin-stale` | The browser half is newer than the host half | `method` | Restart the desktop so the host half loads |
| `too-busy` | The route's 8 in-flight calls are full | none | Wait a second and retry |
| `internal` | Unclassified failure | `ref` | Copy the `ref` into the issue report |
| `transport` | The page cannot reach the local route | none | Refresh the page; restart the desktop if it persists |
| `catalog-unavailable` | The catalog fetch failed; the code is still shown | none | Retry; include the displayed code in the report |

`no-distros` is not a code: when no distribution is installed, `listDistros` returns an empty array and the dialog shows an empty state with a `wsl --install` pointer.

## The health check

After the operator confirms the distribution user, the browse phase shows an expandable "Health check" strip. It is read-only and **advisory**: no failed check disables "Create and open".

| Check | Passes when | Level |
|---|---|---|
| `bash` | `command -v bash` is non-empty | hard failure |
| `python3` | Present and version >= 3.8 | advisory (terminal/PTY bridge) |
| `util-linux` | unshare/setpriv/findmnt/mount all present | advisory (restricted mode) |
| `getent` | Present | advisory (falls back to the default shell) |
| `runner` | helper or sudo-unshare available | advisory (restricted mode) |
| `helper` | Installed and v1.2 | advisory (sudo is enough without it) |
| `nnp` | setpriv supports `--no-new-privs` | advisory (restricted mode) |
| `wsl2` | The distribution's WSL major version is 2 (read host-side from `wsl.exe -l -v`) | hard failure (WSL1 has no mount namespace) |

The answer also carries `ok` (no hard failure) and `restricted` (util-linux, runner and nnp all pass). When `restricted:false` the strip says "Restricted mode is unavailable; danger-full-access can still create." Answers are cached per distribution+user for 60 seconds; the batch has a 15-second budget, runner/NNP each race at 20 seconds, and the overall ceiling is 35 seconds. The fix command follows the `/etc/os-release` family (Debian/Ubuntu, Fedora/RHEL, Arch, Alpine, SUSE); an unrecognised family keeps the generic command instead of guessing.

## Degradation

At startup the host probes its declared symbols. A missing symbol degrades by feature and leaves a visible reason:

| Missing feature | Behaviour |
|---|---|
| `picker` / `preset-generation` / `session-create` | The W button stays mounted; clicking opens a "degraded" card listing the missing features and the fix, and requests no distributions |
| `terminal` / `search` | The dialog works; the matching tools may be unavailable, and the doctor/post-restart report it |
| `selftest` | Development surface only |

When the sidebar anchor is missing (a desktop change replaced the "add workspace" entry), the host log is no longer the only signal: a dismissible floating "WSL" entry appears, and it is removed automatically when the real entry appears. A client injection that never resolves (cordis never calls `apply`) is an external boundary: there is no in-product signal for it, only the host log and the post-restart check.

## Privacy boundary

- The browser receives only `{ ok: false, code, params }`; `SAFE_PARAMS` is a hard whitelist and values are the caller's own short text (truncated to 200 characters).
- `health` returns only command presence, version strings and the runner kind; it never returns the home, mount points or stderr.
- An `internal` stack is written to the host log only, keyed by `ref`.

## Common fixes

- **Missing bash / python3 / util-linux**: install by distribution family. Debian/Ubuntu: `sudo apt-get install -y bash python3 util-linux`; Fedora/RHEL: `sudo dnf install -y bash python3 util-linux`; Arch: `sudo pacman -S --noconfirm bash python3 util-linux`; Alpine: `sudo apk add bash python3 util-linux-misc findutils`. Every check row carries a Copy button.
- **Restricted mode unavailable**: install the `dsh-wsl-confine` helper (see [CONFINEMENT.en.md](CONFINEMENT.en.md)) or give the session user passwordless sudo; with neither, use `danger-full-access`.
- **NNP unsupported**: upgrade the distribution's util-linux; the test is whether `setpriv --help` mentions `--no-new-privs`, not the version number.
- **Default user unavailable**: enter an existing user explicitly, or repair `getent`.
- **Wrong set of distributions**: install with `wsl --install -d <name>`; after `wsl --unregister <name>`, refresh the list.

## Related source and suites

- `lib/protocol.js` — codes, bilingual copy, remedies and the params whitelist
- `lib/wsl/doctor.js` — batch probe, parser, cache and check assembly
- `scripts/verify-protocol.mjs` — catalog integrity, classifier and param filtering
- `scripts/verify-doctor.mjs` — parser, cache, assembly and one live row
- `scripts/verify-host-contract.mjs` — manifest, source cross-check and host export shape

Installation and updates are in [README.en.md](../README.en.md).
