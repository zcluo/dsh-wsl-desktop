# 兼容性与升级 — dsh-wsl-desktop

本文回答两个问题：**这个插件能装在哪个桌面版本上**，以及**桌面或插件升级时按什么顺序做、怎么回退**。它不重复 [发行版支持矩阵](DISTRO-SUPPORT.md)（那是 Linux 发行版一侧）。

## 版本关系

插件通过运行时能力探测判断宿主是否可用，而不是按版本号推断：`bootstrap` 返回 `capabilities`（宿主探测 + 客户端探测的结果），`health` 返回发行版体检，`verify-post-restart` 再把运行中的 manifest 与 checkout 逐字节比对。版本号只是发布标签，不是契约。

| 插件版本 | 桌面版本 | 状态 | 依据 |
|---|---|---|---|
| 0.7.6 | 0.2.2-rc.1 | 已实测 | 契约面全绿：`verify-host-contract` 48/48（10 个 `HOST_IMPORTS` 导出对 0.2.2-rc.1 的包逐一可解析）、`verify-modules` 入口对真实依赖加载通过、`verify-client-ui` 48 + `verify-client-dom` 86、活体投放的 client bundle 200 且 4 个必需标记齐全。两处宿主漂移已登记：`ui-primitives` 图标按 `artwork.ts` 重构（`project-add-outline` 与 `folder-open(-outline)` 符号名仍在，触发器与行图标两代都认）；`fs-local` `writeFileAtomic` 把首步 `mkdir` 包进「catch 只重抛」的 try（`8f798da97d`），发布序列钉已改为两代都认。live 门未跑满：该 profile 的 `developerTools` 为 false，`bootstrap` 回 401，`verify-route` / `verify-post-restart` 因此未执行 |
| 0.7.2 | 0.2.1-rc.3 | 已实测 | 0.2.1-rc3 的图标 sprite 重构（`ui-primitives` `c3eead771d`）曾让 W 按钮消失，本版按 sprite 符号名识别触发器后恢复；`verify-client-dom` / `verify-client-ui` 全绿 |
| 0.7.0 | 0.2.1-rc.2 | 已实测 | 本机 live 门（`verify-all --live`）与 `verify-post-restart` 全绿 |
| 0.6.0 | 0.2.1-rc.2 | 已实测 | 0.6.0 发布时的完整 live 门 |
| 0.7.2 / 0.7.0 / 0.6.0 | >= 0.1.7 | 声明下限，未在本机逐版实测 | 0.1.7 起有 `wsl-*` 预设的运行时注册；更旧的宿主在激活时明确拒绝（代码行为） |
| 0.7.2 / 0.7.0 / 0.6.0 | < 0.1.7 | 不支持 | 同上：没有运行时注册 |

另外：`engines.node >= 22.19` 是宿主 Node 的下限；`manifestVersion: 1` 是插件元数据版本，不是桌面版本。

## Windows 上的 9P 工作区

在 Windows 宿主上，会话工作区可以用 UNC 拼写 `\\wsl.localhost\<发行版>\…`。那是一条 **9P** 挂载，而 9P **不提供 Windows 安全描述符**（实测：`Get-Acl` 对本地 NTFS 与 SMB UNC `\\localhost\C$` 都成功，对本机两个发行版的 9P 路径一律 Win32 1；同一目录的文件内容读写却完全正常）。

宿主侧的 Windows ACL 沙箱因此无法在这种工作区上工作。处理方式：

| 场景 | 行为 |
|---|---|
| `workspace-write` + 9P | 命令照常运行，工具结果带 `enforcement: unconfined`，并明确提示“本工作区无围栏，写入不受治理” |
| `read-only` + 9P | 不受影响（只读不添加能力 ACE，从不需要安全描述符） |
| `danger-full-access` | 不受影响（它根本不经过沙箱的 `confine()`） |
| 非 9P 的本地路径 | 完全不变 |

这**不是**静默放行：沙箱接缝的契约明确禁止 silent unconfined passthrough，所以降级必须以 `unconfined` 显式声明，模型和用户都能看到。

想要真正的围栏，请用 WSL 预设开会话——那时围栏发生在**发行版内部**，不依赖 Windows ACL。宿主侧若直接用 ACL runner 处理 9P 工作区，会看到一句点名原因的拒绝（exit 127），而不是裸的 Win32 错误码。

## 升级顺序

**桌面先升，插件后升。** 顺序反了会得到一个“插件比宿主新”的中间态：宿主的模块图里可能还没有插件要注入的服务，`bootstrap` 会把缺失的符号列进 `capabilities.missing`，界面进入降级卡。

1. 升级 DSH Desktop，重启。
2. 升级插件（插件市场 / `plugin_manager install_bundle dsh-wsl-desktop@<version>`）。
3. **重启**桌面。宿主半边按 URL 缓存模块，装完不重启仍会服务旧代码；客户端半边刷新页面即可。
4. 跑 `node scripts/verify-post-restart.mjs`（仓库内），或至少打开一次 W 对话框，确认：
   - `bootstrap` 的 `pluginVersion` 等于目标版本；
   - `capabilities.status` 不是 `degraded`；
   - 体检条能渲染，没有 `host-plugin-stale`。
5. 如果是开发代次（`sync.ps1` 的 staged generation），再跑一次 `verify-all --live`。

## 回退

**按相反顺序退：先退插件，再退桌面。**

- 插件回退：`plugin_manager remove_bundle dsh-wsl-desktop` → `install_bundle dsh-wsl-desktop@<旧版本>` → 重启。
- 桌面回退：装回旧桌面 → 重启 → 再把插件降到与它匹配的版本。反过来（旧桌面 + 新插件）通常表现为降级卡或 `host-plugin-stale`，不是可用的中间态。
- 回退后同样跑 `verify-post-restart`：它不信任任何版本声明，只信任运行中的 manifest 与模块图。

## 宿主漂移的历史

0.1.6 → 0.1.7 一次断了四处（预设注册、服务访问、模块导入、客户端注入），这是本插件要求 `>= 0.1.7` 且坚持运行时探测的原因。之后每次桌面大版本适配都升一个 minor：`0.5.1 → 0.6.0`（错误目录/体检/契约）、`0.6.0 → 0.7.0`（完整双语 + 无障碍 + 发布预检）。**桌面大版本变了，先看有没有对应的插件 minor**，不要直接升插件。

0.2.1-rc.2 → 0.2.1-rc.3 是一次**字段级**的宿主漂移，不是大版本：`ui-primitives` 把产品图标搬进文档 sprite（`c3eead771d`），"添加工作区"按钮从内联几何

```html
<svg><path d="M5.54492 2.06738…"/></svg>
```

变成一条没有 `<path>` 子节点的引用：

```html
<svg data-icon="dsw-icon-project-add-outline-regular"><use href="#…"/></svg>
```

插件当时按**路径数据前缀**认这个按钮，于是扫不到锚点、W 按钮整体退场（降级入口也只在 5 秒后才出现）。同一改动还让工作区行的云图标读不到文件夹图标的粗细（行图标也没有内联 `path` 了），折叠行会错误地画成实心云。0.7.2 起改为**两代都认**：几何前缀（旧代）+ sprite 符号名 `project-add-outline`（新代），行粗细则读行图标引用的**符号图形**本身。教训：认宿主控件时，可选的第二身份不能只覆盖出现过的代次——`verify-client-dom` 现在同时跑内联与 sprite 两套 fixture。

### 0.2.2-rc.3 的路由准入重构（2026-11-12，`71753fdf91`）——最贵的一次

这个 commit 同时改了三件事，每一件都足以打断本插件，而它们合起来让**整个 W 对话框失效**：

| # | 变更 | 本插件的后果 |
|---|---|---|
| 1 | 路由注册新增 `auth` 字段，**省略时默认 `required`** | webserver 在 handler 之前就拦截；开发令牌那条路（`fenceRejection` 允许它替换 401）**永远走不到** |
| 2 | 删除 `connection.requestRejection()` | 插件调用的方法不存在，即使放行也会 `TypeError` |
| 3 | 认证下沉为独立服务 `connection.authentication`，`connection.admit()` 内部读取它 | Cordis 按**调用方**上下文解析服务属性，插件没 inject 该子服务 → `admit()` 从内部抛 `cannot get property "connection.authentication" without inject` |

**为什么它是"最贵的一次"**：失败是**静默的**。宿主 webserver 的兜底监听器把逃逸的异常变成**空响应体的 400**（`webserver/src/index.ts`：`dispatch().catch(() => res.writeHead(400)`），而浏览器半边的 `json()` 解析失败只能把它报成 `internal` + 空 params。于是 UI 显示「插件内部错误」，**没有任何一处证据指向真正的原因**。

**处置（0.8.1 起）**：

- 路由显式声明 `auth: 'anonymous'`，把准入交回插件自己的围栏；
- 用 `connection.admit()` 取代 `requestRejection`（`admit` 在这次变更之前就存在，因此对新旧两代宿主都成立）；
- `inject` 补上 `'connection.authentication'`；
- handler 的准入段整体包进 try/catch，异常**不再逃逸**成空体 400，改为带 `step` 的 JSON；
- 异常栈写入 `$DSH_HOME/wsl-desktop-route-error.log`（浏览器永远拿不到宿主消息，这个文件是排查的唯一通道）；
- `verify-modules` 增加三条源码钉子（`auth: 'anonymous'`、`.admit(` 且不含 `.requestRejection(`、inject 含子服务）。

**教训（比结论更重要）**：这条路径**离线门结构上覆盖不到**——`verify-route` 需要开发令牌，而开发令牌恰好被缺陷 #1 挡住；`verify-post-restart` 只比对 client bundle 的标记串。它是**真人点一次 W 按钮**才暴露的。定位过程中连续三次基于推理改动都改错了位置，只有把异常落盘取证之后才一次命中：**没有证据就改代码，改的是自己以为的病灶。**

### 0.2.2-rc.5：模块图从 HTTP 流迁到 Remote 服务（2026-11-20）

`/plugins/events` 这个 HTTP SSE 端点被删掉，模块图改由 `pluginEvents` 这个 `TypertRemoteService` 提供（harness 提交 `bd1d6dcd0c`）。**插件本身不受影响**——rc.5 上 `verify-route` 通过，`verify-post-restart` 的 56 项宿主检查全过（预设生成、会话绑定、围栏、PTY、Windows 世界未污染、契约探测）。受影响的是**本仓库的验证工具**：`scripts/live-client.mjs` 还在读那个已经不存在的路径，于是三套件把「读不到图」报成「插件不在图里」。

**处置**：把三种结局分开，只让中间那种变红。

| 结局 | 含义 | 行为 |
|---|---|---|
| 图读得到、插件在 | 正常 | PASS |
| 图读得到、插件不在 | **插件缺陷** | FAIL |
| 图读不到（404 / 连接失败 / 流提前结束） | 该宿主不发布图 | **不可测**，不计入通过也不计入失败 |

`verify-live-env`（整套主题就是被服务的客户端）与 `inspect-live-client` 因此 exit 2，并在 `DECLARED_SKIPS` 里各自带一条点名该宿主的前提；`verify-post-restart` 只把那一组 6 项标成未评估并打印原因，其余 51 项照常给结论。**「测不了」不能报成「坏了」**——这正是这个仓库反复在治的那类谎。

**rc.5 的实测记录（2026-11-20，Desktop 0.2.2-rc.5）**：离线门 25/27、0 失败；live 门 27/31、4 个声明性跳过、0 失败。**侧栏 W 按钮人工确认正常**——这一条替代了那 6 项无法自动评估的客户端检查，也是「客户端半边确实被服务」的唯一直接证据。所以 rc.5 上本插件**功能完全兼容**，缺口只在自动验证侧，且已被收据如实记录。

## 发布预检

仓库根的 `node scripts/release-check.mjs` 会在发布前检查：npm 登录、registry 最新版、目标版本是否已占用、本地/远端 tag、工作树、pnpm 的 `minimumReleaseAge` 窗口，以及隐私扫描（已跟踪文件里的密钥与本机路径、`npm pack` 清单里的测试产物）。它只读，不改任何东西；输出会直接给出下一步命令。

`pnpm` 不在 PATH 上时（本机的 DSH 只装了 `pnpm.mjs`，没有 `.cmd` 垫片），预检会如实说「pnpm 不在 PATH」而不是把它报成配置问题；用 `DSH_PNPM=<shim 或 pnpm.mjs 的路径>` 指定即可，不必把某台机器的路径写进仓库。

**它还要求一份 live 门的收据。** 理由是本仓库最贵的一次缺陷：2026-11-14 宿主改了路由准入，插件每一个路由方法都失效，而**离线门 25/27 全绿**——能抓住它的 `verify-route.mjs` 早就写了那条断言，只是它在 `LIVE` 列表里、从来没跑过。**测试不缺，缺的是发布路径要求它。**

所以现在发布前必须有 `node scripts/verify-all.mjs --live --receipt` 产出的收据，且同时满足三条：`liveRan === true`、`counts.failed === 0`、`version` 等于目标版本（最后一条防止旧构建的收据替新代码背书）。缺一条就阻断，阻断理由会写明它未覆盖的是哪条接缝。

### 回装顺序（别在窗口外卸载）

发布后把 profile 切回 registry 版本时，**先确认 registry 副本可安装，再卸载已装的插件**：

1. 跑 `node scripts/release-check.mjs --version <目标>`；它会把 `minimumReleaseAge` 的 `readyAt` 算出来。
2. 窗口没开（`ready === false`）就**不要** `remove_bundle`——那样 profile 会在一小时内没有任何插件。
3. 窗口开了再按 `remove_bundle` → `install_bundle <目标>` → 重启 的顺序做。

**`verify-post-restart` 必须在切换之前跑，不能放在之后。** 它和整组 live 套件都靠开发令牌调用路由，而**发布出去的包里 `cordis.patch.yml` 没有 `config` 块，`developerTools` 是关闭的**——切到 registry 形态后开发令牌一律 401，`presetStatus` 等方法也不在浏览器命名空间里。实测（0.8.1，2026-11-15）：切换后立刻跑它，得到 `HTTP 401（围栏拒绝或方法被移出浏览器命名空间）`。

正确的顺序是：**先在开发代次上跑完 live 门并留下收据，再切到 registry 形态**。切换之后能自动验证的只剩「bundle 已装且启用」，其余靠人工：点一次 W 按钮，确认对话框列出发行版。这不是妥协，而是两种形态本来就不同——开发代次多开一个令牌面，而用户拿到的那份没有。

窗口是 pnpm 的供应链策略，不是 bug；绕开它需要显式修改 profile 的 `minimumReleaseAge`，那属于降低供应链保护，要单独决定。

**0.8.1 的实测（2026-11-15）**：这个 profile **没有**配置 `minimumReleaseAge`（`pnpm config get` 打印 `undefined`），但 pnpm **仍然**执行了年龄检查——安装刚发布的 0.8.1 时它往 `pnpm-workspace.yaml` 写入了 `minimumReleaseAgeExclude: [dsh-wsl-desktop@0.8.1]`。也就是说存在一个**有效默认值**，而默认行为是**宽松的**：不设 `minimumReleaseAgeStrict: true` 时它记录排除项后继续，而不是阻断（pnpm 自己的提示是「set minimumReleaseAgeStrict to true to gate these updates with a prompt」）。所以「未配置」既不是「无窗口」，也不该被当成阻断理由——`release-check` 现在把它报成 `unset (pnpm default, permissive)` 并放行。
