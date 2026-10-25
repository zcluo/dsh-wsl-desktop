# Verification convergence (C5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the seven hand-copied `check()` shells from the verification suites so every suite reports through `scripts/suite-shell.mjs`'s `makeChecker`, without changing any assertion's verdict.

**Architecture:** `scripts/suite-shell.mjs` already exports `makeChecker({ pass, detail })` returning `{ check, skip, failures, checks, skipped }`. Every suite that declares its own `function check(...)` duplicates that logic with a `failures` counter and a `detailText` import, and drifts independently (one already renders a different PASS token shape). Each conversion replaces the local shell with a destructured `const { check, skip } = checker`, keeps the suite's own PASS token and detail renderer by passing them as options, and leaves every assertion call site untouched. Suites that also count skips use `checker.skip(n)` so the exit-code tail keeps its meaning.

**Tech Stack:** Node.js ESM, `node:test`-free custom checker (`scripts/suite-shell.mjs`), PowerShell-free shell scripts, `scripts/verify-all.mjs` as the aggregate.

**Spec:** This plan implements C5 from `docs/superpowers/specs/2026-10-21-foundation-design.md` §16 ("C2 原语收敛、C3 模块拆分、C4 传输缝、C5 验证收敛"). No new design document: the behaviour contract is `scripts/verify-all.mjs`'s own suite contract plus each suite's existing exit-code tail.

## Global Constraints

- `verify-all.mjs` must keep reporting the same suite count and the same SKIP/pass/fail verdicts after every task; the aggregate's exit code is the gate.
- `makeChecker`'s default PASS token is `'OK  '`; a suite that prints `'PASS'` must pass `{ pass: 'PASS' }` so its output does not change.
- A suite's exit-code tail (`failures > 0 ? 1 : skipped > 0 ? 2 : 0`) is part of its contract with `verify-all.mjs`'s `DECLARED_SKIPS` audit; it must not change.
- No assertion label may change: `DECLARED_SKIPS` cites branch text and labels are read in recorded evidence.
- Zero new dependencies; no change to `lib/**` (this is a test-only refactor).

---

## File Map

| File | Change |
|---|---|
| `scripts/suite-shell.mjs` | Read-only reference; no edit expected. If a suite needs a capability it lacks, add it here once. |
| `scripts/verify-world.mjs` | Replace local `check()` with `makeChecker`. |
| `scripts/verify-fs-fence.mjs` | Same. |
| `scripts/verify-fs-fence-skip.mjs` | Same. |
| `scripts/verify-9p-skip.mjs` | Same. |
| `scripts/verify-all-skip.mjs` | Same. |
| `scripts/verify-confinement.mjs` | Same, plus its `skip()` local if it has one. |
| `scripts/verify-confinement-skip.mjs` | Same. |

Suites already using `makeChecker` (do not touch): `verify-protocol`, `verify-doctor`, `verify-client-ui`, `verify-client-dom`, `verify-release-check`, `verify-release-preflight`, `verify-modules`, `verify-host-contract`, `verify-package`, `verify-diagrams`, `verify-docs`, `verify-world-errors`, `verify-watch`, `verify-search`, `verify-terminal`, `verify-pty-handle`, `verify-sync`.

---

### Task 1: Convert `verify-world.mjs`

**Files:**
- Modify: `scripts/verify-world.mjs` (local `check()` definition and its `failures` counter)

**Interfaces:**
- Consumes: `makeChecker(options)` from `./suite-shell.mjs`, returning `{ check, skip, failures, checks, skipped }`; `detailText` from `./detail.mjs`.
- Produces: nothing new; the suite's own exports stay as they are.

- [ ] **Step 1: Capture the current output as the baseline**

Run: `node scripts/verify-world.mjs > .superpowers/baseline-world.txt 2>&1; echo "exit=$?"`

Expected: exit 0 (or 2 if this machine legitimately skips), and the file records every `PASS` line. Keep it for Step 5.

- [ ] **Step 2: Read the local shell and the tail**

Run: `sed -n '1,40p;' scripts/verify-world.mjs; tail -12 scripts/verify-world.mjs`

Expected: a local `function check(label, ok, detail)` that increments `failures`, and a tail computing `process.exitCode` from `failures`/`skipped`.

- [ ] **Step 3: Replace the local shell**

Replace the local definition (and its `let failures = 0` / `let skipped = 0` declarations, if the file has them) with:

```js
const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value) })
const { check } = checker
```

If the suite previously exposed `skip()`, also destructure it: `const { check, skip } = checker`.

Then replace every `failures += 1` / `skipped += 1` that was owned by the removed shell with the checker's counters: use `checker.failures` and `checker.skipped` in the tail.

- [ ] **Step 4: Run the suite and compare against the baseline**

Run: `node scripts/verify-world.mjs > .superpowers/after-world.txt 2>&1; echo "exit=$?"; diff .superpowers/baseline-world.txt .superpowers/after-world.txt`

Expected: identical exit code and an empty diff.

- [ ] **Step 5: Run the aggregate**

Run: `node scripts/verify-all.mjs`

Expected: the same summary line as before this task (`24/26 suites passed (2 declared skip: …)`), exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-world.mjs
git commit -m "refactor(verify): report verify-world through the shared checker"
```

---

### Task 2: Convert `verify-fs-fence.mjs` and `verify-fs-fence-skip.mjs`

**Files:**
- Modify: `scripts/verify-fs-fence.mjs`
- Modify: `scripts/verify-fs-fence-skip.mjs`

**Interfaces:**
- Consumes: `makeChecker` as in Task 1.
- Produces: nothing new.

- [ ] **Step 1: Baseline both suites**

Run: `node scripts/verify-fs-fence.mjs > .superpowers/baseline-fence.txt 2>&1; echo "fence=$?"; node scripts/verify-fs-fence-skip.mjs > .superpowers/baseline-fence-skip.txt 2>&1; echo "skip=$?"`

Expected: `fence` is 0 or 2 (checkout/second-distro preconditions), `skip` is 0. Record both exit codes.

- [ ] **Step 2: Replace each local `check()`**

In both files, delete the local `function check(...)` and its JSDoc, and add:

```js
const checker = makeChecker({ pass: 'PASS', detail: (value) => detailText(value) })
const { check } = checker
```

Point the tails at `checker.failures` and `checker.skipped`.

- [ ] **Step 3: Run both and diff**

Run: `node scripts/verify-fs-fence.mjs > .superpowers/after-fence.txt 2>&1; echo "fence=$?"; diff .superpowers/baseline-fence.txt .superpowers/after-fence.txt; node scripts/verify-fs-fence-skip.mjs > .superpowers/after-fence-skip.txt 2>&1; echo "skip=$?"; diff .superpowers/baseline-fence-skip.txt .superpowers/after-fence-skip.txt`

Expected: exit codes unchanged, both diffs empty.

- [ ] **Step 4: Run the aggregate**

Run: `node scripts/verify-all.mjs`

Expected: unchanged summary, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-fs-fence.mjs scripts/verify-fs-fence-skip.mjs
git commit -m "refactor(verify): report the fs-fence suites through the shared checker"
```

---

### Task 3: Convert `verify-9p-skip.mjs` and `verify-all-skip.mjs`

**Files:**
- Modify: `scripts/verify-9p-skip.mjs`
- Modify: `scripts/verify-all-skip.mjs`

**Interfaces:**
- Consumes: `makeChecker` as in Task 1.
- Produces: nothing new.

- [ ] **Step 1: Baseline both suites**

Run: `node scripts/verify-9p-skip.mjs > .superpowers/baseline-9p-skip.txt 2>&1; echo "ninep=$?"; node scripts/verify-all-skip.mjs > .superpowers/baseline-all-skip.txt 2>&1; echo "allskip=$?"`

Expected: both 0; record them.

- [ ] **Step 2: Replace each local `check()`**

Same transformation as Task 2. `verify-all-skip.mjs` spawns the aggregate, so keep its child-process expectations untouched — only the reporting shell moves.

- [ ] **Step 3: Run both and diff**

Run: `node scripts/verify-9p-skip.mjs > .superpowers/after-9p-skip.txt 2>&1; echo "ninep=$?"; diff .superpowers/baseline-9p-skip.txt .superpowers/after-9p-skip.txt; node scripts/verify-all-skip.mjs > .superpowers/after-all-skip.txt 2>&1; echo "allskip=$?"; diff .superpowers/baseline-all-skip.txt .superpowers/after-all-skip.txt`

Expected: exit codes unchanged, diffs empty.

- [ ] **Step 4: Run the aggregate**

Run: `node scripts/verify-all.mjs`

Expected: unchanged summary, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-9p-skip.mjs scripts/verify-all-skip.mjs
git commit -m "refactor(verify): report the 9p and aggregate-skip suites through the shared checker"
```

---

### Task 4: Convert `verify-confinement.mjs` and `verify-confinement-skip.mjs`

**Files:**
- Modify: `scripts/verify-confinement.mjs`
- Modify: `scripts/verify-confinement-skip.mjs`

**Interfaces:**
- Consumes: `makeChecker` as in Task 1. `verify-confinement.mjs` is the one suite that also has a local `skip()` in some revisions; `makeChecker.skip(count = 1)` has the same call shape.
- Produces: nothing new.

- [ ] **Step 1: Baseline both suites**

Run: `node scripts/verify-confinement.mjs > .superpowers/baseline-conf.txt 2>&1; echo "conf=$?"; node scripts/verify-confinement-skip.mjs > .superpowers/baseline-conf-skip.txt 2>&1; echo "confskip=$?"`

Expected: `conf` may be 2 on a machine without an unprivileged user namespace; record the actual code, do not assume.

- [ ] **Step 2: Replace each local `check()` and `skip()`**

Same transformation, plus delete the local `skip()` if present and destructure `const { check, skip } = checker`.

- [ ] **Step 3: Run both and diff**

Run: `node scripts/verify-confinement.mjs > .superpowers/after-conf.txt 2>&1; echo "conf=$?"; diff .superpowers/baseline-conf.txt .superpowers/after-conf.txt; node scripts/verify-confinement-skip.mjs > .superpowers/after-conf-skip.txt 2>&1; echo "confskip=$?"; diff .superpowers/baseline-conf-skip.txt .superpowers/after-conf-skip.txt`

Expected: exit codes unchanged, diffs empty.

- [ ] **Step 4: Run the aggregate**

Run: `node scripts/verify-all.mjs`

Expected: unchanged summary, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-confinement.mjs scripts/verify-confinement-skip.mjs
git commit -m "refactor(verify): report the confinement suites through the shared checker"
```

---

### Task 5: Pin the convergence so it cannot regress

**Files:**
- Modify: `scripts/verify-all.mjs` (the suite-contract pre-scan block)
- Test: `scripts/verify-all.mjs` itself (it is the pin)

**Interfaces:**
- Consumes: the suite list `STANDALONE` / `LIVE` already in `verify-all.mjs`.
- Produces: one new assertion in the existing pre-scan block, whose failure message names the offending suite.

- [ ] **Step 1: Write the failing assertion**

In `verify-all.mjs`, inside the existing pre-scan block that checks the `check()` contract, add after the `offenders` loop:

```js
  // The convergence pin: a suite in this aggregate must not declare its own
  // check() shell. suite-shell.mjs owns reporting; a local copy drifts (one
  // already rendered a different PASS token), and seven copies were the state
  // C5 removed. This fails with the offending file names.
  const localShells = []
  for (const suite of suites) {
    const source = readFileSync(join(here, suite), 'utf8')
    if (/^\s*function check\s*\(/mu.test(source)) localShells.push(suite)
  }
  if (localShells.length > 0) {
    console.log(`\nFAIL  a suite declares its own check() shell instead of using suite-shell.mjs: ${localShells.join(', ')}`)
    process.exit(1)
  }
```

- [ ] **Step 2: Run it to confirm it is green after Tasks 1–4**

Run: `node scripts/verify-all.mjs`

Expected: exit 0 and the `check() contract clean across N suites` line still present. This step proves the assertion does not fire on the converted tree.

- [ ] **Step 3: Prove the assertion has teeth**

Temporarily re-add a stub shell to one suite:

```bash
printf '\nfunction check(a, b) { void a; void b }\n' >> scripts/verify-world.mjs
node scripts/verify-all.mjs; echo "exit=$?"
```

Expected: exit 1, with the FAIL line naming `verify-world.mjs`. Then restore:

```bash
git checkout -- scripts/verify-world.mjs
```

- [ ] **Step 4: Run the aggregate again**

Run: `node scripts/verify-all.mjs`

Expected: exit 0, unchanged summary.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-all.mjs
git commit -m "test(verify): pin the single check() shell against reintroduction"
```

---

### Task 6: Document the rule

**Files:**
- Modify: `docs/VERIFICATION.md` (the section explaining what each suite is responsible for)
- Modify: `docs/VERIFICATION.en.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented sentence both editions carry.

- [ ] **Step 1: Add the rule to the Chinese edition**

Add one paragraph to `docs/VERIFICATION.md`, under the list of suites:

```markdown
每个套件都通过 `scripts/suite-shell.mjs` 的 `makeChecker` 报告结果，不再各自实现 `check()`。`verify-all.mjs` 会扫描套件源码，发现本地 `check()` 外壳就判红——七份复制的外壳曾各自漂移（其中一份的 PASS 记号都不一样），收敛后由这一行防回归。
```

- [ ] **Step 2: Add the same rule to the English edition**

```markdown
Every suite reports through `scripts/suite-shell.mjs`'s `makeChecker` instead of declaring its own `check()`. `verify-all.mjs` scans suite sources and reddens on a local shell — seven copied shells had drifted independently (one rendered a different PASS token), and this row is what keeps the convergence from regressing.
```

- [ ] **Step 3: Verify the pair**

Run: `node scripts/verify-docs.mjs`

Expected: `12 pair(s) in parity`, exit 0. If the section count differs, the assertion added in the previous round will name both sides; fix the edition that is missing the paragraph.

- [ ] **Step 4: Commit**

```bash
git add docs/VERIFICATION.md docs/VERIFICATION.en.md
git commit -m "docs(verify): record the single-checker rule"
```

---

## Acceptance Criteria

1. `grep -rn '^function check(' scripts/verify-*.mjs` returns nothing.
2. `node scripts/verify-all.mjs` exits 0 with the same suite count and the same declared-skip list as before the change.
3. Every converted suite's `node scripts/<suite>.mjs` exit code and full stdout are byte-identical to its pre-change baseline (captured in each task's Step 1).
4. Re-adding a local `check()` to any suite makes `verify-all.mjs` exit 1 and name that suite.
5. `node scripts/verify-docs.mjs` reports 12 pairs in parity.
6. No file under `lib/` is modified (`git diff --stat lib/` prints nothing).

## Out of Scope

- C3 module splitting (`lib/client.js`, `lib/index.js`, `lib/wsl/world.js`): separate plan.
- CI workflow: separate plan.
- Any change to what a suite asserts.
