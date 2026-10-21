# 诊断：错误码、体检与降级 — dsh-wsl-desktop

面向 0.6.0 及以上的操作者。本文解释浏览器看到的错误码、W 对话框里的环境检查，以及宿主能力缺失时的降级行为。执行世界的机制见 [ARCHITECTURE.md](ARCHITECTURE.md)；围栏与发行版前提见 [CONFINEMENT.md](CONFINEMENT.md) 与 [DISTRO-SUPPORT.md](DISTRO-SUPPORT.md)。

## 错误码

浏览器半边的每次失败都带一个稳定的 `code` 与一组经白名单过滤的 `params`。宿主侧的 message、`wsl.exe` stderr、解析后的 Windows 路径与堆栈不会出现在响应里；未分类的内部错误只回一个 `ref`，宿主日志里有对应的堆栈。开发令牌调用者仍会拿到人类可读的 message，这是调试面，不是产品面。

| code | 何时出现 | 浏览器 params | 修法 |
|---|---|---|---|
| `wsl-not-available` | 找不到可执行的 `wsl.exe`，或 WSL2 不可用 | 无 | 安装/启用 WSL2；确认 `wsl.exe` 在 PATH 上 |
| `distro-unknown` | 请求的发行版不存在或名字不合法 | `distro` | 刷新发行版列表；重新安装或注册该发行版 |
| `distro-unreachable` | 发行版存在，但探针超时或无法访问 | `distro` | 先在终端启动该发行版，然后重试 |
| `user-unknown` | `getent passwd` 找不到该用户 | `user` | 留空使用默认用户，或输入已有用户 |
| `path-invalid` | 输入不是发行版内的绝对路径 | `path` | 输入以 `/` 开头的 Linux 路径 |
| `path-not-found` | 目录不存在 | `path` | 检查路径，或从上级目录重新选择 |
| `path-not-directory` | 路径存在但不是目录 | `path` | 选择一个目录作为工作区 |
| `preset-not-ready` | WSL 预设尚未生成或无法挂载 | `preset` | 重启桌面；仍失败时运行一次自检 |
| `host-capability-missing` | 当前桌面版本缺少插件依赖的宿主符号 | `feature` | 升级桌面；或按「降级」一节处理 |
| `host-plugin-stale` | 浏览器半边比宿主半边新 | `method` | 重启桌面，让宿主半边加载 |
| `too-busy` | 路由 8 个在途调用已满 | 无 | 等一秒再试 |
| `internal` | 未分类异常 | `ref` | 复制 `ref` 附在问题报告里 |
| `transport` | 浏览器连不上本地路由 | 无 | 刷新页面；仍失败时重启桌面 |
| `catalog-unavailable` | 诊断目录拉取失败；错误码仍会显示 | 无 | 重试；把显示的错误码附在报告里 |

`no-distros` 不是错误码：没有已安装发行版时 `listDistros` 返回空数组，界面显示空状态与 `wsl --install` 指引。

## 环境检查

用户确认发行版用户后，浏览阶段顶部会出现一条可展开的「环境检查」。它只读，**建议性**：任何一项失败都不会禁用「创建并打开」。

| 检查项 | 通过条件 | 级别 |
|---|---|---|
| `bash` | `command -v bash` 非空 | 硬失败 |
| `python3` | 存在且版本 >= 3.8 | 建议（终端/PTY 桥依赖） |
| `util-linux` | unshare/setpriv/findmnt/mount 都在 | 建议（受限模式依赖） |
| `getent` | 存在 | 建议（缺失时回落到默认 shell） |
| `runner` | helper 或 sudo-unshare 可用 | 建议（受限模式依赖） |
| `helper` | 已安装且版本为 v1.2 | 建议（缺失但 sudo 可用时仍可运行） |
| `nnp` | setpriv 支持 `--no-new-privs` | 建议（受限模式依赖） |

返回里另有 `ok`（没有硬失败）与 `restricted`（util-linux、runner、nnp 三项都通过）。`restricted:false` 时界面会明说「受限模式不可用；danger-full-access 仍可创建」。结果按发行版+用户缓存 60 秒；批处理预算 15 秒，runner/NNP 各自 20 秒 race，整体 35 秒上限。

## 降级

启动时宿主探测声明的符号。缺失时按 feature 降级，并给出可见原因：

| 缺失 feature | 表现 |
|---|---|
| `picker` / `preset-generation` / `session-create` | W 按钮仍挂载；点击进入「插件已降级」卡片，列出缺失 feature 与修法，不请求发行版 |
| `terminal` / `search` | 对话框正常；对应工具可能不可用，体检与 post-restart 报告 |
| `selftest` | 只影响开发面 |

侧栏锚点找不到时（桌面改动把「添加工作区」入口换掉），除了宿主日志，还会出现一枚可关闭的浮动「WSL」入口；真实入口后来出现时它会自动移除。关闭浏览器半边的注入失败（cordis 不调用 `apply`）是外部边界：这一层没有产品内信号，只有宿主日志与 post-restart 检查。

## 隐私边界

- 浏览器只收到 `{ ok: false, code, params }`；`SAFE_PARAMS` 是硬白名单，值是调用者自己提交的短文本（截断 200 字符）。
- `health` 只返回命令是否存在、版本字符串与 runner 类型；不返回 home、挂载点或 stderr。
- `internal` 的完整堆栈只写宿主日志，用 `ref` 关联。

## 常见修法

- **缺 bash / python3 / util-linux**：按发行版族安装。Debian/Ubuntu 用 `sudo apt-get install -y bash python3 util-linux`；Fedora/RHEL 用 `sudo dnf install -y bash python3 util-linux`；Arch 用 `sudo pacman -S --noconfirm bash python3 util-linux`；Alpine 用 `sudo apk add bash python3 util-linux-misc findutils`。环境检查的每一项都带「复制」按钮。
- **受限模式不可用**：安装 `dsh-wsl-confine` helper（见 [CONFINEMENT.md](CONFINEMENT.md)），或给会话用户配置免密 sudo；两者都没有时改用 `danger-full-access`。
- **NNP 不支持**：升级发行版的 util-linux；判据是 `setpriv --help` 里能 grep 到 `--no-new-privs`，不要按版本号判断。
- **默认用户不可用**：在对话框里显式输入一个存在的用户，或修复 `getent`。
- **发行版太多/太少**：`wsl --install -d <名字>` 安装；`wsl --unregister <名字>` 卸载后刷新。

## 相关源码与套件

- `lib/protocol.js` — 错误码、双语文案、remedy 与 params 白名单
- `lib/wsl/doctor.js` — 批处理探针、解析、缓存与检查组装
- `scripts/verify-protocol.mjs` — 目录完整性、分类器与参数过滤
- `scripts/verify-doctor.mjs` — 解析器、缓存、组装与一条 live 行
- `scripts/verify-host-contract.mjs` — manifest、源码互查与宿主导出形状

安装与更新见 [README.md](../README.md)。
