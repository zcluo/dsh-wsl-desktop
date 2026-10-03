# dsh-wsl-desktop

简体中文 | [English](README.en.md)

把 WSL 发行版变成 DSH Desktop 里的**一等执行世界**：工作区可以落在发行版内，shell、文件工具、subprocess 与终端随之全部在发行版里运行——而同一实例里的 Windows 工作区仍走宿主自己的沙箱后端，两者并存。

> **生产状态：受控单机生产可用**（见下方边界定义）。需要 **DSH Desktop 0.1.7+**（预设通过运行时注册而非目录加载，旧版宿主会在激活时明确拒绝）。核心能力已活体验收；安全审计 run-1（5 候选闭环）与 run-2（4 confirmed 已修复 + 1 rejected 转加固）均完成，报告见 `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`。逐项证据强度见下方能力表。
>
> **边界定义**：
> - ✅ **适合**：插件作者本人或同信任级别操作者，在明确支持的发行版（见 [发行版支持矩阵](docs/DISTRO-SUPPORT.md)）与 0.1.7+ 桌面上长期使用。
> - ⚠️ **条件**：confined 模式的信任边界依赖 NO_NEW_PRIVS（debian 系现代 setpriv 满足；setpriv 不认 `--no-new-privs` 时 confined 模式**根本不运行**——direct runner 在测到 `false` 时拒绝，helper 的降权用同一个标志、同样失败关闭，见 [安全与信任边界](SECURITY.md)）。
> - ❌ **尚不适合**：分发给第三方用户（缺桌面版本门控与发行版矩阵）、无人值守高价值环境（subprocess 面不设防为已披露设计；对 harness 上游的两项 API 提案见 [docs/UPSTREAM-PROPOSALS.md](docs/UPSTREAM-PROPOSALS.md)）。

## 目录

- **本页**：[目标能力](#目标能力) · [安装 / 更新 / 卸载](#安装--更新--卸载) · [快速开始](#快速开始) · [桌面更新纪律](#桌面更新纪律强制) · [安全与信任边界](#安全与信任边界) · [已知限制](#已知限制) · [校验](#校验) · [开发](#开发) · [发版](#发版)
- **深入材料**：[安全与信任边界](SECURITY.md) · [架构与执行世界](docs/ARCHITECTURE.md) · [Linux 侧约束](docs/CONFINEMENT.md) · [fs 工具的围栏](docs/FS-FENCE.md) · [终端 PTY 桥](docs/PTY-BRIDGE.md) · [校验与 SKIP 裁定](docs/VERIFICATION.md) · [工程笔记](docs/ENGINEERING-NOTES.md) · [发行版支持矩阵](docs/DISTRO-SUPPORT.md) · [上游 API 提案](docs/UPSTREAM-PROPOSALS.md) · [架构与流程图](docs/diagrams.md)

## 目标能力

**活体验收通过后的诚实状态**（`verify-post-restart.mjs` 全绿 + 离线 18 套件；下面每条都注明证据强度）：

| # | 能力 | 状态 |
|---|---|---|
| ① | 工作区可选择 WSL 发行版里的 Linux 目录 | 对话框与宿主调用已实现并活体通过（listDir/checkPath/resolveHome/工作区注册与清理）；**浏览器内交互已由操作者人工确认**（门控流、目录浏览、终端面板均正常） |
| ② | 该工作区内的 shell / 文件工具 / subprocess / 终端 在 WSL 里工作，且可从 WSL 调用宿主机命令 | **活体验收 PASS**：绑定（创建请求命名 preset）、shell 进发行版、fs 工具 Linux 寻址、越界写拒绝、subprocess POSIX 环境、bash 工具、工具层约束；终端传输由 PTY 套件覆盖 |
| ③ | 同一实例里 Windows 与 WSL 工作区并存 | **活体验收 PASS**：Windows 工作区停留在宿主 preset（PowerShell 可用、无 bash），WSL 会话并行运行 confined realm |
| ④ | WSL 侧的 Linux 沙箱约束 | **shell 侧已修并活体验证**：运行时枚举所有 `rw` 挂载逐个改只读（实测 `/mnt/c`、`/dev/shm`、`/run/user/<uid>` 从 WRITABLE 变 READONLY）、失败即拒（保留退出码 97）、`enforcement` 如实报 `partial`。**fs 侧围栏已实现并活体验证**（越界写拒绝 PASS，见 [fs 工具的围栏](docs/FS-FENCE.md)）|

**哪些能力有保留**（证据强度就是上表状态列的措辞）：`grep` / `glob` 工具在 WSL 会话里不存在，终端不支持 `stdio.control`——两条都写在「已知限制」里，不藏。

## 安装 / 更新 / 卸载

**用户安装（生产通道）**：本插件以 npm 包形式发布，形态对齐 dsh-better-sidebar 等成熟插件（`files` 精确清单 + `cordis.patch.yml` bundle patch + `dsh.client.inject` 客户端接线 + `manifestVersion`）。

- 插件市场 / 插件管理器：安装 `dsh-wsl-desktop@<version>`——桌面自动完成 pnpm 接线与 bundle patch 挂载，重启即用。
- 命令行等价：`plugin_manager install_bundle dsh-wsl-desktop@<version>`。
- **安装前提**：WSL2 + 目标发行版满足[支持矩阵](docs/DISTRO-SUPPORT.md)——会话用户 NOPASSWD sudo、bash、python3；推荐同时安装 dsh-wsl-confine helper 闭合围栏边界（安装命令见 [docs/CONFINEMENT.md](docs/CONFINEMENT.md)）。
- **更新**：安装新版本号即可；桌面大版本更新后按「桌面更新纪律」先跑 `verify-post-restart.mjs`。
- **卸载**：插件管理器卸载即同时撤回本插件注册的 wsl-* 预设（disposer 生命周期保证）。

> **版本对应关系**：当前 `0.3.x` 系列要求 DSH Desktop **0.1.7+**。语义化版本的含义见「发版」——`minor` 就是"适配了某个新的桌面大版本"，所以**桌面大版本变了要先看这里有没有对应的 minor**。

## 快速开始

侧栏工作区标题栏里，自带的"+"（添加工作区）右边多一个 **W** 按钮。点开是本插件的工作区对话框，顺序是：选发行版 → 输入要进入该发行版的用户（**留空 = 发行版默认用户**）→ 浏览或输入 Linux 目录 → 创建并打开会话。

进入浏览后，路径直接落在该用户的主目录（宿主在发行版内用 `getent passwd` 解析用户数据库）。输入的用户不存在时，错误就地显示在弹层里，不会进入浏览。切换发行版——**包括重新点击当前已选中的那个**——都会重新弹出用户输入框，并带上一次确认过的用户名作为起点。创建会话进行中时发行版按钮暂时不可点。

边界要说清楚：这一步只决定"浏览谁的 home"，**不决定会话身份**——会话在发行版里始终以发行版默认用户执行（`username` 是插件配置，不随会话创建传递）。

侧栏工作区列表里，**路径落在 WSL UNC 下的工作区，行首图标是 ☁️ 而不是文件夹**。"+" 保持部署自带的行为（Desktop 上是 Electron 目录选择器），本插件不改写它。

界面与 DOM 层为什么这么做（"隐藏必须用 `display`、不能用 `remove()`"、"不要用定时器兜底"这类实测结论），见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 桌面更新纪律（强制）

每次 DSH Desktop 更新后，插件可能因 harness 内部 API 变化而失效（0.1.6→0.1.7 即断裂四处）。**纪律：更新桌面 → 跑 `node scripts/verify-post-restart.mjs` → 全绿才继续使用；任何一次红都先修再干。** 该套件覆盖预设注册、执行世界、会话绑定、Windows 隔离与对话框契约；新宿主的破坏会在这些断言上现形，而不是静默降级成宿主世界。

## 安全与信任边界

- **宿主侧**：Windows 工作区会话仍跑在 DSH 自带的沙箱后端里，本插件不替换它们。
- **发行版内 shell 侧**：在 mount namespace 里把 `/` 改只读，只留工作区与一个私有 `/tmp` 可写；**约束建立失败即拒绝执行**，不裸跑。机制与实测前提见 [docs/CONFINEMENT.md](docs/CONFINEMENT.md)。
- **发行版内 fs 侧**：`WslFileSystem` 自带围栏，两个变更入口都先过 `checkedTarget`，越界抛结构化 `FS_SANDBOX_DENIED`。见 [fs 工具的围栏](docs/FS-FENCE.md)。

**已披露的不设防面**：宿主 subprocess 面不设防是设计取舍，不是遗漏。**围栏的已知边界**：会话用户保留的免密 sudo 授权可以重新调用它绕过文件围栏，两条闭合路径与它们的实际可达性见 [SECURITY.md](SECURITY.md)。

## 已知限制

**grep / glob 工具在 WSL 会话里不可用。** `tool-fs-search` 虽然通过 `ctx.subprocess.spawn()` 启动（`search-core.ts:238`），但它的 argv[0] 是 `@vscode/ripgrep` 提供的**打包 Windows rg.exe**（`search-core.ts:174-178`），在发行版里既不存在、也无法用 Linux 参数工作。所以 WSL 预设会把它从执行世界里移除，WSL 会话的模型只能用 bash 的 `grep` / `find`（两者在发行版里都在）。这算是一个能力回退，不是遗漏——要做成对等的，需要给 WSL 世界提供自己的搜索实现。

**终端走 PTY 桥，PTC 的 `stdio.control`（fd 通道）明确拒绝**——`wsl.exe` 无法转发任意描述符。桥的驱动方式与实测前提见 [docs/PTY-BRIDGE.md](docs/PTY-BRIDGE.md)。

**约束覆盖不到 `/dev`、`/proc`、`/sys` 与 interop**，如实报在 `enforcement: 'partial'` 里；而会话用户保留的免密 sudo 授权可绕过文件围栏，闭合路径见 [SECURITY.md](SECURITY.md)。

## 校验

```powershell
node scripts/verify-all.mjs          # 全部离线套件（18 个）
node scripts/verify-all.mjs --live   # 追加需要已安装插件 + 运行中宿主的套件
```

逐套件职责、单跑命令、以及**聚合器怎么读 SKIP**（退出码 2 是套件自己的 SKIP；只有 `DECLARED_SKIPS` 点名的跳过才算数并打印它的前提，未声明的跳过判红，失效的声明在任何套件运行之前先判红），见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。

## 开发

```bash
git clone https://github.com/zcluo/dsh-wsl-desktop.git
cd dsh-wsl-desktop
node scripts/verify-all.mjs        # 离线全量
.\scripts\sync.ps1                 # stage 进 profile 并重指向（开发者模式：developerTools 开启；首次安装需先接线）
# 重启 DSH Desktop → verify-post-restart.mjs
```

仓库布局：

```
lib/index.js            Host：路由、预设生成、会话预设绑定
lib/client.js           浏览器：侧栏"+"旁的 W 按钮 + 添加 WSL 工作区对话框
lib/wsl/paths.js        UNC ↔ Linux ↔ 盘符 互译（纯函数）
lib/wsl/world.js        发行版发现、wsl.exe 执行核、目录事实
lib/wsl/shell.js        ShellExecutor 实现（WSL bash + 约束接入）
lib/wsl/fs.js           LocalFileSystem 子类（9P 后端 + 路径方言）
lib/wsl/publish.js      覆盖发布的等待边界（重试 + 实测尾部；纯模块，可独立测试）
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

宿主代码改动需要**重启 DSH Desktop** 才会加载，重启后先跑 `verify-post-restart.mjs`（它会在旧模块仍生效时直接报「请重启」而不是给假绿）。**浏览器半边改动不需要重启**，但"文件已改"不等于"投放已变"——热更新的完整边界、以及 `sync.ps1` 的"保留最新两代"规则，见 [docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md)。

执行世界由会话的 agent preset 决定、会话绑定的接缝在哪、界面入口的 DOM 层实现，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 发版

**维护者发版**：语义化版本——patch = 缺陷修复；minor = 兼容的桌面大版本适配（每次 harness 断裂适配后升 minor，如 0.1.x 的 0.1.7 适配）；major = 边界语义或支持矩阵变化。流程：改 `package.json` version → 全量套件 + `verify-post-restart.mjs` 全绿 → `npm publish --access public` → 打 git tag。`files` 清单已含 `lib/wsl/dsh-wsl-confine.sh`（helper 随包分发）。

> ⚠️ **`exports["./client"]` 是硬性契约，改元数据时最容易误删。** 只要有一个包声明了 `dsh.client` 却没有 `exports["./client"]`，宿主就直接拒绝组合，**整张桌面启动失败**（不是本插件单独失效）——v0.2.0 与 0.2.1 因此装上去就起不来。`scripts/verify-modules.mjs` 现在钉住这条，发版前跑它即可拦住；事故经过见 [docs/ENGINEERING-NOTES.md](docs/ENGINEERING-NOTES.md)。

## 许可证

本项目基于 [MIT 协议](LICENSE) 发布。
