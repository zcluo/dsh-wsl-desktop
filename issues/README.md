# Upstream issues and their discussion notes

These are defect reports against the **DeepSeek Harness** host, not against this plugin. They are kept here because this plugin's WSL workspaces are what trip them, and because the workarounds in [Compatibility](COMPATIBILITY.md) depend on the exact behaviour they describe. Each report is filed as a pair: the English text is the report itself (what an upstream maintainer reads), and the `DISCUSSION-` file is the working note that records how the behaviour was measured and why the local workaround takes the shape it does.

| Report | Subject | Local consequence |
|---|---|---|
| [0001](0001-windows-acl-9p-security-descriptor.md) / [讨论](DISCUSSION-1-9p-acl.md) | `sandbox-windows-acl` builds its grant on a Windows security descriptor, and a WSL 9P path exposes none, so every `workspace-write` grant fails at construction | The WSL preset's **in-distribution** fence is the supported path; the host-side ACL runner refuses a 9P workspace with a named cause instead of a bare Win32 code. See the "9P workspaces" section of [Compatibility](../docs/COMPATIBILITY.md) |
| [0002](0002-permission-switch-refusal-swallowed.md) / [讨论](DISCUSSION-2-permission-swallowed.md) | A host-refused permission-preset switch is discarded by the client, so the menu snaps back with no explanation | Not worked around locally: the refusal comes from the host's `terminal-bash` guard and the fix belongs upstream |

## Status vocabulary

A report is **open** until the host behaviour changes. Being listed here is not a claim that it still reproduces: 0001's facts were re-measured when the 9P section was written into [Compatibility](COMPATIBILITY.md), while 0002 is recorded from its original run. Re-measure before quoting either as current.

## Filing

- One report per file, numbered; the discussion note reuses the number.
- Both editions carry the measured evidence (the command, its output, the Win32 code) — a report without that is an opinion.
- No machine-specific paths, credentials or account names: the reports describe the host, not the operator's setup.
