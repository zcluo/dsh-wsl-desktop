# Verification: the suite list and the SKIP ruling — dsh-wsl-desktop

This records what each suite is responsible for, and how the aggregate reads a SKIP. The README keeps only the two aggregate commands.

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
node scripts/verify-docs.mjs         # document-pair parity: a declared bilingual pair must name the same artifacts (language-suffix normalization + full-width punctuation in the splitter)
node scripts/verify-sync.mjs         # runs the real sync.ps1 against a disposable profile: four generation-retention scenarios (link resolves / dangling / no link / never staged into)
node scripts/verify-all-skip.mjs     # the aggregate's ruling on a SKIP: an undeclared skip fails / a declared one is reported with its precondition / a dead declaration fails before any suite runs
node scripts/verify-route.mjs        # live: the acceptance route (needs a running host)
node scripts/inspect-live-client.mjs # reads the client bundle the host actually delivers (accepts marker strings)
.\scripts\sync.ps1                   # stage into the profile; an already-installed profile also gets its link re-pointed (a first install is still wired by plugin_manager)
```

Distro and user are no longer hardcoded: `DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` can override, with defaults read live from `wsl.exe`.
