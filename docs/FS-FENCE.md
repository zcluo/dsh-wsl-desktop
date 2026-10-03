# fs 围栏：设计、实测与规则 — dsh-wsl-desktop

本文是 fs 变更入口围栏的完整记录：围栏为什么必需、可写根与比较命名空间怎么定、9P 共享的实测事实、以及「已存在却无法规范化的组件即拒绝」这条规则的推导与代价。README 只保留结论与入口。

## fs 工具的围栏

`WslFileSystem` 自带围栏：声明 `sandboxMode`，`writeText`/`editText` 两个变更入口都先过 `checkedTarget`（拒绝抛结构化 `FS_SANDBOX_DENIED`，工具层把它映射成模型可见的 `[sandbox: …]` 标记与升级提示）；包含性比较与可写根推导是纯函数，放在 `lib/wsl/fence.js`。**不是**继承官方的沙箱后端——官方后端会把本行包进第二个后端，凭空多出一层组合依赖，而围栏本来就是"可信代码里的策略检查"，放在本行即可。（最初"realm 看不到 `sandboxPolicy` 所以不能继承"的归因是错的，见下面教训 1：同 realm 的 `shell.js` 一直注入着这个服务。）

**可写根与比较命名空间**：`workspace-write` 的允许集 = 会话 cwd（工作区根）+ **发行版的** `/tmp`（9P 分享上的 `\\wsl.localhost\<distro>\tmp`，这是 Linux 侧 `/tmp/…` 请求在本世界解析到的位置；官方推导里的宿主 POSIX `/tmp` 在 Windows 上无意义）+ Windows 临时目录（经 `/mnt/<盘符>` 可达）。比较在**宿主命名空间**做：targetKey 是 Windows 拼写，UNC 前缀自带发行版身份，所以"另一个发行版里恰好同拼写的 Linux 路径"出不了界；未知模式给空允许集，即拒绝（fail-closed）。`checkedTarget` 的重规范化也从 **targetKey** 出发而不是 displayPath——displayPath 是 Linux 拼写、不带发行版，从它重解析会把路径钉到本行固定的发行版上，跨发行版 UNC 请求被静默改写（活体踩过：写进 debian-dev、读 debian 报 not found）；现在跨发行版请求直接 `FS_SANDBOX_DENIED`。

**为什么必须有围栏**：`LocalFileSystem` 从不覆写 `FileSystem.sandboxMode`。一个什么都不宣称的后端会让 `tool-fs` 的 `FsSandboxController` 对每次调用都解析不出策略（`tool-fs/src/sandbox.ts:43-50`：`defaultMode === undefined` ⇒ `escalationModes = []`、`policy = undefined`），于是 `write`/`edit` 完全不受管，能写到共享可达的任何地方，包括 `/mnt/c`——`toHostPath` 也接受直接的 `C:\…` 拼写，所以未围栏时的实际暴露面是整个 Windows 文件系统，不只是分享。

**两次失败尝试的教训**（记在这里以免再犯）：

1. 继承官方后端 → 整行不激活。当时我归因成"realm 看不到 `sandboxPolicy`"，**但真正原因是我把 `LocalFileSystem` 的 import 删掉了**（`node --check` 只解析语法，看不见未定义标识符）。症状吻合不等于归因正确。
2. 自带围栏的第一版在"拿不到 workspace root"时**一律拒绝**，把插件自己写 `/tmp` 也拒了。查清机制后才知道：官方后端的兜底同样是 `sandboxPolicy.resolve()`（不带参数），**它本身也给不出 workspace root**——root 永远是 `tool-fs` 每次调用时传进来的（`resolvePolicy` 用调用会话的 cwd 盖章）。

**因此 selftest 也改了**：它现在像真实调用方一样显式传策略 `{ mode: 'workspace-write', workspaceRoot: <会话 cwd> }`。之前它不传，是"用一个真实调用方永远不会用的方式调 fs"，那才是上次被拒的原因——不是围栏太严。

**两层钉子 + 活体验收**：`scripts/verify-modules.mjs` 钉住围栏的存在（声明 `sandboxMode`、两个变更入口都过 `checkedTarget`、拒绝用 `FS_SANDBOX_DENIED`、包含性比较有分隔符边界）；`scripts/verify-fs-fence.mjs` 离线验证纯逻辑（分隔符边界、大小写、**跨发行版同拼写路径被拒**、**无法规范化的已存在组件被拒**（Task 2，自建链接夹具与 5 条对照，见下节）、可写根推导、未知模式 fail-closed）；`verify-9p.mjs` 增补了身份映射探针（不同文件 (dev,ino) 互异、wsl.localhost/wsl$ 拼写稳定——围栏的身份回退以此为负载假设），并把「链接下的 mkdir」那行从 HAZARD 记录改成真断言。类的接线已由 `verify-post-restart.mjs` 活体验收（越界写拒绝 PASS）。

### Measured fence facts

围栏的几条开放记录不是读源码能定的：9P 共享的大小写语义、realpath 会不会穿过 Linux 符号链接、两个发行版的共享是否报告相同的 (dev,ino)、fs-fence 夹具根是否存在——这些是**这台机器**的属性，不是仓库的属性。给猜测出来的答案写修复，等于给另一台机器写修复，所以先测再记。这张表是 D8 与四条待定记录（token / argv / FIFO / budget）的判定输入。

`scripts/probe-fence-facts.mjs` 只读：每个探针都是 stat / realpath，不创建、不写任何东西；第二个发行版由 argv[2] 传入，缺省时 F3/F5 如实报 `UNMEASURED`——**UNMEASURED 是结果，不是失败**。argv[2] 与主发行版相同时（大小写不敏感）同样报 `UNMEASURED` 并说明原因：拿同一张共享跟自己比，每个 F3 行都会得到空洞的 `COLLIDES`，F5 甚至会报 `true`——那是词法快路包含了自己，不是行走的裁决，而旁边的注解会谎称行走已在缺失的根上短路。

测量时间 **2026-10-01**；主发行版 `debian`，第二个发行版 `debian-dev`：

```powershell
node scripts/probe-fence-facts.mjs debian-dev
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 identity <share root>                             dev 0 vs 0, ino 2 vs 2 -> COLLIDES
F3 identity /tmp                                     dev 0 vs 0, ino 1 vs 1 -> COLLIDES
F3 identity /home                                    dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 false (root absent, so the walk short-circuits; see F4)

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 identity <share root>",
    "value": "dev 0 vs 0, ino 2 vs 2 -> COLLIDES"
  },
  {
    "label": "F3 identity /tmp",
    "value": "dev 0 vs 0, ino 1 vs 1 -> COLLIDES"
  },
  {
    "label": "F3 identity /home",
    "value": "dev 0 vs 0, ino 16386 vs 16386 -> COLLIDES"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "false (root absent, so the walk short-circuits; see F4)"
  }
]
```

不传第二个发行版时：

```powershell
node scripts/probe-fence-facts.mjs
```

```
F1 case: /TMP resolves                               ENOENT -> CASE-SENSITIVE (Linux semantics)
F2 symlink: realpath(/lib)                           ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
F3 cross-share identity                              UNMEASURED - pass a second distribution as argv[2]
F4 fixture root \\wsl.localhost\debian\home\zcluo\proj ENOENT (verify-fs-fence.mjs never creates it)
F5 isUnderHost(foreign target, root)                 UNMEASURED - pass a second distribution as argv[2]

[
  {
    "label": "F1 case: /TMP resolves",
    "value": "ENOENT -> CASE-SENSITIVE (Linux semantics)"
  },
  {
    "label": "F2 symlink: realpath(/lib)",
    "value": "ENOENT -> the link is NOT followed (control /usr/lib resolves (\\\\wsl.localhost\\debian\\usr\\lib))"
  },
  {
    "label": "F3 cross-share identity",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  },
  {
    "label": "F4 fixture root \\\\wsl.localhost\\debian\\home\\zcluo\\proj",
    "value": "ENOENT (verify-fs-fence.mjs never creates it)"
  },
  {
    "label": "F5 isUnderHost(foreign target, root)",
    "value": "UNMEASURED - pass a second distribution as argv[2]"
  }
]
```

**怎么读这张表**（每条都是实测，不是推断）：

- **F1 大小写敏感（Linux 语义）**：`/TMP` 不折叠到 `/tmp`，报 ENOENT。共享本身可达（同一张表里 F2 的对照解析成功、F3 的 stat 也成功），所以这条 ENOENT 是「共享区分大小写」，不是「共享没答话」。
- **F2 realpath 不穿过 Linux 符号链接**：`/lib`（→ `usr/lib`）的 realpath 报 ENOENT，而同一共享上链接自己的目标 `/usr/lib` 正常解析（对照写在探针里，也写在这一行）。按 `lib/wsl/fence.js:31-37`，`canonicalHostPath` 对这类路径走 catch 分支原样返回。
- **F3 跨发行版 (dev,ino) 相撞**：`debian` 与 `debian-dev` 的共享对同拼写路径报告**完全相同**的二元组（`/`=2、`/tmp`=1、`/home`=16386，dev 两侧都是 0）。围栏的身份回退按 `dev === dev && ino === ino` 判相等（`lib/wsl/fence.js:87`），这个相等测试因此区分不了两个发行版。只比 dev 的写法在这台机器上永远报 COLLIDES，问不出 ino 那一半，所以探针比较并打印整个二元组。
- **F4 夹具根不存在**：`<home>/proj` 报 ENOENT，`verify-fs-fence.mjs` 从不创建它。
- **F5 身份行走没有跑**：根不存在时 `isUnderHost` 在 stat 根处短路返回 false（`lib/wsl/fence.js:82-83`），所以这一行的 `false` 是「根不存在」，不是「行走拒绝了跨发行版目标」。**F3 的相撞与 F5 的 false 不能合起来读成「跨发行版包含是安全的」。**

**更正（Task 4，提交 `850e104`）**：F4/F5 记录的是 Task 4 **之前**的状态——当时那个夹具根就是 `<home>/proj`。`verify-fs-fence.mjs` 现在自己创建夹具根：发行版 `/tmp` 下一次性的 `dsh-fence-fixture-<pid>-<rand>`，用完即删（正常退出、断言失败、`process.exit`、未捕获异常、SIGINT/SIGTERM 都清理），并且**不再引用 `<home>/proj`**，所以跨发行版那条钉子在有发行版的机器上都会真的跑身份行走。上表的数字**不改**：它是当时的实测记录，探针输出至今逐字可复现——`<home>/proj` 仍然 ENOENT，套件仍然从不创建**那个**路径。

**更正（Task 9）**：F3 的相撞不只是「记录在案」——它是**活的漏洞**，现已由围栏堵住。词法快路是唯一携带发行版的比较，它失败之后（正是跨发行版目标的情形）身份行走会按**目标自己的共享**重新 stat 每一级祖先，于是外来目标的祖先与本地根的 `(dev,ino)` 相比。发行版 `/tmp` 是 `workspace-write` **总是**授予的可写根（`writableHostRootsFor`），而两个共享为它报告同一元组——实测 `isUnderHost('\\wsl.localhost\debian-dev\tmp\x', '\\wsl.localhost\debian\tmp') === true`：一个被判定为「界内」的跨发行版写。修复把行走绑定到发行版（与 `contains()` 同一规则：**两侧都**解析成 WSL UNC 且发行版不同即拒绝，发行版段按 Windows 拼写大小写不敏感），修复后该调用为 `false`。规则刻意保持**窄**：盘符路径不带发行版，盘符目标与盘符根保持原有的身份裁决（套件对两个方向都有钉子），且实测盘符与共享两个命名空间不可能相撞（Windows 临时目录的 dev 是 NTFS 卷序列号 3764601112，每个 9P 共享报 0）。`verify-fs-fence.mjs` 新增两条钉子：共享身份的根下的跨发行版目标必须被拒（这条**只能**在行走没有跑到时通过——跑到就等于授权，所以它是「行走未被触达」的证明），以及同一发行版的大小写变体拼写（`wsl$` + 大写发行版）必须仍被包含（绑定不能反过来拒掉合法目标）。

### verify-9p 记录的三条共享事实（Task 10）

Task 1 的 `probe-fence-facts.mjs` 是**一次性测量**：它把答案记进上面的表，但它不进聚合器。围栏真正依赖的三条共享事实——符号链接、跨发行版身份、大小写——现在也由 `scripts/verify-9p.mjs` 测量，而它**在 `verify-all.mjs` 的 `STANDALONE` 列表里**：离线全量每次都会跑它，所以这三条事实每次全量都会被重新测一遍。

**但机器只有一个发行版时只重新测两条。** 跨发行版身份那三条 `FACT` 行需要**第二个**发行版；机器只有一个时套件**跳过**这三条：`SKIP` 行点名缺失的前提、**逐条列出这三条事实**、给出补救办法（装第二个发行版，或把 `DSH_WSL_OTHER_DISTRO` 指向本机已有的一个），并**以退出码 2 结束**——这条跳过在 `DECLARED_SKIPS` 里有声明（上面那条前提就在该条目里，与「链接夹具建不起来」并列），`verify-all` 因此把它报成 `SKIP` 并打印该前提，而不是算作 `PASS`，绿色的聚合不能说这三条事实已经确立；未声明的跳过则判红（见 docs/VERIFICATION.md）。这是业主的裁定：单发行版是**缺前提**，不是坏画像。跳过**只限这一族**——不需要第二个共享的事实（符号链接、大小写）照常测量并打印，所以读者失去的正好是被点名的那三条。这段 `SKIP` 的**内容**由 `scripts/verify-9p-skip.mjs` 钉住：它用探针自己的覆盖项把前提强制出来、跑真进程读真输出（每条断言因此在**每台**机器上都会跑），并同时钉住对照——有第二个发行版时套件仍测满三条、退出码 0。

**同一族还有一处。** 链接夹具建不起来时（wsl.exe 失败，或冷启动超过它自己的 30s 上限）套件跳过的不只是符号链接那三条事实，**还有那条断言**——「围栏拒绝它自己的规范化给出的目标拼写」，也就是 HAZARD 转断言的产物，本套件里没有别的检查覆盖它。这一族同样计入（3 条事实 + 4 个检查）并**退出码 2**：只披露、却仍然绿，正是本轮要清除的那一类。
**围栏套件有了同一族。** `scripts/verify-fs-fence.mjs` 有一族**跨发行版断言（4 条）**同样需要第二个共享：三条跨共享主题的断言，加一条**对照**（同一发行版的大小写变体拼写仍须被包含——分布绑定若按大小写比较发行版段，就会拒绝合法目标，比它堵的洞更糟）。机器只有一个发行版时这四条一条都评估不了，此前是**前提那条检查 FAIL、退出码 1**——业主裁定改成 SKIP：`SKIP` 行点名前提（没有第二个发行版 / 覆盖项指向自己 / 覆盖项为空 / 已解析的共享不应答），**逐条列出四条未评估断言的原文标签**、说明未确立的是什么、给出补救办法，**计入 4** 并**退出码 2**——这条跳过同样在 `DECLARED_SKIPS` 里有声明（该条目就列出这条前提），`verify-all` 因此报 `SKIP` 并打印该前提，而不是算作 `PASS`；未声明的跳过判红。那四条标签不再由散文描述，而是来自**唯一的清单 `CROSS_DISTRO_CHECKS`**：检查打印它、`SKIP` 也打印它，所以文字不可能与「实际没跑的东西」脱节（旧文案「the two cross-distribution assertions」既数错又没点名）。这一族的**内容与两类机器**由 `scripts/verify-fs-fence-skip.mjs` 钉住（在 `STANDALONE` 里，每次全量都跑）：用覆盖项把前提强制出来（指向本发行版 / 置空）、用一份把 `listDistros()` 过滤成单发行版的树副本模拟业主那台机器，读的都是真进程的 stdout 与退出码；**对照**证明有第二个发行版时套件仍退出 0、不打印这一族 `SKIP`、四条断言**逐条打印 PASS**；再把副本里 `lib/wsl/fence.js` 的**发行版绑定删掉**，那条共享身份断言必须变红——断言不是常量，这才叫证明而不是声称。

**分工：一件事只有一个主人。** `verify-9p.mjs` 记录**共享怎么答**（`FACT` 行，不是断言）；**围栏怎么答**钉在 `scripts/verify-fs-fence.mjs`——大小写那条按共享自己的答案自适应断言（`isUnderHost(大小写变体) === foldsCase`），跨发行版那条断言共享身份的根下外来目标必须被拒。在画像探针里再断言一遍共享的答案，会在**答法不同但健康**的机器上变红，与「永远不会失败的检查」是同一类缺陷。

**但事实行不能是「打印一句就完」**：每条事实旁边先断言两件让它成为测量的事——**主体存在**、**对照答话**（探针自己建的链接出现在共享列表里、链接自己的目标可读、`/lib` 在共享列表里、`/tmp` 存在）。没有这两条，一个从不存在的路径来的 ENOENT 会被读成「共享拒绝了链接」——正是本计划要清除的空洞钉子（D2）。这三条断言的可证伪性用变异体证明（改错链接名 / 对照文件改错名 / 把创建换成共享**确实**会解析的 rename 原语）：每个变异体都**只**红掉它自己那条，退出码 1。

实测（2026-10-01，主发行版 `debian`，第二个发行版 `debian-dev`）：

```powershell
node scripts/verify-9p.mjs
```

```
  FACT    realpath(/lib), a merged-/usr symlink — ENOENT -> the link is NOT followed (control /usr/lib resolves (\\wsl.localhost\debian\usr\lib))
  FACT    realpath / read of the link (the file behind it exists) — realpath ENOENT; read ENOENT -> the link is exposed but NOT followed
  FACT    a rename whose destination traverses the link — rename accepted without error and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\renamed-dst.txt exists: true -> the file landed AT the link's target (the SHARE resolves the destination spelling; the fence refuses it — the assertion below — and the provider never reaches this primitive anyway: the mkdir below aborts first, fs-local/src/fsio.ts:598)
  FACT    mkdir through the link, at a spelling the share resolves elsewhere — mkdir reported EINVAL and \\wsl.localhost\debian\tmp\dsh-wsl-9p-probe-link\outside\dsh-link-dir exists: true; isUnderHost(the raw spelling) === false
  OK    the fence refuses the target its own canonicalization produces for that spelling
  FACT    cross-share identity <share root> — debian (0,2) vs debian-dev (0,2) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /tmp — debian (0,1) vs debian-dev (0,1) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    cross-share identity /home — debian (0,16386) vs debian-dev (0,16386) -> COLLIDES - the identity comparison cannot tell the two shares apart
  FACT    case-variant path /TMP (control: /tmp exists) — ENOENT -> CASE-SENSITIVE (Linux semantics)

THE 9P PROFILE MATCHES WHAT THE PROVIDER ASSUMES
8 share fact(s) recorded above — NOT assertions: the fence's answers to them are pinned in verify-fs-fence.mjs
```

**F2 的完整答案：共享对符号链接到底做了什么。** Task 1 的 F2 只测了 `realpath`。同一个探针现在在夹具根里用 `ln -s` 自己建链接（目标在夹具根**之外**，两个目录都归探针所有、用完即删），于是每条答案都有一个**确定是链接**的主体：

- `realpath` / `stat` / `read` / `readdir` / 普通创建（`open` 不带 `O_EXCL`）**都不穿过链接**（ENOENT）——这就是围栏假设的那一半。
- `rename`（目标在链接下）与 `mkdir`（在链接下建新目录）**由服务端解析**：rename 真的落在链接目标处；mkdir 客户端报 `EINVAL`，**目录却建在链接目标处**。
- 末级是符号链接是**安全**的：rename 替换的是根内的链接项本身（实测链接目标文件内容不变），独占创建报 `EEXIST`。
- Windows 侧连链接项本身都删不掉：`unlink` → ENOENT、`rm` → EISDIR、含链接的目录 `rm -r` → ENOTEMPTY。所以夹具必须用 `wsl.exe ... rm -rf` 清理，并为此挂了 `exit`/`SIGINT`/`SIGTERM` 处理器（Windows 侧删不掉的东西不能留给用户）——这不是洁癖，是这条事实的直接后果。

### 围栏的新规则（Task 2）：无法规范化的已存在组件即拒绝

**规则（一句，可被证伪）**：一个目标的包含性判定为真，当且仅当「可写根」与「目标自身文件名」之间的**每一个路径组件**要么在共享上**不存在**（`lstat` 报 ENOENT/ENOTDIR），要么**能被规范化**（`realpathSync.native` 成功）；一个**存在却无法规范化**的组件（本机实测：`lstat` 报 EISDIR、`realpath` 与 `stat` 都报 ENOENT 的 Linux 符号链接）直接拒绝该目标。目标**自身的文件名不在规则内**。

**这条 HAZARD 因此关闭**：原记录是「围栏授权一个共享会解析到别处的拼写，而发布的第一个动作 `mkdir(directory, {recursive:true})`（`fs-local/src/fsio.ts:598`）把缺失的那一级目录建在链接目标处——可写根之外」。规则落地后，同一个拼写在 `verify-9p.mjs` 里的实测从 `isUnderHost(...) === true` 变成 `false`，那行 HAZARD 换成真断言（「围栏拒绝它自己的规范化给出的目标」）。**FACT 行仍然为真**：共享侧的 mkdir 依旧把目录建在链接目标处（那是共享的行为），变的只是围栏对它的回答。

**为什么选 (b) 而不是 (a)**：候选规则 (a)「拒绝路径**组件**存在却不解析的目标」字面上把**末级组件**也算进去，而末级是链接是**实测安全**的——发布的 rename 替换的是根内的链接项本身，链接目标文件内容不变（上面 F2 的第三条），并且**今天就能成功**（`verify-fs-fence.mjs` 的对照钉子「末级文件链接 / 末级目录链接仍被授权」）。拒绝它就是拒掉一条能工作的合法写入，而「拒掉合法同根写入的规则比缺口更糟」。另外 (a) 没有给规则划根边界，字面读下去会因为**根之上**的某个组件无法解析而拒绝一切。选定的 (b) 把范围钉死在「根与目标文件名之间」——这正是第 598 行那个 `mkdir` 会遍历、并会创建的组件集合。

**规则住在哪**：`lib/wsl/fence.js` 的 `isUnderHost`（新助手 `canonicalizationOf` / `componentsCanonicalize`），**不是** `checkedTarget`。理由有三：一，授权判定就是 `isUnderHost` 的答案（`checkedTarget` 只是对每个可写根调用它，并把它当作授权），把规则放在别处会让 `isUnderHost('<root>\<link>\...', root)` 继续返回 `true`——而那条表达式正是原 HAZARD 记录的实测对象，那样只能「注释掉」缺口，不能关闭它；二，规则需要根边界，而 `isUnderHost` 已经有（词法前缀 + 身份行走）；三，两条路（词法快路与身份回退）都必须过它，否则 `wsl$` 别名拼写会绕开规则——别名钉子就是为这一条存在的。`checkedTarget` 与两个变更入口一字未改。

**代价（实测，不是推理）**：规范化分不出「指向界内」与「指向界外」的链接，所以两种都被拒。代价是**零**——穿过链接的写在本共享上**本来就不能发布**：`mkdir(directory, {recursive:true})` 对穿过链接的路径报 ENOENT（实测，含中间目录已存在的情形），写永远走不到 rename；围栏的拒绝只是把「先留下一个越界目录、再报 ENOENT」换成「在建任何东西之前拒绝」。`readlink` 也救不了：它对链接项报 EISDIR（实测），拿不到链接目标。

**残留**：**检查与发布之间的竞态**。规则只能拒绝**先已存在**的组件；在 `checkedTarget` 通过之后、第 598 行 `mkdir` 之前由 bash 工具种下的链接仍然看不见（规范化对这类组件本来就是瞎的，任何检查都看不见它）。窗口是亚毫秒级，收益仍只是越界建目录、无内容外泄。

**钉子与变异体**：`verify-fs-fence.mjs` 自建链接夹具（`escape` 指向界外、`inside-link` 指向界内、`dangling` 指向不存在的目标、`file-link` 指向界外的文件；用发行版的 `ln -s` 建、`wsl.exe rm -rf` 删，因为 Windows 侧既建不了也删不了链接项），断言拒绝矩阵（界外祖先、**写入真正交给围栏的那个 key**、目标自己的父级、界内链接、悬空链接、`wsl$` 别名拼写）**加 5 条对照**（真实目录下的缺失组件、根下直接缺失组件、已存在目录、末级文件链接、末级目录链接——都必须仍然放行）；夹具建不起来时**先 FAIL 再跳过**，不允许「链接不存在所以断言空洞地通过」。

**「写入的 key」不是 `canonicalHostPath`**：它是 fs-local 自己那套解析行走出来的 key（`resolveLocalTarget`，`fs-local/src/fsio.ts:161-210`），套件里镜像为 `writeTargetKey`。`canonicalHostPath` 是对**整条路径**做 `realpathSync.native` 加原样兜底，而本节的每个目标尾部都不存在——所以它在**任何**共享上都原样返回，「两个拼写是否相同」根本不是盲性的函数（R=1 曾据此写了一条**会误红**的钉子：把真命题写成了假失败）。换成 write key 之后这条关系才成立：**盲臂**下行走停在夹具根、key 就是原始拼写；**解析臂**下行走穿过链接、key 是链接目标；两臂都由包含性拒绝。

**两条臂，两个都不许红**：围栏答什么取决于它的规范化能不能看穿链接，所以上面的期望**不是常量**——按实测的 `blindTo(链接)` 写成关系（`=== !blind`，与大小写那条 `=== foldsCase` 同一形状）。另一条臂（规范化**能**看穿链接）在本机也建得出来：NTFS 目录 junction 是 `realpathSync.native` **会解析**的 reparse point（实测）、不需要特权、`rmSync` 只删链接本身（实测目标不受影响），于是它被**钉住**而不是被论证——在该臂下围栏拒绝的是 write key（包含性，不是盲性），而原始拼写**确实在界内**：这正是「把盲臂期望写成常量」会在健康机器上变红的地方。

**代价那条也有钉子**：`fs-local` 的发布序列是「先 `mkdir(directory, {recursive:true})`，且这一步在**任何**可能捕获它的 try/catch 之外」（结构性，不是偶然），所以它失败时暂存目录、临时文件、rename 都还没发生——这也是那次越界只留下一个目录、别无他物的原因。它以**结构性**方式钉在 `verify-fs-fence.mjs`：读 harness checkout 的 `packages/fs/fs-local/src/fsio.ts`（先用共享的 `blankLiterals` 抹掉注释与字符串体，免得文档注释里提到这个调用就算过；`--checkout=` / `DSH_CHECKOUT` 定位，默认本仓库旁边的 checkout），断言这个调用是一个**裸的 await 语句**，且四条判据一起成立：调用前紧邻的必须是 `await`（`head`）、调用后同一行只能是空白或 `;`（`tail`，注释被抹成空白所以行尾注释不算）、函数开头到调用之间不得有 try/catch（`beforeCreate`，窗口从**函数开头**算起，不是从 `const directory` 那行——否则「在调用之前开 try、catch 放在调用之后」会溜过去）、调用到下一个 `try {` 之间也不得有（`toNextTry`）。它**不**声称：这个 `mkdir` 是真绑定（被遮蔽是另一种缺陷），或调用方不会吞掉函数自身的 rejection——两者都在结构钉子的边界之外。并断言那个 try 守护的**就是**暂存序列（边界限在该 try 到函数收尾之间；它**不**声称没有别的代码路径能到达那两个调用）。读不到 checkout 时**计为 skip 并让整套以退出码 2 报 SKIP**（与兄弟套件一致；该套件在 `DECLARED_SKIPS` 里声明了「读不到 harness checkout（或没有第二个发行版的共享应答）」这条前提，`verify-all` 因此报 `SKIP` 并打印它，而不是算作通过），不允许绿色聚合掩盖一条没跑的钉子。**六个变异体**都在**副本**上跑过（真文件必须全绿）：挪进被守护的 try → 红 2 条；自带 try 包住 → 红 1 条；在调用之前开 try 而 catch 在调用之后 → 红 1 条；**把 promise 拿在手里再 await**（`const p = mkdir(…)` 后接 `try { await p } catch {}`）→ 红 1 条（只由 `head` 拦住）；**`.catch(() => {})` 链**（全文没有 try/catch 这个词）→ 红 1 条（只由 `tail` 拦住）；**延后注册的 catch** → 红 1 条；harness checkout 逐字节不变（`D7CC70E0…`）。

`verify-9p.mjs` 那行改成真断言。围栏侧变异体：只删词法快路那一半 → `verify-fs-fence.mjs` 只红 5 条词法钉子（别名那条仍绿）、`verify-9p.mjs` 红 1 条、退出码 1；只删身份行走那一半 → 只红别名那条；两半都删 = 改动前的状态 → 红 6 条。每次变异后还原到逐字节相同（blob `3a353748…`）。

