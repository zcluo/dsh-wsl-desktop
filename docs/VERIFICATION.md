# 校验：套件清单与 SKIP 裁定 — dsh-wsl-desktop

本文记录逐套件职责、以及聚合器读 SKIP 的裁定规则。README 只保留两条聚合命令。

```powershell
node scripts/verify-all.mjs          # 全部离线套件（等价于下面这些）
node scripts/verify-all.mjs --live   # 追加需要已安装插件 + 运行中宿主的套件
node scripts/verify-all.mjs --receipt  # 同上，另写一份可分享收据到 verify-receipt.json
```

## 收据：把「跑过」变成「别人能核对」

这套门是**本机的**，所以第三方要判断「这些声明在他的机器上成不成立」，需要的不是一句通过，而是**什么跑了、什么没跑、为什么没跑**——最后一项在绿色的摘要里是看不见的。

`--receipt[=路径]` 写出一份 JSON 收据（默认 `verify-receipt.json`），逐套件记录 `passed` / `skipped` / `failed` 与**判定的理由**：

| reason | 含义 |
|---|---|
| `passed` | 退出码 0 |
| `declared-skip` | 退出码 2，且 `DECLARED_SKIPS` 点了名——行里带着**允许它跳过的那条前提** |
| `checks-failed` | 非零且非跳过：**它跑了，并且判错了** |
| `undeclared-skip` | 退出码 2 却没声明：**判作 failed**，与聚合器的裁定一致 |
| `stopped` | 被聚合器的上限杀死或收到信号：它**什么也没 establish**，所以是 failed，但理由与缺陷分开 |
| `unstarted` | 进程**根本没起来**（EPERM、二进制缺失）：同样什么也没 establish，但「从未运行」与「跑错了」是两回事——收据存在的意义就是让人分得清这两者 |

`stopped` / `unstarted` / `checks-failed` 三者**必须可区分**：把「没启动」归进「检查失败」正是这份产物要防的那种谎，`verify-receipt.mjs` 对三种结局各钉一条。

**失败的原因随裁定一起走。** 聚合器以前用 `stdio: 'inherit'` 跑套件，于是它**一个字节都看不到**套件打印了什么，`checks-failed` 只能记成 `exit 1`，真正的 `FAIL` 行只存在于调用方碰巧留下的那段流里——一次偶发失败因此无法诊断（2026-11-15 实测：同一个门连续 20+ 次复现不出来，而当时的失败原因已经丢失）。现在聚合器捕获每个套件的输出并立即回显，`FAIL` 行进入收据的 `detail`。代价是套件的输出**按套件粒度出现**而不是逐行实时；每个套件前的 `=== 名称 ===` 仍标记进度，且 `scripts/` 里没有任何套件读 TTY 或 stdin（已核查）。这条由 `verify-all-skip.mjs` 的 C 段钉住：夹具套件故意失败，收据里必须带着它自己那句 `FAIL`。

两条硬规则，都由 `verify-receipt.mjs` 钉住：**没跑的套件必须被点名**（不压缩成一个计数），**收据不得携带机器路径**（它是要贴进 issue 的，所以适用与受跟踪文件相同的隐私标准；命中即拒绝写出并以 1 退出）。

收据**不进仓库**（`.gitignore` 里有 `verify-receipt*.json`）：它描述的是**一台机器的一次运行**，提交它会让某个操作者的环境看起来像项目本身的声明。

**聚合器怎么读 SKIP（提交 `2d44dd6`）**：套件的退出码 2 是它自己的 SKIP（本机上评估不了某项检查），而聚合器只读退出码、看不见套件自己那段 `SKIP` 说明——所以一条跳过**只在** `scripts/verify-all.mjs` 的 `DECLARED_SKIPS` 点名了该套件、并给出允许它的**前提**时才算数。摘要行因此是 `N/M suites passed (K declared skip: <名称>)`，每条 `SKIP` 下面打印它声明的前提；**未声明**的跳过判红（`FAIL (undeclared skip) <套件>`，并打印「往 `DECLARED_SKIPS` 补一条，或去掉逼出这条跳过的前提」的修法），聚合以退出码 1 结束——退出码 0 从此不能与「有一条套件从未跑过」共存。声明的前提在本机不成立时该条**休眠**：套件照跑，只多打印一行 `NOTICE`，不判红。声明**失效**（套件改名 / 源码里已经没有 exit-2 分支 / 不在套件列表里）在**任何套件运行之前**判红，因为那是仓库自身的腐烂、操作者当场就能清掉。这套裁定由 `scripts/verify-all-skip.mjs` 钉住：它用夹具套件构建聚合器的副本（放在仓库外），读真进程的真退出码与真摘要。它还从真实的 `STANDALONE` 列表与各套件源码里的 exit-2 **形状**重新推导声明表的两个方向：能跳过却没声明的套件当场点名，声明了却没有该形状的条目同样点名。

## 每个套件怎么报告

每个套件都通过 `scripts/suite-shell.mjs` 的 `makeChecker` 报告结果，不再各自实现 `check()`。`verify-all.mjs` 会扫描套件源码，发现本地 `check()` 外壳就判红——七份复制的外壳曾各自漂移（其中一份的 PASS 记号都不一样），收敛后由这一行防回归。

两句相关约束：套件自己的 **PASS 记号**要显式传进 `makeChecker`（默认是 `OK  `，多数套件是 `PASS`），这样输出不变；而复制式变异套件（`verify-fs-fence-skip`、`verify-9p-skip`、`verify-confinement-skip`）会**复制整棵套件树**去跑变体，所以它们必须把 `suite-shell.mjs` 也加进复制清单，否则副本在 import 阶段就崩，变异段落会读成一个假的“没有 FAIL 行”。

单跑某一项：

```powershell
node scripts/verify-world.mjs        # 路径互译 + 在发行版里执行命令 + 目录事实 + exec 边界拒绝
node scripts/verify-preset.mjs       # 预设重写（对着随附 standard 预设跑）
node scripts/verify-fs-fence.mjs     # fs 围栏的纯逻辑：包含性、跨发行版、可写根推导
node scripts/verify-fs-fence-skip.mjs # 围栏「机器只有一个发行版」时的 SKIP 报告：前提 / 逐条未评估的断言 / 补救，退出码 2；有第二个发行版时四条断言照跑
node scripts/verify-9p.mjs           # 9P 共享原语画像 + 身份映射（围栏负载假设）
node scripts/verify-9p-skip.mjs      # 9P 探针「机器只有一个发行版」时的 SKIP 报告：内容、退出码 2、以及不早退
node scripts/verify-confinement.mjs  # 约束围栏：工作区可写、外部被拒、属主正确、含空格路径
node scripts/verify-terminal.mjs     # PTY 桥：resize / 前台进程组 / 信号 / 终止
node scripts/verify-pty-handle.mjs   # JS 终端句柄（对着真实桥跑）
node scripts/verify-client-ui.mjs    # 浏览器半边的静态检查（不注册槽位、定位几何、宿主调用、快捷键注册与清理）
node scripts/verify-client-dom.mjs   # 浏览器半边的行为检查：在 jsdom 里跑真实 factory（挂载位置 / 放不下时的收敛 / 隐藏跟随 / 工作区行图标 / 快捷键提示与打开对话框）
node scripts/verify-modules.mjs      # 宿主半边的结构性钉子：发行版接缝 + `exports` 清单（`./client` 是硬契约）+ 授权准入（inject 白名单，以及 `rejectRequest` 对两种访问器的行为与失败方向）
node scripts/verify-docs.mjs         # 文档对一致性：声明过的双语文档必须命名同一组产物（语言后缀规范化 + 全角标点分词）
node scripts/verify-sync.mjs         # 对一次性 profile 跑真 sync.ps1：代次保留四场景（链接可用 / 悬空 / 无链接 / 从未 stage 过）
node scripts/verify-all-skip.mjs     # 聚合器对 SKIP 的裁定：未声明的跳过判红 / 已声明的报 SKIP 并点名前提 / 失效声明在任何套件运行之前先判红
node scripts/verify-watch.mjs        # 监听策略：策略选择、条目集合差分与首轮基线、absence 与错误的分流、tick 不叠加、disposer 幂等与晚到 abort（无前置条件，因此从不跳过）
node scripts/verify-search.mjs       # 发行版内搜索的纯逻辑：glob 翻译与两条整条 argv 金标向量、两个解析器与限额、失败词汇分类（无前置条件，因此从不跳过）
node scripts/verify-protocol.mjs     # 浏览器错误目录与路由分类器：code、双语、remedy、安全 params、domain→wire 映射（从不跳过）
node scripts/verify-release-preflight.mjs # 发布预检的纯逻辑：已装 patch 的 developerTools、bootstrap 信封分类、client 标记（从不跳过）
node scripts/verify-world-errors.mjs # 注入 run 的 world 类型化失败：目录不存在 vs 发行版不可达、未知用户、默认用户探针失败（从不跳过）
node scripts/verify-receipt.mjs       # 可分享收据的纯逻辑：计数、未声明跳过判红、被中止的套件与真失败区分、不含机器路径、同样输入字节相同（从不跳过）
node scripts/verify-host-contract.mjs # 宿主 manifest 与代码互查；依赖可达时核对宿主包导出形状，只对解析不到的宿主包按模块 SKIP
node scripts/verify-doctor.mjs       # 体检解析器、缓存与组装，外加一条 live 行（无法解析出发行版时按声明 SKIP）
node scripts/verify-route.mjs        # 活体：验收路由（需要运行中的宿主）
node scripts/verify-live-env.mjs     # 活体：--live 的第一道预检——dev surface、版本、目录与投放的 client 标记（401 时打印切换步骤）
node scripts/inspect-live-client.mjs # 读宿主真正投放的 client bundle（可带若干标记串）
.\scripts\sync.ps1                   # stage 进 profile；已装过时同时把链接重指向新一代（首次安装仍由 plugin_manager 接线）
```

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。

## 改过 lib/ 之后重钉图表证据

`docs/diagrams-src/*.json` 里的 `revision` 钉住了"最后一次改动 `lib/**` 的提交"，`verify-diagrams` 会检查它是祖先。所以**每次改了 `lib/` 都要重钉**，否则套件变红。整条流程（重钉 → 清旧回执 → finalize → visual-check → 去路径 → 验证）用一条命令：

```powershell
node scripts/repin-diagram.mjs architecture
```

手工做过三次都出错（过滤删除漏掉文件、旧回执挡住重跑），所以它现在是脚本。回执里的绝对路径由 `scripts/scrub-receipts.mjs` 清除，这一步也在脚本里；`release-check` 会以 `--check` 模式兜底，防止忘记清理的回执进入发布件。