# dsh-wsl-desktop

简体中文 | [English](README.en.md)

> **生产状态：受控单机生产可用**（见下方边界定义）。需要 **DSH Desktop 0.1.7+**（预设通过运行时注册而非目录加载，旧版宿主会在激活时明确拒绝）。核心能力已活体验收；安全审计 run-1（5 候选闭环）与 run-2（4 confirmed 已修复 + 1 rejected 转加固）均完成，报告见 `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`。逐项证据强度见下方能力表。
>
> **边界定义**：
> - ✅ **适合**：插件作者本人或同信任级别操作者，在明确支持的发行版（见「发行版支持矩阵」）与 0.1.7+ 桌面上长期使用。
> - ⚠️ **条件**：confined 模式的信任边界依赖 NO_NEW_PRIVS（debian 系现代 setpriv 满足；不支持的老 setpriv 上围栏可被模型自身的 sudo 授权穿透，见 caveats）。
> - ❌ **尚不适合**：分发给第三方用户（缺桌面版本门控与发行版矩阵——见生产化路线图与 `docs/DISTRO-SUPPORT.md`）、无人值守高价值环境（subprocess 面不设防为已披露设计；对 harness 上游的两项 API 提案见 `docs/UPSTREAM-PROPOSALS.md`）。

## 桌面更新纪律（强制）

每次 DSH Desktop 更新后，插件可能因 harness 内部 API 变化而失效（0.1.6→0.1.7 即断裂四处）。**纪律：更新桌面 → 跑 `node scripts/verify-post-restart.mjs` → 全绿才继续使用；任何一次红都先修再干。** 该套件覆盖预设注册、执行世界、会话绑定、Windows 隔离与对话框契约；新宿主的破坏会在这些断言上现形，而不是静默降级成宿主世界。

## 目标能力

**活体验收通过后的诚实状态**（`verify-post-restart.mjs` 全绿 + 离线 11 套件；下面每条都注明证据强度）：

| # | 能力 | 状态 |
|---|---|---|
| ① | 工作区可选择 WSL 发行版里的 Linux 目录 | 对话框与宿主调用已实现并活体通过（listDir/checkPath/resolveHome/工作区注册与清理）；**浏览器内交互已由操作者人工确认**（门控流、目录浏览、终端面板均正常） |
| ② | 该工作区内的 shell / 文件工具 / subprocess / 终端 在 WSL 里工作，且可从 WSL 调用宿主机命令 | **活体验收 PASS**：绑定（创建请求命名 preset）、shell 进发行版、fs 工具 Linux 寻址、越界写拒绝、subprocess POSIX 环境、bash 工具、工具层约束；终端传输由 PTY 套件覆盖 |
| ③ | 同一实例里 Windows 与 WSL 工作区并存 | **活体验收 PASS**：Windows 工作区停留在宿主 preset（PowerShell 可用、无 bash），WSL 会话并行运行 confined realm |
| ④ | WSL 侧的 Linux 沙箱约束 | **shell 侧已修并活体验证**：运行时枚举所有 `rw` 挂载逐个改只读（实测 `/mnt/c`、`/dev/shm`、`/run/user/<uid>` 从 WRITABLE 变 READONLY）、失败即拒（保留退出码 97）、`enforcement` 如实报 `partial`。**fs 侧围栏已实现并活体验证**（越界写拒绝 PASS，见「fs 工具的围栏」）|

## 会话绑定：在创建请求里命名执行世界

harness 在会话**创建**时就把 preset 定下来（`SessionCreateRequest.agentPreset` → `composeAgent` 的 `setup: presets.mount(...)`，挂载发生在会话发布之前）。事后用 `agentPresets.select` 只能作用于"还没有跑过任何 turn"的会话，一旦有过 turn 就被 `agent-preset/locked` 拒绝，而且拒绝只写进内存日志、不报给用户。

**当前实现就是围绕这个事实做的**：

- 浏览器半边在 W 对话框里创建会话时，先调宿主的 `wslPresetFor` 解析变体 id，然后把 `agentPreset` 放进**创建请求**（`lib/client.js` 的 `createBoundSession()`）。这是唯一无竞态的接缝：preset 随会话一起组合，不存在"先跑在 Windows 世界再切"的窗口。
  - **这个字段会经过两层 API，其中一层会把它丢掉。** 宿主侧的 `SessionCreateRequest.agentPreset` 是真实契约，但客户端服务包装 `ctx.sessions.create` 只用 `workspaceId | cwd | sessionId` 重建请求体——`agentPreset` 被静默丢弃，会话落到默认 preset 上，只剩上面那条兜底去救。所以创建走的是**生成出来的 remote 契约** `ctx.remote.session.create({ workspaceId, agentPreset })`（`inject` 里相应地注入 `remote` / `remote.session`），`ctx.sessions.create` 仅作为 remote 面不可用时的退路。`scripts/verify-client-ui.mjs` 同时钉住这两点。
- 宿主半边保留一个 `api-session/added` 监听（`lib/index.js` 的 `bindWslSession`）作为**兜底**：只处理"cwd 是 WSL 路径、但创建时没带 preset"的会话（比如从别的入口创建的）。它尝试事后 `select`，成功就补绑，失败就写 `bindingLog` 并在宿主日志里告警——这类条目现在是**异常信号**，不再是正常路径的一部分。
- 因此 `verify-post-restart.mjs` 的 binding 段语义是：非 selftest 的 `bindingLog` 条目 = 有人绕过创建接缝建了 WSL 会话；零条目 = 一切经创建请求绑定的会话都正常。GUI 侧的最终确认已由操作者完成（会话预设显示 WSL · PTC 模式，工具在发行版内执行）。

## 界面入口

侧栏工作区标题栏里，自带的"+"（添加工作区）右边多一个 **W** 按钮；点开是本插件的工作区对话框：选发行版 → 输入用户 → 浏览或输入 Linux 目录 → 创建并打开会话。

侧栏工作区列表里，**路径落在 WSL UNC 下的工作区，行首图标是 ☁️ 而不是文件夹**。判定走工作区列表（`ctx.workspaces.list.getSnapshot().items` 里的 `path`——**`list` 这一跳不能省，写成 `ctx.workspaces.path` 会拿到 undefined 并静默不生效**），因为行 DOM 里只有工作区名字、没有路径；而行 key `workspace:<id>` 里的就是 workspaceId，映射因此可靠。图标是自带的矢量云而非 emoji：harness 图标集里没有云，也**没有逐行图标槽位**（只有整段 `sidebar.workspaces`，占位会遮蔽自带列表），所以替换在 DOM 层完成，并入 W 按钮那条 sync 通道。

两个实测细节：**云跟随行的字重**——收起态部署渲染 `IconFolderCloseRegular`（1px 描边），展开态是 `IconFolderOpenRegular`（纯填充），所以同一份闭合路径按两种方式渲染（描边 = 轮廓，填充 = 实心），随展开状态重建，行内不会出现"描边配填充"。**部署自带的 `<svg>` 只隐藏、不删除**：节点属于 React，抽掉它的子节点正是 `removeChild` 异常的来源；`display` 也不是 childList 变更，因此不喂回观察器（实测 2.6s 内 0 条 childList 记录）。`scripts/verify-client-dom.mjs` 覆盖以上全部行为。

选中某个发行版后，对话框**先要求输入要进入该发行版的用户**（留空 = 发行版默认用户），确认后才进入浏览：路径直接落在该用户的主目录（宿主在发行版内用 `getent passwd` 解析用户数据库，方法为 `resolveHome`）。输入的用户不存在时，错误就地显示在弹层里，不会进入浏览。切换发行版——包括重新点击当前已选中的那个——都会重新弹出用户输入框，并带上一次确认过的用户名作为起点。创建会话进行中时发行版按钮暂时不可点（提交的结果归属提交本身）。进入浏览后，主目录就是普通路径——输入框、前往、面包屑、目录点击照常可用。边界要说清楚：这一步只决定"浏览谁的 home"，**不决定会话身份**——会话在发行版里始终以发行版默认用户执行（`username` 是插件配置，不随会话创建传递）。

"+" 保持部署自带的行为（Desktop 上是 Electron 目录选择器），本插件不改写它：

- `sidebar.workspaces.directoryFlow` 是 `kind: 'single'`，占位会**遮蔽**部署自己的目录选择器，所以本插件不注册这个槽位；
- 侧栏标题栏没有扩展点，所以 W 按钮以伴随节点挂在"+"按钮之后：用 "add workspace" 图标的 SVG path 几何定位（与语言无关，全应用只有这一处渲染它），并复用该按钮的 class 以取得同样的尺寸与悬停态。桌面重构过该图标（`IconProjectAddOutline16` → `ProjectAddOutlineArtwork`，几何完全改变），触发器因此携带**新旧两代几何的已知列表**、按前缀匹配任一代——桌面更新不会让 W 静默消失。React 替换该子树时，MutationObserver 会把 W 重新挂回。
- **隐藏必须用 `display`，不能用 `remove()`。** 观察器监听的是 `childList`，`remove()` 自己就是下一次触发，两者会以刷新率互相喂养（实测 52 次/2.6s，每次还带两次强制布局）。放不下时设 `display: none`，它不是 childList 变更，因此收敛。
- **不要用定时器兜底。** 曾经的 `setInterval(sync, 2000)` 就是这个回路的种子；重新挂载/portal 都是被观察子树上的 childList 变更，定时器不解决任何真实情况。
- 伴随按钮只在"+"可见时显示（内联搜索展开时随官方动作簇一起隐藏），并且当有第二个控件带同样图标几何时优先选 `*_headerActions` 簇里的那个，认不出来就整体让位而不是猜。

## 终端（PTY 桥）

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

## 已知限制：grep / glob 工具

`tool-fs-search` 虽然通过 `ctx.subprocess.spawn()` 启动（`search-core.ts:238`），但它的 argv[0] 是 `@vscode/ripgrep` 提供的**打包 Windows rg.exe**（`search-core.ts:174-178`），在发行版里既不存在、也无法用 Linux 参数工作。所以 WSL 预设会把它从执行世界里移除，WSL 会话的模型只能用 bash 的 `grep` / `find`（两者在发行版里都在）。这算是一个能力回退，不是遗漏——要做成对等的，需要给 WSL 世界提供自己的搜索实现。

**预设里不需要终端 registry 行。** 侧栏终端面板走的是 `agent.ctx.get('subprocess').spawnTerminal(...)`（`packages/api/terminal-controller/src/index.ts:333,346`）—— 会话作用域，所以 realm 里的 `subprocess-wsl` 自动把 PTY 放进了发行版。隔离 `terminals` 只会服务模型的持久 shell 工具，而这个预设并不挂它；多挂一组 registry + backend 只增加挂载失败的面，所以不加。

## 架构

**执行世界由会话的 agent preset 决定。** `ctx.shell` / `ctx.fs` / `ctx.subprocess` 都是进程级单实例，而 Windows 与 WSL 的工具方言不同（pwsh vs bash），因此并存不是靠"按路径路由的全局 provider"，而是靠 preset 的 `isolate` realm：

```
Windows 工作区会话                      WSL 工作区会话
  preset: standard                        preset: wsl-standard
  ctx.shell = pwsh-sandbox（宿主）          isolate: { shell, fs, subprocess }
  ctx.fs    = fs-sandbox（宿主）            ├─ shell-wsl  → ctx.shell
                                            ├─ fs-wsl     → ctx.fs
                                            ├─ subprocess-wsl → ctx.subprocess
                                            └─ tool-bash / tool-fs
```

`wsl.exe` 本身是普通 Windows 进程，所以 WSL 执行器最终仍由**宿主的** subprocess provider 启动它。realm 隔离 `shell`、`fs` 与 `subprocess` 三者，因此 realm 内的 `ctx.subprocess` 解析到 realm 自己的 provider；宿主那一行在根组合里捕获根 provider（`lib/wsl/host-refs.js`），realm 行再读回它 —— 托管进程的终止、输出溢出与回收仍归本地 provider。

**执行世界的命名发生在创建请求里。** 浏览器半边创建 WSL 会话时通过 `wslPresetFor` 把变体 id 写进 `agentPreset`；宿主半边只在 `api-session/added` 里对"没带 preset 的 WSL 路径会话"做兜底并告警（见「会话绑定」）。浏览器半边因此不依赖任何 preset 客户端 API 之外的东西。

## 约束（Linux 侧，M2）

宿主的 `ctx.sandbox` 包不住 `wsl.exe`（子进程在 Linux 内核侧），所以约束发生在**发行版内部**：在 mount namespace 里把 `/` 改成只读，只留工作区与一个私有 `/tmp` 可写。

```
workspace-write:  bind <workspace>  →  tmpfs /tmp  →  remount,ro,bind /
read-only:        tmpfs /tmp        →  remount,ro,bind /
```

顺序是负载性的：**先绑可写路径，再 remount 根为只读**。反过来的话新 bind 会继承只读状态（实测工作区写入会失败）。

两个实测得出的前提：

- **必须 root。** WSL 内核拒绝在 user namespace 里做 bind mount：`unshare -Ur --mount` 能起，但 `mount --bind` 报 "wrong fs type"。所以用 `sudo -n unshare …`；没有免密 sudo 时受限模式**明确失败**（`SandboxUnavailableError`），而不是裸跑。
- **降权后保留的 sudo 授权是围栏的已知边界——两条闭合路径。** 会话用户保留着 runner 自己依赖的免密 sudo 授权——被约束的命令可以重新调用它（新开一个不带围栏脚本的 `sudo -n unshare --mount`，或在围栏内 `sudo -n mount -o remount,rw /`），从而绕过文件围栏。闭合路径（按优先级）：
  1. **专用 helper（推荐；一次安装，但每次升级插件后必须重装）**：
     ```bash
     # 在发行版内以 root 执行（路径按实际安装位置调整）
     install -m 0755 -o root -g root /mnt/c/Users/<you>/.dsh/profiles/desktop/plugins/dsh-wsl-desktop-*/lib/wsl/dsh-wsl-confine.sh /usr/local/sbin/dsh-wsl-confine
     echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/dsh-wsl-confine *" > /etc/sudoers.d/dsh-wsl-confine && chmod 0440 /etc/sudoers.d/dsh-wsl-confine
     ```
     helper 以 root 身份**总是先施加完整围栏**再降权执行命令——重新调用只会从已围栏的上下文再围栏一次，参数游戏（workspace='/'）被 `/ is not read-only` 后置条件击败。插件自动探测并优先使用 helper（sudoers 只授权这一个文件），但**只接受与插件要求完全一致的版本（当前 v1.2）**：v1.1 的豁免正则没有转义，工作区路径含元字符时会被误清扫成只读，含 `|` 的路径甚至会让 `/mnt/c` 成为豁免目标（受限会话里 Windows 文件系统保持可写）。因此**升级插件后必须重新执行上面的 install**；helper 版本不匹配时插件不会选它，而是回落到直接 sudo-unshare runner（其进程内构造器一直是正确的），不会静默沿用旧围栏。版本要求是**精确匹配**（不是“不低于”），所以将来提升 helper 版本时必须同时提升 `confinement.js` 里的 `HELPER_VERSION`——`verify-confinement.mjs` 有一条钉子把两者钉在一起，不一致会红。

     **helper 自己钉死 PATH，不依赖 sudoers。** 它以 root 身份按裸名调用十二个工具（getent/cut/sed/tr/mount/findmnt/grep/mountpoint/setpriv/env/bash/unshare）；`env_reset` 挡不住这件事——`secure_path` 只替换**继承来的** PATH，而以 `sudo PATH=… <helper>` 形式传入的赋值在策略允许时仍会到达 helper（debian/debian-dev/arch 实测；是否允许由 sudoers 的 `SETENV`/`ALL` 决定——本机是 `NOPASSWD: ALL`，sudo 对 ALL 隐含 SETENV），且 NOPASSWD 授权是参数通配的。身份闸门是最坏的一环：它信任经该 PATH 解析出的 getent/cut 输出，伪造的答案即可满足 `--uid 0 --gid 0`。因此 helper 把 PATH 钉为 `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` 并 `export`，而且这是它**执行的第一条语句**（早于参数解析与身份闸门）；发行版自己的 `secure_path` 请照原样保留——钉死是 helper 自己的保证，不是替代品。该钉子**没有回退**：十二个工具必须能在上述六个目录里解析到，解析不到就**失败关闭**（getent 缺失→调用者记录为空→闸门拒绝；cut 缺失→pipefail 下 127，围栏不会建立；`command -v` 预检→exit 97 + setup-failure 标记），绝不回退到调用者的 PATH——回退等于把这个洞原样放回来。

     **helper 在启动前就丢掉调用者给的 BASH_ENV，并且不导入环境里的函数。** bash 会在脚本第一行之前 source 调用者给的 `BASH_ENV` 文件——以 root 身份，早于本文件里的每一条控制（PATH 钉子在内，所以钉子关不掉它）。实测（bash 5.2.37）：`bash script`、`#!/bin/bash` shebang 经 exec、`bash -c` 都会 source，而 `bash -p script`、`#!/bin/bash -p` shebang、`bash -p -c` 都不会。由此有三处改动。shebang 是 `#!/bin/bash -p`。`-p` 不会把这个变量从环境里删掉，而每个后代都会继承它——降权后的 `bash -lc` 不是特权模式、确实会处理它（实测：以会话用户身份、在围栏内 source 了该文件）——所以 exec 尾巴用 `env -u BASH_ENV` 删除，删在唯一那条所有 root 阶段后代都挂在它下面的调用上。又因为 `-p` 是 shell 自身的属性，围栏体这个独立的 `bash -c` 仍会导入调用者导出的函数：一组配合好的 `mount`/`findmnt`/`mountpoint` 覆盖会让清扫报告“系统已受限”而 `/mnt/c` 保持可写（实测：静默绕过围栏；只覆盖 `mount()` 时只是碰巧在后置条件上失败关闭），因此围栏体也用 `-p` 启动，使这类覆盖彻底失效。`-p` 同时关掉了绕过 PATH 钉子的第二条伪造路径（实测：伪造的 `getent()` 函数让身份闸门接受 `--uid 0 --gid 0`，命令以 uid 0 跑在围栏里；加上 `-p` 后闸门拒绝，exit 2）。严重性：这是围栏之前、第一行之前的无约束 root 代码执行，超出 PATH 钉子关掉的“围栏内 root 访问”（围栏内的 root 也不是只读者，见身份闸门那段）——可达性由 sudoers 决定：**窄**规则并**不**隐含 SETENV，而导出的 `BASH_ENV` 会被 sudo 的 env_reset 剥掉（实测），所以这条路需要命令行赋值形式，而 SETENV 允许它、`ALL` 匹配隐含它；helper 侧的修复因此是无条件的，不依赖部署的 sudoers。`HELPER_VERSION` 保持 v1.2，所以**没重装的旧 helper 仍会被探测选中**——升级插件后必须重装，这次尤其。

     **身份闸门失败关闭，但它只在没有 SETENV 的部署里成立。** 闸门用 SUDO_USER 判断调用者；空值或未设**曾经意味着跳过检查**，而这个变量是调用者可设的：实测 `sudo -n SUDO_USER= <helper> --uid 0 --gid 0 --home /root --cwd / -- '…'` 与 `sudo -n env -u SUDO_USER` 都让命令以 uid 0 跑在围栏里、`/etc/shadow` 可读。现在空值/未设一律**拒绝**（exit 2；root 自己直接调用请显式传 `SUDO_USER=root`）。但闸门挡不住**伪造**：`sudo SUDO_USER=root <helper> --uid 0 --gid 0 …` 仍被接受——闸门只有这一个身份来源，`SUDO_UID` 走同一条路同样可伪造，交叉校验买不到东西。因此闸门**只在 sudoers 不授予 SETENV 的部署里**才是边界（没有 `ALL` 匹配、也没有命令行赋值形式）；授予 SETENV 时它只挡无意误用、不挡伪造，围栏会按**伪造的 uid** 降权——那是 root **写**，不是读原语：只读状态是私有 namespace 里的 per-mount bind remount，伪造的 uid 0 可以 `mount -o remount,rw /` 与 `mount -o remount,rw /mnt/c`（实测两者都成功，且两个文件系统上都有真实写入落地：root-only 路径、以及 /mnt/c 下新建的文件），从而写发行版文件系统与 Windows 文件系统；仍然成立的只有 namespace 与 NO_NEW_PRIVS，文件围栏不在了。
  2. **NO_NEW_PRIVS（自动，无 helper 时的缓解）**：降权时运行时探测 `setpriv --no-new-privs` 支持（debian 系现代 setpriv 满足，实测 `noNewPrivs: true` 已激活）——围栏内 setuid 提权响亮失败。不支持该标志的老 setpriv 上，此边界仍存在——如实记录于 `enforcement: 'partial'` 的 caveats。
- **findmnt 的 `\xNN` 转义已解码。** `findmnt -r` 会把 TARGET 里的空格/制表/换行/反斜杠编码为 `\x20` 等——修复前清扫按字面转义名 remount（ENOENT 被 `|| true` 吞掉）且后置条件测的是假名，含空格的挂载点在只读模式下保持可写而退出码 97 不触发。现在两处管道都先解码再匹配，并有真实含空格 bind 目标的只读断言回归（verify-confinement）。
- **进 namespace 后必须降回原用户。** 经 `sudo` 进入后 euid 是 root，直接用会让工作区里出现 root 属主文件；用 `setpriv --reuid --regid --init-groups` 降回会话用户（有断言覆盖属主）。
- **所有输出被解析的探针一律非登录。** `resolveIdentity` / `detectRunner` / `listLinuxDir` / `checkLinuxPath` / `resolveDistroHome` / `resolveExecutable` / pty 的 python3 探测全部 `loginShell: false`——登录 shell 的 rc 会先于探针命令输出，位置性解析就会把 profile 打印的内容当作 uid/gid/home（模型可写 dotfiles 时等于把 setpriv 的 uid 交给攻击者）。`resolveIdentity` 额外用 `__DSH_IDENTITY__` 哨兵行界定 + 恰好四行校验，解析失败抛**携带探针实际输出**的错误（不再静默 null）。探针超时 60s + 超时后一次透明重试：桌面重启后的首个 wsl.exe 冷启动可以超过短上限。
- **wsl.exe 的选项值在 spawn 前过语法校验。** `runWslShell` / `buildWslExecArgv` 顶部对 distro（`DISTRO_NAME`）与 username（`LINUX_USER`）拒绝分隔符字符——exec 路径的安全性不依赖 wsl.exe 外部未文档化的分词规则；checkPath 也在任何 wsl.exe 副作用之前先做 UNC 校验（回归钉在 verify-world）。

## 关键约束（都是实测得出，不是推断）

1. **工作区路径必须是 UNC 拼写。** `packages/workspace/workspace/src/paths.ts:16-23` 在 win32 上把 POSIX 路径 `/home/...` 判为非法（root === '/'），只有 `C:\…` 与 `\\server\share` 能过。
2. **插件必须落在 profile 目录内。** profile 的模块解析器只给 profile 前缀内的模块把 `@deepseek-ai/*` 路由到安装代；`link:` 到 profile 外时 7 个 harness 包全部 `Cannot find package`。
3. **宿主插件代码无法热重载。** Node 按 URL 缓存模块，重新安装同一目录仍服务旧代码；因此核心逻辑写成不依赖 harness 的纯模块，用独立 Node 脚本校验。
4. **9P 共享没有硬链接。** `link()` 报 `ENOTSUP`；`ReplaceFileW` / `SetFileSecurityW` 是本地卷 Win32 API，在网络共享上无意义 —— 三者都由 `WslFileSystem` 覆盖。
5. **`appendWindowsPath = false` 是常见默认值。** 宿主机程序不在 PATH 上，必须用 `/mnt/c/Windows/System32/*.exe` 绝对路径（`hostExecutable()`）。
6. **客户端插件 apply 时 `<body>` 可能还不存在。** client 半边在文档解析期间就 apply，`document.body` 会是 `null`；这时 `MutationObserver.observe(document.body, …)` 直接抛错，整个 apply 失败，界面静默无反应（W 按钮第一版就踩在这里）。观察根必须用 `document.documentElement`，并额外用定时器兜底 —— 只靠 observer 等于假设"每次都要有 childList 变更"，这个假设不成立。
7. **client 半边改动能热更新，宿主半边不能。** 就地改写 profile 里当前那一代的 `lib/client.js` 会改变投放 rev 并通过 `/plugins/events` 推给页面，**不需要重启**；`lib/index.js` 改了必须重启。`scripts/inspect-live-client.mjs` 读宿主真正投放的那份 bundle（内存缓存，磁盘文件不是证据）。

## 目录

```
lib/index.js            Host：路由、预设生成、会话预设绑定
lib/client.js           浏览器：侧栏"+"旁的 W 按钮 + 添加 WSL 工作区对话框
lib/wsl/paths.js        UNC ↔ Linux ↔ 盘符 互译（纯函数）
lib/wsl/world.js        发行版发现、wsl.exe 执行核、目录事实
lib/wsl/shell.js        ShellExecutor 实现（WSL bash + 约束接入）
lib/wsl/fs.js           LocalFileSystem 子类（9P 后端 + 路径方言）
lib/wsl/subprocess.js  SubprocessRuntime 实现（管道 + 终端；委托宿主 subprocess）
lib/wsl/pty.js         终端句柄：两个进程驱动发行版内的 PTY 桥
lib/wsl/terminal-bridge.py 发行版内运行的 PTY 桥（python3 标准库，零安装）
lib/wsl/host-refs.js    宿主 subprocess provider 的跨模块引用（realm 隔离后必需）
lib/wsl/confinement.js  mount namespace 约束（纯函数 + 探测，可独立测试）
lib/wsl/fence.js        fs 围栏的包含性比较与可写根推导（纯函数，可独立测试）
lib/wsl/preset.js       预设重写（纯文本，可独立测试）
scripts/sync.ps1        把插件 stage 进 profile（随后由 plugin_manager 安装）
scripts/env.mjs         校验用的发行版/用户/home 解析（不硬编码机器身份）
scripts/verify-*.mjs    独立校验（不需要 harness）
scripts/verify-all.mjs  聚合运行全部套件（--live 追加需要运行中宿主的套件）
```

## 校验

```powershell
node scripts/verify-all.mjs          # 全部离线套件（等价于下面这些）
node scripts/verify-all.mjs --live   # 追加需要已安装插件 + 运行中宿主的套件
```

单跑某一项：

```powershell
node scripts/verify-world.mjs        # 路径互译 + 在发行版里执行命令 + 目录事实 + exec 边界拒绝
node scripts/verify-preset.mjs       # 预设重写（对着随附 standard 预设跑）
node scripts/verify-fs-fence.mjs     # fs 围栏的纯逻辑：包含性、跨发行版、可写根推导
node scripts/verify-9p.mjs           # 9P 共享原语画像 + 身份映射（围栏负载假设）
node scripts/verify-9p-skip.mjs      # 9P 探针「机器只有一个发行版」时的 SKIP 报告：内容、退出码 2、以及不早退
node scripts/verify-confinement.mjs  # 约束围栏：工作区可写、外部被拒、属主正确、含空格路径
node scripts/verify-terminal.mjs     # PTY 桥：resize / 前台进程组 / 信号 / 终止
node scripts/verify-pty-handle.mjs   # JS 终端句柄（对着真实桥跑）
node scripts/verify-client-ui.mjs    # 浏览器半边的静态检查（不注册槽位、定位几何、宿主调用）
node scripts/verify-client-dom.mjs   # 浏览器半边的行为检查：在 jsdom 里跑真实 factory（挂载位置 / 放不下时的收敛 / 隐藏跟随 / 工作区行图标）
node scripts/verify-modules.mjs      # 宿主半边的结构性钉子：发行版接缝 + `exports` 清单（`./client` 是硬契约）
node scripts/verify-sync.mjs         # 对一次性 profile 跑真 sync.ps1：代次保留四场景（链接可用 / 悬空 / 无链接 / 从未 stage 过）
node scripts/verify-route.mjs        # 活体：验收路由（需要运行中的宿主）
node scripts/inspect-live-client.mjs # 读宿主真正投放的 client bundle（可带若干标记串）
.\scripts\sync.ps1                   # stage 进 profile；已装过时同时把链接重指向新一代（首次安装仍由 plugin_manager 接线）
```

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。

## 安装 / 更新 / 发版

**用户安装（生产通道）**：本插件以 npm 包形式发布，形态对齐 dsh-better-sidebar 等成熟插件（`files` 精确清单 + `cordis.patch.yml` bundle patch + `dsh.client.inject` 客户端接线 + `manifestVersion`）。

- 插件市场 / 插件管理器：安装 `dsh-wsl-desktop@<version>`——桌面自动完成 pnpm 接线与 bundle patch 挂载，重启即用。
- 命令行等价：`plugin_manager install_bundle dsh-wsl-desktop@<version>`。
- **安装前提**：WSL2 + 目标发行版满足支持矩阵（`docs/DISTRO-SUPPORT.md`）——会话用户 NOPASSWD sudo、bash、python3；推荐按「约束」一节安装 dsh-wsl-confine helper（闭合 retained-grant 边界）。
- **更新**：安装新版本号即可；桌面大版本更新后按「桌面更新纪律」先跑 `verify-post-restart.mjs`。
- **卸载**：插件管理器卸载即同时撤回本插件注册的 wsl-* 预设（disposer 生命周期保证）。

**维护者发版**：语义化版本——patch = 缺陷修复；minor = 兼容的桌面大版本适配（每次 harness 断裂适配后升 minor，如 0.1.x 的 0.1.7 适配）；major = 边界语义或支持矩阵变化。流程：改 `package.json` version → 全量套件 + `verify-post-restart.mjs` 全绿 → `npm publish --access public` → 打 git tag。`files` 清单已含 `lib/wsl/dsh-wsl-confine.sh`（helper 随包分发）。

> ⚠️ **`exports["./client"]` 是硬性契约，改元数据时最容易误删。** 宿主的 client-modules 是**必装**插件：只要有一个包声明了 `dsh.client` 却没有 `exports["./client"]`，它就直接拒绝组合，整张桌面**启动失败**（不是本插件单独失效）：
> ```
> DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate
>   client-modules: dsh-wsl-desktop declares dsh.client but exports no "./client" bundle
> ```
> v0.2.0 的「release readiness」元数据改造（`38e6356`）删掉了整个 `exports` 块，0.2.0 与 0.2.1 因此**装上去就起不来**；`main` 顶不了这个位置——Node 解析 `./client` 子路径时不看它。`scripts/verify-modules.mjs` 现在钉住这条（`./client` 与 `.` 都在、client 入口不是 host 入口、文件真实存在、platform 为 web），发版前跑它即可拦住。**`cordis.patch.yml` 与 `lib/` 之外，`package.json` 也是投放面的一部分**：`verify-post-restart.mjs` 会把运行中的 manifest 与 checkout 逐字节比对。

**代码安装（开发模式）**：

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # 离线全量
.\scripts\sync.ps1                 # stage 进 profile 并重指向（开发者模式：developerTools 开启；首次安装需先接线）
# 重启 DSH Desktop → verify-post-restart.mjs
```

**已知不稳定 → 已修，多轮验证稳定**：`verify-terminal.mjs` 曾偶发失败（实测 6 次里 1 次）。根因在宿主侧 `lib/wsl/pty.js`，不是桥：分配失败路径不终止已 spawn 的数据进程，泄漏的桥会干扰后续运行；且控制应答不携带请求 id，一次超时之后迟到的应答会被下一条请求消费，整个控制通道从此错位。修复：失败路径终止并等待两个进程退出；每个请求带 id、桥回显同一 id，超时先摘除条目、迟到应答直接丢弃。修复后历经今日十余轮全量套件（含多次背靠背）无一复现，结论稳定。

宿主代码改动需要**重启 DSH Desktop** 才会加载；重启后先跑 `verify-post-restart.mjs`，它会在旧模块仍生效时直接报「请重启」而不是给假绿。**浏览器半边改动不需要重启**：就地改写当前那一代的 `lib/client.js` 会改变投放 rev 并由 `/plugins/events` 推给已打开的页面（`patchReload: live`）。`verify-post-restart.mjs` 会从 `/plugins/events` 读实时模块图并取回真正投放的那份 bundle 来断言这一点。 **注意 rev 不是即时更新的**：宿主惰性重建客户端 bundle，就地改写后立刻回读 `/plugins/events` 仍会拿到旧 rev（实测数秒后才变）。"文件已改"因此不等于"投放已变"，验证要读到新 rev 为止，否则会得出错误的"已部署"结论。

`sync.ps1` 每次 stage 到新的时间戳目录（Node 按 URL 缓存模块，同目录重装仍服务旧代码；时间戳只到秒，同一秒内的第二次运行会顺延到不冲突的名字，否则 loader 会静默忽略它已经挂载过的 row id），并**把 profile 链接重指向刚 stage 的这一代**，同时改写 profile 的 `package.json` 与 `pnpm-lock.yaml`——否则下一次 `pnpm install` 会按 manifest 把链接 reconcile 回旧代，"已经 stage 了"就成了假象。**保留规则是"保留最新的两代"**：链接一旦移动，"链接着的那一代"正是没人在跑的那一代，而运行中的宿主解析的是它前一代；只保留链接会在下一次 stage 时删掉正在使用的那一代，让所有 WSL 会话在下一次重启前失效。链接**无法定位那一代**时（profile 根本没有链接，或链接指向的目录已消失）`sync.ps1` **保留全部代次并告警**；profile **从未 stage 过**（连 `plugins/` 都没有）同样告警并点明那个链接路径——这时它只是把文件放好，**真正生效要等 profile 装过这个插件（首次安装由 plugin_manager 接线）**。删链接走 .NET 而不是 `Remove-Item`：Windows PowerShell 5.1 对 junction 抛 NullReferenceException，会让重指向中途失败而旧代仍被链接。以上全部由 `scripts/verify-sync.mjs` 在一次性 profile 上跑真脚本验证（四个场景：链接可用 / 悬空 / 无链接 / 从未 stage 过，最后一个钉住"告警必须写出链接路径"）。

## fs 工具的围栏

`WslFileSystem` 自带围栏：声明 `sandboxMode`，`writeText`/`editText` 两个变更入口都先过 `checkedTarget`（拒绝抛结构化 `FS_SANDBOX_DENIED`，工具层把它映射成模型可见的 `[sandbox: …]` 标记与升级提示）；包含性比较与可写根推导是纯函数，放在 `lib/wsl/fence.js`。**不是**继承官方的沙箱后端——官方后端会把本行包进第二个后端，凭空多出一层组合依赖，而围栏本来就是"可信代码里的策略检查"，放在本行即可。（最初"realm 看不到 `sandboxPolicy` 所以不能继承"的归因是错的，见下面教训 1：同 realm 的 `shell.js` 一直注入着这个服务。）

**可写根与比较命名空间**：`workspace-write` 的允许集 = 会话 cwd（工作区根）+ **发行版的** `/tmp`（9P 分享上的 `\\wsl.localhost\<distro>\tmp`，这是 Linux 侧 `/tmp/…` 请求在本世界解析到的位置；官方推导里的宿主 POSIX `/tmp` 在 Windows 上无意义）+ Windows 临时目录（经 `/mnt/<盘符>` 可达）。比较在**宿主命名空间**做：targetKey 是 Windows 拼写，UNC 前缀自带发行版身份，所以"另一个发行版里恰好同拼写的 Linux 路径"出不了界；未知模式给空允许集，即拒绝（fail-closed）。`checkedTarget` 的重规范化也从 **targetKey** 出发而不是 displayPath——displayPath 是 Linux 拼写、不带发行版，从它重解析会把路径钉到本行固定的发行版上，跨发行版 UNC 请求被静默改写（活体踩过：写进 debian-dev、读 debian 报 not found）；现在跨发行版请求直接 `FS_SANDBOX_DENIED`。

**为什么必须有围栏**：`LocalFileSystem` 从不覆写 `FileSystem.sandboxMode`。一个什么都不宣称的后端会让 `tool-fs` 的 `FsSandboxController` 对每次调用都解析不出策略（`tool-fs/src/sandbox.ts:43-50`：`defaultMode === undefined` ⇒ `escalationModes = []`、`policy = undefined`），于是 `write`/`edit` 完全不受管，能写到共享可达的任何地方，包括 `/mnt/c`——`toHostPath` 也接受直接的 `C:\…` 拼写，所以未围栏时的实际暴露面是整个 Windows 文件系统，不只是分享。

**两次失败尝试的教训**（记在这里以免再犯）：

1. 继承官方后端 → 整行不激活。当时我归因成"realm 看不到 `sandboxPolicy`"，**但真正原因是我把 `LocalFileSystem` 的 import 删掉了**（`node --check` 只解析语法，看不见未定义标识符）。症状吻合不等于归因正确。
2. 自带围栏的第一版在"拿不到 workspace root"时**一律拒绝**，把插件自己写 `/tmp` 也拒了。查清机制后才知道：官方后端的兜底同样是 `sandboxPolicy.resolve()`（不带参数），**它本身也给不出 workspace root**——root 永远是 `tool-fs` 每次调用时传进来的（`resolvePolicy` 用调用会话的 cwd 盖章）。

**因此 selftest 也改了**：它现在像真实调用方一样显式传策略 `{ mode: 'workspace-write', workspaceRoot: <会话 cwd> }`。之前它不传，是"用一个真实调用方永远不会用的方式调 fs"，那才是上次被拒的原因——不是围栏太严。

**两层钉子 + 活体验收**：`scripts/verify-modules.mjs` 钉住围栏的存在（声明 `sandboxMode`、两个变更入口都过 `checkedTarget`、拒绝用 `FS_SANDBOX_DENIED`、包含性比较有分隔符边界）；`scripts/verify-fs-fence.mjs` 离线验证纯逻辑（分隔符边界、大小写、**跨发行版同拼写路径被拒**、**无法规范化的已存在组件被拒**（Task 2，自建链接夹具与 5 条对照，见下节）、可写根推导、未知模式 fail-closed）；`verify-9p.mjs` 增补了身份映射探针（不同文件 (dev,ino) 互异、wsl.localhost/wsl$ 拼写稳定——围栏的身份回退以此为负载假设），并把「链接下的 mkdir」那行从 HAZARD 记录改成真断言。类的接线已由 `verify-post-restart.mjs` 活体验收（越界写拒绝 PASS）。

### Measured fence facts

围栏的几条开放记录不是读源码能定的：9P 共享的大小写语义、realpath 会不会穿过 Linux 符号链接、两个发行版的共享是否报告相同的 (dev,ino)、fs-fence 夹具根是否存在——这些是**这台机器**的属性，不是仓库的属性。给猜测出来的答案写修复，等于给另一台机器写修复，所以先测再记。这张表是 D8 与四条待定记录（token / argv / FIFO / budget）的判定输入。

`scripts/probe-fence-facts.mjs` 只读：每个探针都是 stat / realpath，不创建、不写任何东西；第二个发行版由 argv[2] 传入，缺省时 F3/F5 如实报 `UNMEASURED`——**UNMEASURED 是结果，不是失败**。argv[2] 与主发行版相同时（大小写不敏感）同样报 `UNMEASURED` 并说明原因：拿同一张共享跟自己比，每个 F3 行都会得到空洞的 `COLLIDES`，F5 甚至会报 `true`——那是词法快路包含了自己，不是行走的裁决，而旁边的注解会谎称行走已在缺失的根上短路。

测量时间 **2026-10-01**；主发行版 `debian`，第二个发行版 `debian-dev`：

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

不传第二个发行版时：

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

**怎么读这张表**（每条都是实测，不是推断）：

- **F1 大小写敏感（Linux 语义）**：`/TMP` 不折叠到 `/tmp`，报 ENOENT。共享本身可达（同一张表里 F2 的对照解析成功、F3 的 stat 也成功），所以这条 ENOENT 是「共享区分大小写」，不是「共享没答话」。
- **F2 realpath 不穿过 Linux 符号链接**：`/lib`（→ `usr/lib`）的 realpath 报 ENOENT，而同一共享上链接自己的目标 `/usr/lib` 正常解析（对照写在探针里，也写在这一行）。按 `lib/wsl/fence.js:31-37`，`canonicalHostPath` 对这类路径走 catch 分支原样返回。
- **F3 跨发行版 (dev,ino) 相撞**：`debian` 与 `debian-dev` 的共享对同拼写路径报告**完全相同**的二元组（`/`=2、`/tmp`=1、`/home`=16386，dev 两侧都是 0）。围栏的身份回退按 `dev === dev && ino === ino` 判相等（`lib/wsl/fence.js:87`），这个相等测试因此区分不了两个发行版。只比 dev 的写法在这台机器上永远报 COLLIDES，问不出 ino 那一半，所以探针比较并打印整个二元组。
- **F4 夹具根不存在**：`<home>/proj` 报 ENOENT，`verify-fs-fence.mjs` 从不创建它。
- **F5 身份行走没有跑**：根不存在时 `isUnderHost` 在 stat 根处短路返回 false（`lib/wsl/fence.js:82-83`），所以这一行的 `false` 是「根不存在」，不是「行走拒绝了跨发行版目标」。**F3 的相撞与 F5 的 false 不能合起来读成「跨发行版包含是安全的」。**

**更正（Task 4，提交 `850e104`）**：F4/F5 记录的是 Task 4 **之前**的状态——当时那个夹具根就是 `<home>/proj`。`verify-fs-fence.mjs` 现在自己创建夹具根：发行版 `/tmp` 下一次性的 `dsh-fence-fixture-<pid>-<rand>`，用完即删（正常退出、断言失败、`process.exit`、未捕获异常、SIGINT/SIGTERM 都清理），并且**不再引用 `<home>/proj`**，所以跨发行版那条钉子在有发行版的机器上都会真的跑身份行走。上表的数字**不改**：它是当时的实测记录，探针输出至今逐字可复现——`<home>/proj` 仍然 ENOENT，套件仍然从不创建**那个**路径。

**更正（Task 9）**：F3 的相撞不只是「记录在案」——它是**活的漏洞**，现已由围栏堵住。词法快路是唯一携带发行版的比较，它失败之后（正是跨发行版目标的情形）身份行走会按**目标自己的共享**重新 stat 每一级祖先，于是外来目标的祖先与本地根的 `(dev,ino)` 相比。发行版 `/tmp` 是 `workspace-write` **总是**授予的可写根（`writableHostRootsFor`），而两个共享为它报告同一元组——实测 `isUnderHost('\\wsl.localhost\debian-dev\tmp\x', '\\wsl.localhost\debian\tmp') === true`：一个被判定为「界内」的跨发行版写。修复把行走绑定到发行版（与 `contains()` 同一规则：**两侧都**解析成 WSL UNC 且发行版不同即拒绝，发行版段按 Windows 拼写大小写不敏感），修复后该调用为 `false`。规则刻意保持**窄**：盘符路径不带发行版，盘符目标与盘符根保持原有的身份裁决（套件对两个方向都有钉子），且实测盘符与共享两个命名空间不可能相撞（Windows 临时目录的 dev 是 NTFS 卷序列号 3764601112，每个 9P 共享报 0）。`verify-fs-fence.mjs` 新增两条钉子：共享身份的根下的跨发行版目标必须被拒（这条**只能**在行走没有跑到时通过——跑到就等于授权，所以它是「行走未被触达」的证明），以及同一发行版的大小写变体拼写（`wsl$` + 大写发行版）必须仍被包含（绑定不能反过来拒掉合法目标）。

### verify-9p 记录的三条共享事实（Task 10）

Task 1 的 `probe-fence-facts.mjs` 是**一次性测量**：它把答案记进上面的表，但它不进聚合器。围栏真正依赖的三条共享事实——符号链接、跨发行版身份、大小写——现在也由 `scripts/verify-9p.mjs` 测量，而它**在 `verify-all.mjs` 的 `STANDALONE` 列表里**：离线全量每次都会跑它，所以这三条事实每次全量都会被重新测一遍。

**但机器只有一个发行版时只重新测两条。** 跨发行版身份那三条 `FACT` 行需要**第二个**发行版；机器只有一个时套件**跳过**这三条：`SKIP` 行点名缺失的前提、**逐条列出这三条事实**、给出补救办法（装第二个发行版，或把 `DSH_WSL_OTHER_DISTRO` 指向本机已有的一个），并**以退出码 2 结束**——`verify-all` 因此把它报成 `SKIP` 而不是 `PASS`，绿色的聚合不能说这三条事实已经确立。这是业主的裁定：单发行版是**缺前提**，不是坏画像。跳过**只限这一族**——不需要第二个共享的事实（符号链接、大小写）照常测量并打印，所以读者失去的正好是被点名的那三条。这段 `SKIP` 的**内容**由 `scripts/verify-9p-skip.mjs` 钉住：它用探针自己的覆盖项把前提强制出来、跑真进程读真输出（每条断言因此在**每台**机器上都会跑），并同时钉住对照——有第二个发行版时套件仍测满三条、退出码 0。

**分工：一件事只有一个主人。** `verify-9p.mjs` 记录**共享怎么答**（`FACT` 行，不是断言）；**围栏怎么答**钉在 `scripts/verify-fs-fence.mjs`——大小写那条按共享自己的答案自适应断言（`isUnderHost(大小写变体) === foldsCase`），跨发行版那条断言共享身份的根下外来目标必须被拒。在画像探针里再断言一遍共享的答案，会在**答法不同但健康**的机器上变红，与「永远不会失败的检查」是同一类缺陷。

**但事实行不能是「打印一句就完」**：每条事实旁边先断言两件让它成为测量的事——**主体存在**、**对照答话**（探针自己建的链接出现在共享列表里、链接自己的目标可读、`/lib` 在共享列表里、`/tmp` 存在）。没有这两条，一个从不存在的路径来的 ENOENT 会被读成「共享拒绝了链接」——正是本计划要清除的空洞钉子（D2）。这三条断言的可证伪性用变异体证明（改错链接名 / 对照文件改错名 / 把创建换成共享**确实**会解析的 rename 原语）：每个变异体都**只**红掉它自己那条，退出码 1。

实测（2026-10-01，主发行版 `debian`，第二个发行版 `debian-dev`）：

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

**F2 的完整答案：共享对符号链接到底做了什么。** Task 1 的 F2 只测了 `realpath`。同一个探针现在在夹具根里用 `ln -s` 自己建链接（目标在夹具根**之外**，两个目录都归探针所有、用完即删），于是每条答案都有一个**确定是链接**的主体：

- `realpath` / `stat` / `read` / `readdir` / 普通创建（`open` 不带 `O_EXCL`）**都不穿过链接**（ENOENT）——这就是围栏假设的那一半。
- `rename`（目标在链接下）与 `mkdir`（在链接下建新目录）**由服务端解析**：rename 真的落在链接目标处；mkdir 客户端报 `EINVAL`，**目录却建在链接目标处**。
- 末级是符号链接是**安全**的：rename 替换的是根内的链接项本身（实测链接目标文件内容不变），独占创建报 `EEXIST`。
- Windows 侧连链接项本身都删不掉：`unlink` → ENOENT、`rm` → EISDIR、含链接的目录 `rm -r` → ENOTEMPTY。所以夹具必须用 `wsl.exe ... rm -rf` 清理，并为此挂了 `exit`/`SIGINT`/`SIGTERM` 处理器（Windows 侧删不掉的东西不能留给用户）——这不是洁癖，是这条事实的直接后果。

### 围栏的新规则（Task 2）：无法规范化的已存在组件即拒绝

**规则（一句，可被证伪）**：一个目标的包含性判定为真，当且仅当「可写根」与「目标自身文件名」之间的**每一个路径组件**要么在共享上**不存在**（`lstat` 报 ENOENT/ENOTDIR），要么**能被规范化**（`realpathSync.native` 成功）；一个**存在却无法规范化**的组件（本机实测：`lstat` 报 EISDIR、`realpath` 与 `stat` 都报 ENOENT 的 Linux 符号链接）直接拒绝该目标。目标**自身的文件名不在规则内**。

**这条 HAZARD 因此关闭**：原记录是「围栏授权一个共享会解析到别处的拼写，而发布的第一个动作 `mkdir(directory, {recursive:true})`（`fs-local/src/fsio.ts:598`）把缺失的那一级目录建在链接目标处——可写根之外」。规则落地后，同一个拼写在 `verify-9p.mjs` 里的实测从 `isUnderHost(...) === true` 变成 `false`，那行 HAZARD 换成真断言（「围栏拒绝它自己的规范化给出的目标」）。**FACT 行仍然为真**：共享侧的 mkdir 依旧把目录建在链接目标处（那是共享的行为），变的只是围栏对它的回答。

**为什么选 (b) 而不是 (a)**：候选规则 (a)「拒绝路径**组件**存在却不解析的目标」字面上把**末级组件**也算进去，而末级是链接是**实测安全**的——发布的 rename 替换的是根内的链接项本身，链接目标文件内容不变（上面 F2 的第三条），并且**今天就能成功**（`verify-fs-fence.mjs` 的对照钉子「末级文件链接 / 末级目录链接仍被授权」）。拒绝它就是拒掉一条能工作的合法写入，而「拒掉合法同根写入的规则比缺口更糟」。另外 (a) 没有给规则划根边界，字面读下去会因为**根之上**的某个组件无法解析而拒绝一切。选定的 (b) 把范围钉死在「根与目标文件名之间」——这正是第 598 行那个 `mkdir` 会遍历、并会创建的组件集合。

**规则住在哪**：`lib/wsl/fence.js` 的 `isUnderHost`（新助手 `canonicalizationOf` / `componentsCanonicalize`），**不是** `checkedTarget`。理由有三：一，授权判定就是 `isUnderHost` 的答案（`checkedTarget` 只是对每个可写根调用它，并把它当作授权），把规则放在别处会让 `isUnderHost('<root>\<link>\...', root)` 继续返回 `true`——而那条表达式正是原 HAZARD 记录的实测对象，那样只能「注释掉」缺口，不能关闭它；二，规则需要根边界，而 `isUnderHost` 已经有（词法前缀 + 身份行走）；三，两条路（词法快路与身份回退）都必须过它，否则 `wsl$` 别名拼写会绕开规则——别名钉子就是为这一条存在的。`checkedTarget` 与两个变更入口一字未改。

**代价（实测，不是推理）**：规范化分不出「指向界内」与「指向界外」的链接，所以两种都被拒。代价是**零**——穿过链接的写在本共享上**本来就不能发布**：`mkdir(directory, {recursive:true})` 对穿过链接的路径报 ENOENT（实测，含中间目录已存在的情形），写永远走不到 rename；围栏的拒绝只是把「先留下一个越界目录、再报 ENOENT」换成「在建任何东西之前拒绝」。`readlink` 也救不了：它对链接项报 EISDIR（实测），拿不到链接目标。

**残留**：**检查与发布之间的竞态**。规则只能拒绝**先已存在**的组件；在 `checkedTarget` 通过之后、第 598 行 `mkdir` 之前由 bash 工具种下的链接仍然看不见（规范化对这类组件本来就是瞎的，任何检查都看不见它）。窗口是亚毫秒级，收益仍只是越界建目录、无内容外泄。

**钉子与变异体**：`verify-fs-fence.mjs` 自建链接夹具（`escape` 指向界外、`inside-link` 指向界内、`dangling` 指向不存在的目标、`file-link` 指向界外的文件；用发行版的 `ln -s` 建、`wsl.exe rm -rf` 删，因为 Windows 侧既建不了也删不了链接项），断言拒绝矩阵（界外祖先、**写入真正交给围栏的那个 key**、目标自己的父级、界内链接、悬空链接、`wsl$` 别名拼写）**加 5 条对照**（真实目录下的缺失组件、根下直接缺失组件、已存在目录、末级文件链接、末级目录链接——都必须仍然放行）；夹具建不起来时**先 FAIL 再跳过**，不允许「链接不存在所以断言空洞地通过」。

**「写入的 key」不是 `canonicalHostPath`**：它是 fs-local 自己那套解析行走出来的 key（`resolveLocalTarget`，`fs-local/src/fsio.ts:161-210`），套件里镜像为 `writeTargetKey`。`canonicalHostPath` 是对**整条路径**做 `realpathSync.native` 加原样兜底，而本节的每个目标尾部都不存在——所以它在**任何**共享上都原样返回，「两个拼写是否相同」根本不是盲性的函数（R=1 曾据此写了一条**会误红**的钉子：把真命题写成了假失败）。换成 write key 之后这条关系才成立：**盲臂**下行走停在夹具根、key 就是原始拼写；**解析臂**下行走穿过链接、key 是链接目标；两臂都由包含性拒绝。

**两条臂，两个都不许红**：围栏答什么取决于它的规范化能不能看穿链接，所以上面的期望**不是常量**——按实测的 `blindTo(链接)` 写成关系（`=== !blind`，与大小写那条 `=== foldsCase` 同一形状）。另一条臂（规范化**能**看穿链接）在本机也建得出来：NTFS 目录 junction 是 `realpathSync.native` **会解析**的 reparse point（实测）、不需要特权、`rmSync` 只删链接本身（实测目标不受影响），于是它被**钉住**而不是被论证——在该臂下围栏拒绝的是 write key（包含性，不是盲性），而原始拼写**确实在界内**：这正是「把盲臂期望写成常量」会在健康机器上变红的地方。

**代价那条也有钉子**：`fs-local` 的发布序列是「先 `mkdir(directory, {recursive:true})`，且这一步在**任何**可能捕获它的 try/catch 之外」（结构性，不是偶然），所以它失败时暂存目录、临时文件、rename 都还没发生——这也是那次越界只留下一个目录、别无他物的原因。它以**结构性**方式钉在 `verify-fs-fence.mjs`：读 harness checkout 的 `packages/fs/fs-local/src/fsio.ts`（先用共享的 `blankLiterals` 抹掉注释与字符串体，免得文档注释里提到这个调用就算过；`--checkout=` / `DSH_CHECKOUT` 定位，默认本仓库旁边的 checkout），断言这个调用是一个**裸的 await 语句**，且四条判据一起成立：调用前紧邻的必须是 `await`（`head`）、调用后同一行只能是空白或 `;`（`tail`，注释被抹成空白所以行尾注释不算）、函数开头到调用之间不得有 try/catch（`beforeCreate`，窗口从**函数开头**算起，不是从 `const directory` 那行——否则「在调用之前开 try、catch 放在调用之后」会溜过去）、调用到下一个 `try {` 之间也不得有（`toNextTry`）。它**不**声称：这个 `mkdir` 是真绑定（被遮蔽是另一种缺陷），或调用方不会吞掉函数自身的 rejection——两者都在结构钉子的边界之外。并断言那个 try 守护的**就是**暂存序列（边界限在该 try 到函数收尾之间；它**不**声称没有别的代码路径能到达那两个调用）。读不到 checkout 时**计为 skip 并让整套以退出码 2 报 SKIP**（与兄弟套件一致），不允许绿色聚合掩盖一条没跑的钉子。**六个变异体**都在**副本**上跑过（真文件必须全绿）：挪进被守护的 try → 红 2 条；自带 try 包住 → 红 1 条；在调用之前开 try 而 catch 在调用之后 → 红 1 条；**把 promise 拿在手里再 await**（`const p = mkdir(…)` 后接 `try { await p } catch {}`）→ 红 1 条（只由 `head` 拦住）；**`.catch(() => {})` 链**（全文没有 try/catch 这个词）→ 红 1 条（只由 `tail` 拦住）；**延后注册的 catch** → 红 1 条；harness checkout 逐字节不变（`D7CC70E0…`）。

`verify-9p.mjs` 那行改成真断言。围栏侧变异体：只删词法快路那一半 → `verify-fs-fence.mjs` 只红 5 条词法钉子（别名那条仍绿）、`verify-9p.mjs` 红 1 条、退出码 1；只删身份行走那一半 → 只红别名那条；两半都删 = 改动前的状态 → 红 6 条。每次变异后还原到逐字节相同（blob `3a353748…`）。

## 许可证

本项目基于 [MIT 协议](LICENSE) 发布。
