# dsh-wsl-desktop

简体中文 | [English](README.en.md)

## 这是什么

一个 DSH Desktop 插件。它让你的 WSL 发行版变成可以直接干活的地方：把工作区建在发行版里，AI 的
shell 命令、文件读写、搜索和终端就都跑在发行版内，而不是跑在 Windows 上。

## 为什么你会想要它

插件给每个 WSL 会话配一套"预设"，预设就是会话启动时拿到的那一整套工具配置。这套配置把 shell、
文件读写、搜索、终端都指向发行版，所以：

- **你的 Linux 工具真的能用。** 工作区放在发行版里，AI 用的是发行版自己的 `bash`、`grep`、`find`、
  解释器和包。
- **命令之间不再各过各的。** 模型侧的 `bash` 是一条常驻 shell，上一次调用留下的当前目录和环境变量，
  下一次调用还看得见。
- **两种工作区可以同时开着。** 同一个窗口里，Windows 工作区照旧跑在宿主自己的沙箱后端上，WSL 工作区
  跑在发行版里，互不干扰。
- **可以顺手用到 Windows 那边的东西。** 在发行版里能调用宿主机的命令；WSL 把这项功能叫 interop，
  它在发行版里默认开着。

## 装之前要有什么

- **WSL2**。不是 WSL1。
- **一个受支持的发行版。** Debian、Ubuntu、Fedora/RHEL、Arch 已实测通过，Alpine 装上
  `bash` 与 `util-linux-misc` 后也可以。清单与每种发行版的安装命令见
  [发行版支持矩阵](docs/DISTRO-SUPPORT.md)。
- **DSH Desktop 0.1.7 或更高。** 旧版宿主在激活时会明确拒绝。
- **会话用户能免密 sudo，并且有 `bash` 和 `python3`。** 这一条最容易卡住。受限模式要在发行版内部
  搭一个 mount namespace（让进程看到一份独立挂载表的 Linux 机制），把文件系统改成只读，而 WSL 内核
  不允许在 user namespace 里做 bind mount，所以只能用 `sudo -n`。没有免密 sudo 时受限模式会
  **明确失败**，不会退回去裸跑。
- **建议再装一个 helper。** helper 是装在发行版里的一份小脚本 `dsh-wsl-confine`，用来闭合"用户保留的
  sudo 授权"这条边界。安装命令见 [Linux 侧约束](docs/CONFINEMENT.md)。它是可选的，但推荐。

## 怎么装

**插件市场 / 插件管理器（推荐）**：安装 `dsh-wsl-desktop@<version>`。桌面会自动把包装进 pnpm 工作区，
并把 bundle patch（插件挂进桌面的那份配置）挂上，重启即用。

**命令行等价**：

```
plugin_manager install_bundle dsh-wsl-desktop@<version>
```

**更新**：装一个新版本号就行。桌面大版本更新之后，先跑一次 `verify-post-restart.mjs`
（见「会意外的地方」里桌面更新那一条）。

**卸载**：用插件管理器卸载即可。本插件注册的 `wsl-*` 预设会一起撤回，不会留下指向不存在插件的工作区。

## 怎么用

侧栏工作区标题栏里，自带的「+」（添加工作区）右边多出一个 **W** 按钮。点它，然后按顺序走：

1. **选发行版。** 已安装的 WSL 发行版会列出来。
2. **输入用户。** 这是要进入该发行版的用户，用来决定"浏览谁的 home"。**留空 = 发行版默认用户。**
   用户名不存在时，错误就地显示在弹层里，不会进入浏览。
3. **选目录。** 浏览或直接输入 Linux 路径。进来时路径落在上一步那个用户的主目录，
   宿主在发行版内用 `getent passwd` 解析用户数据库。
4. **创建并打开会话。**

几个会碰到的细节：

- **切换发行版会重新问用户**，包括重新点当前已选中的那个；输入框会带上一次确认过的名字作为起点。
- **创建会话进行中时，发行版按钮暂时点不动**，避免提交到一半换了目标。
- **这一步只决定浏览谁的 home，不决定会话身份。** 会话在发行版里始终以发行版的默认用户执行；
  插件配置里的 `username` 不随会话创建传递。
- 侧栏工作区列表里，**路径落在 WSL UNC 下的工作区，行首图标是 ☁️ 而不是文件夹**。UNC 是 Windows
  表示网络/子系统路径的写法，形如 `\\wsl.localhost\<发行版>\home\...`。
- 自带的「+」保持部署原本的行为（桌面上是 Electron 的目录选择器），本插件不改写它。
- 已经打开的 WSL 工作区里，文件列表和终端都是发行版内的。Windows 工作区里的 PowerShell 不受影响。

## 会意外的地方

这些都是真的边界，不是缺陷清单的免责声明。每条都给了读下去的地方。

- **搜索工具的语义和宿主不一样。** WSL 会话里的 `grep` / `glob` 用的是发行版自己的
  `grep` / `find`。所以正则方言是 Linux 上 grep 的标准方言 POSIX ERE，`\d` 与 `(?i)` 都不可用。
  它也不解析 `.gitignore`，只排除六个 VCS 目录。点目录会被搜到；`include` 只匹配
  basename 且不支持花括号；路径含 `:` 的记录可能被丢弃或错配；二进制文件永远不匹配；
  到上限的结果不落盘。完整八条与限额见 [发行版内搜索](docs/SEARCH.md)。
- **终端走 PTY 桥，不支持 `stdio.control`。** 终端要在发行版里真的开出一个伪终端（PTY），
  而 `wsl.exe` 只有三条管道，所以插件在发行版里跑一个小桥，由宿主侧两个进程驱动它。终端的
  `stdio.control` 那条 fd 通道明确拒绝，因为 `wsl.exe` 无法转发任意描述符。桥怎么驱动见
  [终端（PTY 桥）](docs/PTY-BRIDGE.md)。
- **文件围栏管的是模型，不是你。** GUI 的网页终端按设计**不受围栏约束**——你在终端面板里敲的命令
  和在发行版里直接开一个 shell 一样；受约束的是模型侧那条 `bash`。另外**终端这条路没有
  PID namespace**：PID namespace 是让一组进程只看得见自己那棵进程树的 Linux 机制，而终端这条路
  没有它，一次性命令路径则有。两条边界的完整说明见 [常驻 shell](docs/PERSISTENT-SHELL.md)。
- **`/dev`、`/proc`、`/sys` 和 interop 在围栏之外。** 它们不是文件存储，所以插件把自我报告的
  `enforcement` 字段报成 `partial`（部分覆盖），而不是说成"已沙箱化"。
- **subprocess 这一面不设防。** 托管进程的终止、输出溢出与回收，都仍归宿主自己的 subprocess
  provider，不受文件围栏约束。这是设计取舍，不是遗漏。见 [安全与信任边界](SECURITY.md)。
- **保留的免密 sudo 能绕过文件围栏。** 会话用户保留着插件建立围栏时自己要用的那份授权，所以被约束
  的命令可以重新调用它。两条闭合路径是 helper 与 NO_NEW_PRIVS。后者是内核标志，让进程再也拿不到
  提权。两条路径的实际可达性见 [安全与信任边界](SECURITY.md)。
- **文件变更监听是轮询的，不是事件驱动的。** 9P 是 WSL 把发行版文件暴露给 Windows 的那套共享，
  在它上面 `fs.watch` 会抛 `EISDIR`。所以插件改为在宿主侧轮询：目录每 300ms 看一次条目集合，
  文件每 300ms `stat` 一次。**目录目标只对条目变化生效**——新增、删除、改名可见，目录里某个文件的
  内容变化不可见；要盯内容就按文件路径监听它。机制与实测见
  [WSL 文件变更监听](docs/WATCH.md)。
- **桌面更新后插件可能失效。** 插件依赖桌面内部的框架（harness）的 API，这些 API 变化会打断它
  （0.1.6 → 0.1.7 一次断了四处）。所以更新桌面之后先跑一次
  `node scripts/verify-post-restart.mjs`，全绿再继续用。
- **失败现在带 code，可以先自己诊断。** 浏览器侧的错误只回稳定 code 与允许的 params，
  宿主 message、stderr 与解析后的路径不会过线；W 对话框在确认用户后会显示一条建议性的
  「环境检查」，失败项带修复命令。错误码、检查项与降级行为见 [诊断](docs/DIAGNOSTICS.md)。
- **适合谁用。** 目前适合插件作者本人或同信任级别的操作者长期使用。分发给第三方用户、或放进
  无人值守的高价值环境，都还不适合——理由写在 [SECURITY.md](SECURITY.md)。

## 想读更多

- [安全与信任边界](SECURITY.md) — 信任边界、已披露的不设防面、审计结论
- [执行世界与架构](docs/ARCHITECTURE.md) — 会话怎么绑定执行世界，界面为什么这样做
- [Linux 侧约束](docs/CONFINEMENT.md) — mount namespace 围栏、helper、实测前提
- [fs 工具的围栏](docs/FS-FENCE.md) — 文件读写的越界判定
- [终端（PTY 桥）](docs/PTY-BRIDGE.md) — 终端是怎么跑进发行版的
- [常驻 shell](docs/PERSISTENT-SHELL.md) — 模型侧 `bash` 的缺口清单、限额、人工核验清单
- [发行版内搜索](docs/SEARCH.md) — 八条语义差异、限额、怎么自己验
- [WSL 文件变更监听](docs/WATCH.md) — 轮询策略与它的边界
- [校验](docs/VERIFICATION.md) — 每个套件管什么，以及跳过（SKIP）怎么裁定
- [诊断](docs/DIAGNOSTICS.md) — 错误码、环境检查、宿主能力缺失时的降级与隐私边界
- [工程笔记](docs/ENGINEERING-NOTES.md) — 实测约束、仓库布局、发版流程、安装形态
- [发行版支持矩阵](docs/DISTRO-SUPPORT.md) — 哪些发行版验证过，每种缺什么
- [上游 API 提案](docs/UPSTREAM-PROPOSALS.md) — 对 harness 上游的两项提案
- [架构与流程图](docs/diagrams.md) — 可交互的架构、时序与生命周期图

其中三份——发行版支持矩阵、上游 API 提案、架构与流程图索引——**只有中文版**，因为目前没有对应的
英文文本。把它们翻成英文是一件独立的工作，不是改个文件名。

## 给维护者

这一节是给要改这个仓库的人看的；只想用插件的话，上面已经够了。

- `README.en.md` 与本文件是一对声明过的双语版：`scripts/verify-docs.mjs` 要求两边命名同一批仓库文件。
- 自检：`node scripts/verify-all.mjs` 跑全部离线套件；加 `--live` 追加需要已安装插件与运行中宿主的
  套件。逐套件职责与 SKIP 裁定见 [校验](docs/VERIFICATION.md)。
- 仓库布局、安装形态与发版流程见 [工程笔记](docs/ENGINEERING-NOTES.md)。语义化版本在这个仓库里的
  具体含义、以及 `npm publish` 的步骤都在那里。
- ⚠️ **`exports["./client"]` 是硬性契约。** 一个包声明了 `dsh.client` 却没有
  `exports["./client"]`，宿主会直接拒绝组合，**整张桌面启动失败**。`scripts/verify-modules.mjs`
  钉住这条，发版前跑它就能拦住。事故经过见 [工程笔记](docs/ENGINEERING-NOTES.md)。
- 发行版与用户不硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，
  默认从 `wsl.exe` 现读。

## 许可证

本项目基于 [MIT 协议](LICENSE) 发布。
