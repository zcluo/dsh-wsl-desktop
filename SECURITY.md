# 安全与信任边界 — dsh-wsl-desktop

本文件说明这个插件把哪些东西当作信任边界、哪些**明确不当作**，以及已知边界的闭合状态。

**实测细节不在本文件。** 每一条结论都指向拥有它的文档——同一项测量写两遍就会漂移，所以这里只放判定，不放证据。

## 部署前提（不满足就不要装）

- **DSH Desktop 0.1.7+**。预设通过运行时注册而非目录加载，旧版宿主会在激活时明确拒绝。
- **WSL2**，且目标发行版满足[发行版支持矩阵](docs/DISTRO-SUPPORT.md)：会话用户需有 **NOPASSWD sudo**、`bash`、`python3`。
- **只适合插件作者本人或同信任级别的操作者长期使用。** 分发给第三方用户尚不适合（缺桌面版本门控与发行版矩阵），无人值守高价值环境明确不适合。

## 三层边界

| 面 | 边界 | 拥有它的文档 |
|---|---|---|
| 宿主侧（Windows 工作区会话） | 仍是 DSH 自带的沙箱后端（`fs-sandbox` / `pwsh-sandbox`），本插件不替换它们 | 本插件不涉及 |
| 发行版内 shell 侧 | 在 mount namespace 里把 `/` 改只读，只留工作区与一个私有 `/tmp` 可写；**约束建立失败即拒绝执行**，不裸跑 | [docs/CONFINEMENT.md](docs/CONFINEMENT.md) |
| 发行版内 fs 侧 | `WslFileSystem` 自带围栏，`writeText`/`editText` 两个变更入口都先过 `checkedTarget`，越界抛结构化 `FS_SANDBOX_DENIED` | [docs/FS-FENCE.md](docs/FS-FENCE.md) |

## 已披露的不设防面

**宿主 subprocess 面不设防是设计取舍，不是遗漏**（托管进程的终止、输出溢出与回收仍归宿主自己的 provider）。对 harness 上游的两项 API 提案见 [docs/UPSTREAM-PROPOSALS.md](docs/UPSTREAM-PROPOSALS.md)。

约束覆盖不到的部分——`/dev`、`/proc`、`/sys` 与 interop——如实报在 `enforcement: 'partial'` 里，不用"已沙箱化"这类说法掩盖。

## 围栏的已知边界：降权后保留的 sudo 授权

会话用户**保留着 runner 自己依赖的免密 sudo 授权**，所以被约束的命令可以重新调用它绕过文件围栏。两条闭合路径：

1. **专用 helper（推荐；一次安装，但每次升级插件后必须重装）**——`dsh-wsl-confine`。版本要求是**精确匹配**（不是"不低于"），所以升级插件后旧 helper 不会被选中，插件回落到直接 runner 而不是静默沿用旧围栏。
2. **NO_NEW_PRIVS（无 helper 时的自动缓解）**——探测是**三态**的，只有测到 `true` 才以 `--no-new-privs` 降权；`setpriv` 不认这个标志的发行版**根本不运行受限命令**，而装 helper 不是绕过（helper 的降权用同一个标志，同样失败关闭）。

两条路径的实际可达性、helper 的 PATH 与 BASH_ENV 硬化、以及**身份闸门只在 sudoers 不授予 `SETENV` 的部署里才是边界**（授予时它只挡无意误用、不挡伪造），都在 [docs/CONFINEMENT.md](docs/CONFINEMENT.md) 里逐条实测记录。

## 审计与报告

- 安全审计 run-1（5 候选闭环）与 run-2（4 confirmed 已修复 + 1 rejected 转加固）均完成，报告见 `security-audit-skill/dsh-wsl-desktop/run-{1,2}/`。
- 发现新问题请开 GitHub issue；如果涉及可复现的攻击步骤，请先联系维护者再公开。
