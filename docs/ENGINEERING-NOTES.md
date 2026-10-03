# 工程笔记与实测约束 — dsh-wsl-desktop

本文收集 README 之外的工程记录：都是实测得出的约束、致命交付事故、以及同步脚本的保留规则。它们是维护者读的东西，不是使用者读的。

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
