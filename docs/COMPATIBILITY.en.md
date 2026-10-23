# Compatibility and upgrades — dsh-wsl-desktop

This answers two questions: **which desktop versions this plugin can run on**, and **in what order to upgrade (and roll back) the desktop and the plugin**. It does not repeat the [distro support matrix](DISTRO-SUPPORT.md), which is the Linux side.

## How versions relate

The plugin decides whether a host is usable by probing capabilities at runtime, not by comparing version numbers: `bootstrap` returns `capabilities` (host probe plus client probe), `health` returns the distro checklist, and `verify-post-restart` compares the running manifest against the checkout byte for byte. A version number is a release label, not the contract.

| Plugin | Desktop | Status | Evidence |
|---|---|---|---|
| 0.7.0 | 0.2.1-rc.2 | measured | this machine's live gate (`verify-all --live`) and `verify-post-restart`, all green |
| 0.6.0 | 0.2.1-rc.2 | measured | the full live gate at the 0.6.0 release |
| 0.7.0 / 0.6.0 | >= 0.1.7 | declared floor, not measured version by version here | 0.1.7 introduced runtime registration of the `wsl-*` presets; older hosts explicitly reject the plugin at activation (code behavior) |
| 0.7.0 / 0.6.0 | < 0.1.7 | unsupported | same: no runtime registration |

Also: `engines.node >= 22.19` is the host Node floor; `manifestVersion: 1` is the plugin metadata version, not the desktop version.

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

## Release preflight

`node scripts/release-check.mjs` at the repository root checks, before publishing: npm auth, the registry latest, whether the target version is already taken, local/remote tags, the working tree, and pnpm's `minimumReleaseAge` window. It is read-only and prints the next commands.
