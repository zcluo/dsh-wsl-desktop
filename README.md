# dsh-wsl-desktop

> ⚠️ **开发快照，暂勿用于生产。** 需要 **DSH Desktop 0.1.7+**（预设通过运行时注册而非目录加载，旧版宿主不支持）。核心能力已活体验收（`verify-post-restart.mjs` 全绿 + 离线 10 套件 + 操作者确认）；安全审计 run-1 完成——**5 条候选全部闭环**（2 条被探针关闭、2 条修复经动态确认关闭、1 条确认为预期行为），报告见 `security-audit-skill/dsh-wsl-desktop/run-1/`。逐项证据强度见下方能力表。

DSH Desktop 的 WSL 执行世界插件：在 GUI 里添加 WSL 发行版中的 Linux 工作区，并让该工作区内的工具真正在发行版里执行。

## 目标能力

**活体验收通过后的诚实状态**（`verify-post-restart.mjs` 全绿 + 离线 10 套件；下面每条都注明证据强度）：

| # | 能力 | 状态 |
|---|---|---|
| ① | 工作区可选择 WSL 发行版里的 Linux 目录 | 对话框与宿主调用已实现并活体通过（listDir/checkPath/resolveHome/工作区注册与清理）；**浏览器内交互已由操作者人工确认**（门控流、目录浏览、终端面板均正常） |
| ② | 该工作区内的 shell / 文件工具 / subprocess / 终端 在 WSL 里工作，且可从 WSL 调用宿主机命令 | **活体验收 PASS**：绑定（创建请求命名 preset）、shell 进发行版、fs 工具 Linux 寻址、越界写拒绝、subprocess POSIX 环境、bash 工具、工具层约束；终端传输由 PTY 套件覆盖 |
| ③ | 同一实例里 Windows 与 WSL 工作区并存 | **活体验收 PASS**：Windows 工作区停留在宿主 preset（PowerShell 可用、无 bash），WSL 会话并行运行 confined realm |
| ④ | WSL 侧的 Linux 沙箱约束 | **shell 侧已修并活体验证**：运行时枚举所有 `rw` 挂载逐个改只读（实测 `/mnt/c`、`/dev/shm`、`/run/user/<uid>` 从 WRITABLE 变 READONLY）、失败即拒（保留退出码 97）、`enforcement` 如实报 `partial`。**fs 侧围栏已实现并活体验证**（越界写拒绝 PASS，见「fs 工具的围栏」）|

## 会话绑定：在创建请求里命名执行世界

harness 在会话**创建**时就把 preset 定下来（`SessionCreateRequest.agentPreset` → `composeAgent` 的 `setup: presets.mount(...)`，挂载发生在会话发布之前）。事后用 `agentPresets.select` 只能作用于"还没有跑过任何 turn"的会话，一旦有过 turn 就被 `agent-preset/locked` 拒绝，而且拒绝只写进内存日志、不报给用户。

**当前实现就是围绕这个事实做的**：

- 浏览器半边在 W 对话框里创建会话时，先调宿主的 `wslPresetFor` 解析变体 id，然后把 `agentPreset` 放进**创建请求**（`lib/client.js` 的 `commit()`）。这是唯一无竞态的接缝：preset 随会话一起组合，不存在"先跑在 Windows 世界再切"的窗口。
- 宿主半边保留一个 `api-session/added` 监听（`lib/index.js` 的 `bindWslSession`）作为**兜底**：只处理"cwd 是 WSL 路径、但创建时没带 preset"的会话（比如从别的入口创建的）。它尝试事后 `select`，成功就补绑，失败就写 `bindingLog` 并在宿主日志里告警——这类条目现在是**异常信号**，不再是正常路径的一部分。
- 因此 `verify-post-restart.mjs` 的 binding 段语义是：非 selftest 的 `bindingLog` 条目 = 有人绕过创建接缝建了 WSL 会话；零条目 = 一切经创建请求绑定的会话都正常。GUI 侧的最终确认已由操作者完成（会话预设显示 WSL · PTC 模式，工具在发行版内执行）。

## 界面入口

侧栏工作区标题栏里，自带的"+"（添加工作区）右边多一个 **W** 按钮；点开是本插件的工作区对话框：选发行版 → 输入用户 → 浏览或输入 Linux 目录 → 创建并打开会话。

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
- **rc 里向终端发查询的程序会挂住整个会话。** 这台机器的 `~/.bashrc` 末尾是 `oh-my-posh init` + `clear` + `fastfetch`；其中 `fastfetch` 会向终端发查询并等应答，而无头校验里没有终端模拟器应答，于是永远不出提示符。真实 Web 终端里 xterm.js 会应答，所以这是校验环境的问题而不是桥的缺陷 —— 但据此把校验用的 shell 固定为 `bash --noprofile --norc -i`，让校验测的是桥而不是用户的 rc。

PTC 的 `stdio.control`（fd 通道）仍然明确拒绝：`wsl.exe` 无法转发任意描述符。

## 已知限制：grep / glob 工具

`tool-fs-search` 虽然通过 `ctx.subprocess.spawn()` 启动（`search-core.ts:238`），但它的 argv[0] 是 `@vscode/ripgrep` 提供的**打包 Windows rg.exe**（`search-core.ts:174-178`），在发行版里既不存在、也无法用 Linux 参数工作。所以 WSL 预设会把它从执行世界里移除，WSL 会话的模型只能用 bash 的 `grep` / `find`（两者在发行版里都在）。这算是一个能力回退，不是遗漏——要做成对等的，需要给 WSL 世界提供自己的搜索实现。

**预设里不需要终端 registry 行。** 侧栏终端面板走的是 `agent.ctx.get('subprocess').spawnTerminal(...)`（`packages/api/terminal-controller/src/index.ts:333,346`）—— 会话作用域，所以 realm 里的 `subprocess-wsl` 自动把 PTY 放进了发行版。隔离 `terminals` 只会服务模型的持久 shell 工具，而这个预设并不挂它；多挂一组 registry + backend 只增加挂载失败的面，所以不加。

## 架构

**执行世界由会话的 agent preset 决定。** `ctx.shell` / `ctx.fs` / `ctx.subprocess` 都是进程级单实例，而 Windows 与 WSL 的工具方言不同（pwsh vs bash），因此并存不是靠"按路径路由的全局 provider"，而是靠 preset 的 `isolate` realm：

```
Windows 工作区会话                      WSL 工作区会话
  preset: standard                        preset: wsl-standard
  ctx.shell = pwsh-sandbox（宿主）          isolate: { shell, fs }
  ctx.fs    = fs-sandbox（宿主）            ├─ shell-wsl  → ctx.shell
                                            ├─ fs-wsl     → ctx.fs
                                            ├─ tool-bash / tool-fs
                                            └─ ctx.subprocess 继承宿主的 subprocess-local
```

`wsl.exe` 本身是普通 Windows 进程，所以 WSL 执行器通过**继承来的** `ctx.subprocess` 启动它 —— realm 只隔离 `shell` 和 `fs`，托管进程的终止、输出溢出与回收仍归本地 provider。

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
node scripts/verify-confinement.mjs  # 约束围栏：工作区可写、外部被拒、属主正确、含空格路径
node scripts/verify-terminal.mjs     # PTY 桥：resize / 前台进程组 / 信号 / 终止
node scripts/verify-pty-handle.mjs   # JS 终端句柄（对着真实桥跑）
node scripts/verify-client-ui.mjs    # 浏览器半边的静态检查（不注册槽位、定位几何、宿主调用）
node scripts/verify-client-dom.mjs   # 浏览器半边的行为检查：在 jsdom 里跑真实 factory（挂载位置 / 放不下时的收敛 / 隐藏跟随）
node scripts/inspect-live-client.mjs # 读宿主真正投放的 client bundle（可带若干标记串）
.\scripts\sync.ps1                   # stage 进 profile（随后由 plugin_manager 安装）
```

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。

**已知不稳定 → 已修，多轮验证稳定**：`verify-terminal.mjs` 曾偶发失败（实测 6 次里 1 次）。根因在宿主侧 `lib/wsl/pty.js`，不是桥：分配失败路径不终止已 spawn 的数据进程，泄漏的桥会干扰后续运行；且控制应答不携带请求 id，一次超时之后迟到的应答会被下一条请求消费，整个控制通道从此错位。修复：失败路径终止并等待两个进程退出；每个请求带 id、桥回显同一 id，超时先摘除条目、迟到应答直接丢弃。修复后历经今日十余轮全量套件（含多次背靠背）无一复现，结论稳定。

宿主代码改动需要**重启 DSH Desktop** 才会加载；重启后先跑 `verify-post-restart.mjs`，它会在旧模块仍生效时直接报「请重启」而不是给假绿。**浏览器半边改动不需要重启**：就地改写当前那一代的 `lib/client.js` 会改变投放 rev 并由 `/plugins/events` 推给已打开的页面（`patchReload: live`）。`verify-post-restart.mjs` 会从 `/plugins/events` 读实时模块图并取回真正投放的那份 bundle 来断言这一点。

`sync.ps1` 每次 stage 到新的时间戳目录（Node 按 URL 缓存模块，同目录重装仍服务旧代码），但**保留当前 profile 链接着的那一代**：运行中的宿主生成的预设里写的是它自己目录内的绝对模块路径，把那个目录删掉会让所有 WSL 会话在下一次重启前失效。

## fs 工具的围栏

`WslFileSystem` 自带围栏：声明 `sandboxMode`，`writeText`/`editText` 两个变更入口都先过 `checkedTarget`（拒绝抛结构化 `FS_SANDBOX_DENIED`，工具层把它映射成模型可见的 `[sandbox: …]` 标记与升级提示）；包含性比较与可写根推导是纯函数，放在 `lib/wsl/fence.js`。**不是**继承官方的沙箱后端——官方后端会把本行包进第二个后端，凭空多出一层组合依赖，而围栏本来就是"可信代码里的策略检查"，放在本行即可。（最初"realm 看不到 `sandboxPolicy` 所以不能继承"的归因是错的，见下面教训 1：同 realm 的 `shell.js` 一直注入着这个服务。）

**可写根与比较命名空间**：`workspace-write` 的允许集 = 会话 cwd（工作区根）+ **发行版的** `/tmp`（9P 分享上的 `\\wsl.localhost\<distro>\tmp`，这是 Linux 侧 `/tmp/…` 请求在本世界解析到的位置；官方推导里的宿主 POSIX `/tmp` 在 Windows 上无意义）+ Windows 临时目录（经 `/mnt/<盘符>` 可达）。比较在**宿主命名空间**做：targetKey 是 Windows 拼写，UNC 前缀自带发行版身份，所以"另一个发行版里恰好同拼写的 Linux 路径"出不了界；未知模式给空允许集，即拒绝（fail-closed）。`checkedTarget` 的重规范化也从 **targetKey** 出发而不是 displayPath——displayPath 是 Linux 拼写、不带发行版，从它重解析会把路径钉到本行固定的发行版上，跨发行版 UNC 请求被静默改写（活体踩过：写进 debian-dev、读 debian 报 not found）；现在跨发行版请求直接 `FS_SANDBOX_DENIED`。

**为什么必须有围栏**：`LocalFileSystem` 从不覆写 `FileSystem.sandboxMode`。一个什么都不宣称的后端会让 `tool-fs` 的 `FsSandboxController` 对每次调用都解析不出策略（`tool-fs/src/sandbox.ts:43-50`：`defaultMode === undefined` ⇒ `escalationModes = []`、`policy = undefined`），于是 `write`/`edit` 完全不受管，能写到共享可达的任何地方，包括 `/mnt/c`——`toHostPath` 也接受直接的 `C:\…` 拼写，所以未围栏时的实际暴露面是整个 Windows 文件系统，不只是分享。

**两次失败尝试的教训**（记在这里以免再犯）：

1. 继承官方后端 → 整行不激活。当时我归因成"realm 看不到 `sandboxPolicy`"，**但真正原因是我把 `LocalFileSystem` 的 import 删掉了**（`node --check` 只解析语法，看不见未定义标识符）。症状吻合不等于归因正确。
2. 自带围栏的第一版在"拿不到 workspace root"时**一律拒绝**，把插件自己写 `/tmp` 也拒了。查清机制后才知道：官方后端的兜底同样是 `sandboxPolicy.resolve()`（不带参数），**它本身也给不出 workspace root**——root 永远是 `tool-fs` 每次调用时传进来的（`resolvePolicy` 用调用会话的 cwd 盖章）。

**因此 selftest 也改了**：它现在像真实调用方一样显式传策略 `{ mode: 'workspace-write', workspaceRoot: <会话 cwd> }`。之前它不传，是"用一个真实调用方永远不会用的方式调 fs"，那才是上次被拒的原因——不是围栏太严。

**两层钉子 + 活体验收**：`scripts/verify-modules.mjs` 钉住围栏的存在（声明 `sandboxMode`、两个变更入口都过 `checkedTarget`、拒绝用 `FS_SANDBOX_DENIED`、包含性比较有分隔符边界）；`scripts/verify-fs-fence.mjs` 离线验证纯逻辑（分隔符边界、大小写、**跨发行版同拼写路径被拒**、可写根推导、未知模式 fail-closed）；`verify-9p.mjs` 增补了身份映射探针（不同文件 (dev,ino) 互异、wsl.localhost/wsl$ 拼写稳定——围栏的身份回退以此为负载假设）。类的接线已由 `verify-post-restart.mjs` 活体验收（越界写拒绝 PASS）。