# dsh-wsl-desktop

> ## ⚠️ 开发中快照，未完成，暂勿用于生产
>
> 发布时代码里有以下已知状态，细节与每项的证据强度见下方「目标能力」表与「fs 工具的围栏」一节：
>
> - **① 路由的未认证命令执行洞已关闭**：`connection.requestRejection` 围栏 + 强制 `application/json` + 64KiB 体积上限 + 命令类方法移出浏览器命名空间。有活体 18/18 验证，其中包含"未认证请求携带的命令没有执行"的副作用断言。
> - **④ WSL 会话的 fs 工具没有围栏（未解决）**：`lib/wsl/fs.js` 不覆写 `sandboxMode`，于是 `tool-fs` 对每次调用都解析不出策略，`write`/`edit` 可以写到 9P 共享可达的任何地方，**包括 `/mnt/c`（整个 Windows 文件系统）**。同一文件里 shell 侧的约束已修并验证。
> - **② / ③ 的绑定与清扫**：代码已改，宿主侧效果待观察；绑定接缝的活体验证曾被 fs 的挂载问题挡住，**尚未完成**。
> - 离线 9 个校验套件当前全绿；`verify-post-restart.mjs` 说明了活体侧还缺什么。

DSH Desktop 的 WSL 执行世界插件：在 GUI 里添加 WSL 发行版中的 Linux 工作区，并让该工作区内的工具真正在发行版里执行。

## 目标能力

**2026-09-19 三方代码审查后的诚实状态**（审查报告见 `docs/` 之外的会话记录；下面每条都注明证据强度）：

| # | 能力 | 状态 |
|---|---|---|
| ① | 工作区可选择 WSL 发行版里的 Linux 目录 | 对话框与宿主调用已实现；**浏览器内交互仍未被自动化覆盖**（2 项 PENDING） |
| ② | 该工作区内的 shell / 文件工具 / subprocess / 终端 在 WSL 里工作，且可从 WSL 调用宿主机命令 | **仅 selftest 路径被证明**。GUI 创建的会话绑定失败（见下），因此真实 GUI 会话目前跑在 Windows 世界 |
| ③ | 同一实例里 Windows 与 WSL 工作区并存 | 设计成立（按会话 preset realm），但**自动绑定这条路是坏的**，见「会话绑定」 |
| ④ | WSL 侧的 Linux 沙箱约束 | **shell 侧已修并验证**：运行时枚举所有 `rw` 挂载逐个改只读（实测 `/mnt/c`、`/dev/shm`、`/run/user/<uid>` 从 WRITABLE 变 READONLY）、失败即拒（保留退出码 97）、`enforcement` 如实报 `partial`。**fs 侧已加围栏，活体待验**（见下）|

## 会话绑定：必须发生在创建时

harness 在会话**创建**时就把 preset 定下来（`SessionCreateRequest.agentPreset` → `composeAgent` 的 `setup: presets.mount(...)`，挂载发生在会话发布之前）。事后用 `agentPresets.select` 只能作用于"还没有跑过任何 turn"的会话，一旦有过 turn 就被 `agent-preset/locked` 拒绝，而且拒绝只写进内存日志、不报给用户。实测 `bindingLog`：唯一一个真实 GUI WSL 会话（`\\wsl.localhost\<发行版>\home\<用户>\<项目>`）被记录了两次 `ok:false "has already started; its agent preset is fixed"` —— 也就是说它一直在 Windows 世界里跑。

**当前实现（事后绑定）是错的**，正确做法是让创建请求带上 `agentPreset`（浏览器半边自己创建会话时传，宿主提供 `wslPresetFor` 解析变体 id）。修好之前，`verify-post-restart.mjs` 的绑定检查会**如实报 FAIL**，而不是拿本脚本自己创建的 selftest 会话冒充绿灯。

## 界面入口

侧栏工作区标题栏里，自带的"+"（添加工作区）右边多一个 **W** 按钮；点开是本插件的工作区对话框：选发行版 → 浏览或输入 Linux 目录 → 创建并打开会话。

"+" 保持部署自带的行为（Desktop 上是 Electron 目录选择器），本插件不改写它：

- `sidebar.workspaces.directoryFlow` 是 `kind: 'single'`，占位会**遮蔽**部署自己的目录选择器，所以本插件不注册这个槽位；
- 侧栏标题栏没有扩展点，所以 W 按钮以伴随节点挂在"+"按钮之后：用 `IconProjectAddOutline16` 的 path 数据定位（与语言无关，全应用只有这一处渲染它），并复用该按钮的 class 以取得同样的尺寸与悬停态。React 替换该子树时，MutationObserver 会把 W 重新挂回。
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

桥用 `pty.fork()` 分配 PTY，把 master 与管道对泵，并把 `resize`/`foreground`/`activity`/`signal`/`terminate` 实现为 FIFO 上的 JSON 行协议。**发行版内零安装**（只用 python3 标准库）。

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

**预设绑定在 Host 侧自动完成。** 会话创建时 `agent/created`（serial 事件）里按 `session.header.cwd` 是否为 UNC 路径（`\\wsl.localhost\<distro>\…`）决定是否切到 `wsl-<原预设>`。浏览器半边因此不依赖任何 preset 客户端 API。

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
node scripts/verify-world.mjs        # 路径互译 + 在发行版里执行命令 + 目录事实
node scripts/verify-preset.mjs       # 预设重写（对着随附 standard 预设跑）
node scripts/verify-9p.mjs           # 9P 共享原语画像
node scripts/verify-confinement.mjs  # 约束围栏：工作区可写、外部被拒、属主正确
node scripts/verify-terminal.mjs     # PTY 桥：resize / 前台进程组 / 信号 / 终止
node scripts/verify-pty-handle.mjs   # JS 终端句柄（对着真实桥跑）
node scripts/verify-client-ui.mjs    # 浏览器半边的静态检查（不注册槽位、定位几何、宿主调用）
node scripts/verify-client-dom.mjs   # 浏览器半边的行为检查：在 jsdom 里跑真实 factory（挂载位置 / 放不下时的收敛 / 隐藏跟随）
node scripts/inspect-live-client.mjs # 读宿主真正投放的 client bundle（可带若干标记串）
.\scripts\sync.ps1                   # stage 进 profile（随后由 plugin_manager 安装）
```

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。

**已知不稳定**：`verify-terminal.mjs` 偶发失败（实测 6 次里 1 次，两项失败），紧接着上一次运行之后更容易出现，与 PTY 桥的清理问题（见审查发现的 I11–I13）一致；连续重跑会恢复。修桥的清理之前，不要把它当成稳定信号。

宿主代码改动需要**重启 DSH Desktop** 才会加载；重启后先跑 `verify-post-restart.mjs`，它会在旧模块仍生效时直接报「请重启」而不是给假绿。**浏览器半边改动不需要重启**：就地改写当前那一代的 `lib/client.js` 会改变投放 rev 并由 `/plugins/events` 推给已打开的页面（`patchReload: live`）。`verify-post-restart.mjs` 会从 `/plugins/events` 读实时模块图并取回真正投放的那份 bundle 来断言这一点。

`sync.ps1` 每次 stage 到新的时间戳目录（Node 按 URL 缓存模块，同目录重装仍服务旧代码），但**保留当前 profile 链接着的那一代**：运行中的宿主生成的预设里写的是它自己目录内的绝对模块路径，把那个目录删掉会让所有 WSL 会话在下一次重启前失效。

## fs 工具的围栏：两次失败之后的结论

`WslFileSystem` 自带围栏（`sandboxMode` + `checkedTarget` + `isUnder`），**不是**继承官方的沙箱后端。

**为什么不能继承**：`SandboxedFileSystem` 注入 `sandboxPolicy`，而本后端挂在 preset realm 内部，多一个 realm 里拿不到的服务就多一种整行不激活的失败。

**为什么必须有围栏**：`LocalFileSystem` 从不覆写 `FileSystem.sandboxMode`。一个什么都不宣称的后端会让 `tool-fs` 的 `FsSandboxController` 对每次调用都解析不出策略（`tool-fs/src/sandbox.ts:43-50`：`defaultMode === undefined` ⇒ `escalationModes = []`、`policy = undefined`），于是 `write`/`edit` 完全不受管，能写到共享可达的任何地方，包括 `/mnt/c`。

**两次失败尝试的教训**（记在这里以免再犯）：

1. 继承官方后端 → 整行不激活。当时我归因成"realm 看不到 `sandboxPolicy`"，**但真正原因是我把 `LocalFileSystem` 的 import 删掉了**（`node --check` 只解析语法，看不见未定义标识符）。症状吻合不等于归因正确。
2. 自带围栏的第一版在"拿不到 workspace root"时**一律拒绝**，把插件自己写 `/tmp` 也拒了。查清机制后才知道：官方后端的兜底同样是 `sandboxPolicy.resolve()`（不带参数），**它本身也给不出 workspace root**——root 永远是 `tool-fs` 每次调用时传进来的（`resolvePolicy` 用调用会话的 cwd 盖章）。

**因此 selftest 也改了**：它现在像真实调用方一样显式传策略 `{ mode: 'workspace-write', workspaceRoot: <会话 cwd> }`。之前它不传，是"用一个真实调用方永远不会用的方式调 fs"，那才是上次被拒的原因——不是围栏太严。

`scripts/verify-modules.mjs` 会把这三行钉住（声明 `sandboxMode`、两个变更入口都过 `checkedTarget`、包含性比较有分隔符边界），避免以后有人（包括我）再把围栏悄悄删掉。