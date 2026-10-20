# 发行版内搜索：grep 与 glob（WSL 工作区）— dsh-wsl-desktop

本文是 WSL 世界里搜索工具的完整记录：为什么宿主的两个名字必须被换掉、两个工具与它们的参数、与宿主的八条语义差异、八条之外还要知道的两处边界、限额、未测与已知限制，以及怎么自己验。README 只保留结论与入口。

## 为什么必须换掉宿主的搜索工具

宿主那两个名字（`tool-fs-search` 的 `grep` 与 `glob`）在 WSL 世界里被**刻意移除**，理由是两个实测事实：它经 `ctx.subprocess.spawn()` 启动（`search-core.ts:238`），而它的 `argv[0]` 是 `@vscode/ripgrep` 提供的**打包 Windows rg.exe**（`search-core.ts:174-178`）——那是一个 Windows 可执行文件，**在发行版里不存在**，也无法用 Linux 参数工作；反过来，发行版自带它自己的 `/usr/bin/grep` 与 `/usr/bin/find`（本机实测：`command -v rg` 在发行版里**回答为空**，而 grep 3.11、findutils 4.10.0 在场）。**两个事实合起来**才是这条线的完整理由：宿主那张行没有可用的后端，而这个后端本来就在发行版里。

所以 `wsl-world` 组把这两个宿主行移除（`lib/wsl/preset.js` 的 `WORLD_MODULE_NAMES`），再由本插件把**两个名字**挂回去，与 `bash`、`fs` 的重挂载同形：两行，各自一个实例，都指向 `lib/wsl/search-tool.js`，由 `config.tool` 说明这个实例注册哪一个（两行指向同一个模块，否则会把同一个工具注册两次；缺了 `config.tool` 的行在挂载时被拒绝，而不是静默地什么都不挂）。

两个工具跑的是**发行版自己的** `/usr/bin/grep -E` 与 `/usr/bin/find`，而且这条路上**没有 shell**：模式、路径、include 都作为**恰好一个 argv 元素**到达发行版，所以 `a b; rm -rf /` 只是一个参数（shell 语法在这里是惰性的）；排序与限额在 Node 侧做——realm 里没有可以管道的 `sort`。

于是 README 里那条回退不再是回退，而是一条**已声明、有边界的能力**：名字是宿主的，语义不是——下面八条是全部差异。

## 两个工具与参数

`grep`：`pattern`（必填，POSIX ERE，见缺口 1）· `path`（缺省为会话工作区，相对路径按它解析）· `include`（单个 glob，对每个文件的 **basename** 匹配，见缺口 5 与 6）。结果按文件分组，每个命中带 `path`、`lineNumber` 与 `line`（正文按「路径 + `Line N: 文本`」打印）；一条都没有时打印 `No matches found`。

`glob`：`pattern`（必填，glob）· `path`（缺省为会话工作区）。结果是 `{root, paths}`，`paths` 是**文件**（不列目录）的绝对路径，按 mtime **升序（最旧在前）**——与宿主 `--sort=modified` 的实测方向一致，而不是看着更顺眼的降序；一条都没有时打印 `No files found`。

两个名字**无条件注册**（跟随宿主自己的选择）：发行版真的缺 `grep`/`find` 时，调用以明确的错误失败，而不是静默降级或偷偷改用宿主的工具。

出货的两条向量（逐字节由 `scripts/verify-search.mjs` 的两条金标向量钉住）：

```text
/usr/bin/grep -r -n -H -E --binary-files=without-match --exclude-dir=.git … --exclude-dir=.sl [--include=<include>] --regexp <pattern> -- <root>
/usr/bin/find -- <root> -name .git -prune -o … -name .sl -prune -o -path <root>/<tail> -type f ( -exec stat -c %.9Y {} \; -print0 -o -print0 )
```

**为什么不是 `-printf`**：`-printf` 是 GNU 扩展。busybox 的 `find`（Alpine、很多最小发行版）会拒绝它，拒绝落在 stderr 上，而 stdout 为空——空 stdout 被解析成「没有文件匹配」，也就是**静默的空结果**，与 `lib/wsl/pty.js:572-573` 已经记录并刻意避开的是同一类失败。这里只要求两种每个 `find` 都带的谓词：`-print0`（busybox 的 `FEATURE_FIND_PRINT0` 默认开）与 `-exec … ;`（`FEATURE_FIND_EXEC` 默认开），mtime 由发行版自己的 `stat` 打在每个路径前面。**仍然是一次 spawn**：find 自己按命中逐个执行 `stat`，一条记录的两半因此总是描述同一次命中。`stat` 之所以写**裸名**而不写绝对路径，是因为没有可移植的绝对拼写——coreutils 装在 `/usr/bin/stat`（Debian、Fedora），busybox 的小程序在 `/bin/stat`（Alpine）——`-exec stat` 由 find 自己的 `execvp` 在发行版的 PATH 上解析。

**那个带括号的 `-o -print0` 不是装饰，是实测出来的防线**：`-exec stat … ;` 与紧跟的 `-print0` 之间是**隐式 AND**，所以 `stat` 跑不起来时 `-print0` 根本到不了——而 GNU find 只把这件事写到 stderr，**退出码仍是 0**（实测：exit 0、stdout 为空、stderr 两行 `'stat': No such file or directory`）。只看 stdout 的读者会看到**和本次修复要消除的一模一样的静默空结果**，只是下沉了一层。有回退组之后两种情况都会打印：`stat` 正常时 mtime 在前，`stat` 缺席时是裸的 NUL 分隔路径——而裸路径不是可读记录（`stat -c` 一定带自己的换行，解析器需要那个换行），于是留下**非空的输出却解析不出任何路径**，这正好落进 `search-tool.js` 已有的损坏守卫（"its output could not be read as path records"）。因此缺少 `stat` 的发行版会**响亮**失败，而不是回答「没有文件」。这个组还顺带让单个读不到的文件（`stat` 对某一条失败）只损失那一条记录，而不是整份列表。括号是**必需的**：find 的隐式 AND 比 `-o` 结合得紧，没有括号时回退项会脱离 `-path`/`-type` 测试，导致整棵树都被打印出来。

`%.9Y` 是 mtime 的秒：GNU coreutils 会给出小数部分（正是旧的 `%T@` 交给排序的东西），busybox 的格式引擎把同一个整数补齐到九位小数，解析回来是同一个整秒——所以 busybox 上损失的是小数精度，**文档契约（mtime 升序）不受影响**。

搜索根是**解析后的 Linux 绝对路径**（realm 自己的 `fs` 服务解析模型的路径，见「八条之外」那一段），这也是「以 `-` 开头的路径」到不了向量的原因。

## 语义与缺口（八条）

工具描述（模型在调用前读到的那一份）是同一批事实的**权威措辞**；本节给出完整版与实测依据。

1. **正则方言是 POSIX ERE，不是 ripgrep 的**：`\d`、`(?i)` 不可用（写 `[0-9]`，或把大小写两支拼出来）。模式匹配不到不是错误，返回空结果。
2. **不解析 `.gitignore`**：只有六个 VCS 目录被排除（`.git`、`.svn`、`.hg`、`.bzr`、`.jj`、`.sl`，清单与宿主 `tool-fs-search/src/glob.ts:37` 逐项同序）——grep 靠 `--exclude-dir=<name>`，find 靠 `-name <name> -prune`（两个工具各用原生手段真的排除：去掉它的 grep 向量会返回 `.git` 里的文件，实测）。没有 `.ignore`、没有全局 ignore，所以 `node_modules`、构建产物这类目录**不会被静默跳过**——要安静就收窄 `path`，或用 `include`。
3. **模式按搜索根相对解释，且 `*` 与 `**/` 一样跨 `/`**：`src/*.ts` 也能匹配更深层的文件；不含 `/` 的模式在任意深度都匹配；前导 `/` 与不写等价（那是 rg 的锚定写法，在这里不是锚）。这条是**实测**（findutils 4.10.0：`-path` 匹配整条打印路径，且 `*` 跨 `/`），也是翻译把 `**/` 收成 `*`、把每一个前导 `/` 剥掉的原因：留下的任何一个都会组成 `//` 开头的 `-path` 模式，而**那种模式匹配不到任何东西**（同一夹具：单斜杠 2 条，双斜杠 0 条）。
4. **点目录会被搜到**：宿主靠 ripgrep 默认跳过**所有**隐藏项，realm 只排除那六个 VCS 名字 → `.github`、`.vscode` 这类目录**在结果里**。已披露的差异，不是缺陷。
5. **`include` 没有花括号**：`*.{ts,tsx}` 匹配不到任何东西（GNU grep 的 `--include` 走 fnmatch，不做花括号展开）——写两次，或用 `path` 收窄。
6. **`include` 只匹配 basename**：带目录的 include（如 `src/*.ts`、`*/deep/*.ts`）**返回 0 条**——与宿主相反（它把 include 交给 ripgrep）。要按目录收窄就用 `path`。
7. **路径含 `:` 的记录可能被丢弃，也可能被静默错配**：grep 打印的是 `path:line:text` 且**没有任何转义**，字段边界在打印那一刻就没了（宿主读的是 ripgrep 的 JSON，realm 只有这份打印）。行号字段读不出整数时记录被**跳过**：`NaN` 不是无损 JSON，宿主的 value 快照会拒绝它（`packages/util/values/src/index.ts:128-129`），整次调用会连同批次里其它命中一起以 `ToolOutputError` 失败，而那个错误里从不提冒号——丢一条是**可恢复的假阴性**，所以现在的选择是跳过（`9.30` 这种**有限但非整数**的行号同样跳过：`tool-fs-search/src/grep.ts:307` 把这个字段声明为 integer）。但读成**有限整数**时没有任何守卫能发现：`/ws/2024:12:00.log:7:needle` 会被错读成 `/ws/2024` 的第 12 行（实测），`''` 与 `' 7'` 同样静默读成 0 与 7。**带冒号的路径请改用 `read`**——这件事只有打印格式能定，而格式是工具自己的，改不动。
8. **二进制文件永不被匹配**：向量带 `--binary-files=without-match`，它的文档语义是「假定二进制文件不匹配」→ 二进制内容**永远不会进入 `line`**（比宿主更安全）；代价是宿主的 rg 对二进制文件**会报一条命中**，realm 报「无匹配」。

> **机制补记（本机实测，GNU grep 3.11，两个流各自重定向到文件）**：带 flag 的二进制命中 → exit 1、stdout 0 字节、stderr 0 字节；不带 flag → exit 0、stdout 0 字节、**stderr 82 字节**（`binary file matches` 的 notice）。那条 notice 走 **stderr**，而工具成功时不表面化 stderr → 去掉 flag 不会让它响亮失败，只会让「二进制命中」多出一条与「无匹配」同形的理由；flag 的真实价值就是上面那句文档语义。

**八条之外，两处边界要一并知道：**

- **返回的路径是工具打印的形式（绝对）**，而宿主返回的是工作区相对路径；`glob` 的 `root` 也是**解析后的 Linux 绝对路径**——它与 `paths` 互相一致，**不是调用方拼写的原样**（宿主填的是相对路径或 `.`）。
- **`grep` 的退出码 2 被归为「模式非法」**（`SEARCH_INVALID_PATTERN`），但这类错误里不止模式：**缺目标、目标不可读同样是 2**。分类名不是结论——**消息里带逐字的 stderr**，真因在那里（要区分就得解析 stderr 的内容，那是这个仓库避免的脆弱做法）。这个分类是 grep **独有**的：find 没有这个退出码，所以 glob 的 2 是普通的 `SEARCH_FAILED`。启动失败（发行版缺工具、被杀、超时）与「打印了却读不出任何记录」也同样是 `SEARCH_FAILED`。

## 限额

| 上限 | 值 | 到顶时的行为 |
|---|---|---|
| `grep` 命中数 | 250 | 文本头说 `Found 250 of N matches`，**其余不落盘** |
| `grep` 单行字节 | 2000 | 该行截断并标记 `" (line truncated)"`（与宿主同形）；记录本身仍在 |
| `glob` 路径数 | 100 | 尾注说 `Showing 100 of N paths, oldest first`，**其余不落盘** |

三个数字是模块常量，**镜像宿主 `@deepseek-ai/dsh-tool-fs-search` 的默认值**（逐字段）。达到上限的结果**说自己被截断了**，而且说「完整结果未保存」——宿主会在那里指向它保存的文件，本世界**不落盘**，所以诚实的尾注就是这句「未保存」，而不是指向一个不存在的文件。另外两项预算：stdout 20,000,000 字节（跑出它的打印**响亮失败**，因为部分解析出的短答案读起来与完整答案一模一样——那是搜索唯一不许静默的事）、超时 30 秒（宽限 3 秒）。

**操作者给宿主搜索工具调过的上限不会到达 realm**：基础预设里那份配置随那两行一起被移除（`prune()` 把它收进 `toolConfig`，而没有任何消费者），所以 realm 用的是上面这些**宿主默认值**，不是那份配置。

## 未测与已知限制

- **`lib/wsl/search-tool.js` 的运行时行为没有离线钉子**：它 import 的是 harness 包（`defineTool`/`HarnessError`），而本机 checkout 没有 `node_modules`——没有任何离线套件能经注册表驱动它。唯一的观察者是**活体两行**（见下节）。这不是遗漏而是结构，且可见度边界是**实测**的：把记录名写成复数、或把探针的行号写错，在 `node --check`、部署解析树下的 import 检查与 `verify-modules` 下**全绿**。
- **只在 `debian` 上实测**：本机还有 `debian-dev` 与 `arch`，与它共用同一个 WSL2 内核与 9P 栈，但没有逐个复测。
- **9P 共享可能短暂给出陈旧视图（单向，实测）**：宿主重启后经 `\\wsl.localhost\<发行版>` 写的文件，可能在 `wsl.exe -d <发行版>` 里**看不见**（`cat`/`ls` 报 No such file or directory），甚至从共享里消失；反向（发行版内写、共享读）正常。**为什么这与搜索有关**：realm 的 `fs` 服务是**经共享**写文件的，而两个工具是**经 `wsl.exe`** 跑的 `grep`/`find`——共享一陈旧，「我刚写的文件搜不到」会是环境而不是工具。判断方法：经共享写一个文件、立刻从发行版读它；读不到就先复位共享（`wsl.exe --shutdown` 或重启桌面）。
- **代价在发行版与 9P 侧，不在本进程**：`grep -r` 按被读的文件数与字节数线性，`find` 按目录条目数线性。无界的 `find /` 在本机**跑不完**（发行版把 C:/D:/E: 整盘挂在 9p 上；240 秒上限内刷出的 24,855 条只证明「多于 0」，不是规模）——收窄 `path` 是唯一的手段。

## 钉子在哪

`scripts/verify-search.mjs`（离线、**无前置条件，因此从不跳过**；`node scripts/verify-search.mjs` → 本机 **35 passed, 0 failed**）按五节钉住：glob 翻译（`**/` 收成 `*`，前导 `/` 与 `./` 剥除，搜索根的尾部斜杠同样剥除）、argv 向量（每个模型值恰好一个惰性元素，加**两条金标向量**——整条 argv 字面相等，VCS 六个名字、顺序、分隔符与可移植的 mtime 配对都在里面，另有一行断言 glob 向量不含 GNU 专有的 `-printf`/`%T@`——也就是 busybox 上静默的那一类））、向量所依赖的性质（VCS 清单与宿主同序、排除必须站在 `--` 之前）、两个解析器（首冒号切分、正文里的冒号要保住、`:` 路径的跳过、非整数行号的跳过、CRLF、字节限额与字符边界、cap 与损坏记录的分别、NUL 分隔与路径里的换行、mtime 升序取最旧、整秒 mtime 与小数 mtime 并排排序、无换行与非有限 mtime 的跳过）、失败词表（grep 的 2 是 `SEARCH_INVALID_PATTERN`，find 的同码不是；启动失败是 `SEARCH_FAILED`）。

**活体两行**在 `scripts/verify-post-restart.mjs` 里（`tool.search.grep` 与 `tool.search.glob`，需要已安装插件 + 运行中的宿主）：它们断言命中探针文件的**第 3 行**（行号，不只是「搜到了这个文件」）、glob 列出探针**与两层深的嵌套文件**、且结果里**不出现 `.git`**。它们必须在**开发装配**上跑（`developerTools === true`）：production 装配下验收路由按设计回 `HTTP 401`，那**就是这两行从未被执行**的样子（本机实测两次），不是工具的失败。这两行也是上面「没有离线钉子」那条唯一的观察者。

文档自身也在被钉：`docs/SEARCH.md` 与 `docs/SEARCH.en.md` 由 `scripts/verify-docs.mjs` 的**声明对表**校验——两版必须命名同一批产物。**那张对表只比产物名、不看语义**：两版是否说同一批缺口、同一个数字，只有写作者守着（本节因此把清单、数字与边界逐条并列出来）。
