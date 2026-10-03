# The fs fence: design, measurements and rule — dsh-wsl-desktop

This is the complete record of the fence on the fs mutation entries: why the fence must exist, how the writable roots and the comparison namespace are defined, the measured facts about 9P shares, and the derivation and cost of the rule "a component that exists but cannot be canonicalized is refused". The README keeps only the conclusion and the entry point.

## The fs tool fence

`WslFileSystem` carries its own fence: it declares `sandboxMode`, and both mutation entries, `writeText`/`editText`, go through `checkedTarget` first (rejections throw structured `FS_SANDBOX_DENIED`, which the tool layer maps into a model-visible `[sandbox: …]` marker plus an escalation hint); the containment comparison and writable-root derivation are pure functions in `lib/wsl/fence.js`. It does **not** inherit the official sandbox backend — the official backend would wrap this class inside a second backend, adding a layer of composition dependency for nothing, while the fence is, at bottom, "a policy check inside trusted code" and belongs in this class. (The original attribution — "the realm cannot see `sandboxPolicy`, so it cannot inherit" — was wrong; see lesson 1 below: `shell.js` in the same realm had been injecting that service all along.)

**Writable roots and the comparison namespace**: the `workspace-write` allow set = the session cwd (the workspace root) + **the distro's** `/tmp` (on the 9P share, `\\wsl.localhost\<distro>\tmp` — where a Linux-side `/tmp/…` request resolves in this world; the host POSIX `/tmp` from the official derivation is meaningless on Windows) + the Windows temp directory (reachable via `/mnt/<drive>`). The comparison happens in the **host namespace**: targetKey is in Windows spelling, and the UNC prefix carries the distro identity, so "a Linux path that happens to spell the same in another distro" cannot escape the boundary; unknown modes get an empty allow set, i.e. deny (fail-closed). `checkedTarget`'s re-normalization also starts from **targetKey**, not displayPath — displayPath is in Linux spelling without a distro, and re-resolving from it pins the path onto this class's fixed distro, silently rewriting cross-distro UNC requests (live-tripped: written into debian-dev, read from debian reported not found); now cross-distro requests get `FS_SANDBOX_DENIED` directly.

**Why the fence must exist**: `LocalFileSystem` never overrides `FileSystem.sandboxMode`. A backend that claims nothing leaves `tool-fs`'s `FsSandboxController` unable to resolve a policy for every call (`tool-fs/src/sandbox.ts:43-50`: `defaultMode === undefined` ⇒ `escalationModes = []`, `policy = undefined`), so `write`/`edit` are entirely unmanaged and can write anywhere the share reaches — including `/mnt/c` — and `toHostPath` also accepts direct `C:\…` spelling, so the actual exposure while unfenced is the entire Windows filesystem, not just the share.

**Lessons from two failed attempts** (recorded here to avoid repeating them):

1. Inheriting the official backend → the whole class never activated. At the time I attributed it to "the realm cannot see `sandboxPolicy`", **but the real cause was that I had deleted the `LocalFileSystem` import** (`node --check` parses syntax only; it cannot see undefined identifiers). Symptom matching is not attribution.
2. The first version of the built-in fence **denied everything** when it "could not get the workspace root", including the plugin's own `/tmp` writes. Only after tracing the mechanism did it become clear: the official backend's fallback is the same `sandboxPolicy.resolve()` (no arguments), **which itself cannot produce the workspace root either** — the root is always passed in by `tool-fs` on every call (`resolvePolicy` stamps it with the calling session's cwd).

**The selftest changed accordingly**: it now passes the policy explicitly, like a real caller: `{ mode: 'workspace-write', workspaceRoot: <session cwd> }`. It previously passed nothing — "calling fs in a way no real caller would ever use" — which is why it got rejected last time, not because the fence was too strict.

**Two pins + live acceptance**: `scripts/verify-modules.mjs` pins the fence's existence (declares `sandboxMode`, both mutation entries go through `checkedTarget`, rejections use `FS_SANDBOX_DENIED`, the containment comparison has separator boundaries); `scripts/verify-fs-fence.mjs` verifies the pure logic offline (separator boundaries, casing, **same-spelling cross-distro paths rejected**, **components that exist but cannot be canonicalized refused** (Task 2: a self-built link fixture plus five controls, the write key as the world-independent subject, and an NTFS-junction arm so the blind-arm expectations are not constants — see the next subsection), writable-root derivation, unknown modes fail-closed); `verify-9p.mjs` gained identity-mapping probes (distinct files have distinct (dev,ino); the wsl.localhost/wsl$ spellings are stable — the fence's identity fallback is load-bearing on this) and now ASSERTS the fence's refusal of the escaping spelling where it used to record a HAZARD. The class wiring is live-accepted by `verify-post-restart.mjs` (out-of-bounds write rejected, PASS). Task 2's rule, and the two suites' SKIP families, each have ONE owner below: the rule — why the final component is exempt, where it lives (`lib/wsl/fence.js`'s `isUnderHost`), its measured zero cost, the check-to-publication residue, **the two arms and the write key** the expectations are relations against, and the structural pin on `fs-local`'s publication sequence with its six mutants — in *The fence's new rule (Task 2)*; the SKIP families, with the reports that pin them and the `CROSS_DISTRO_CHECKS` list they print, in *The three share facts verify-9p records (Task 10)*.

### Measured fence facts

Several of the fence's open records cannot be settled by reading source: the 9P share's case semantics, whether `realpath` crosses a Linux symlink, whether two distributions' shares report the same `(dev,ino)`, whether the fs-fence fixture root exists — these are properties of **this machine**, not of the repository. Writing a fix for a guessed answer is writing a fix for another machine, so measure first and record after. This table is the ruling input for D8 and the four pending records (token / argv / FIFO / budget).

`scripts/probe-fence-facts.mjs` is read-only: every probe is a stat / realpath, it creates nothing and writes nothing; the second distribution is passed as argv[2], and when it is absent F3/F5 report `UNMEASURED` honestly — **UNMEASURED is a result, not a failure**. When argv[2] names the same distribution as the primary (case-insensitively) they likewise report `UNMEASURED` and say why: comparing one share against itself gives every F3 row a vacuous `COLLIDES`, and F5 would even report `true` — that is the lexical fast path containing itself, not the walk's verdict, while the annotation beside it would falsely claim the walk had short-circuited on the missing root.

Measured **2026-10-01**; primary distribution `debian`, second distribution `debian-dev`:

```powershell
node scripts/probe-fence-facts.mjs debian-dev
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 identity <share root>                             dev 0 vs 0, ino 2 vs 2 -> COLLIDES
F3 identity /tmp                                     dev 0 vs 0, ino 1 vs 1 -> COLLIDES
F3 identity /home                                    dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 false (root absent, so the walk short-circuits; see F4)

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 identity <share root>",
    "value": "dev 0 vs 0, ino 2 vs 2 -> COLLIDES"
  },
  {
    "label": "F3 identity /tmp",
    "value": "dev 0 vs 0, ino 1 vs 1 -> COLLIDES"
  },
  {
    "label": "F3 identity /home",
    "value": "dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "false (root absent, so the walk short-circuits; see F4)"
  }
]
```

With no second distribution passed:

```powershell
node scripts/probe-fence-facts.mjs
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 cross-share identity                              UNMEASURED - pass a second distribution as argv[2]
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 UNMEASURED - pass a second distribution as argv[2]

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 cross-share identity",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  }
]
```

**How to read this table** (every row is measured, none inferred):

- **F1 case-sensitive (Linux semantics)**: `/TMP` does not fold onto `/tmp` and reports ENOENT. The share itself answers (in the same table F2's control resolves and F3's stat succeeds), so this ENOENT means "the share distinguishes case", not "the share did not answer".
- **F2 realpath does not cross a Linux symlink**: realpath of `/lib` (→ `usr/lib`) reports ENOENT, while the link's own target `/usr/lib` resolves normally on the same share (the control is written into the probe and into this row). Per `lib/wsl/fence.js:31-37`, `canonicalHostPath` takes the catch branch for such a path and returns it unchanged.
- **F3 cross-distribution (dev,ino) collision**: the shares of `debian` and `debian-dev` report a **completely identical** pair for the same spelling (`/`=2, `/tmp`=1, `/home`=16386, dev 0 on both sides). The fence's identity fallback tests equality as `dev === dev && ino === ino` (`lib/wsl/fence.js:87`), so that equality test cannot tell the two distributions apart. A spelling that compared only dev would always report COLLIDES on this machine and could never ask the ino half, so the probe compares and prints the whole pair.
- **F4 the fixture root does not exist**: `<home>/proj` reports ENOENT, and `verify-fs-fence.mjs` never creates it.
- **F5 the identity walk did not run**: when the root does not exist, `isUnderHost` short-circuits to false at the stat of the root (`lib/wsl/fence.js:82-83`), so this row's `false` means "the root does not exist", not "the walk refused a cross-distribution target". **F3's collision and F5's false must not be read together as "cross-distribution containment is safe".**

**Correction (Task 4, commit `850e104`)**: F4/F5 record the state **before** Task 4 — at that time the fixture root was `<home>/proj`. `verify-fs-fence.mjs` now builds its own fixture root: a one-off `dsh-fence-fixture-<pid>-<rand>` under the distribution's `/tmp`, removed as soon as it is done (normal exit, assertion failure, `process.exit`, uncaught exception, SIGINT/SIGTERM all clean up), and it **no longer references `<home>/proj`**, so the cross-distribution pin really runs the identity walk on any machine that has two distributions. The table's numbers are **not** changed: they are that time's measurement, and the probe's output is reproducible word for word to this day — `<home>/proj` still reports ENOENT, and the suite still never creates **that** path.

**Correction (Task 9)**: F3's collision was not merely "on record" — it was a **live hole**, and the fence now closes it. The lexical fast path is the only comparison that carries the distribution, and once it fails (which is exactly the cross-distribution case) the identity walk re-stats every ancestor against **the target's own share**, so a foreign target's ancestors are compared with the local root's `(dev,ino)`. The distribution's `/tmp` is a writable root `workspace-write` **always** grants (`writableHostRootsFor`), and both shares report the same pair for it — measured `isUnderHost('\\wsl.localhost\debian-dev\tmp\x', '\\wsl.localhost\debian\tmp') === true`: a cross-distribution write judged "contained". The fix binds the walk to the distribution (the same rule as `contains()`: if **both** sides resolve to a WSL UNC and the distributions differ, refuse — the distribution segment compared case-insensitively in Windows spelling), and after the fix that call is `false`. The rule is deliberately kept **narrow**: a drive-letter path carries no distribution, so drive-letter targets and drive-letter roots keep the identity verdict they had (the suite pins both directions), and a drive letter and a share are measured to be unable to collide (the Windows temp directory's dev is the NTFS volume serial number 3764601112, while every 9P share reports 0). `verify-fs-fence.mjs` gains two pins: a cross-distribution target under a share-identity root must be refused (this one **can only** pass when the walk did not run — running it means authorization, so it is the proof that "the walk was not reached"), and a case-variant spelling of the same distribution (`wsl$` plus an upper-case distribution) must still be contained (the binding must not refuse a legitimate target in the other direction).

### The three share facts verify-9p records (Task 10)

Task 1's `probe-fence-facts.mjs` is a **one-off measurement**: it records the answers in the table above, but it does not enter the aggregate. The three share facts the fence actually depends on — symlinks, cross-distribution identity, case — are now also measured by `scripts/verify-9p.mjs`, which **is in `verify-all.mjs`'s `STANDALONE` list**: the offline aggregate runs it every time, so these three facts are re-measured on every full run.

**But on a machine with only one distribution only two of them are re-measured.** The three cross-distribution identity `FACT` rows need a **second** distribution; with only one, the suite **skips** those three: the `SKIP` line names the missing precondition, **lists the three facts one by one**, gives the remedy (install a second distribution, or point `DSH_WSL_OTHER_DISTRO` at one already on this machine), and **ends with exit code 2** — this skip is declared in `DECLARED_SKIPS` (that entry carries the precondition above, alongside "the link fixture cannot be built"), so `verify-all` reports it as `SKIP` and prints that precondition instead of counting it as `PASS`; a green aggregate cannot say these three facts are established, and an undeclared skip is judged red (see docs/VERIFICATION.md). This is the owner's ruling: a single distribution is a **missing precondition**, not a bad profile. The skip is **limited to that family** — the facts that do not need a second share (symlinks, case) are still measured and printed, so what the reader loses is exactly the three that are named. The **content** of that `SKIP` is pinned by `scripts/verify-9p-skip.mjs`: it forces the precondition out through the probe's own override, runs a real process and reads real output (so every assertion runs on **every** machine), and pins the control as well — with a second distribution the suite still measures all three and exits 0.

**The same family has one more member.** When the link fixture cannot be built (wsl.exe fails, or a cold start exceeds its own 30s ceiling) the suite skips not only the three symlink facts but **also that assertion** — "the fence refuses the target spelling its own canonicalization produces", the product of turning the HAZARD into an assertion, which no other check in this suite covers. This family counts too (3 facts + 4 checks) and **exits 2**: disclosing it while staying green is exactly the class this round removes.

**The fence suite has the same family.** `scripts/verify-fs-fence.mjs` carries a family of **four cross-distribution assertions** that likewise need a second share: three with across-share subjects plus a **control** (a case-variant spelling of the same distribution must still be contained — a distribution binding that compared the segment case-sensitively would refuse a legitimate target, which is worse than the defect it closes). With only one distribution not one of the four can be evaluated, and this used to be **the precondition check FAILing, exit 1** — the owner ruled for a SKIP: the `SKIP` line names the precondition (no second distribution / the override pointed at itself / an empty override / a resolved share that does not answer), **lists the original label of each of the four unevaluated assertions**, says what is therefore unestablished, gives the remedy, **counts 4** and **exits 2** — this skip is likewise declared in `DECLARED_SKIPS` (that entry lists this precondition), so `verify-all` reports `SKIP` and prints the precondition instead of counting it as `PASS`; an undeclared skip is judged red. Those four labels are no longer described by prose but come from the **single list `CROSS_DISTRO_CHECKS`**: the checks print it and the `SKIP` prints it, so the words cannot drift from "what actually did not run" (the old text, "the two cross-distribution assertions", both miscounted and named none of them). This family's **content and both machine classes** are pinned by `scripts/verify-fs-fence-skip.mjs` (in `STANDALONE`, so it runs on every aggregate): it forces the precondition through the suite's override (pointed at the selected distribution / empty), simulates the owner's machine with a copy of the tree whose `listDistros()` reports one distribution, and reads a real child's stdout and exit code; the **control** proves that with a second distribution the suite still exits 0, prints no `SKIP` of this family, and prints all four assertions **PASS one by one**; and if the **distribution binding is removed** from `lib/wsl/fence.js` in the copy, that share-identity assertion must redden — an assertion is not a constant, and that is a proof rather than a claim.

**Division of labour: one owner per thing.** `verify-9p.mjs` records **how the share answers** (`FACT` rows, not assertions); **how the fence answers** is pinned in `scripts/verify-fs-fence.mjs` — the case row asserts adaptively against the share's own answer (`isUnderHost(case variant) === foldsCase`), and the cross-distribution row asserts that a foreign target under a share-identity root must be refused. Asserting the share's answer again in the profiling probe would redden on a machine whose **answers differ but which is healthy**, the same class of defect as "a check that can never fail".

**But a fact row cannot be "print a sentence and be done"**: beside every fact it first asserts the two things that make it a measurement — **the subject exists** and **the control answers** (the link the probe itself built appears in the share's listing, the link's own target is readable, `/lib` is in the share's listing, `/tmp` exists). Without those two, an ENOENT from a path that never existed would be read as "the share refused the link" — exactly the hollow pin this plan removes (D2). The falsifiability of these three assertions is proven with mutants (a wrong link name / a wrong control file name / replacing the creation with a rename primitive the share **does** resolve): each mutant reddens **only** its own row, exit code 1.

Measured (2026-10-01, primary distribution `debian`, second distribution `debian-dev`):

```powershell
node scripts/verify-9p.mjs
```

```
  FACT    realpath(/lib), a merged-/usr symlink — ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
  FACT    realpath / read of the link (the file behind it exists) — realpath ENOENT; read ENOENT -> the link is exposed but NOT followed
  FACT    a rename whose destination traverses the link — rename accepted without error and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\renamed-dst.txt exists: true -> the file landed AT the link's target (the SHARE resolves the destination spelling; the fence refuses it — the assertion below — and the provider never reaches this primitive anyway: the mkdir below aborts first, fs-local/src/fsio.ts:598)
  FACT    mkdir through the link, at a spelling the share resolves elsewhere — mkdir reported EINVAL and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\dsh-link-dir exists: true; isUnderHost(the raw spelling) === false
  OK    the fence refuses the target its own canonicalization produces for that spelling
  FACT    cross-share identity <share root> — debian (0,2) vs debian-dev (0,2) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /tmp — debian (0,1) vs debian-dev (0,1) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /home — debian (0,16386) vs debian-dev (0,16386) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    case-variant path /TMP (control: /tmp exists) — ENOENT -> CASE-SENSITIVE (Linux semantics)

THE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES
8 share fact(s) recorded above — NOT assertions: the fence's answers to them are pinned in verify-fs-fence.mjs
```

**F2's full answer: what the share actually does with a symlink.** Task 1's F2 measured only `realpath`. The same probe now builds its own link in the fixture root with `ln -s` (the target lies **outside** the fixture root; both directories belong to the probe and are removed afterwards), so every answer has a subject that is **definitely a link**:

- `realpath` / `stat` / `read` / `readdir` / plain creation (`open` without `O_EXCL`) **all fail to cross the link** (ENOENT) — that is the half the fence assumes.
- `rename` (destination under the link) and `mkdir` (creating a new directory under the link) **are resolved by the server**: the rename really lands at the link's target; mkdir reports `EINVAL` on the client while **the directory is created at the link's target**.
- A final-component symlink is **safe**: the rename replaces the link entry itself inside the root (measured: the link's target file content is unchanged), and exclusive creation reports `EEXIST`.
- The Windows side cannot even delete the link entry itself: `unlink` → ENOENT, `rm` → EISDIR, `rm -r` on a directory containing a link → ENOTEMPTY. So the fixture must be cleaned up with `wsl.exe ... rm -rf`, which is why `exit`/`SIGINT`/`SIGTERM` handlers are attached (what the Windows side cannot delete must not be left for the user) — that is not fastidiousness, it is a direct consequence of this fact.

### The fence's new rule (Task 2): a component that exists but cannot be canonicalized is refused

**The rule (one sentence, falsifiable)**: a target's containment verdict is true if and only if **every path component** between the "writable root" and "the target's own file name" either **does not exist** on the share (`lstat` reports ENOENT/ENOTDIR) or **can be canonicalized** (`realpathSync.native` succeeds); a component that **exists but cannot be canonicalized** (measured on this machine: a Linux symlink where `lstat` reports EISDIR and both `realpath` and `stat` report ENOENT) refuses the target outright. The target's **own file name is not inside the rule**.

**That HAZARD is therefore closed**: the original record was "the fence authorizes a spelling the share resolves elsewhere, and the publication's first action, `mkdir(directory, {recursive:true})` (`fs-local/src/fsio.ts:598`), creates the missing directory level at the link's target — outside the writable root". After the rule landed, the same spelling's measurement in `verify-9p.mjs` went from `isUnderHost(...) === true` to `false`, and that HAZARD row became a real assertion ("the fence refuses the target its own canonicalization produces"). **The FACT row is still true**: the share-side mkdir still creates the directory at the link's target (that is the share's behaviour); what changed is only the fence's answer to it.

**Why (b) and not (a)**: the candidate rule (a), "refuse a target whose path **component** exists but does not resolve", literally includes the **final component**, and a final component that is a link is **measured safe** — the publication's rename replaces the link entry itself inside the root, the link's target file content is unchanged (F2's third row above), and it **works today** (`verify-fs-fence.mjs`'s control pin "a final-component file link / directory link is still authorized"). Refusing it would refuse a legitimate write that works, and "a rule that refuses legitimate same-root writes is worse than the gap it closes". Rule (a) also draws no root boundary, and read literally it would refuse everything because some component **above the root** cannot resolve. The chosen (b) pins the scope to "between the root and the target's file name" — exactly the set of components line 598's `mkdir` walks, and would create.

**Where the rule lives**: in `lib/wsl/fence.js`'s `isUnderHost` (new helpers `canonicalizationOf` / `componentsCanonicalize`), **not** in `checkedTarget`. Three reasons: one, the authorization verdict *is* `isUnderHost`'s answer (`checkedTarget` merely calls it for every writable root and treats it as the authorization), so putting the rule elsewhere would leave `isUnderHost('<root>\<link>\...', root)` returning `true` — and that expression is exactly the measured subject of the original HAZARD, so that would only "comment out" the gap, not close it; two, the rule needs a root boundary and `isUnderHost` already has one (lexical prefix plus identity walk); three, both paths (the lexical fast path and the identity fallback) must pass through it, otherwise the `wsl$` alias spelling would bypass the rule — the alias pin exists for exactly that. `checkedTarget` and the two mutation entries are unchanged word for word.

**The cost (measured, not reasoned)**: canonicalization cannot tell a link pointing **inside** from one pointing **outside**, so both are refused. The cost is **zero** — a write through a link **cannot publish on this share anyway**: `mkdir(directory, {recursive:true})` reports ENOENT for a path through a link (measured, including when the intermediate directories already exist), so the write never reaches the rename; the fence's refusal only replaces "leave an out-of-bounds directory behind and report ENOENT" with "refuse before creating anything". `readlink` does not help either: it reports EISDIR for a link entry (measured) and cannot obtain the link's target.

**Residue**: the **race between the check and the publication**. The rule can only refuse components that **already exist**; a link planted by a bash tool after `checkedTarget` passes and before line 598's `mkdir` is still invisible (canonicalization is blind to such a component by construction, and no check can see it). The window is sub-millisecond and the payoff is still only an out-of-bounds directory creation with no content leak.

**Pins and mutants**: `verify-fs-fence.mjs` builds its own link fixture (`escape` pointing out of bounds, `inside-link` pointing in bounds, `dangling` pointing at a nonexistent target, `file-link` pointing at an out-of-bounds file; built with the distribution's `ln -s` and removed with `wsl.exe rm -rf`, because the Windows side can neither create nor delete link entries), asserts the rejection matrix (an out-of-bounds ancestor, **the key the write is actually handed**, the target's own parent, an in-bounds link, a dangling link, the `wsl$` alias spelling) **plus 5 controls** (a missing component under a real directory, a directly missing component under the root, an existing directory, a final-component file link, a final-component directory link — all of which must still be allowed); when the fixture cannot be built it **FAILs first and only then skips**, and does not permit "the link does not exist, so the assertion passes vacuously".

**"The key the write hands over" is not `canonicalHostPath`**: it is the key fs-local's own resolution walk produces (`resolveLocalTarget`, `fs-local/src/fsio.ts:161-210`), mirrored in the suite as `writeTargetKey`. `canonicalHostPath` runs `realpathSync.native` over the **whole path** with a fall-back to the input, and every target in this section has a nonexistent tail — so on **any** share it returns its input unchanged, and "are the two spellings the same" is simply not a function of blindness (R=1 wrote a pin from that reasoning that **would red falsely**: a true proposition written as a false failure). With the write key the relation holds: under the **blind arm** the walk stops at the fixture root and the key is the raw spelling; under the **resolving arm** the walk crosses the link and the key is the link's target; both arms are refused by containment.

**Two arms, and neither may be reddened**: what the fence answers depends on whether its canonicalization can see through the link, so the expectations above are **not constants** — they are written as relations against the measured `blindTo(link)` (`=== !blind`, the same shape as the case row's `=== foldsCase`). The other arm (canonicalization **can** see through the link) is buildable on this machine too: an NTFS directory junction is a reparse point `realpathSync.native` **does** resolve (measured), needs no privilege, and `rmSync` removes only the link itself (measured: the target is unaffected), so it is **pinned** rather than argued — under that arm the fence refuses the write key (containment, not blindness), while the raw spelling **is** in bounds: this is exactly where "writing the blind-arm expectation as a constant" would redden on a healthy machine.

**The cost row has a pin too**: `fs-local`'s publication sequence is "first `mkdir(directory, {recursive:true})`, and that step is outside **any** try/catch that could catch it" (structural, not incidental), so when it fails the staging directory, the temp file and the rename have not happened yet — which is also why that out-of-bounds trip left only a directory and nothing else. It is pinned **structurally** in `verify-fs-fence.mjs`: it reads the harness checkout's `packages/fs/fs-local/src/fsio.ts` (comments and string bodies blanked with the shared `blankLiterals` first, so a mention of the call in a doc comment does not count; located with `--checkout=` / `DSH_CHECKOUT`, defaulting to the checkout beside this repository) and asserts that the call is a **bare await statement** with all four criteria holding: what immediately precedes the call must be `await` (`head`), what follows it on the same line may only be blank or `;` (`tail`, comments being blanked to whitespace so a trailing comment does not count), there must be no try/catch from the **start of the function** to the call (`beforeCreate`, the window measured from the **function's opening**, not from the `const directory` line — otherwise "open a try before the call, put the catch after it" would slip through), and none between the call and the next `try {` (`toNextTry`). It does **not** claim: that this `mkdir` is the real binding (shadowing is a different defect), or that the caller will not swallow the function's own rejection — both are outside the structural pin's boundary. It also asserts that the try being guarded **is** the staging sequence (the boundary is limited to that try through the end of the function; it does **not** claim no other code path can reach those two calls). When the checkout is unreadable it **counts a skip and makes the whole suite report SKIP with exit code 2** (as its sibling suites do; the suite declares the precondition "the harness checkout is unreadable (or no second distribution's share answers)" in `DECLARED_SKIPS`, so `verify-all` reports `SKIP` and prints it instead of counting it as a pass) and does not let a green aggregate hide an unrun pin. **All six mutants** were run on **copies** (the real file must stay green): moving the call inside the guarded try → 2 red; wrapping it in its own try → 1 red; opening a try before the call with the catch after it → 1 red; **holding the promise and awaiting it later** (`const p = mkdir(…)` followed by `try { await p } catch {}`) → 1 red (caught only by `head`); a **`.catch(() => {})` chain** (no try/catch keyword anywhere) → 1 red (caught only by `tail`); a **late-registered catch** → 1 red; the harness checkout is byte-identical (`D7CC70E0…`).

That line in `verify-9p.mjs` was changed to a real assertion. Fence-side mutants: removing only the lexical fast path half → `verify-fs-fence.mjs` reddens only its 5 lexical pins (the alias row stays green), `verify-9p.mjs` reddens 1, exit 1; removing only the identity walk half → only the alias row reddens; removing both halves = the state before the change → 6 red. After every mutation the file is restored byte-identically (blob `3a353748…`).
