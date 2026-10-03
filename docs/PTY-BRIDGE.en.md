# Terminal (PTY bridge) — dsh-wsl-desktop

This records how the in-distro PTY bridge is driven, its control protocol, and its measured preconditions. The README keeps only the one-line conclusion that the terminal works.

`wsl.exe` has only three pipes — it is not a terminal; meanwhile `SubprocessTerminalHandle` also demands `resize` / `inspectForeground` / `signalForeground`. So the PTY is allocated **inside the distro**, and the host side drives it with two processes:

```
data process    wsl.exe -e python3 -c <bridge> <fifo> <cols> <rows> <shell…>
                stdin/stdout = terminal bytes           stderr = one JSON control reply per line
control process wsl.exe -e bash -c 'exec 3>"$fifo"; while read -r l; do printf "%s\n" "$l" >&3; done'
```

The bridge allocates a PTY with `pty.fork()`, pumps the master and the pipe pair, and implements `resize`/`foreground`/`activity`/`signal`/`terminate` as a JSON line protocol over the FIFO. **Every control request carries an id, and the bridge echoes the same id in its reply**; the host pairs by id: on timeout the entry is removed first, and late or unowned replies are dropped outright — otherwise, after one timeout, a late reply gets consumed by the next request and the whole control channel is misaligned from then on (this is exactly one of the mechanisms behind the old `verify-terminal.mjs` flakiness). Host-side cleanup contract: on announce timeout or control-process start failure, terminate the two already-spawned processes and wait for their exit (the old version leaked the data process and PTY session here); once the bridge exits, pending and subsequent control requests fail immediately instead of waiting out the full control timeout. **Zero install inside the distro** (python3 standard library only).

Residual limitation: when the host process is hard-killed (SIGKILL-level), the bridge's `finally` never runs and `/tmp/dsh-pty-*.fifo` survives until the distro restarts; on the next allocation the bridge unlinks a same-named FIFO first, so this is temporary garbage only and does not affect behavior.

Two measured preconditions:

- **The control process must start only after the bridge reports the session**, because `open` fails outright before the bridge creates the FIFO. The bridge creates the FIFO before `_spawn()` and makes this timing observable via the `started` reply.
- **Programs that query the terminal from rc hang the whole session.** Some distro users' `~/.bashrc` ends by launching programs that query the terminal (e.g. `fastfetch`); they wait for a reply that only a terminal emulator would give, and in headless verification there is no replier, so the prompt never appears. In the real web terminal, xterm.js does reply, so this is a problem of the verification environment, not a bridge defect — the verification shell is therefore pinned to `bash --noprofile --norc -i`, so that verification tests the bridge, not the user's rc.

PTC's `stdio.control` (fd channel) remains explicitly rejected: `wsl.exe` cannot forward arbitrary descriptors.
