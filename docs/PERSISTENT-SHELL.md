# 常驻 shell：模型侧的 `bash`（WSL 工作区）— dsh-wsl-desktop

本文是 WSL 世界里模型常驻 shell 的完整记录：为什么这三行必须自写、这个工具与它的参数、缺口清单（逐条）、限额、未测与已知限制、以及钉子在哪。README 只保留结论摘要与入口。

## 为什么必须自写这三行

宿主那份预设里的常驻工具与这个 realm 要挂的常驻工具**注册同一个模型侧工具名 `bash`**，而一个 realm 里的同名工具只能有一个拥有者。哪个拥有者真的在回答，是**实测**出来的：活体探针的两次调用（`tools.bashPersist.a` / `.b`）证明常驻那一行回答了第二次调用——它读回了第一次调用建立的 cwd，所以常驻行就是这个 realm 的 `bash` 拥有者（M1 = P2）。

第二个事实决定了**不能照抄宿主的行**：harness 那几行带 `disabled: !!js process.platform === 'win32'`（`minimal.patch.yml`）。这个表达式在**本宿主进程**里求值，照抄进来就会在 Windows 桌面上**挂着但禁用**——一个看起来存在、实际不注册任何东西的工具行（F12）。

所以三行是**自己写**的：注册表（`@deepseek-ai/dsh-terminal`）、后端（`@deepseek-ai/dsh-terminal-bash`）与常驻工具（`@deepseek-ai/dsh-tool-bash-persistent`），配置按**字面**重述（`toolRow` 不会为常驻行搬运配置）。反过来，宿主那三行**仍然**按模块名被移除：移除名单与 `prune` 一个字段都没改。

## 这个工具与参数

工具名是 `bash`，参数**只有** `command`。`timeoutMs` 是 300000（毫秒，与 harness 自己的行一致）；`backendType` 默认 `shell`；后端在发行版里起的是**发行版自己的** `/bin/bash --noprofile --norc -i`。

于是它承诺的是 harness 那句原文：命令在常驻 bash shell 里跑，**当前目录与导出的环境变量跨调用保留**。活体门里这两件事各有一条会红的行：`tools.bashPersist.a` 建立状态，`.b` 读回它。两条行各自钉一个**只可能由对应的那一半产生**的字面量——cwd 行钉 `.dsh-wsl-persist-cwd`（只可能来自第一次调用建的目录），导出变量行钉 `dsh-wsl-persist-probe`（只可能来自 `echo "$DSH_WSL_PERSIST_PROBE"`，变量没活下来时那行就是空的）。**这个判据成立有一个前提，值得写下来**：活体门的工作区根是 `.dsh-wsl-selftest-<pid>`，它**不含** `dsh-wsl-persist-probe` 这个子串；若工作区根改叫 `.dsh-wsl-persist-probe-<pid>`（M1 探针用的正是这个 scratch 名），`pwd` 打出来的路径就会自带 token，第二条行便会在变量根本没存活时也通过。M1 探针因此**故意只用 cwd 判定**、不用 token——同一个坑的镜像。

## 缺口清单（逐条，缺一不可）

1. **宿主 `ctx.sandbox` 会包一层**：`terminal-bash` 在模式非 `danger-full-access` 时用 `ctx.get('sandbox')` 包装 argv，而本仓自己判定宿主沙箱对 `wsl.exe` **无法约束**（`lib/wsl/confinement.js` 的头部）。**实测三态落在 b**：包装之后 PTY 仍然跑得起来（`tools.bash` 报 `Linux` + 发行版内路径 + exit 0）。补救不是「接受这层无效包装」，而是 realm 内**自己提供** `sandbox` 服务（`lib/wsl/sandbox.js`），使那层包装变成**发行版内的约束**而不是 Windows 的运行器；没有这个 provider 时，非 `danger-full-access` 模式会**抛错**而不是静默降级。
2. **常驻 shell 在发行版内是受约束的**（M3）：工作区外写被拒——`Read-only file system`、`write-exit=1`。它与一次性命令路径的差别在**走哪个接缝**：常驻 PTY 经 `sandbox` 接缝拿 argv（`lib/wsl/sandbox.js` → `lib/wsl/confined-argv.js` → `lib/wsl/confinement.js`），一次性命令经 realm 自己的 `ctx.shell`（`lib/wsl/shell.js`），两条路用同一个约束构造器，**但 PTY 路径不经 `ctx.shell`**。
3. **`sessionProjections` 只有推断**：常驻后端的 `inject` 里有它（`packages/terminal/terminal-bash/src/index.ts`），而 realm 里**没有**在用的消费者。它在 realm 内的可达性靠宿主的回落机制**推断**，**未在 realm 实测**。
4. **`terminals` 必须在组里隔离**：不隔离则挂载**被拒绝**（服务型插件落在根 realm 会被加载器拒绝），不是静默降级。组的 `isolate` 因此有 `terminals: true`。
5. **不能照抄 harness 的行**（F12，见上）；反过来，宿主那三行**仍然**按模块名被移除。
6. **`pwsh-persistent` 不挂**：发行版里没有 PowerShell，挂上去只会产生一个假的能力面。
7. **常驻会话开着时不允许改沙箱模式**：后端自带守卫（`packages/terminal/terminal-bash/src/index.ts` 的事件处理器），活体行钉住它的**形状**（在会话开着时改模式被拒），不是逐字节的错误文本。
8. **交互式方言未测的部分**：prompt / PS2 / 回显在发行版里的行为是这一支里**首次实跑**，钉的是「**不泄漏**进工具输出」，不是逐字节的终端语义。
9. **回收的边界**：普通关闭时是**桥自己的 `finally`** unlink 那个 FIFO——所以宿主侧的 `rm -f`（`lib/wsl/pty.js`）在普通路径上是**后盾，不是拥有者**；被 SIGKILL 时桥的 `finally` 不会跑，宿主侧的 `rm -f` 是**唯一**能挺过 SIGKILL 的清理。留下的名字**由清扫收**：每次分配的清扫按「代」判定（本进程 pid + 活集合、他人 pid + 存活性、legacy 名 + 发行版自己的年龄），不是按年龄。

**关于「重启即清」——它不是保证**：重启**不是**拆卸，上一代留下的 FIFO 要等下一代**首次分配**时的清扫；而**冷发行版的首次分配可能烧掉 10 秒上限**（清扫自带的上限），于是清扫**静默跳过**（fail-safe 方向：留下一处泄漏，而不是删错名字）。所以正确的说法是「下一次分配**通常会**收掉它」，而不是「重启总会清掉」。

## 限额

| 上限 | 值 | 说明 |
|---|---|---|
| `timeoutMs` | 300000 | 与 harness 自己的常驻行同值；超时返回部分输出并说明超时 |
| `maxOutputChars` | 16000 | 后端 schema 默认值；超出截断并标记 |
| `backendType` | `shell` | 默认值；本 realm 不覆盖它 |

**操作者为宿主设的上限不会到达 realm**：宿主那份常驻行的配置随宿主行一起被移除（`prune` 把它收进 `toolConfig`，而 realm 里没有消费者），所以 realm 用的是上面这些**默认值**，不是操作者调过的那份。

## 未测与已知限制

- **两个终端原语的离线覆盖不一样，必须分开说**：**`lib/wsl/subprocess.js` 的 `spawnTerminal` 没有行为级的离线钉子**——该文件 import 了 harness 包，离线套件驱动不了它的行为；钉住它的只有 `scripts/verify-modules.mjs` 里的一条**源码形状**行（`planFor(spec.cwd, spec.wslDistro)`）加上**活体那几行**，不是行为观察。**`lib/wsl/pty.js` 相反**：它只 import `node:fs/crypto/os/path` 内建模块与两个同目录相对模块，**没有任何 harness 包**，所以 `scripts/verify-pty-handle.mjs` 能 import `spawnWslTerminal` 并**离线驱动**它（真发行版、经桥与 FIFO，不经模型工具）——那个套件就是这一半的离线钉子，不是「驱动不了」的旁证。
- **两个分界必须知道**：**（a）GUI 的网页终端按设计不受 fence 约束**——终端控制器直接调 `subprocess.spawnTerminal`，它自己就声明走的路由「without Agent sandbox or approval restrictions」，所以「模型的 `bash` 受约束」与「用户的 GUI 终端不受约束」**不同**；**（b）终端那条没有 PID namespace**——`isolateProcesses` 默认 `false`（`lib/wsl/sandbox.js` 的 Config 注释），因为 PID namespace 会把交互 shell 变成 PID 1、其进程组在 PTY 的前台查询里不可寻址（helper 的 `--no-pidns` 是为同一件事）；一次性命令路径**保留** namespace，这是已声明的边界。
- **12 小时的活 claim 上限及其已声明的残余**：活集合的条目只在**年轻于 12 小时**时才声称「活着」（`lib/wsl/pty.js` 的 `LIVE_FIFO_CLAIM_MS`）。残余情形写在代码里：一个超过 12 小时、cleanup 真的没跑过的会话，**加上**同一窗口里的第二次分配，可能让清扫 unlink 一个活会话仍持有的名字。代价是**名字，不是会话**（桥与控制写入者持有描述符，FIFO 的 inode 比目录项活得久）——这就是这个界为什么以**小时**计而不是分钟。
- **只在 `debian` 上实测**：本机还有 `debian-dev` 与 `arch`，与它共用同一个 WSL2 内核与 9P 栈，但没有逐个复测。
- **一次活体绿**：活体门最近一次是 **58 PASS / 0 FAIL**、尾部 `NO AUTOMATED FAILURES; 3 manual step(s) pending`、`EXIT=0`（`artifacts/t3live2-post-restart.txt`）。其中会话释放与 FIFO 回收那条是绿的。**事后计数是另一次量测、另一份归档**：发行版里的 `plugin fifos in debian: 0` / `pty bridges in debian: 0` 读自 `artifacts/t3fix3-distro-clean.txt` 与 `artifacts/t3fix4-distro-clean.txt`（带括号判别式，见台账的跑后检查）——**不是**上面那份活体门输出，后者没有这两个计数行。

### 人工核验清单（浏览器专属，不可自动化）

活体门的尾巴里有 **3 条待人工项**。它们**不计入自动化门**，但必须由人看一眼；**传输面已经由桥的检查覆盖**，这三条是**UI 面**：

1. 点侧栏「+」旁的 **W** 按钮，建一个 WSL 工作区；会话的 preset 应显示 `WSL · <base>`。
2. 同一个 **W** 按钮应列出发行版**与它们的目录**（对话框渲染出来）。
3. 打开一个 WSL 会话的**终端面板**，提示符应是发行版自己的 shell。

## 钉子在哪

- `node scripts/verify-preset.mjs`：三行的顺序、`isolate` 的五个键、常驻行**字面** config、`bash` 的**唯一拥有者**、以及 realm 里**没有** `pwsh-persistent`。
- `node scripts/verify-post-restart.mjs`：判据 1（cwd 与导出变量跨调用）、判据 2（会话释放与 FIFO 回收）、判据 3（宿主世界未获得该能力）、围栏行、以及「常驻会话开着时改模式被拒」那条守卫行。
- `node scripts/verify-pty-handle.mjs`：桥与 FIFO 的离线钉子（真发行版、经 `lib/wsl/pty.js`），包括清扫的「代」规则与失败上报。
- 文档自身也在被钉：`docs/PERSISTENT-SHELL.md` 与它的英文版由 `scripts/verify-docs.mjs` 的**声明对表**校验——两版必须命名同一批产物。**那张对表只比产物名、不看语义**：两版是否说同一批缺口、同一个数字，只有写作者守着（本节因此把清单、数字与边界逐条并列出来）。
