# A refused permission switch is silently discarded, so the menu snaps back with no explanation

## Summary

Switching a session's permission preset can be refused by the host. The most reproducible
refusal is the sandbox-mode fence in `terminal-bash`: while a persistent terminal is open,
the host refuses to change the sandbox mode. That is correct behaviour.

The client throws the refusal away:

```ts
// packages/client/ui-permission-presets/src/client/PermissionSelect.tsx
const submit = (id: string): void => {
  setPick(id)
  void select(id)
    .catch(() => false)          // ← the reason vanishes here
    .then(() => { setPick(null) })   // ← optimistic pick clears, UI reverts
}
```

The menu snaps back to the old value with no message. To the user this is
indistinguishable from a broken control — there is no next step to take.

## Reproduction

1. Start a session that has a persistent terminal open (the `ptc`/`standard` presets do).
2. Open the permission picker and choose **full access** (`danger-full-access`).
3. Acknowledge the risk dialog and confirm.
4. The picker reverts to **workspace-write** with no error shown.

## Evidence that the refusal is real and where it is lost

Decoding a session log (concatenated zstd frames, `session.v4.jsonl.zstd`) shows the two
halves parting company:

```
permission/preset  {"preset":"danger-full-access"}   ×5   (recorded)
sandbox/mode       {"mode":"workspace-write"}         ×1   (never changed)
```

This matches `PermissionPresetService.apply()` exactly — it appends `permission/preset`
first, then calls `setSandboxMode()`, which the fence rejects:

```ts
if (current !== name) session.append('permission/preset', { preset: name })  // ① lands
updateKnobs()   // ② setSandboxMode → fence throws
```

So the preset is recorded, the knob is not, and the client discards the exception. The
projection then refolds to `workspace-write` and the UI shows the old value.

The fence itself is correct and already has tests
(`packages/terminal/terminal-bash/src/index.ts:56`, asserted at
`packages/terminal/terminal-bash/tests/index.spec.ts:702`):

```ts
throw new Error(
  `cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent
   terminal sessions are open or being created; wait for creation to settle and close them first`,
)
```

## Why this matters beyond one refusal

`.catch(() => false)` is a general pattern here, not a fence-specific workaround: **any**
rejection from the command writer is swallowed. A future refusal reason would be equally
invisible.

There is a competing consideration, and this report does not ask to break it: the existing
test `falls back to an unknown current value and clears a rejected optimistic choice`
deliberately asserts that a rejected pick reverts the optimistic label. That behaviour is
right. What is missing is the *reason*.

## Suggested fix

Keep the optimistic pick clearing; surface the rejection beside the picker.

```tsx
const [failure, setFailure] = useState<string | null>(null)

const submit = (id: string): void => {
  setPick(id)
  setFailure(null)
  void select(id)
    .catch((error: unknown) => {
      setFailure(describeFailure(error))
      return false
    })
    .then(() => { setPick(null) })
}
```

```tsx
{failure !== null && <p className={css.failure} role="alert">{failure}</p>}
```

`describeFailure` should translate known refusals into an action and pass anything else
through verbatim, so nothing is ever silently lost:

```ts
function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/persistent terminal sessions are open/.test(text)) {
    return 'Close this session\'s terminal, then set the permission again.'
  }
  return text
}
```

`role="alert"` matters: it is what makes the refusal reach a screen reader as well as the
eye.

Companion change (server side, optional but cheap): end the fence message with the action
rather than stopping at the condition — `... close them first — then switch again`. The
existing loose matchers (`toThrow('open or being created')`) keep passing.

## Impact

Any Windows or Linux user who tries to widen permission while a terminal is open gets a
control that appears to do nothing. It is the failure mode that generates the least
actionable bug report, because there is nothing to quote: no error, no text, just a menu
that reverts.
