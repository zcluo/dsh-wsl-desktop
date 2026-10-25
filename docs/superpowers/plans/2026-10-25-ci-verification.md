# CI for the verification matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions workflow that runs the platform-independent part of the verification matrix on every push, and a local `--ci` mode that proves *which* suites that is, so a green CI run can never be mistaken for coverage of the Windows/WSL half.

**Architecture:** The matrix is deliberately platform-heavy: many suites spawn `wsl.exe`, read a WSL 9P share, need a harness checkout, or need the desktop host running. Running all of them on a Linux runner would produce a wall of SKIPs that a reader would misread as "verified". So CI runs a **named subset** — the suites whose preconditions are satisfiable on a plain Linux runner — and the aggregate keeps its existing rule that an undeclared SKIP fails. The subset is defined in one place (`scripts/ci-suites.mjs`), the local `--ci` flag runs exactly it, and the workflow is a thin wrapper over that flag. This makes the CI set testable on the developer's machine before any workflow exists.

**Tech Stack:** GitHub Actions (`ubuntu-latest`), Node 22.x, `scripts/verify-all.mjs`, ESM.

**Spec:** None; this plan is infrastructure around the existing matrix. The behaviour it must preserve is `scripts/verify-all.mjs`'s documented SKIP doctrine (an undeclared skip is a failure).

## Global Constraints

- **A green CI run must not imply the Windows/WSL half passed.** The workflow name, job name and a summary line must say which subset ran.
- CI must not run `--live`: it needs an installed plugin behind a running desktop host, which CI does not have.
- `verify-all.mjs`'s off-CI behaviour is unchanged: `node scripts/verify-all.mjs` still runs the full offline matrix.
- The subset list lives in exactly one module, imported by both the aggregate and the workflow's command; no duplicated list.
- Workflow must not require secrets. No publishing, no tag creation, no writes to the registry.
- Node version in CI matches `engines.node` (`>=22.19`): use `22.x`.

---

## File Map

| File | Responsibility |
|---|---|
| `scripts/ci-suites.mjs` | **New.** The named subset and the reason each excludes-vs-includes decision was made. Single source of truth. |
| `scripts/verify-all.mjs` | Accept `--ci`; when present, run the subset and say so in the summary. |
| `scripts/verify-ci-subset.mjs` | **New.** Tests the selector itself (the subset is non-empty, excludes the platform-heavy suites, and every named suite exists on disk). |
| `.github/workflows/verify.yml` | **New.** Node setup, `npm ci` if a lockfile exists (it does not: zero dependencies), run `node scripts/verify-all.mjs --ci`. |

---

### Task 1: Define the subset as data

**Files:**
- Create: `scripts/ci-suites.mjs`
- Test: `scripts/verify-ci-subset.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CI_SUITES: string[]` (suite file names) and `export const CI_EXCLUDED: Array<{ suite: string, why: string }>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-ci-subset.mjs`:

```js
/**
 * Checks on the CI subset selector itself.
 *
 * The subset decides what a green CI run means, so it gets its own assertions:
 * a typo in a suite name would otherwise turn into a silently narrower run.
 *
 * Run: node scripts/verify-ci-subset.mjs
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeChecker } from './suite-shell.mjs'
import { CI_EXCLUDED, CI_SUITES } from './ci-suites.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checker = makeChecker({ pass: 'PASS' })
const { check } = checker

check('the subset is not empty', CI_SUITES.length > 0, CI_SUITES)
check('every named suite exists as a file',
  CI_SUITES.every((suite) => existsSync(join(here, suite))),
  CI_SUITES.filter((suite) => !existsSync(join(here, suite))))
check('the subset never includes a live suite',
  !CI_SUITES.some((suite) => /^verify-(route|live-env|post-restart)\.mjs$|^inspect-live-client\.mjs$/u.test(suite)),
  CI_SUITES)
check('the subset never includes the platform-bound suites',
  !CI_SUITES.some((suite) => /^verify-(9p|confinement|fs-fence|terminal|pty-handle|sync)/u.test(suite)),
  CI_SUITES)
check('every excluded suite carries a reason',
  CI_EXCLUDED.every((entry) => typeof entry.why === 'string' && entry.why.length > 10),
  CI_EXCLUDED.filter((entry) => !(typeof entry.why === 'string' && entry.why.length > 10)))
check('included and excluded do not overlap',
  CI_SUITES.every((suite) => !CI_EXCLUDED.some((entry) => entry.suite === suite)),
  CI_SUITES.filter((suite) => CI_EXCLUDED.some((entry) => entry.suite === suite)))

console.log(`\n${checker.passed} passed, ${checker.failures} failed`)
process.exit(checker.failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/verify-ci-subset.mjs`

Expected: FAIL — `Cannot find module './ci-suites.mjs'`.

- [ ] **Step 3: Write the selector**

Create `scripts/ci-suites.mjs`. Start from the suites whose preconditions a plain Linux runner satisfies, and record every exclusion with the measured reason:

```js
/**
 * The part of the verification matrix that a plain Linux CI runner can execute.
 *
 * Everything else is EXCLUDED and listed with its precondition. The rule this
 * file exists for: a green CI run must not be readable as "the Windows/WSL half
 * passed". Add a suite here only after running it on a Linux runner once and
 * seeing it pass — not because it "looks portable".
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
  'verify-client-ui.mjs',
  'verify-package.mjs',
  'verify-ci-subset.mjs',
])

/** Suites CI does not run, each with the reason. */
export const CI_EXCLUDED = Object.freeze([
  { suite: 'verify-9p.mjs', why: 'spawns wsl.exe and reads a 9P share; needs a Windows host with WSL2' },
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
  { suite: 'verify-doctor.mjs', why: 'its live row needs a resolvable distribution; the offline rows would pass, but the suite would exit 2' },
  { suite: 'verify-client-dom.mjs', why: 'needs jsdom from a harness checkout' },
  { suite: 'verify-all-skip.mjs', why: 'spawns the aggregate itself; running it inside the aggregate is recursive' },
  { suite: 'inspect-live-client.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-route.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-live-env.mjs', why: 'live: needs a running desktop host' },
  { suite: 'verify-post-restart.mjs', why: 'live: needs an installed plugin behind a running desktop host' },
])
```

- [ ] **Step 4: Run the selector test**

Run: `node scripts/verify-ci-subset.mjs`

Expected: PASS. If `verify-docs` or `verify-package` fail on the runner for a reason the next task reveals, move that suite to `CI_EXCLUDED` **with the measured reason** — do not delete the assertion.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-suites.mjs scripts/verify-ci-subset.mjs
git commit -m "test(ci): define the Linux-runnable verification subset"
```

---

### Task 2: Make the aggregate honour `--ci`

**Files:**
- Modify: `scripts/verify-all.mjs` (argument parsing, suite list, summary line)

**Interfaces:**
- Consumes: `CI_SUITES` from `./ci-suites.mjs`.
- Produces: nothing exported; a new CLI flag.

- [ ] **Step 1: Add the flag and the list**

In the argument parsing area of `scripts/verify-all.mjs`, alongside `const live = process.argv.includes('--live')`:

```js
const ci = process.argv.includes('--ci')
```

and where `const suites = live ? [...STANDALONE, ...LIVE] : STANDALONE` is computed:

```js
// CI narrows the matrix to the suites a plain Linux runner can execute. The
// narrowing is announced in the summary, because a reader who sees "green" must
// also see that the Windows/WSL half did not run.
const suites = ci ? [...CI_SUITES] : live ? [...STANDALONE, ...LIVE] : STANDALONE
```

Add the import near the other local imports:

```js
import { CI_EXCLUDED, CI_SUITES } from './ci-suites.mjs'
```

- [ ] **Step 2: Keep the declared-skip audit honest under `--ci`**

`--ci` excludes suites, so `DECLARED_SKIPS` entries for excluded suites would read as stale (their suite is not in the run). Guard the stale check so it only audits suites that are actually in `suites`:

```js
  for (const { suite, branch } of DECLARED_SKIPS) {
    if (!suites.includes(suite)) {
      // Under --ci the subset is deliberately narrower; an excluded suite's
      // declaration is not stale, it is out of scope for this run.
      if (ci) continue
      stale.push(`${suite} is not in the suite list, so the declaration can never apply`)
      continue
    }
```

- [ ] **Step 3: Announce the narrowing in the summary**

Just before the per-suite results are printed:

```js
if (ci) {
  console.log(`\nCI SUBSET: ${suites.length} suite(s) of the offline matrix; ${CI_EXCLUDED.length} excluded for this runner.`)
  console.log('A green run here does NOT cover the Windows/WSL suites; run the full matrix on a Windows host with WSL2.')
}
```

- [ ] **Step 4: Run it**

Run: `node scripts/verify-all.mjs --ci`

Expected: the subset runs, the CI SUBSET line appears, excluded suites are absent, exit 0. Any suite that fails on this machine for a *portability* reason must move to `CI_EXCLUDED` with a measured reason — but note that this machine is Windows, so first re-run on a Linux container or the failure may be the runner's, not the suite's.

- [ ] **Step 5: Confirm the default path is unchanged**

Run: `node scripts/verify-all.mjs`

Expected: identical to the pre-change run — 24/26 suites, same 2 declared skips, exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-all.mjs
git commit -m "feat(ci): add a --ci subset mode that names what it excludes"
```

---

### Task 3: Add the workflow

**Files:**
- Create: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: `node scripts/verify-all.mjs --ci`.
- Produces: a CI status named so it cannot be mistaken for the full matrix.

- [ ] **Step 1: Write the workflow**

```yaml
name: verify (linux subset)

# This workflow runs the part of the matrix a plain Linux runner can execute.
# The Windows/WSL suites are NOT covered here; they need a Windows host with
# WSL2 and a running desktop, and running them as SKIPs would read as coverage.
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  subset:
    name: offline subset (no Windows/WSL)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'

      # The package declares no runtime dependencies; `npm ci` would need a
      # lockfile this repository does not carry.
      - name: Run the CI subset
        run: node scripts/verify-all.mjs --ci

      - name: State the coverage boundary
        if: always()
        run: |
          echo "This run covered the Linux-runnable subset only."
          echo "The Windows/WSL suites (9P, confinement, PTY, sync, live host) did not run."
```

- [ ] **Step 2: Validate the YAML locally**

Run: `node -e "const fs=require('node:fs');const t=fs.readFileSync('.github/workflows/verify.yml','utf8');if(!/^\s*on:/m.test(t))throw new Error('missing on:');if(!t.includes('verify-all.mjs --ci'))throw new Error('missing the CI command');console.log('workflow shape ok')"`

Expected: `workflow shape ok`.

- [ ] **Step 3: Prove the command the workflow runs is green here**

Run: `node scripts/verify-all.mjs --ci; echo "exit=$?"`

Expected: exit 0 on this machine. This is the only local evidence available; it does not prove `ubuntu-latest` passes, and the plan must not claim it does.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/verify.yml
git commit -m "ci: run the Linux-runnable subset and name the coverage boundary"
```

---

### Task 4: Document the CI boundary

**Files:**
- Modify: `docs/VERIFICATION.md`
- Modify: `docs/VERIFICATION.en.md`

**Interfaces:**
- Consumes: nothing.
- Produces: one section per edition.

- [ ] **Step 1: Add the Chinese section**

```markdown
## CI 覆盖边界

`.github/workflows/verify.yml` 只跑 `node scripts/verify-all.mjs --ci`，也就是 Linux runner 能执行的那部分套件。9P、围栏、PTY、`sync.ps1`、以及所有 `--live` 套件都不在 CI 里，它们需要一台装了 WSL2 的 Windows 主机和一个运行中的桌面。CI 变绿**不等于**这些通过了——工作流名称和汇总行都会写出这条边界。子集定义在 `scripts/ci-suites.mjs`，每个被排除的套件都带理由。
```

- [ ] **Step 2: Add the English section**

```markdown
## CI coverage boundary

`.github/workflows/verify.yml` runs only `node scripts/verify-all.mjs --ci` — the suites a Linux runner can execute. The 9P, confinement, PTY, `sync.ps1` and every `--live` suite are not in CI; they need a Windows host with WSL2 and a running desktop. A green CI run **does not** mean those passed — the workflow name and the summary line both state the boundary. The subset is defined in `scripts/ci-suites.mjs`, and every excluded suite carries its reason.
```

- [ ] **Step 3: Verify the pair and the aggregate**

Run: `node scripts/verify-docs.mjs; echo "docs=$?"; node scripts/verify-all.mjs; echo "all=$?"`

Expected: `docs=0` with the pair count, `all=0` with 24/26.

- [ ] **Step 4: Commit**

```bash
git add docs/VERIFICATION.md docs/VERIFICATION.en.md
git commit -m "docs(verify): state the CI coverage boundary"
```

---

## Acceptance Criteria

1. `node scripts/verify-all.mjs --ci` exits 0 and prints a line naming how many suites it excluded.
2. The `--ci` run never includes a `--live` suite or a suite that spawns `wsl.exe`.
3. `node scripts/verify-all.mjs` (no flag) is unchanged: 24/26, same declared skips, exit 0.
4. `node scripts/verify-ci-subset.mjs` passes and would fail if a suite name were mistyped.
5. `.github/workflows/verify.yml` exists, runs the `--ci` command, and its name states the subset.
6. `node scripts/verify-docs.mjs` reports the pair in parity with the new sections.
7. No secrets, no publishing steps, no `--live` in the workflow.

## Honest Evidence Gap

This plan can be fully verified **locally** only for items 1–4 and 6–7. Item 5's *runtime* behaviour on `ubuntu-latest` cannot be verified from this machine: the plan's Step 3 of Task 3 proves the command is green here, not that the runner is. The first real evidence is the first CI run after the workflow is pushed; until then the workflow is a claim, and the documentation must say so.
