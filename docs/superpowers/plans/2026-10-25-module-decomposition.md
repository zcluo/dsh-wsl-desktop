# Module decomposition (C3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the three oversized modules (`lib/client.js`, `lib/index.js`, `lib/wsl/world.js`) along the responsibilities already visible inside them, one extraction per task, with the full offline gate green after every task.

**Architecture:** This is a **pure move** refactor: every task extracts an existing, self-contained group of functions into a new module and leaves behaviour, exports, labels and messages byte-identical. No function is rewritten, no error path is reordered, no assertion changes. The safety net is the existing suite matrix plus byte-identical stdout comparison where a suite touches the moved code. Extraction order is chosen so each step's new module has no dependency on the group extracted next.

**Tech Stack:** Node.js ESM, hand-written client half (`window.__ModuleLoader__` factory, no bundler), `scripts/verify-*.mjs` suites, `scripts/verify-all.mjs` aggregate.

**Spec:** This plan implements C3 from `docs/superpowers/specs/2026-10-21-foundation-design.md` §16. There is no separate design document; the module boundaries below are derived from the current file contents and are argued task by task.

## Global Constraints

- **Behaviour-identical move.** Every task ends with the same observable behaviour: identical suite verdicts, identical user-facing strings, identical error codes. A task that has to change behaviour is out of scope and must be split out.
- `lib/**` is the published payload: a new module must be added to `package.json`'s `files` implicitly (the `lib` directory is shipped wholesale) **and** to `scripts/verify-modules.mjs`'s `ALL` list, and to `PURE` if it imports nothing from the harness.
- The client half is not bundled: it is evaluated by `window.__ModuleLoader__`. A client-side split must therefore stay inside **one file** unless the loader is verified to resolve a second module — which it currently is not. See Task 4 for the constraint this creates.
- No new dependencies. No change to `package.json` `exports`.
- Every task ends with `node scripts/verify-all.mjs` exit 0 (24/26 suites, 2 declared skips) and `node scripts/verify-modules.mjs` ALL CHECKS PASSED when the host dependencies are reachable.

---

## File Map

| File | Responsibility after this plan |
|---|---|
| `lib/index.js` | Plugin entry, lifecycle, route table wiring; delegates to the modules below |
| `lib/host/presets.js` | **New.** Preset id derivation and materialisation (`variantIdFor`, `sourceDirFor`, `basePluginsOf`, `materializePresets`, `refreshPresets`, `runShellSpec`) |
| `lib/host/http.js` | **New.** JSON body read, JSON send, rejection send, dev-token mint and developer-caller test (`readJsonBody`, `sendJson`, `sendRejection`, `devToken`, `isDeveloperCaller`, `connectionOf`) |
| `lib/host/binding.js` | **New.** Session/preset binding bookkeeping (`recordBinding`, `bindWslSession`, `bindWslPreset`) |
| `lib/wsl/distros.js` | **New.** Distribution discovery and per-distro facts (`listDistros`, `defaultDistro`, `defaultDistroSync`, `wslMajorVersion`, `parseWslVersionTable`, the Lxss registry readers) |
| `lib/wsl/world.js` | Execution and filesystem world only (shell runs, directory listing, path checks, home resolution) |
| `lib/client.js` | Unchanged file count; internal sections get explicit boundaries and section-level comments (Task 4) |

---

### Task 1: Extract the HTTP helpers from `index.js`

**Files:**
- Create: `lib/host/http.js`
- Modify: `lib/index.js` (delete the moved functions; import them)
- Modify: `scripts/verify-modules.mjs` (`PURE`/`ALL` lists)

**Interfaces:**
- Consumes: `node:http` request/response objects; the plugin's `DEV_TOKEN_HEADER`, `MAX_BODY_BYTES` from `lib/http-admission.js`.
- Produces: `readJsonBody(req)`, `sendJson(res, status, payload)`, `sendRejection(res, rejection)`, `devToken()`, `isDeveloperCaller(req, config)`, `connectionOf(ctx)` — all with their current signatures, exported from `lib/host/http.js`.

- [ ] **Step 1: Record the current aggregate baseline**

Run: `node scripts/verify-all.mjs > .superpowers/baseline-c3-t1.txt 2>&1; echo "exit=$?"`

Expected: exit 0; keep the file.

**Do not expect a byte-identical aggregate diff.** The aggregate's output is not deterministic: `verify-9p` prints its probe's temp-directory spelling (which carries a process id), and a task that registers a new module adds its own `PASS  lib/… loads` rows by design. The correct comparison is: same exit code, same `N/M suites passed` summary line, and no *unexpected* difference once pid-bearing lines and the new module rows are filtered out.

```bash
node -e "const fs=require('node:fs');const d=(f)=>fs.readFileSync(f,'utf8').split('\n');const a=d('.superpowers/baseline-c3-t1.txt'),b=d('.superpowers/after-c3-t1.txt');const noise=(l)=>/dsh-wsl-9p-probe-\d+|FACT /.test(l)||/PASS  lib\/(host|wsl)\/.* loads|every base class is imported/.test(l);const real=b.filter((l)=>!a.includes(l)&&!noise(l)).concat(a.filter((l)=>!b.includes(l)&&!noise(l)));console.log(real.length?real.join('\n'):'no unexpected difference')"
```

- [ ] **Step 2: Read the exact current bodies**

Run: `sed -n '1527,1620p' lib/index.js`

Expected: the six functions with their JSDoc. Copy them verbatim in the next step — do not retype from memory.

- [ ] **Step 3: Create `lib/host/http.js` with the moved code**

The new file starts with the module JSDoc:

```js
/**
 * The route's HTTP seam: reading a JSON body, answering with one, and deciding
 * whether a caller may reach the development-token surface.
 *
 * Extracted verbatim from `lib/index.js` (C3). Nothing in here is new behaviour;
 * the move exists so the plugin entry file carries wiring and lifecycle rather
 * than request plumbing.
 * @module dsh-wsl-desktop/host/http
 */
```

then the imports the moved functions need, then the six functions copied **unchanged** (same names, same parameters, same bodies), each exported.

- [ ] **Step 4: Import them back into `index.js`**

Add to `lib/index.js`'s import block:

```js
import { connectionOf, devToken, isDeveloperCaller, readJsonBody, sendJson, sendRejection } from './host/http.js'
```

Delete the six local definitions. `git diff` must show only a deletion block and one import line.

- [ ] **Step 5: Register the new module**

In `scripts/verify-modules.mjs`, add `'lib/host/http.js'` to `ALL`, and to `PURE` only if it imports nothing from `@deepseek-ai/*` (check with `node scripts/verify-modules.mjs` — it reports which import fails).

- [ ] **Step 6: Run the gate**

Run: `node scripts/verify-all.mjs > .superpowers/after-c3-t1.txt 2>&1; echo "exit=$?"; diff .superpowers/baseline-c3-t1.txt .superpowers/after-c3-t1.txt`

Expected: exit 0 and an empty diff (the aggregate's output names suites, not internals).

- [ ] **Step 7: Commit**

```bash
git add lib/host/http.js lib/index.js scripts/verify-modules.mjs
git commit -m "refactor(host): move the route's HTTP seam into lib/host/http.js"
```

---

### Task 2: Extract preset materialisation from `index.js`

**Files:**
- Create: `lib/host/presets.js`
- Modify: `lib/index.js`
- Modify: `scripts/verify-modules.mjs`

**Interfaces:**
- Consumes: `buildVariantPlugins` from `../wsl/preset.js`; the `agentPresets` service from the host context.
- Produces: `variantIdFor(preset)`, `sourceDirFor(id)`, `basePluginsOf(presets, id)`, `runShellSpec(shell, spec)`, `materializePresets(ctx, distro, generation, previous)`, `refreshPresets(ctx, distro, generation)`.

- [ ] **Step 1: Baseline**

Run: `node scripts/verify-all.mjs > .superpowers/baseline-c3-t2.txt 2>&1; echo "exit=$?"`

- [ ] **Step 2: Copy the bodies verbatim**

Run: `sed -n '103,477p' lib/index.js`

Expected: the six functions. They form one group: the first three are pure id/plan helpers the last three call.

- [ ] **Step 3: Create `lib/host/presets.js` with the moved code**

Module JSDoc:

```js
/**
 * Preset materialisation: turning one WSL distribution into the `wsl-*` agent
 * presets the host loads, and refreshing them when the distribution set changes.
 *
 * Extracted verbatim from `lib/index.js` (C3).
 * @module dsh-wsl-desktop/host/presets
 */
```

Import what the bodies reference (`buildVariantPlugins` and any path helpers), then the six functions unchanged, exported.

- [ ] **Step 4: Import them back**

```js
import { materializePresets, refreshPresets } from './host/presets.js'
```

`variantIdFor`, `sourceDirFor`, `basePluginsOf` and `runShellSpec` are internal to the new module; import them into `index.js` only if `index.js` still calls them directly (check with `grep -n 'variantIdFor\|sourceDirFor\|basePluginsOf\|runShellSpec' lib/index.js` after deleting the definitions — a remaining call site means it must be imported).

- [ ] **Step 5: Register and gate**

Add `'lib/host/presets.js'` to `verify-modules.mjs`'s `ALL`. Run:

`node scripts/verify-all.mjs > .superpowers/after-c3-t2.txt 2>&1; echo "exit=$?"; diff .superpowers/baseline-c3-t2.txt .superpowers/after-c3-t2.txt`

Expected: exit 0, empty diff.

- [ ] **Step 6: Commit**

```bash
git add lib/host/presets.js lib/index.js scripts/verify-modules.mjs
git commit -m "refactor(host): move preset materialisation into lib/host/presets.js"
```

---

### Task 3: Extract session binding from `index.js`

**Files:**
- Create: `lib/host/binding.js`
- Modify: `lib/index.js`
- Modify: `scripts/verify-modules.mjs`

**Interfaces:**
- Consumes: the recorded binding entry shape already used by `index.js` (`{ agent, cwd, sessionId }`).
- Produces: `recordBinding(entry)`, `bindWslSession(ctx, summary)`, `bindWslPreset(ctx, agent, cwd, sessionId)`.

- [ ] **Step 1: Baseline**

Run: `node scripts/verify-all.mjs > .superpowers/baseline-c3-t3.txt 2>&1; echo "exit=$?"`

- [ ] **Step 2: Copy the bodies verbatim**

Run: `sed -n '1778,1832p' lib/index.js`

Expected: the three binding functions.

- [ ] **Step 3: Create `lib/host/binding.js`**

Module JSDoc:

```js
/**
 * Session-to-world binding: recording which execution world a session was created
 * with, and binding a preset or a session to a WSL distribution.
 *
 * Extracted verbatim from `lib/index.js` (C3).
 * @module dsh-wsl-desktop/host/binding
 */
```

Then the three functions unchanged, exported.

- [ ] **Step 4: Import them back, register and gate**

Add the import to `index.js`, delete the definitions, add `'lib/host/binding.js'` to `verify-modules.mjs`'s `ALL`, then:

`node scripts/verify-all.mjs > .superpowers/after-c3-t3.txt 2>&1; echo "exit=$?"; diff .superpowers/baseline-c3-t3.txt .superpowers/after-c3-t3.txt`

Expected: exit 0, empty diff.

- [ ] **Step 5: Commit**

```bash
git add lib/host/binding.js lib/index.js scripts/verify-modules.mjs
git commit -m "refactor(host): move session binding into lib/host/binding.js"
```

---

### Task 4: Give `client.js` section boundaries (no file split)

**Files:**
- Modify: `lib/client.js` (comments and ordering only)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. **No function moves across files.**

**Why no file split:** the client half is a single `window.__ModuleLoader__` factory body. Splitting it into two files would require the loader to resolve a second module — an unverified host capability. Until that is measured, the honest boundary is *within* the file.

- [ ] **Step 1: Baseline the client suites**

Run: `node scripts/verify-client-ui.mjs > .superpowers/baseline-client-ui.txt 2>&1; echo "ui=$?"; node scripts/verify-client-dom.mjs > .superpowers/baseline-client-dom.txt 2>&1; echo "dom=$?"`

Expected: both 0 (or 2 with the declared skip). Record.

- [ ] **Step 2: Add a section index at the top of the factory**

Immediately inside the factory body, add a comment block listing the file's own sections in order, for example:

```js
    /*
     * Section index (this file is one loader module; see C3 in
     * docs/superpowers/plans/2026-10-25-module-decomposition.md for why it is not
     * split across files):
     *   1. copy and locale
     *   2. shared node helpers and theme
     *   3. failure, remedy and diagnostics rendering
     *   4. the W dialog (state, phases, rendering)
     *   5. the companion button, the fallback entry and the workspace rows
     *   6. module registration and dispose
     */
```

- [ ] **Step 3: Add one marker comment per section**

Insert a `// ── N. <name> ─────…` line at each boundary named in Step 2. **Do not reorder or edit any code.** The diff for this task must contain only added comment lines.

- [ ] **Step 4: Prove the file is behaviourally untouched**

Run this (works in PowerShell and in a POSIX shell — it does not rely on `grep`):

```bash
node -e "const {execFileSync}=require('node:child_process');const d=execFileSync('git',['diff','-U0','lib/client.js'],{encoding:'utf8'});const changed=d.split('\n').filter((l)=>/^[+-][^+-]/.test(l)&&!/^\+\s*(\/\/|\/\*|\*)/.test(l));console.log(changed.length===0?'comment-only diff':changed.slice(0,10).join('\n'))"
```

Expected: `comment-only diff`. If anything else prints, revert that hunk before continuing.

- [ ] **Step 5: Run the client suites and the aggregate**

Run: `node scripts/verify-client-ui.mjs > .superpowers/after-client-ui.txt 2>&1; echo "ui=$?"; diff .superpowers/baseline-client-ui.txt .superpowers/after-client-ui.txt; node scripts/verify-client-dom.mjs > .superpowers/after-client-dom.txt 2>&1; echo "dom=$?"; diff .superpowers/baseline-client-dom.txt .superpowers/after-client-dom.txt; node scripts/verify-all.mjs`

Expected: exit codes unchanged, empty diffs, aggregate exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/client.js
git commit -m "docs(client): name the browser half's sections at their boundaries"
```

---

### Task 5: Extract distribution discovery from `world.js`

**Files:**
- Create: `lib/wsl/distros.js`
- Modify: `lib/wsl/world.js`
- Modify: `lib/index.js` and `lib/wsl/doctor.js` (import sites)
- Modify: `scripts/verify-modules.mjs`

**Interfaces:**
- Consumes: `WSL_CHILD_ENV`, `decodeWslOutput`, `isUnderHost`-free helpers already in `world.js`.
- Produces: `listDistros`, `defaultDistro`, `defaultDistroSync`, `wslMajorVersion`, `parseWslVersionTable`, and the Lxss registry readers, exported from `lib/wsl/distros.js`.

- [ ] **Step 1: Baseline**

Run: `node scripts/verify-all.mjs > .superpowers/baseline-c3-t5.txt 2>&1; echo "exit=$?"`

- [ ] **Step 2: Identify the exact move set**

Run: `grep -n 'export\( async\)\? function \|^const LXSS_KEY\|DEFAULT_DISTRIBUTION_VALUE\|DISTRIBUTION_NAME_VALUE\|GUID_PATTERN\|NAME_PATTERN' lib/wsl/world.js`

Expected: discovery, default-distro (async + sync), version probe/parser, and the registry constants. **Do not move** `runWslShell`, `listLinuxDir`, `checkLinuxPath`, `resolveDistroHome`, `joinWslUnc`-adjacent helpers — those are the execution world.

- [ ] **Step 3: Move them and re-export from `world.js` for one release**

Create `lib/wsl/distros.js`, move the functions and constants **verbatim**, and in `world.js` replace the moved definitions with:

```js
// The discovery half moved to ./distros.js (C3). Re-exported here so every
// existing import site keeps working; callers migrate in the same commit.
export { defaultDistro, defaultDistroSync, listDistros, parseWslVersionTable, wslMajorVersion } from './distros.js'
```

- [ ] **Step 4: Update every import site**

Run: `grep -rn "from './wsl/world.js'\|from '../wsl/world.js'\|from './world.js'" lib scripts | grep -E 'listDistros|defaultDistro|wslMajorVersion|parseWslVersionTable'`

Expected: `lib/index.js` (listDistros, defaultDistro, wslMajorVersion), `lib/wsl/doctor.js` if it reads versions, and `scripts/verify-doctor.mjs` (parseWslVersionTable). Point each at `distros.js`.

- [ ] **Step 5: Register and gate**

Add `'lib/wsl/distros.js'` to `verify-modules.mjs`'s `ALL` (and `PURE` only if it has no harness import). Then:

`node scripts/verify-all.mjs > .superpowers/after-c3-t5.txt 2>&1; echo "exit=$?"; diff .superpowers/baseline-c3-t5.txt .superpowers/after-c3-t5.txt`

Expected: exit 0, empty diff. `verify-doctor` must stay green: it imports `parseWslVersionTable`.

- [ ] **Step 6: Commit**

```bash
git add lib/wsl/distros.js lib/wsl/world.js lib/index.js lib/wsl/doctor.js scripts/verify-modules.mjs scripts/verify-doctor.mjs
git commit -m "refactor(wsl): move distribution discovery into lib/wsl/distros.js"
```

---

### Task 6: Drop the temporary re-export and pin the new layout

**Files:**
- Modify: `lib/wsl/world.js` (remove the re-export added in Task 5)
- Modify: `scripts/verify-modules.mjs` (pin the split)
- Test: `scripts/verify-modules.mjs`

**Interfaces:**
- Consumes: the import sites migrated in Task 5.
- Produces: two assertions in `verify-modules.mjs` naming the split.

- [ ] **Step 1: Remove the re-export**

Delete the re-export line from `world.js`, then run `node scripts/verify-all.mjs` and expect it to **fail** if any import site still points at `world.js` for a moved name. Fix those sites; the failure is the check doing its job.

- [ ] **Step 2: Pin the split**

In `scripts/verify-modules.mjs`, add to the structural assertions:

```js
check('the distribution-discovery half lives in its own module',
  ALL.includes('lib/wsl/distros.js') && ALL.includes('lib/wsl/world.js'))
check('world.js no longer exports the discovery half',
  !/export\s+(?:async\s+)?function\s+(?:listDistros|defaultDistro|wslMajorVersion)\b/u
    .test(await readFile(join(pluginRoot, 'lib/wsl/world.js'), 'utf8')))
```

- [ ] **Step 3: Run the module suite**

Run: `node scripts/verify-modules.mjs`

Expected: ALL CHECKS PASSED with the host dependencies reachable, or the declared SKIP without them.

- [ ] **Step 4: Run the aggregate and commit**

`node scripts/verify-all.mjs` → exit 0.

```bash
git add lib/wsl/world.js scripts/verify-modules.mjs
git commit -m "test(modules): pin the distribution-discovery split"
```

---

## Acceptance Criteria

1. `lib/index.js` is under 1200 lines (from 1833), and each extracted module is under 600.
2. `lib/wsl/world.js` is under 900 lines (from 1063) and exports no discovery function.
3. `git diff --stat` for every task touches only the files its File block names.
4. `node scripts/verify-all.mjs` exits 0 with 24/26 suites and the same 2 declared skips, after **every** task.
5. Each task's baseline/after diff (where captured) is empty.
6. `node scripts/verify-modules.mjs` reports ALL CHECKS PASSED with the host dependencies reachable; the `ALL` list names every new module.
7. No user-facing string, error code, or suite label changes. Review with:

```bash
node -e "const {execFileSync}=require('node:child_process');const d=execFileSync('git',['diff','HEAD~6','HEAD'],{encoding:'utf8'});const hits=d.split('\n').filter((l)=>/^[+-][^+-]/.test(l)&&/(PASS|FAIL|code:|zh:|en:)/.test(l));console.log(hits.length?hits.slice(0,20).join('\n'):'no user-facing string changed')"
```

Expected: `no user-facing string changed` (the only allowed hits are the new comments).

## Out of Scope

- Splitting `lib/client.js` across files (needs a measured loader capability first).
- Any behavioural change; this plan is a move.
- CI (separate plan).
- Retiring the `world.js` name or re-exporting differently for consumers: `exports` is unchanged.
