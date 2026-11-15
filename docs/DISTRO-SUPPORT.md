# 发行版支持矩阵 — dsh-wsl-desktop

> 验证方法：**userland 兼容轴**用 docker 容器逐家族实测（驱动：`scripts/distro-matrix.sh`，夹具由 `scripts/generate-fence-fixture.mjs` 从 `buildNamespaceScript` 生成——即插件真实发布的围栏脚本）；**WSL 集成轴**（wsl.exe 调用链、9P、sudo 交互）需要每个家族一个真实 WSL 实例，按检查单执行。
> 共享不变式（一次验证覆盖全机所有 WSL2 发行版）：WSL2 内核行为（mount ns / NO_NEW_PRIVS / user-ns 限制）、WSL 基础设施（9P、interop）、Windows 侧全部逻辑。

## 矩阵（2026-09-25 首次实测；2026-11-14 两条轴全部重测）

> **两条轴，不能互相替代。** userland 轴：用 docker 容器逐家族跑**真实发布的围栏脚本**，测的是「这个发行版的用户态能不能建立只读根」。WSL 集成轴：用**真实 WSL 实例**跑整套套件，测的是「wsl.exe 调用链、9P、sudo 交互、PTY 桥在这个发行版上成不成立」。

| 家族 | 镜像 | unshare/setpriv/findmnt/mount | bash | python3 | NNP 支持 | 围栏实测 | 结论 |
|---|---|---|---|---|---|---|---|
| Debian | debian:12 (util-linux 2.38) | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS（FENCE-OK / INSIDE-OK / ESCAPE-DENIED / exit 0） | ✅ 支持 |
| Ubuntu | ubuntu:24.04 | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持 |
| Fedora/RHEL | fedora:41 | ✅✅✅✅ | ✅ | ✅ | ✅ | ✅ PASS | ✅ 支持（**真实 WSL 实例已验证**，见下） |
| Arch | archlinux | ✅✅✅✅ | ✅ | ✅ | ✅ | ✅ PASS | ✅ 支持（**真实 WSL 实例已验证**，见下） |
| Alpine (musl) | alpine:3.20 (util-linux 2.40.1) | ✅（util-linux-misc） | ✅（需安装） | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持（需 bash + util-linux-misc + shadow） |
| openSUSE | leap:15.6 (util-linux 2.39.3) | ✅（util-linux-systemd） | ✅ | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持（**真实实例已用 Tumbleweed 验证**，见下） |

**userland 轴：6/6 家族全部 `FENCE-OK / INSIDE-OK / ESCAPE-DENIED`，`FENCE-EXIT=0`。** 2026-11-14 在 `debian-dev`（Docker 29.8.2）上逐个重跑，几个与首次记录不同的实测事实：

| 镜像 | 与旧记录的差异 |
|---|---|
| `debian:12` / `ubuntu:24.04` | 原记录「python3 需安装」正确；`sudo` 同样需要装 |
| `fedora:41` | **原镜像缺 `setpriv`**（`util-linux` 只提供部分工具），装 `util-linux` 后齐全。旧记录写 ✅✅✅✅ 是「装完为准」，这里写明 |
| `archlinux` | 开箱全齐（util-linux 2.42.4），无需补装 |
| `alpine:3.20` | 需 `bash` + `util-linux-misc` + **`shadow`**（夹具里 `useradd` 用它） |
| `opensuse/leap:15.6` | 见下：`findmnt` 由 `util-linux-systemd` 提供；且**仓库签名密钥已过期**，`zypper install` 会挂起 |

**真实 WSL 实例已验证**：debian-dev（Debian 13.7）✅、debian ✅、**arch（Arch Linux rolling）✅**、**openSUSE-Tumbleweed ✅**、**Fedora41（Fedora 41）✅**——含 wsl.exe 调用链、9P 路径、sudo 交互、PTY 桥全链。

### arch 的真实 WSL 实例实测（2026-11-14）

这是一行**真实 WSL2 实例**证据，不是容器 userland 证据。探针结果：

| 项 | 实测值 |
|---|---|
| `/etc/os-release` `ID` | `arch` |
| `bash` / `unshare` / `setpriv` / `findmnt` / `getent` / `python3` | 六个全部在 `/usr/sbin/`（预装，无需补装） |
| `setpriv --help` 含 `--no-new-privs` | 是（探测方式按矩阵约定，不按版本号） |
| `sudo -n true` | 0（免密 sudo 可用） |
| WSL 版本 | 2 |

在该发行版上逐套件实测（`DSH_WSL_DISTRO=arch`）：

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `verify-confinement` | **ALL CHECKS PASSED**，exit 0 | 围栏建立、工作区可写、外部被拒、helper 属主闸门全套 |
| `verify-world` | **ALL CHECKS PASSED**，exit 0 | 路径互译、发行版内执行、目录事实、exec 边界拒绝 |
| `verify-doctor` | **45 passed, 0 failed, 0 skipped** | 含 live 行：真实体检测量成功 |
| `verify-fs-fence` | **ALL CHECKS PASSED**，exit 0 | 跨发行版包含性（arch 为主、debian 为对照） |
| `verify-9p` | **PROFILE MATCHES**，exit 0 | 9 条共享事实；含「跨 share 身份碰撞」与「大小写敏感」两条已知事实 |
| `verify-terminal` | **ALL CHECKS PASSED**，exit 0 | PTY 桥：resize / 前台进程组 / 信号 / 终止 / 畸形控制行 |
| `verify-pty-handle` | **ALL CHECKS PASSED**，exit 0 | FIFO 生命周期、清扫、失败上报 |
| `verify-world-errors` | **16 passed, 0 failed** | 类型化失败分类 |
| `verify-sync` | **29 check(s) passed** | 开发代次 stage（Windows 侧，与发行版无关） |
| 完整离线门（`DSH_WSL_DISTRO=arch DSH_WSL_OTHER_DISTRO=debian-dev`） | **25/27 通过，0 失败**，2 个声明性跳过 | 收据 `counts = {total:27, passed:25, skipped:2, failed:0}` |

**Arch 家族因此从「容器 userland 已验证」升级为「真实 WSL 实例已验证」。**

**仍未做的**：GUI 一侧的三条人工核验（W 按钮建会话显示 `WSL · <base>`、对话框列出该发行版及其目录、终端面板是发行版自己的 shell）**没有在本轮执行**——它们需要点击真实界面，不是命令能替代的。检查单见 [真实机器验收手册](ACCEPTANCE-RUNBOOK.md) 的 2.2 节。

### openSUSE-Tumbleweed 的真实 WSL 实例实测（2026-11-14）

官方 `wsl --install openSUSE-Tumbleweed` 装的实例，**开箱状态有两个真实差异**，两条都有解决办法：

| # | 开箱状态 | 后果 | 解决 |
|---|---|---|---|
| 1 | 默认用户是 **root** | 围栏 helper 的属主闸门对 root 恒判「文件可写」→ 拒绝该 helper，回落到 direct runner。这是 fail-closed 的正确行为，但**矩阵行的证据条件与其它发行版不同** | 建非 root 用户（`useradd -m -s /bin/bash tester`）+ `NOPASSWD` sudo，并把它设为默认用户 |
| 2 | **`findmnt` 缺失**（`util-linux` 包在 Tumbleweed 上不含它），`/run/user/<uid>` 不存在（未启用 systemd） | `findmnt` 是围栏的可读性判定前提；缺 `/run/user` 会让「session runtime directory」一行报 MISSING | `zypper -n install -y util-linux-systemd`（provides `findmnt`）+ 在 `/etc/wsl.conf` 写 `[boot] systemd=true` 后 `wsl --terminate` |

**这两条是发行版前提，不是插件缺陷**——但它们必须写进安装说明，否则用户会撞在「围栏建立失败」上。

准备好之后（默认用户 `tester`、systemd 已启、`findmnt` 已装），逐套件实测：

| 套件 | 结果 |
|---|---|
| `verify-confinement` | **ALL CHECKS PASSED**，exit 0 |
| `verify-world` | **ALL CHECKS PASSED**，exit 0 |
| `verify-doctor` | **45 passed, 0 failed, 0 skipped** |
| `verify-fs-fence` | **ALL CHECKS PASSED**，exit 0（openSUSE 为主、arch 为对照） |
| `verify-9p` | **PROFILE MATCHES**，exit 0（9 条共享事实） |
| `verify-terminal` | **ALL CHECKS PASSED**，exit 0 |
| `verify-pty-handle` | **ALL CHECKS PASSED**，exit 0 |
| `verify-world-errors` | **16 passed, 0 failed** |
| 完整离线门 | **25/27 通过，0 失败**，2 个声明性跳过 |

**openSUSE 家族因此从「未测」升级为「真实 WSL 实例已验证」**，覆盖 rolling 家族的第二种实现（与 Arch 并列）。

**证据边界要写清**：上表是真实实例轴。容器 userland 轴（`leap:15.6`）当时未测，2026-11-14 已补测并通过（见上表的 userland 轴说明）——**两条轴互相独立，都要有才算完整**。

### Fedora 的真实 WSL 实例实测（2026-11-14）

官方 Store 的 `FedoraLinux-45` 镜像在**本机网络下 VHD 下载卡住**（650 MB 后 16 分钟零进展），所以改用等价路径：从本机 docker 的 `fedora:41` 镜像 `docker export` 出 rootfs，再 `wsl --import Fedora41 <dir> <rootfs.tar> --version 2`。**这是一个真实 WSL2 实例**，只是 rootfs 来自容器镜像而非 Store。

`/etc/os-release`：`NAME="Fedora Linux" VERSION="41 (Container Image)" RELEASE_TYPE=stable` —— 容器镜像形态，因此**开箱缺三样**：

| # | 开箱状态 | 后果 | 解决 |
|---|---|---|---|
| 1 | **缺 `setpriv`** | 围栏的两个 runner 都不可用 → 受限模式 fail-closed | `dnf install -y util-linux` |
| 2 | **缺 `python3`** | PTY 桥（`terminal-bridge.py`）不可用 | `dnf install -y python3` |
| 3 | **无 systemd（容器镜像）**，无 `/run/user/<uid>` | 「session runtime directory」一行报 MISSING | `dnf install -y systemd` + `ln -sf /usr/lib/systemd/systemd /sbin/init` + `/etc/wsl.conf` 的 `[boot] systemd=true` |
| 4 | 默认用户是 **root** | 同 openSUSE：属主闸门对 root 恒判可写 → 拒绝 helper | 建 `tester` + NOPASSWD sudo + `/etc/wsl.conf` 的 `[user] default=tester` |

准备好之后逐套件实测（`DSH_WSL_DISTRO=Fedora41`）：

| 套件 | 结果 |
|---|---|
| `verify-confinement` | **ALL CHECKS PASSED**，exit 0 |
| `verify-world` | **ALL CHECKS PASSED**，exit 0 |
| `verify-doctor` | **45 passed, 0 failed, 0 skipped** |
| `verify-fs-fence` | **ALL CHECKS PASSED**，exit 0（Fedora 为主、arch 为对照） |
| `verify-9p` | **PROFILE MATCHES**，exit 0（9 条共享事实） |
| `verify-terminal` | **ALL CHECKS PASSED**，exit 0 |
| `verify-pty-handle` | **ALL CHECKS PASSED**，exit 0 |
| `verify-world-errors` | **16 passed, 0 failed** |
| 完整离线门 | **25/27 通过，0 失败**，2 个声明性跳过 |

**Fedora/RHEL 家族因此从「只有容器证据」升级为「真实 WSL 实例已验证」。**

**证据边界要写清**：这一行的 rootfs 来自 **容器镜像**，不是 Store 的 `FedoraLinux-45` 官方 WSL 镜像。差别在于**开箱形态**（Store 镜像带 systemd、带默认非 root 用户、预装更多），不在于围栏语义——上表四项「开箱差异」正是这个差别的全部。用官方 Store 镜像时这四项大概率不需要手工处理。

## 各发行版运行时前提（安装配置，非插件自动配置）

1. 会话用户 **NOPASSWD sudo**（confinement runner 前提；推荐同时安装 dsh-wsl-confine helper 闭合 retained-grant 边界，见 [安全与信任边界](../SECURITY.md)）。
2. `bash` + `python3` + util-linux 工具（unshare/setpriv/findmnt/mount）：
   - Debian/Ubuntu: `apt-get install -y python3 sudo`（util-linux/bash 预装）
   - Fedora/RHEL: `dnf install -y python3 sudo util-linux`（**联网实测：`fedora:41` 容器镜像缺 `setpriv`，必须显式装 `util-linux`**；`findmnt` 该包里就有，与 openSUSE 不同）
   - Arch: `pacman -S python3 sudo`（util-linux/bash 预装；**实测 arch 的真实 WSL 实例上这六项全部预装**，无需任何补装）
   - openSUSE-Tumbleweed: `zypper -n install -y util-linux-systemd python3 sudo` + 在 `/etc/wsl.conf` 写 `[boot] systemd=true`；**`findmnt` 由 `util-linux-systemd` 提供，基础 `util-linux` 包里没有**（实测）。默认用户是 root，建议建一个非 root 用户并设为其默认用户（见下）
   - Alpine: `apk add bash python3 sudo util-linux-misc findutils`（容器矩阵还需要 `shadow` 提供 `useradd`）
   - `getent`（登录 shell 解析用它读用户数据库）：缺失时**拒绝**并回落到 provider 的 `defaultShell`，不会把 `/bin/bash` 当作答案（实测：`getent` 缺席时 `getent … | cut` 的退出码是 `cut` 的 0，管道会把「探针没跑成」伪装成「字段为空」）。
3. Python 3.8+（PTY 桥；仅标准库依赖）。
4. **发行版的仓库签名密钥可能过期。** 实测 `opensuse/leap:15.6` 的 `openSUSE Project Signing Key` 已于 2026-06-19 过期，`zypper install` 会停在「Looking for gpg keys」并挂起（不是报错，是**无声卡住**）。绕过方式：直接 HTTP 拉 RPM 后 `rpm -U --nodeps --nosignature --force`。**这只影响容器矩阵的准备步骤，不影响插件本身的围栏语义。**

## 不支持 / 已知边界

| 条目 | 原因 |
|---|---|
| **WSL1** | mount namespace 语义完全不同（syscall 翻译层），未测试，明确不支持。插件要求 WSL2。 |
| **NixOS-WSL** | 无 /usr 语义与不同的 profile 管理，未测试。 |
| **busybox-only 极简镜像** | 缺 util-linux（setpriv/findmnt）与 bash；安装 util-linux-misc + bash 后可用（Alpine 实测即此形态）。 |
| **setpriv 不支持 `--no-new-privs` 的发行版** | 受限模式**不运行**：direct runner 测到 `false` 即拒绝（`NO_NEW_PRIVS_UNSUPPORTED`），而 helper 的降权用同一个标志、同样失败关闭——但**不是 exit 97**：helper 没有该标志的预检（`--no-new-privs` 在 `dsh-wsl-confine.sh` 只出现一次，就是那条无条件的 `exec setpriv --no-new-privs …`，实测），旧 setpriv 在选项解析处即失败，**exit 1** 且不打印 `dsh-wsl-sandbox: setup failed` 标记，所以 `shell.js` 的 `runnerFailed`（退出码 97 **且** 带标记）把它归为**普通命令失败**而不是 setup 失败。命令确实没有运行，因此安装 helper 不构成绕过；修法是升级发行版的 util-linux——**判据可探测，不要按版本号判断**：在发行版里 `setpriv --help` 的输出中能 grep 到 `--no-new-privs` 才算支持（无输出即不支持），版本号无法回答这个问题（发行版会 backport）。`enforcement: 'partial'` 不是这一条的 caveat——它对每次受限运行都成立（见 [安全与信任边界](../SECURITY.md)，读到的是同一事实）。 |
| **会话用户是 root 的发行版** | helper 的属主闸门有一行 `[ -w "$f" ] && ok=no`：root 对任何非只读挂载上的文件都返回「可写」（root 可覆盖 DAC 权限），所以**闸门恒判「可被替换」→ 拒绝 helper**，回落到 direct runner。这是 **fail-closed 的正确行为**，不是缺陷。实测对照：同一谓词在 arch 上以 root 身份跑同样返回可写（`[ -w ]` → 真），说明它是 root 语义而非某个发行版的兼容性问题。**处置**：建一个非 root 会话用户并设为其默认用户；`openSUSE-Tumbleweed` 与 `fedora:41` 容器镜像的默认用户都是 root，都已按此处置后通过全套验收。 |
| **容器内运行插件行** | 矩阵验证的是发行版 userland 与插件的兼容性；插件的 WSL 服务（fs-wsl 等）运行在真实 WSL 发行版内，不在容器里。 |

## 新增发行版家族的检查单

1. `wsl --install -d <Distro>` → 创建用户 → 配置 NOPASSWD sudo。
2. 安装 python3 + 确认 bash/util-linux。
3. `DSH_WSL_DISTRO=<name> node scripts/verify-confinement.mjs && node scripts/verify-world.mjs`。
4. GUI 点 W → 走完门控流程 → 会话里跑 `uname -a`。
5. 在本矩阵追加一行 + 提交。
