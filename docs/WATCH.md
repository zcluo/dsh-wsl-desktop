# 文件变更监听（WSL 工作区）— dsh-wsl-desktop

本文是 WSL 工作区文件变更监听的完整记录：为什么必须轮询、两个策略各自承诺什么、实测代价、未测与已知边界、以及为什么不把原生监听当后备。README 只保留结论与入口。

## 为什么需要轮询

消费者链条是 `WorkspaceChangeFeed.follow` → `ctx.fs.watch` → `LocalFileSystem.watch` → chokidar → `fs.watch`，而它在共享的第一环就断了：**`fs.watch` 在 `\\wsl.localhost\…` 上构造即抛 `EISDIR`——目录目标与文件目标都抛**（实测）。`LocalFileSystem.watch`（`packages/fs/fs-local/src/index.ts:69-89`）两个分支都监听**目录**：目录目标监听目标自己，文件目标监听它的 `dirname`；所以 EISDIR 堵死的是每一个 WSL 目标，`changes.ts:79-89` 把它包成 `workspace-file/watch-unsupported`。消费方（侧栏文件树）收到该错误后不报失败、保留手动刷新（`directory-node.ts:124-131`）。用户可见的影响因此是：**WSL 工作区的侧栏文件树失去实时刷新，手动刷新仍在**——是声明的降级，不是崩溃，也不是静默失效。

本行的修法是给这个世界自带一个共享支持的策略：**只依赖 `node:fs` 的用户态轮询**。`lib/wsl/watch.js` 是唯一 owner（两个策略 + 纯函数策略选择 + 可注入 io 的 `startWatch`），`lib/wsl/fs.js` 覆写 `watch`，把它接到 `ctx.fs.watch` 上。

## 两个策略

`watchStrategyFor` 是纯函数：`directory` → `dir-entries`，`file` 与 `absent` → `path-stat`。「尚不存在 → 轮询 stat」直接满足基类 `watch` 契约原文的 *an absent path to observe for creation*：路径出现即失效。

**`dir-entries`（目录目标）**：每 tick 一次 `readdir`，把条目**名字**集合变成键（排序后以 NUL 连接）与上一 tick 比较，变化才通知一次。

- **失效条件是条目集合**：新增 / 删除 / 改名可见；子项的内容变化不可见（见「未测与已知限制」）。
- 首轮读取只建立基线、**不报变化**——对齐宿主后端的 `ignoreInitial: true`。少了这一条，每个 watch 一开口就会报一次假变化。
- `ENOENT` 是「空集合」而不是错误：目录被删与重现都通知（空目录这一个例外见「未测与已知限制」）。
- tick 不叠加（上一 tick 未完成时跳过本 tick），且**每 tick 至多一次通知**。合并不是优化：`changes.ts:95-102` 的帧由该目标构成，逐子项通知会产出 N 个关于**同一个目录**的完全相同帧——轮询结构把这个风暴消掉了。

**`path-stat`（文件与尚不存在的路径）**：`fs.watchFile(hostPath, { interval, persistent: true }, listener)`，mtime / size / ino 任一变化即失效，启动时不报变化。disposer 只摘**自己那份**注册（`unwatchFile` 带 listener）：Node 按路径对 StatWatcher 引用计数，不带 listener 的 `unwatchFile(path)` 会连别的消费者一起摘掉。

监听的路径取 `target.targetKey`（宿主拼写），**不是** `processPath`——后者返回 Linux 拼写，在宿主侧解析它会去监听另一个东西（`/home/…` 变成 `E:\home\…`），而且通常静默：那个路径多半不存在。

`WATCH_INTERVAL_MS = 300`，是常量而不是配置项：两个要发布的策略实测都是 0ms CPU / 3s，没有可拉的杆；真需要按部署调时，它是唯一一处。

## 实测数字

条件：发行版 `debian-dev`，目录 200 项，interval 300ms（本机实测，2026-10-14）。

| 策略 | 空闲 CPU（本进程） | 子项内容变化 | 新增 / 删除 | 延迟 |
|---|---|---|---|---|
| 目录 `readdir` 名称集合（**要发布**） | **0ms CPU / 3s** | 不可见 | 可见 / 可见 | **2–3ms** |
| 文件 `fs.watchFile`（**要发布**） | **0ms CPU / 3s** | 可见 | — | **52ms** |
| 对照：`readdir` + 每项 `stat` | 594ms / 3s | 可见 | 可见 / 可见 | 247–655ms |
| 对照：chokidar `usePolling`（**不可发布**：插件没有 `dependencies`） | 624ms / 3s | 可见 | 可见 / 可见 | 37–168ms |

mtime 经共享会及时更新（实测 `advanced`）——这是轮询类修法成立的前提：轮询只在共享上的时间戳真的动时才看得见变化。

## 未测与已知限制

- **`readdir` 的代价计在 9P 服务侧，不在本进程**：每 tick 一次往返，按条目数线性。本进程 0ms CPU / 3s **不等于**全机开销为 0；超大目录（>10k 项）的代价未量化。
- **只在 `debian-dev` 上实测**：其他发行版共用同一 WSL2 内核与 9P 栈，但没有逐个复测。
- **目录目标对子项的内容变化不可见**（设计使然，不是缺陷）：要跟一个文件的内容，就按**文件路径**监听它。唯一活跃的目录消费方（侧栏文件树）收到任何帧都只重新列目录，本来也不需要内容感知。
- **`readdir` 对一个文件抛 `ENOTDIR`，它以 error 而不是「缺席」到达消费者**（实测）。可达路径只有一条：目标在 `watch` 里被 stat 成目录之后、某个 tick 之前不再是目录——`dir-entries` 分支的竞态；`path-stat` 分支不调用 `readdir`，碰不到。后果是那次通知以失败上报（走到 `changed(error)`），不会被读成「目录没了」。
- **缺席目录与存在的空目录共用同一个键**：`readEntryKey` 把 `ENOENT` 映射成空串，而空条目集合的键**也是**空串，于是空目录的创建与删除**不通知任何人**（前后同键，判为无变化）。窗口很窄，只影响「空目录 ↔ 不存在」这一个转换：目录里一旦有内容，新增 / 删除 / 改名照常通知。本轮以声明处置（代码保持现状）；若要修，修法是把「缺席」映射成一个 `readdir` 不可能产出的哨兵键，并加一条离线钉子（缺席 → 空目录出现必须通知）。
- **发行版内 `inotify` 在 `/mnt/c` 上 0 事件**（ext4 与 tmpfs 上 4/4 事件类型齐全，`/mnt/c` 上连脚本自己的写入都看不到）——这是「发行版内 inotify 桥」（方案 2）暂缓的理由，也是它的边界。触发条件：出现一个**必须**感知目录内子项内容变化、且目录很大的消费方时，加第三个策略；`lib/wsl/watch.js` 已是唯一 owner，那是加法而不是改结构。

## 为什么不把原生监听当后备

两条捷径都被明确拒绝：

- **`process.env.CHOKIDAR_USEPOLLING = '1'`**：一行就能让 chokidar 转轮询，但它是**进程级**环境变量——同一实例里的 **Windows 工作区**监听会一起变成轮询，副作用跨出本插件（不变量：不改 Windows 工作区行为）。而不用这个开关时，chokidar 自己不会为 UNC 转轮询（4.0.3 唯一的自动轮询分支是 IBM i），所以「让 chokidar 原生处理共享」这条路本来就不存在。
- **`import 'chokidar'`**：插件 `package.json` **没有 `dependencies`**，chokidar 只是宿主 `@deepseek-ai/dsh-fs-local` 的传递依赖；从插件里 reach 传递依赖在 pnpm 严格布局下根本解析不到——正是 `docs/UPSTREAM-PROPOSALS.md` 记的那类解析脆弱。

宿主侧的原生监听**原样保留**：本插件不替换 Windows 工作区的任何东西。所以本行的轮询不是「原生监听的后备」，而是 WSL 世界自己的监听策略。

## 钉子在哪

`scripts/verify-watch.mjs`（离线，**无前置条件，因此从不跳过**；清单与单跑命令见 `docs/VERIFICATION.md`）钉住：策略选择、条目集合差分与首轮基线、`ENOENT` 与真实错误的分流、tick 不叠加、disposer 幂等与晚到 abort、以及 stat 策略只摘自己那份注册。它靠 `startWatch` 的**可注入 io 缝**逐 tick 手驱动——不 sleep、不赛跑，测的是行为而不是本机速度。最后一节是刻意的例外：**不传 io**，用模块自己的默认缝在真临时目录上跑一次目录策略与 stat 策略；注入的假 io 对「默认缝写错了」是瞎的——回调风格的 `readdir` 会让每个 WSL 目录目标在基线读取时就 reject，而注入缝的每一行仍然绿（本系列实测）。

`scripts/verify-post-restart.mjs` 的三行活体证据（需要已安装插件 + 运行中的宿主）：`fs.watch.file`（发行版内改文件 → 收到通知）、`fs.watch.dir`（发行版内新增条目 → 收到通知）、`fs.watch.native`（**诚实状态行**：原生 `fs.watch` 在共享上仍抛 `EISDIR`）。前两行断言的是**通知真的到了**（`notified > 0` 且 `watchError === null`），不是「调用返回了」——没 arm 成功的行会读成 `notified: 0`，看着像什么都没发生。第三行把「覆写仍有存在理由」记成证据：哪天共享不再抛 EISDIR，它会红，并告诉维护者可以删掉覆写。等待窗口是 5 × `WATCH_INTERVAL_MS`（1500ms），对实测 2–52ms 是 30 倍余量，poll 从不跑时仍会红。

文档本身也在被钉：`docs/WATCH.md` 与 `docs/WATCH.en.md` 由 `scripts/verify-docs.mjs` 的**声明对表**校验——两个语言版本必须命名同一批产物，而未声明的对根本不在校验范围内，并且这一点不会以任何红报出来。
