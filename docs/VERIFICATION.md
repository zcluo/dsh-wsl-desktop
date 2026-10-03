# 校验：套件清单与 SKIP 裁定 — dsh-wsl-desktop

本文记录逐套件职责、以及聚合器读 SKIP 的裁定规则。README 只保留两条聚合命令。

```powershell
node scripts/verify-all.mjs          # 全部离线套件（等价于下面这些）
node scripts/verify-all.mjs --live   # 追加需要已安装插件 + 运行中宿主的套件
```

**聚合器怎么读 SKIP（提交 `2d44dd6`）**：套件的退出码 2 是它自己的 SKIP（本机上评估不了某项检查），而聚合器只读退出码、看不见套件自己那段 `SKIP` 说明——所以一条跳过**只在** `scripts/verify-all.mjs` 的 `DECLARED_SKIPS` 点名了该套件、并给出允许它的**前提**时才算数。摘要行因此是 `N/M suites passed (K declared skip: <名称>)`，每条 `SKIP` 下面打印它声明的前提；**未声明**的跳过判红（`FAIL (undeclared skip) <套件>`，并打印「往 `DECLARED_SKIPS` 补一条，或去掉逼出这条跳过的前提」的修法），聚合以退出码 1 结束——退出码 0 从此不能与「有一条套件从未跑过」共存。声明的前提在本机不成立时该条**休眠**：套件照跑，只多打印一行 `NOTICE`，不判红。声明**失效**（套件改名 / 源码里已经没有 exit-2 分支 / 不在套件列表里）在**任何套件运行之前**判红，因为那是仓库自身的腐烂、操作者当场就能清掉。这套裁定由 `scripts/verify-all-skip.mjs` 钉住：它用夹具套件构建聚合器的副本（放在仓库外），读真进程的真退出码与真摘要。它还从真实的 `STANDALONE` 列表与各套件源码里的 exit-2 **形状**重新推导声明表的两个方向：能跳过却没声明的套件当场点名，声明了却没有该形状的条目同样点名。

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
node scripts/verify-client-ui.mjs    # 浏览器半边的静态检查（不注册槽位、定位几何、宿主调用）
node scripts/verify-client-dom.mjs   # 浏览器半边的行为检查：在 jsdom 里跑真实 factory（挂载位置 / 放不下时的收敛 / 隐藏跟随 / 工作区行图标）
node scripts/verify-modules.mjs      # 宿主半边的结构性钉子：发行版接缝 + `exports` 清单（`./client` 是硬契约）
node scripts/verify-docs.mjs         # 文档对一致性：声明过的双语文档必须命名同一组产物（语言后缀规范化 + 全角标点分词）
node scripts/verify-sync.mjs         # 对一次性 profile 跑真 sync.ps1：代次保留四场景（链接可用 / 悬空 / 无链接 / 从未 stage 过）
node scripts/verify-all-skip.mjs     # 聚合器对 SKIP 的裁定：未声明的跳过判红 / 已声明的报 SKIP 并点名前提 / 失效声明在任何套件运行之前先判红
node scripts/verify-route.mjs        # 活体：验收路由（需要运行中的宿主）
node scripts/inspect-live-client.mjs # 读宿主真正投放的 client bundle（可带若干标记串）
.\scripts\sync.ps1                   # stage 进 profile；已装过时同时把链接重指向新一代（首次安装仍由 plugin_manager 接线）
```

发行版与用户不再硬编码：`DSH_WSL_DISTRO` / `DSH_WSL_USER` / `DSH_WSL_HOME` 可覆盖，默认从 `wsl.exe` 现读。
