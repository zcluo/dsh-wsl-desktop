# `sandbox-windows-acl` crashes on any WSL 9P workspace: 9P exposes no security descriptor

## Summary

On Windows, when a session's workspace root is a WSL 9P UNC path
(`\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`), every `workspace-write`
sandbox grant fails at construction:

```
GetNamedSecurityInfoW failed (Win32 1): \\wsl.localhost\<distro>\home\<user>\<project>
```

The command never runs. `run_code` reports this as
`code run failed (worker-exit)`.

## Root cause

9P filesystems expose **no Windows security descriptor**, and `sandbox-windows-acl`
builds its capability grant on exactly that descriptor:

```
AclSandbox constructor
  → grantWrite(path, ...)                    packages/sandbox/sandbox-windows-acl/src/acl.ts:377
  → readCurrentSecurity(api, path)           acl.ts:141
  → GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL|LABEL, ...)   acl.ts:150
  → returns Win32 error 1, throws            acl.ts:154
```

There is no UNC / 9P detection anywhere in the package.

## Measurements (Windows 11, WSL 6.18, both distro spellings)

| Path | `Get-Acl` result |
|---|---|
| `C:\Users\<user>` (local NTFS) | **OK** |
| `\\localhost\C$\Users\<user>` (SMB UNC) | **OK** — SMB *does* carry a descriptor |
| `\\wsl.localhost\<distro>\...` | **FAIL**, Win32 error 1 (0x1509 / 5385) |
| `\\wsl$\<distro>\...` | **FAIL**, same |
| `\\wsl.localhost\<other-distro>\...` (second distro) | **FAIL**, same |
| Reading / listing the same directory's **files** | **OK** — data access is unaffected |

So this is a **capability gap in 9P**, not a permissions misconfiguration, and it is
**not** "all UNC is broken" — SMB UNC works. Any `isWsl9pPath()` predicate must match
only the two WSL share prefixes; matching arbitrary UNC would drop a confinement that
actually works.

`realpathSync.native` returns these paths **unchanged** (no `\\?\` extended prefix), so a
predicate on the share prefix is stable through the `canonicalPath()` step.

## Why the plugin's realm isolation does not already cover it

`dsh-wsl-desktop` isolates `shell`, `fs`, `subprocess`, `terminals` and `sandbox` inside a
`wsl-world` group, which makes the in-realm tools resolve the plugin's
`WslSandboxProvider` (confinement happens inside the distribution) instead of the host's
ACL runner. That works for the five tool rows it replaces.

It does **not** cover `run_code`: `@deepseek-ai/dsh-tool-executor-ptc` and
`@deepseek-ai/dsh-ptc-runtime-node` are not in the plugin's replacement list, so they stay
in the host realm and resolve the host's `sandbox-local` → `windows-acl` → this crash.

## Proposed fixes (upstream's choice)

**Option A — recognise 9P and degrade explicitly (smallest).**

Add a predicate matching only `\\wsl.localhost\` and `\\wsl$\` (case-insensitive), then:

- in `runner.ts`, before constructing `AclSandbox`, refuse `workspace-write` on 9P with a
  message that names the cause and the two ways forward (exit 127 keeps the existing
  runner-failure contract);
- in `sandbox-local.confine()`, degrade that one combination to a **declared** unconfined
  result rather than throwing.

The second half needs a third `SandboxEnforcement` value, because "cannot be governed at
all" is a different fact from `partial` (governs less than promised) and from
`SandboxUnavailableError` (refused). A silent unconfined passthrough is what the seam's own
contract forbids; a value the consumer must surface is the declared form.

**Important detail if you add that value:** `ConfinedArgv.denialSignatures` and
`.runnerFailureRules` are **required** fields, and three consumers dereference the former
unconditionally (line numbers verified against the tree):

```
packages/ptc-runtime/ptc-runtime-node/src/persistent.ts:90
packages/ptc-runtime/ptc-runtime-node/src/index.ts:286
packages/experimental/ptc-runtime-python/src/index.ts:1808
```

A degraded result that omits them throws
`Cannot read properties of undefined (reading 'some')` — which replaces the clear ACL
failure with a confusing TypeError one layer up. Carry empty arrays instead. There is also a
**runtime** enum in `tool-executor-ptc/src/ptc.ts:328`
(`enforcement: { enum: ['full','partial'] }`) that rejects any new value as invalid output
before it can be rendered — a type-only change is not enough.

**Option B — skip the ACL rung for 9P.** Same predicate; `sandbox-local` selects no runner
for 9P workspaces. Still needs the declared-unconfined value for the same reason.

**Option C — document and refuse at session start.** Cheapest, but leaves 9P workspaces
unusable, which is the current behaviour.

## Impact

Any Windows user who opens a WSL directory as their workspace and uses `run_code`, `bash`
or `fs` outside the plugin's realm hits this. The plugin's own realm is unaffected.

## Workaround today

Use a WSL agent preset so confinement happens inside the distribution, or switch the
session to `danger-full-access` (which skips `confine()` entirely:
`ptc-runtime-node/src/index.ts:219`).
