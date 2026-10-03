# 执行世界：会话绑定、界面入口与架构 — dsh-wsl-desktop

本文是 README 拆出来的深度材料：执行世界如何被会话的 agent preset 决定、会话绑定的接缝在哪、界面入口为什么在 DOM 层做。README 只保留读者动手需要的那部分。

## 会话绑定：在创建请求里命名执行世界

harness 在会话**创建**时就把 preset 定下来（`SessionCreateRequest.agentPreset` → `composeAgent` 的 `setup: presets.mount(...)`，挂载发生在会话发布之前）。事后用 `agentPresets.select` 只能作用于"还没有跑过任何 turn"的会话，一旦有过 turn 就被 `agent-preset/locked` 拒绝，而且拒绝只写进内存日志、不报给用户。

**当前实现就是围绕这个事实做的**：

- 浏览器半边在 W 对话框里创建会话时，先调宿主的 `wslPresetFor` 解析变体 id，然后把 `agentPreset` 放进**创建请求**（`lib/client.js` 的 `createBoundSession()`）。这是唯一无竞态的接缝：preset 随会话一起组合，不存在"先跑在 Windows 世界再切"的窗口。
  - **这个字段会经过两层 API，其中一层会把它丢掉。** 宿主侧的 `SessionCreateRequest.agentPreset` 是真实契约，但客户端服务包装 `ctx.sessions.create` 只用 `workspaceId | cwd | sessionId` 重建请求体——`agentPreset` 被静默丢弃，会话落到默认 preset 上，只剩上面那条兜底去救。所以创建走的是**生成出来的 remote 契约** `ctx.remote.session.create({ workspaceId, agentPreset })`（`inject` 里相应地注入 `remote` / `remote.session`），`ctx.sessions.create` 仅作为 remote 面不可用时的退路。`scripts/verify-client-ui.mjs` 同时钉住这两点。
- 宿主半边保留一个 `api-session/added` 监听（`lib/index.js` 的 `bindWslSession`）作为**兜底**：只处理"cwd 是 WSL 路径、但创建时没带 preset"的会话（比如从别的入口创建的）。它尝试事后 `select`，成功就补绑，失败就写 `bindingLog` 并在宿主日志里告警——这类条目现在是**异常信号**，不再是正常路径的一部分。
- 因此 `verify-post-restart.mjs` 的 binding 段语义是：非 selftest 的 `bindingLog` 条目 = 有人绕过创建接缝建了 WSL 会话；零条目 = 一切经创建请求绑定的会话都正常。GUI 侧的最终确认已由操作者完成（会话预设显示 WSL · PTC 模式，工具在发行版内执行）。

## 界面入口（为什么在 DOM 层做）

侧栏工作区列表里，**路径落在 WSL UNC 下的工作区，行首图标是 ☁️ 而不是文件夹**。判定走工作区列表（`ctx.workspaces.list.getSnapshot().items` 里的 `path`——**`list` 这一跳不能省，写成 `ctx.workspaces.path` 会拿到 undefined 并静默不生效**），因为行 DOM 里只有工作区名字、没有路径；而行 key `workspace:<id>` 里的就是 workspaceId，映射因此可靠。图标是自带的矢量云而非 emoji：harness 图标集里没有云，也**没有逐行图标槽位**（只有整段 `sidebar.workspaces`，占位会遮蔽自带列表），所以替换在 DOM 层完成，并入 W 按钮那条 sync 通道。

两个实测细节：**云跟随行的字重**——收起态部署渲染 `IconFolderCloseRegular`（1px 描边），展开态是 `IconFolderOpenRegular`（纯填充），所以同一份闭合路径按两种方式渲染（描边 = 轮廓，填充 = 实心），随展开状态重建，行内不会出现"描边配填充"。**部署自带的 `<svg>` 只隐藏、不删除**：节点属于 React，抽掉它的子节点正是 `removeChild` 异常的来源；`display` 也不是 childList 变更，因此不喂回观察器（实测 2.6s 内 0 条 childList 记录）。`scripts/verify-client-dom.mjs` 覆盖以上全部行为。

选中某个发行版后，对话框**先要求输入要进入该发行版的用户**（留空 = 发行版默认用户），确认后才进入浏览：路径直接落在该用户的主目录（宿主在发行版内用 `getent passwd` 解析用户数据库，方法为 `resolveHome`）。输入的用户不存在时，错误就地显示在弹层里，不会进入浏览。切换发行版——包括重新点击当前已选中的那个——都会重新弹出用户输入框，并带上一次确认过的用户名作为起点。创建会话进行中时发行版按钮暂时不可点（提交的结果归属提交本身）。进入浏览后，主目录就是普通路径——输入框、前往、面包屑、目录点击照常可用。边界要说清楚：这一步只决定"浏览谁的 home"，**不决定会话身份**——会话在发行版里始终以发行版默认用户执行（`username` 是插件配置，不随会话创建传递）。

"+" 保持部署自带的行为（Desktop 上是 Electron 目录选择器），本插件不改写它：

- `sidebar.workspaces.directoryFlow` 是 `kind: 'single'`，占位会**遮蔽**部署自己的目录选择器，所以本插件不注册这个槽位；
- 侧栏标题栏没有扩展点，所以 W 按钮以伴随节点挂在"+"按钮之后：用 "add workspace" 图标的 SVG path 几何定位（与语言无关，全应用只有这一处渲染它），并复用该按钮的 class 以取得同样的尺寸与悬停态。桌面重构过该图标（`IconProjectAddOutline16` → `ProjectAddOutlineArtwork`，几何完全改变），触发器因此携带**新旧两代几何的已知列表**、按前缀匹配任一代——桌面更新不会让 W 静默消失。React 替换该子树时，MutationObserver 会把 W 重新挂回。
- **隐藏必须用 `display`，不能用 `remove()`。** 观察器监听的是 `childList`，`remove()` 自己就是下一次触发，两者会以刷新率互相喂养（实测 52 次/2.6s，每次还带两次强制布局）。放不下时设 `display: none`，它不是 childList 变更，因此收敛。
- **不要用定时器兜底。** 曾经的 `setInterval(sync, 2000)` 就是这个回路的种子；重新挂载/portal 都是被观察子树上的 childList 变更，定时器不解决任何真实情况。
- 伴随按钮只在"+"可见时显示（内联搜索展开时随官方动作簇一起隐藏），并且当有第二个控件带同样图标几何时优先选 `*_headerActions` 簇里的那个，认不出来就整体让位而不是猜。

## 终端 registry 行

**预设里不需要终端 registry 行。** 侧栏终端面板走的是 `agent.ctx.get('subprocess').spawnTerminal(...)`（`packages/api/terminal-controller/src/index.ts:333,346`）—— 会话作用域，所以 realm 里的 `subprocess-wsl` 自动把 PTY 放进了发行版。隔离 `terminals` 只会服务模型的持久 shell 工具，而这个预设并不挂它；多挂一组 registry + backend 只增加挂载失败的面，所以不加。

## 架构

**执行世界由会话的 agent preset 决定。** `ctx.shell` / `ctx.fs` / `ctx.subprocess` 都是进程级单实例，而 Windows 与 WSL 的工具方言不同（pwsh vs bash），因此并存不是靠"按路径路由的全局 provider"，而是靠 preset 的 `isolate` realm：

```
Windows 工作区会话                      WSL 工作区会话
  preset: standard                        preset: wsl-standard
  ctx.shell = pwsh-sandbox（宿主）          isolate: { shell, fs, subprocess }
  ctx.fs    = fs-sandbox（宿主）            ├─ shell-wsl  → ctx.shell
                                            ├─ fs-wsl     → ctx.fs
                                            ├─ subprocess-wsl → ctx.subprocess
                                            └─ tool-bash / tool-fs
```

`wsl.exe` 本身是普通 Windows 进程，所以 WSL 执行器最终仍由**宿主的** subprocess provider 启动它。realm 隔离 `shell`、`fs` 与 `subprocess` 三者，因此 realm 内的 `ctx.subprocess` 解析到 realm 自己的 provider；宿主那一行在根组合里捕获根 provider（`lib/wsl/host-refs.js`），realm 行再读回它 —— 托管进程的终止、输出溢出与回收仍归本地 provider。

**执行世界的命名发生在创建请求里。** 浏览器半边创建 WSL 会话时通过 `wslPresetFor` 把变体 id 写进 `agentPreset`；宿主半边只在 `api-session/added` 里对"没带 preset 的 WSL 路径会话"做兜底并告警（见上面「会话绑定」）。浏览器半边因此不依赖任何 preset 客户端 API 之外的东西。

