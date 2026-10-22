# 工程笔记与实测约束 — dsh-wsl-desktop

本文收集 README 之外的工程记录：都是实测得出的约束、致命交付事故、以及同步脚本的保留规则。README 重写成面向使用者的入口文档之后，原本只写在 README 里的维护者材料（安装形态、仓库布局、桌面更新纪律、发版流程、能力证据表）也搬到了这里。它们是维护者读的东西，不是使用者读的。

## 关键约束（都是实测得出，不是推断）

1. **工作区路径必须是 UNC 拼写。** `packages/workspace/workspace/src/paths.ts:16-23` 在 win32 上把 POSIX 路径 `/home/...` 判为非法（root === '/'），只有 `C:\…` 与 `\\server\share` 能过。
2. **插件必须落在 profile 目录内。** profile 的模块解析器只给 profile 前缀内的模块把 `@deepseek-ai/*` 路由到安装代；`link:` 到 profile 外时 7 个 harness 包全部 `Cannot find package`。
3. **宿主插件代码无法热重载。** Node 按 URL 缓存模块，重新安装同一目录仍服务旧代码；因此核心逻辑写成不依赖 harness 的纯模块，用独立 Node 脚本校验。
4. **9P 共享没有硬链接。** `link()` 报 `ENOTSUP`；`ReplaceFileW` / `SetFileSecurityW` 是本地卷 Win32 API，在网络共享上无意义 —— 三者都由 `WslFileSystem` 覆盖。
5. **`appendWindowsPath = false` 是常见默认值。** 宿主机程序不在 PATH 上，必须用 `/mnt/c/Windows/System32/*.exe` 绝对路径（`hostExecutable()`）。
6. **客户端插件 apply 时 `<body>` 可能还不存在。** client 半边在文档解析期间就 apply，`document.body` 会是 `null`；这时 `MutationObserver.observe(document.body, …)` 直接抛错，整个 apply 失败，界面静默无反应（W 按钮第一版就踩在这里）。观察根必须用 `document.documentElement`，并额外用定时器兜底 —— 只靠 observer 等于假设"每次都要有 childList 变更"，这个假设不成立。
7. **client 半边改动能热更新，宿主半边不能。** 就地改写 profile 里当前那一代的 `lib/client.js` 会改变投放 rev 并通过 `/plugins/events` 推给页面，**不需要重启**；`lib/index.js` 改了必须重启。`scripts/inspect-live-client.mjs` 读宿主真正投放的那份 bundle（内存缓存，磁盘文件不是证据）。

## 交付事故：`exports["./client"]` 被整个删掉

> ⚠️ **`exports["./client"]` 是硬性契约，改元数据时最容易误删。** 宿主的 client-modules 是**必装**插件：只要有一个包声明了 `dsh.client` 却没有 `exports["./client"]`，它就直接拒绝组合，整张桌面**启动失败**（不是本插件单独失效）：
> ```
> DesktopHostFatalError: dsh: startup failed: 1 required plugin did not activate
>   client-modules: dsh-wsl-desktop declares dsh.client but exports no "./client" bundle
> ```
> v0.2.0 的「release readiness」元数据改造（`38e6356`）删掉了整个 `exports` 块，0.2.0 与 0.2.1 因此**装上去就起不来**；`main` 顶不了这个位置——Node 解析 `./client` 子路径时不看它。`scripts/verify-modules.mjs` 现在钉住这条（`./client` 与 `.` 都在、client 入口不是 host 入口、文件真实存在、platform 为 web），发版前跑它即可拦住。**`cordis.patch.yml` 与 `lib/` 之外，`package.json` 也是投放面的一部分**：`verify-post-restart.mjs` 会把运行中的 manifest 与 checkout 逐字节比对。

## 一次已修的偶发失败：verify-terminal

**已知不稳定 → 已修，多轮验证稳定**：`verify-terminal.mjs` 曾偶发失败（实测 6 次里 1 次）。根因在宿主侧 `lib/wsl/pty.js`，不是桥：分配失败路径不终止已 spawn 的数据进程，泄漏的桥会干扰后续运行；且控制应答不携带请求 id，一次超时之后迟到的应答会被下一条请求消费，整个控制通道从此错位。修复：失败路径终止并等待两个进程退出；每个请求带 id、桥回显同一 id，超时先摘除条目、迟到应答直接丢弃。修复后历经今日十余轮全量套件（含多次背靠背）无一复现，结论稳定。

## 改动何时生效：重启、热更新与投放 rev

宿主代码改动需要**重启 DSH Desktop** 才会加载；重启后先跑 `verify-post-restart.mjs`，它会在旧模块仍生效时直接报「请重启」而不是给假绿。**浏览器半边改动不需要重启**：就地改写当前那一代的 `lib/client.js` 会改变投放 rev 并由 `/plugins/events` 推给已打开的页面（`patchReload: live`）。`verify-post-restart.mjs` 会从 `/plugins/events` 读实时模块图并取回真正投放的那份 bundle 来断言这一点。 **注意 rev 不是即时更新的**：宿主惰性重建客户端 bundle，就地改写后立刻回读 `/plugins/events` 仍会拿到旧 rev（实测数秒后才变）。"文件已改"因此不等于"投放已变"，验证要读到新 rev 为止，否则会得出错误的"已部署"结论。

## sync.ps1 的代次保留规则

`sync.ps1` 每次 stage 到新的时间戳目录（Node 按 URL 缓存模块，同目录重装仍服务旧代码；时间戳只到秒，同一秒内的第二次运行会顺延到不冲突的名字，否则 loader 会静默忽略它已经挂载过的 row id），并**把 profile 链接重指向刚 stage 的这一代**，同时改写 profile 的 `package.json` 与 `pnpm-lock.yaml`——否则下一次 `pnpm install` 会按 manifest 把链接 reconcile 回旧代，"已经 stage 了"就成了假象。**保留规则是"保留最新的两代"**：链接一旦移动，"链接着的那一代"正是没人在跑的那一代，而运行中的宿主解析的是它前一代；只保留链接会在下一次 stage 时删掉正在使用的那一代，让所有 WSL 会话在下一次重启前失效。链接**无法定位那一代**时（profile 根本没有链接，或链接指向的目录已消失）`sync.ps1` **保留全部代次并告警**；profile **从未 stage 过**（连 `plugins/` 都没有）同样告警并点明那个链接路径——这时它只是把文件放好，**真正生效要等 profile 装过这个插件（首次安装由 plugin_manager 接线）**。删链接走 .NET 而不是 `Remove-Item`：Windows PowerShell 5.1 对 junction 抛 NullReferenceException，会让重指向中途失败而旧代仍被链接。以上全部由 `scripts/verify-sync.mjs` 在一次性 profile 上跑真脚本验证（四个场景：链接可用 / 悬空 / 无链接 / 从未 stage 过，最后一个钉住"告警必须写出链接路径"）。

## 安装形态（发布包长什么样）

插件以 npm 包发布，形态对齐 dsh-better-sidebar 这类成熟插件：`package.json` 的 `files` 给**精确清单**（`lib`、`cordis.patch.yml`、两版 README、LICENSE），`cordis.patch.yml` 是 bundle patch，`dsh.client.inject` 声明客户端要注入的宿主服务，`manifestVersion` 标出元数据版本。桌面侧的插件市场 / 插件管理器安装 `dsh-wsl-desktop@<version>` 时会自动完成 pnpm 接线与 bundle patch 挂载，命令行等价是 `plugin_manager install_bundle dsh-wsl-desktop@<version>`。

`dsh-wsl-confine` helper 的脚本 `lib/wsl/dsh-wsl-confine.sh` 随包分发（在 `files` 的 `lib` 里），安装方法与版本精确匹配的要求见 [Linux 侧约束](CONFINEMENT.md)。

本插件注册的 `wsl-*` 预设由**插件自己的 disposer 生命周期**持有，所以用插件管理器卸载时它们会一起撤回，不会留下指向不存在插件的工作区（这条以前只写在 README 的卸载那一行）。

这些预设是**运行时注册的，不是从目录加载的**——这正是 0.1.7 这个版本下限的真实原因：更旧的宿主没有运行时注册，会在激活时明确拒绝。`SECURITY.md` 把同一条事实记作部署前提。

## 开发 profile 与发布 profile

同一个 profile 可以装两种形态，它们只差 `cordis.patch.yml` 里有没有 `config.developerTools`：

- **发布形态**：`plugin_manager install_bundle dsh-wsl-desktop@<version>` 从 registry 安装。包内 patch 不带 `config`，`developerTools` 因此是 `false`，dev-token 调用一律 401。这是给用户用的形态。
- **开发形态**：`.\scripts\sync.ps1` 把 checkout stage 成带时间戳的代次，并在 patch 里写 `config: developerTools: true`，再把 profile 链接指过去。`verify-route`、`verify-post-restart`、`verify-live-env` 需要这一形态。

切换：发布 → 开发用 `sync.ps1`；开发 → 发布用 `plugin_manager remove_bundle dsh-wsl-desktop` 再 `install_bundle dsh-wsl-desktop@<version>`。两种切换都要**重启 DSH Desktop** 才换得掉宿主半边；客户端半边刷新页面即可。`verify-all --live` 现在先跑 `verify-live-env.mjs`：401 时它会直接打印上面的切换步骤，而不是让三个 live 套件各自报 401。

## 仓库布局

```
lib/index.js            Host：路由、预设生成、会话预设绑定
lib/client.js           浏览器：侧栏"+"旁的 W 按钮 + 添加 WSL 工作区对话框
lib/wsl/paths.js        UNC ↔ Linux ↔ 盘符 互译（纯函数）
lib/wsl/world.js        发行版发现、wsl.exe 执行核、目录事实
lib/wsl/shell.js        ShellExecutor 实现（WSL bash + 约束接入）
lib/wsl/fs.js           LocalFileSystem 子类（9P 后端 + 路径方言）
lib/wsl/publish.js      覆盖发布的等待边界（重试 + 实测尾部；纯模块，可独立测试）
lib/wsl/watch.js        文件变更监听的轮询策略（纯模块，可独立测试）
lib/wsl/subprocess.js   SubprocessRuntime 实现（管道 + 终端；委托宿主 subprocess）
lib/wsl/pty.js          终端句柄：两个进程驱动发行版内的 PTY 桥
lib/wsl/terminal-bridge.py  发行版内运行的 PTY 桥（python3 标准库，零安装）
lib/wsl/host-refs.js    宿主 subprocess provider 的跨模块引用（realm 隔离后必需）
lib/wsl/confinement.js  mount namespace 约束（纯函数 + 探测，可独立测试）
lib/wsl/fence.js        fs 围栏的包含性比较与可写根推导（纯函数，可独立测试）
lib/wsl/preset.js       预设重写（纯文本，可独立测试）
scripts/sync.ps1        把插件 stage 进 profile（随后由 plugin_manager 安装）
scripts/env.mjs         校验用的发行版/用户/home 解析（不硬编码机器身份）
scripts/verify-*.mjs    独立校验（不需要 harness）
scripts/verify-all.mjs  聚合运行全部套件（--live 追加需要运行中宿主的套件）
```

## 桌面更新纪律（强制）

每次 DSH Desktop 更新后，插件都可能因 harness 内部 API 变化而失效（0.1.6 → 0.1.7 一次断裂四处）。纪律是：**更新桌面 → 跑 `node scripts/verify-post-restart.mjs` → 全绿才继续使用；任何一次红都先修再干。** 该套件覆盖预设注册、执行世界、会话绑定、Windows 隔离与对话框契约，新宿主的破坏会在这些断言上现形，而不是静默降级成宿主世界。逐套件职责见 [校验](VERIFICATION.md)。

## 开发回路

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # 离线全量
.\scripts\sync.ps1                 # stage 进 profile 并重指向（开发者模式：developerTools 开启；首次安装需先接线）
# 重启 DSH Desktop → verify-post-restart.mjs
```

宿主代码改动需要重启 DSH Desktop 才会加载，重启后先跑 `verify-post-restart.mjs`；浏览器半边改动不需要重启，但「文件已改」不等于「投放已变」，见下面「改动何时生效」。

## 发版流程

语义化版本在这个仓库里有具体含义：`patch` = 缺陷修复；`minor` = 兼容的桌面大版本适配（每次 harness 断裂适配后升 minor，如 0.1.x 里的 0.1.7 适配）；`major` = 边界语义或支持矩阵变化。**所以桌面大版本变了，先看有没有对应的 minor。** 流程：改 `package.json` 的 version → 全量套件 + `verify-post-restart.mjs` 全绿 → `npm publish --access public` → 打 git tag。

## 能力与证据强度

活体验收的诚实状态（`verify-post-restart.mjs` 最近一次实跑：**58 PASS / 0 FAIL**、尾部 `NO AUTOMATED FAILURES; 3 manual step(s) pending`、`EXIT=0`，含搜索的两条活体行与常驻 shell 的那几条；**剩 3 条浏览器专属的人工项**，清单在 [常驻 shell](PERSISTENT-SHELL.md#人工核验清单浏览器专属不可自动化)；另加离线 20 套件）：

| # | 能力 | 状态 |
|---|---|---|
| ① | 工作区可选择 WSL 发行版里的 Linux 目录 | 对话框与宿主调用已实现并活体通过（listDir/checkPath/resolveHome/工作区注册与清理）；**浏览器内交互已由操作者人工确认**（门控流、目录浏览、终端面板均正常） |
| ② | 该工作区内的 shell / 文件工具 / subprocess / 终端在 WSL 里工作，且可从 WSL 调用宿主机命令 | **活体验收 PASS**：绑定（创建请求命名 preset）、shell 进发行版、fs 工具 Linux 寻址、越界写拒绝、subprocess POSIX 环境、bash 工具、工具层约束；终端传输由 PTY 套件覆盖。**模型侧的 `bash` 是发行版内的常驻 PTY shell，cwd 与环境变量跨调用保留**（活体验证：两次调用读数一致；缺口清单见 [常驻 shell](PERSISTENT-SHELL.md)） |
| ③ | 同一实例里 Windows 与 WSL 工作区并存 | **活体验收 PASS**：Windows 工作区停留在宿主 preset（PowerShell 可用、无 bash），WSL 会话并行运行 confined realm |
| ④ | WSL 侧的 Linux 沙箱约束 | **shell 侧已修并活体验证**：运行时枚举所有 `rw` 挂载逐个改只读（实测 `/mnt/c`、`/dev/shm`、`/run/user/<uid>` 从 WRITABLE 变 READONLY）、失败即拒（保留退出码 97）、`enforcement` 如实报 `partial`。**fs 侧围栏已实现并活体验证**（越界写拒绝 PASS，见 [fs 工具的围栏](FS-FENCE.md)） |

**哪些能力有保留**：证据强度就是上表状态列的措辞。终端不支持 `stdio.control`——写在 [终端（PTY 桥）](PTY-BRIDGE.md) 与 README 的「会意外的地方」里，不藏。常驻 shell 的缺口同样写在 README 里，权威清单在 [常驻 shell](PERSISTENT-SHELL.md)。
