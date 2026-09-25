# 发行版支持矩阵 — dsh-wsl-desktop

> 验证方法：**userland 兼容轴**用 docker 容器逐家族实测（驱动：`scripts/distro-matrix.sh`，夹具由 `scripts/generate-fence-fixture.mjs` 从 `buildNamespaceScript` 生成——即插件真实发布的围栏脚本）；**WSL 集成轴**（wsl.exe 调用链、9P、sudo 交互）需要每个家族一个真实 WSL 实例，按检查单执行。
> 共享不变式（一次验证覆盖全机所有 WSL2 发行版）：WSL2 内核行为（mount ns / NO_NEW_PRIVS / user-ns 限制）、WSL 基础设施（9P、interop）、Windows 侧全部逻辑。

## 矩阵（2026-09-25 实测，宿主 debian-dev + Docker 29.8.1）

| 家族 | 镜像 | unshare/setpriv/findmnt/mount | bash | python3 | NNP 支持 | 围栏实测 | 结论 |
|---|---|---|---|---|---|---|---|
| Debian | debian:12 (util-linux 2.38) | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS（FENCE-OK / INSIDE-OK / ESCAPE-DENIED / exit 0） | ✅ 支持 |
| Ubuntu | ubuntu:24.04 | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持 |
| Fedora/RHEL | fedora:41 | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持 |
| Arch | archlinux | ✅✅✅✅ | ✅ | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持 |
| Alpine (musl) | alpine:3.20 (util-linux 2.40) | ✅（util-linux-misc） | ✅（需安装） | ✅（需安装） | ✅ | ✅ PASS | ✅ 支持（需 bash + util-linux-misc） |
| openSUSE | leap:15.6 | — | — | — | — | — | ⚠️ 本环境未测（容器内 zypper 源经双重 NAT 不可达）；真实 WSL 实例可按检查单补测 |

**真实 WSL 实例已验证**：debian-dev（Debian 13.7）✅、debian ✅——含 wsl.exe 调用链、9P 路径、sudo 交互、PTY 桥全链。

## 各发行版运行时前提（安装配置，非插件自动配置）

1. 会话用户 **NOPASSWD sudo**（confinement runner 前提；推荐同时安装 dsh-wsl-confine helper 闭合 retained-grant 边界，见 README）。
2. `bash` + `python3` + util-linux 工具（unshare/setpriv/findmnt/mount）：
   - Debian/Ubuntu: `apt-get install -y python3 sudo`（util-linux/bash 预装）
   - Fedora/RHEL: `dnf install -y python3 sudo`（util-linux 预装）
   - Arch: `pacman -S python3 sudo`（util-linux 预装）
   - Alpine: `apk add bash python3 sudo util-linux-misc findutils`
3. Python 3.8+（PTY 桥；仅标准库依赖）。

## 不支持 / 已知边界

| 条目 | 原因 |
|---|---|
| **WSL1** | mount namespace 语义完全不同（syscall 翻译层），未测试，明确不支持。插件要求 WSL2。 |
| **NixOS-WSL** | 无 /usr 语义与不同的 profile 管理，未测试。 |
| **busybox-only 极简镜像** | 缺 util-linux（setpriv/findmnt）与 bash；安装 util-linux-misc + bash 后可用（Alpine 实测即此形态）。 |
| **setpriv < 2.32（无 --no-new-privs）** | 受限模式仍可运行但文件围栏可被模型自身的 sudo 授权穿透（caveats 如实披露 `enforcement: 'partial'`）；建议升级发行版或安装 helper。 |
| **容器内运行插件行** | 矩阵验证的是发行版 userland 与插件的兼容性；插件的 WSL 服务（fs-wsl 等）运行在真实 WSL 发行版内，不在容器里。 |

## 新增发行版家族的检查单

1. `wsl --install -d <Distro>` → 创建用户 → 配置 NOPASSWD sudo。
2. 安装 python3 + 确认 bash/util-linux。
3. `DSH_WSL_DISTRO=<name> node scripts/verify-confinement.mjs && node scripts/verify-world.mjs`。
4. GUI 点 W → 走完门控流程 → 会话里跑 `uname -a`。
5. 在本矩阵追加一行 + 提交。
