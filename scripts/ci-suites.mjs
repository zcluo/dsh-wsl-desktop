/**
 * The part of the verification matrix that a plain Linux CI runner can execute.
 *
 * Everything else is EXCLUDED and listed with its precondition. The rule this
 * file exists for: a green CI run must not be readable as "the Windows/WSL half
 * passed". Add a suite here only after running it on a Linux runner once and
 * seeing it pass — not because it "looks portable".
 *
 * `verify-client-ui` is excluded for a different reason worth stating: its icon
 * assertion reads the harness checkout, which a runner does not have, so it
 * would SKIP (exit 2) and the aggregate's undeclared-skip rule would redden on
 * it. A suite that can only skip on the target platform adds no signal there.
 * @module scripts/ci-suites
 */

/** Suites CI runs. */
export const CI_SUITES = Object.freeze([
  'verify-protocol.mjs',
  'verify-world-errors.mjs',
  'verify-release-check.mjs',
  'verify-release-preflight.mjs',
  'verify-watch.mjs',
  'verify-search.mjs',
  'verify-preset.mjs',
  'verify-docs.mjs',
  'verify-package.mjs',
  'verify-ci-subset.mjs',
])

/** Suites CI does not run, each with the reason. */
export const CI_EXCLUDED = Object.freeze([
  { suite: 'verify-9p.mjs', why: 'spawns wsl.exe and reads a 9P share; needs a Windows host with WSL2' },
  { suite: 'verify-world.mjs', why: 'spawns wsl.exe and runs commands inside a distribution; needs a Windows host with WSL2' },
  { suite: 'verify-9p-skip.mjs', why: 'pins the SKIP text of verify-9p, which only occurs on a Windows host' },
  { suite: 'verify-confinement.mjs', why: 'runs unshare/setpriv inside a distribution; needs a Linux distro and user namespaces' },
  { suite: 'verify-confinement-skip.mjs', why: 'pins the SKIP text of verify-confinement' },
  { suite: 'verify-fs-fence.mjs', why: 'needs a harness checkout plus a second WSL distribution share' },
  { suite: 'verify-fs-fence-skip.mjs', why: 'pins the SKIP text of verify-fs-fence' },
  { suite: 'verify-terminal.mjs', why: 'drives the PTY bridge through wsl.exe' },
  { suite: 'verify-pty-handle.mjs', why: 'drives the PTY handle lifecycle through wsl.exe' },
  { suite: 'verify-sync.mjs', why: 'runs scripts/sync.ps1 in Windows PowerShell against a throwaway profile' },
  { suite: 'verify-diagrams.mjs', why: 'reads git history and committed evidence; it is a release-time check, not a per-push one' },
  { suite: 'verify-modules.mjs', why: 'imports the host packages; without them it SKIPs (declared), so it adds no signal in CI' },
  { suite: 'verify-host-contract.mjs', why: 'imports the host packages; declared SKIP without them' },
  { suite: 'verify-doctor.mjs', why: 'its live row needs a resolvable distribution; without one the suite exits 2' },
  { suite: 'verify-client-ui.mjs', why: 'reads the harness checkout icon source; it can only SKIP on a runner, which the aggregate treats as undeclared' },
  { suite: 'verify-client-dom.mjs', why: 'needs jsdom from a harness checkout' },
  { suite: 'verify-all-skip.mjs', why: 'spawns the aggregate itself; running it inside the aggregate is recursive' },
  { suite: 'inspect-live-client.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-route.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-live-env.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-post-restart.mjs', why: 'live: needs an installed plugin behind a running desktop host' },
])
