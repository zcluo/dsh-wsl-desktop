# 终端（PTY 桥）— dsh-wsl-desktop

本文记录发行版内 PTY 桥的驱动方式、控制协议与实测前提。README 只保留「终端可用」这一句结论。

`wsl.exe` 只有三条管道，不是终端；而 `SubprocessTerminalHandle` 还要求 `resize` / `inspectForeground` / `signalForeground`。所以 PTY 在**发行版内**分配，宿主侧用两个进程驱动它：

```
数据进程  wsl.exe -e python3 -c <bridge> <fifo> <cols> <rows> <shell…>
          stdin/stdout = 终端字节          stderr = 每行一条 JSON 控制应答
控制进程  wsl.exe -e bash -c 'exec 3>"$fifo"; while read -r l; do printf "%s\n" "$l" >&3; done'
```

桥用 `pty.fork()` 分配 PTY，把 master 与管道对泵，并把 `resize`/`foreground`/`activity`/`signal`/`terminate` 实现为 FIFO 上的 JSON 行协议。**每个控制请求携带 id，桥在应答里回显同一 id**，宿主按 id 配对：超时先把条目摘除，迟到的或无主的应答直接丢弃——否则一次超时之后，迟到的应答会被下一条请求消费，整条控制通道从此错位（这正是旧版 `verify-terminal.mjs` 偶发失败的机制之一）。宿主侧的清理契约：announce 超时或控制进程启动失败时，终止已 spawn 的两个进程并等待退出（旧版在这里泄漏数据进程与 PTY 会话）；桥退出后，未决与后续控制请求立即失败，不再空等整个控制超时。**发行版内零安装**（只用 python3 标准库）。

残余限制：宿主进程被硬杀（SIGKILL 级）时，桥的 `finally` 不会执行，`/tmp/dsh-pty-*.fifo` 会残留到发行版重启；下次分配时桥会先 unlink 同名 FIFO，所以这只是临时垃圾，不影响行为。

两个实测前提：

- **控制进程必须在桥报告会话之后才启动**，因为在桥创建 FIFO 之前 `open` 会直接失败。桥在 `_spawn()` 前先建 FIFO，靠 `started` 应答把这一点变成可观测的时序。
- **rc 里向终端发查询的程序会挂住整个会话。** 有的发行版用户的 `~/.bashrc` 末尾会启动向终端发查询的程序（如 `fastfetch`），它们要等只有终端模拟器才会给的应答，而无头校验里没有应答方，于是永远不出提示符。真实 Web 终端里 xterm.js 会应答，所以这是校验环境的问题而不是桥的缺陷 —— 但据此把校验用的 shell 固定为 `bash --noprofile --norc -i`，让校验测的是桥而不是用户的 rc。

PTC 的 `stdio.control`（fd 通道）仍然明确拒绝：`wsl.exe` 无法转发任意描述符。

