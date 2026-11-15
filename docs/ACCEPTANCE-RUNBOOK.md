# 需要一台真实 Windows + WSL2 的验收手册

本文是**一份给操作者的检查单**，不是规范。它列出那些**只能在真实 Windows 主机 + WSL2 上完成**的验收项——本仓库的离线门跑不了它们，因为它们在派生进程（`wsl.exe`）被禁止的环境里只能得到 SKIP，而 SKIP 不等于通过。

**为什么单独写一份**：这些项曾经散落在多个文档的「待人工核验」段落里，结果是每次都要重新拼。这里把它们集中，并给每一条写明**命令、期望输出、失败时读哪里**。

**不做的事**：本手册不修改任何代码。它产出的证据（收据、矩阵行）需要人工判断后再入库，因为一次运行描述的是**一台机器**，而矩阵行描述的是**一个发行版家族**——后者可以入库，前者只能贴进 issue（见 [校验](VERIFICATION.md) 的「收据」一节）。

---

## 0. 前置条件

| 要求 | 怎么确认 |
|---|---|
| Windows 10/11 + WSL2（不是 WSL1） | `wsl.exe -l -v` 里目标发行版的 VERSION 是 `2` |
| 至少一个发行版已运行过 | `wsl.exe -d <distro> -- true` 返回 0 |
| 会话用户可免密 sudo（**仅受限模式需要**） | `wsl.exe -d <distro> -- sudo -n true` 返回 0 |
| Node ≥ 22.19（宿主侧） | `node --version` |
| 一个 git 工作树 | `git -C <repo> rev-parse --is-inside-work-tree` 打印 `true` |

**逐项说明**：

- 第 3 条不满足**不是阻塞**：受限模式会 fail-closed，但只要用 `danger-full-access` 就能工作。缺的是围栏，不是可用性。详见 [Linux 侧约束](CONFINEMENT.md)。
- 第 5 条不满足会让 `verify-diagrams` 与 `verify-package` 都 SKIP（它们分别需要 git 与 npm），矩阵会显示为声明性跳过而不是失败。

---

## 1. 完整离线门 + 收据

这是**最重要的一条**：它同时验证聚合器、所有能跑的套件、以及新增的收据写出。

```powershell
cd <repo>
node scripts/verify-all.mjs --receipt
```

**期望**：

- 末行是 `N/M suites passed ...`，其中 **`M` 现在是 27**（新增了 `verify-receipt.mjs`）；
- 退出码 0；
- 打印 `receipt written to verify-receipt.json — paste it into an issue to make this run checkable`。

**实测基线（2026-11-14，win32-x64，debian-dev 可用）**：**25/27 通过、2 个声明性跳过、0 失败**。两个跳过是 `verify-modules` 与 `verify-host-contract`，前提相同：插件根目录没有 `node_modules`，所以 `lib/index.js` 无法按宿主依赖解析。收据里 `counts = {total: 27, passed: 25, skipped: 2, failed: 0}`。

**这条基线与旧的 24/26 不可直接比较**：套件数从 26 变 27，且旧数字取自一个 `wsl.exe` 不可用的会话（当时 12 个套件只能 SKIP）。**数字不是不变式**——它是「本机满足了多少前置条件」的函数。判断这次运行是否健康，看的是：

1. **0 failed**（没有 `FAIL` 行，也没有 `undeclared skip`）；
2. 每一条 `SKIP` 都有 `declared skip:` 与它声明的前提；
3. 收据里 `counts.failed` 为 `0`。

**失败时读哪里**：

| 症状 | 读 |
|---|---|
| 某个套件 `FAIL (exit 1)` | 直接单跑它：`node scripts/<suite>`，输出比聚合器详细 |
| `FAIL (undeclared skip)` | `DECLARED_SKIPS` 少一条，或该套件多了一个 exit-2 分支——见 [校验](VERIFICATION.md) |
| `FAIL (exit 1) verify-diagrams` | 改了 `lib/` 后没重钉图表：`node scripts/repin-diagram.mjs architecture` |
| 收据没写出且打印 `machine layout` | 这是收据写入器的缺陷，**请开 issue**，不要手动改收据 |

**把收据贴进 issue 时**：先看一眼 `rows` 里每条 `skipped` 的 `precondition` 是否描述了你机器的真实情况。收据的价值在于「什么没跑、为什么」，一条写错的前提比没有前提更糟。

---

## 2. 发行版支持矩阵

这是 `SECURITY.md` 里**现在唯一的发行版分发障碍**：已实测的只有 Debian 与 Ubuntu，其余家族只在容器里按 userland 兼容轴验过，不是真实 WSL 实例。

### 2.1 有第二台机器或第二个发行版时：容器矩阵

在**有 docker 的 WSL 发行版内**（如 `debian-dev`）跑：

```bash
node scripts/generate-fence-fixture.mjs      # 夹具是生成的，不随仓库提交
bash scripts/distro-matrix.sh
```

**期望**：每个家族一行，六列（镜像 / 包管理器 / 工具可用性 / NNP / 围栏结果 / 结论）。夹具缺失时脚本会以退出码 2 报 SKIP 并给出补救命令——**这是正确行为，不是失败**。

**注意**：`distro-matrix.sh` 验证的是**发行版 userland 与围栏脚本的兼容性**，不是 WSL 集成（`wsl.exe` 调用链、9P、sudo 交互）——后者需要真实 WSL 实例。

### 2.2 真实 WSL 实例：逐家族检查单

对每个要新增的家族（例如 openSUSE）：

```powershell
wsl --install -d <Distro>
# 创建用户，配置 NOPASSWD sudo
```

```bash
# 在发行版内
apt-get install -y python3        # 或 dnf / zypper / pacman 对应命令
command -v bash unshare setpriv findmnt getent python3
setpriv --help | grep -q -- --no-new-privs && echo "NNP supported"
```

```powershell
# 回到 Windows
$env:DSH_WSL_DISTRO = "<Distro>"
node scripts/verify-confinement.mjs
node scripts/verify-world.mjs
node scripts/verify-doctor.mjs
```

**期望**：`verify-confinement` 与 `verify-world` 退出码 0；`verify-doctor` 的 live 行能解析出该发行版。

**然后手工确认 GUI 一侧**（这三条自动化不了）：

1. 点侧栏 **W** → 选该发行版 → 选目录 → 创建会话，preset 标签应显示 `WSL · <base>`；
2. 同一 W 按钮应列出该发行版**及其目录**；
3. 打开该会话的**终端面板**，提示符应是发行版自己的 shell（不是 PowerShell）。

**通过后**，在 [发行版支持矩阵](DISTRO-SUPPORT.md) 表格里追加一行，并写明「真实 WSL 实例已验证」或「容器 userland 已验证」——**这两者的证据强度不同，不要混写**。

**已经这样验过一次的例子**：Arch Linux（2026-11-14）。`DSH_WSL_DISTRO=arch` 下 `verify-confinement` / `verify-world` / `verify-doctor` / `verify-fs-fence` / `verify-9p` / `verify-terminal` / `verify-pty-handle` / `verify-world-errors` 全部 exit 0，完整离线门 25/27、0 失败。全套命令与实测值见 [发行版支持矩阵](DISTRO-SUPPORT.md) 的「arch 的真实 WSL 实例实测」一节。

### 这三条为什么不能省——一次真实记录

2026-11-14 的 GUI 核验在这三条上**全部失败**，而当时的离线门是 25/27 全绿、`verify-client-ui` 与 `verify-client-dom` 也全绿。

原因是宿主 0.2.2-rc.3 的路由准入重构（`71753fdf91`）：省略 `auth` 的路由被默认 `required` 拦截、`connection.requestRejection` 被删除、认证下沉成独立服务而插件没有 inject 它。三者叠加让**每一个路由方法都失败**，而浏览器只能显示「插件内部错误 / internal」。完整分析见 [兼容性与升级](COMPATIBILITY.md) 的「0.2.2-rc.3 的路由准入重构」。

**这条路径对离线门是结构性不可见的**：`verify-route` 需要开发令牌，而开发令牌那条路恰好被同一个缺陷挡住。所以本节的三条手工核验不是"补充"，是**唯一能覆盖它的手段**。

---

## 3. live 门（需要已安装插件 + 运行中的宿主）

这些套件在仓库的 `LIVE` 列表里，只有 `--live` 才会跑。

```powershell
node scripts/verify-live-env.mjs      # 第一道预检
node scripts/verify-all.mjs --live
```

**前置**：宿主以**开发代次**运行（`developerTools: true`）。registry 形态下 `bootstrap` 回 401，这是**预期的生产形态**，不是缺陷——用 `scripts/sync.ps1` stage 一个开发代次并重启桌面。

**如果 `verify-live-env` 报 401**：说明当前是 registry 形态。按 [兼容性与升级](COMPATIBILITY.md) 的「回装顺序」操作，**注意不要在 pnpm 的 `minimumReleaseAge` 窗口外卸载插件**——那会让 profile 在一小时内没有任何插件。

---

## 4. 已知会「看起来失败但其实不是」的情形

这一节是为了防止误判。每一条都是实测过的。

| 现象 | 真相 | 依据 |
|---|---|---|
| 大量套件 `SKIP`，其中 `verify-9p`、`verify-confinement`、`verify-terminal`、`verify-pty-handle` 全跳 | 这台机器上 `wsl.exe` 不能被派生（未安装 / 不在 PATH / 沙箱禁止） | 每条 SKIP 会点名前置条件 |
| `verify-fs-fence` 在 `mkdir \\wsl.localhost\...` 上 FAIL | 发行版不可达或不可写；**不是围栏逻辑的缺陷** | 失败行会点名 `EPERM` 与补救 |
| `verify-package` SKIP | `npm` 不能被派生 | 声明性跳过的前提写明 |
| `verify-diagrams` SKIP | 不是 git 工作树，或 `git` 不能运行 | 同上 |
| 聚合器把某套件报成 `FAIL (exit 1)` 但单跑是绿的 | 该套件被聚合器的上限杀死（300 s），它**什么也没 establish** | 摘要会打印 `stopped before finishing`，收据里 `reason: "stopped"` |
| `verify-post-restart` 报「请重启」 | 宿主还在跑旧代码（Node 按 URL 缓存模块） | 重启桌面后再跑 |

---

## 4b. 偶发失败：先取证，再判断

聚合器在 2026-11-15 出现过**一次**偶发红：`verify-9p-skip.mjs` 与 `verify-confinement.mjs` 同时失败，而两者单跑都绿、紧接着重跑聚合器也绿。事后连跑 20+ 次（聚合器 4 次 + 两套件各 8 轮）**没有复现**，因此**根因至今未知**。

那次之所以查不动，是因为当时失败套件的输出**只存在于终端流里**，而只保留了摘要尾部。这一点已经修掉：聚合器现在捕获每个套件的输出，`FAIL` 行会进入收据的 `detail`（见 [验证矩阵](VERIFICATION.md) 的「失败的原因随裁定一起走」）。

**所以下次它再出现时，按这个顺序做，不要先猜：**

1. **用 `--receipt` 跑**，不要裸跑：

   ```powershell
   node scripts/verify-all.mjs --receipt
   ```

2. **打开收据**，找到 `outcome: "failed"` 的行，读两个字段：

   - `reason`：`checks-failed` / `stopped` / `unstarted` / `undeclared-skip`
   - `detail`：`checks-failed` 时是套件自己那几行 `FAIL`；`stopped` 时是被上限杀死

3. **按 `reason` 分流，不要混为一谈**：

   | reason | 含义 | 下一步 |
   |---|---|---|
   | `stopped` | 被 300 s 上限杀掉，**什么也没 establish** | 机器负载问题，不是缺陷；重跑即可，但记录是哪台机器 |
   | `unstarted` | 进程根本没起来（EPERM / 缺二进制） | 环境问题，看 `detail` 里的错误码 |
   | `checks-failed` | **它跑了，并且判错了** | 看 `detail` 里的 `FAIL` 行——这才是要找的根因 |

4. **把收据连同这一行贴进 issue**。收据不含机器路径（写出前会被拒绝），可以直接贴。

5. **不要「重跑到绿为止」。** 一次红就是一次证据；重跑掩盖的正是这份收据存在的理由。

**一种容易被误当成偶发的情况**：聚合器把某套件报成 `FAIL (exit 1)` 而单跑是绿的——见上一节的「被上限杀死」一行。那种情况 `reason` 是 `stopped`，与真正的检查失败可区分；区分它们正是 `reason` 字段存在的理由。

---

## 5. 这份手册自己怎么维护

- 每新增一条**只能真实机器验证**的检查，就加进对应小节，并写明**期望输出**与**失败时读哪里**。
- 不要把这里的结论复制进 README 或 SECURITY——那两份写的是**判定**，不是**证据**。证据留在能复现它的地方。
- 本手册的双语对偶：暂无英文版（与 [发行版支持矩阵](DISTRO-SUPPORT.md)、[上游 API 提案](UPSTREAM-PROPOSALS.md) 一致，它们同样只有中文）。若将来补英文版，需在 `scripts/verify-docs.mjs` 的声明对表里登记。
