# 兼容性与升级 — dsh-wsl-desktop

本文回答两个问题：**这个插件能装在哪个桌面版本上**，以及**桌面或插件升级时按什么顺序做、怎么回退**。它不重复 [发行版支持矩阵](DISTRO-SUPPORT.md)（那是 Linux 发行版一侧）。

## 版本关系

插件通过运行时能力探测判断宿主是否可用，而不是按版本号推断：`bootstrap` 返回 `capabilities`（宿主探测 + 客户端探测的结果），`health` 返回发行版体检，`verify-post-restart` 再把运行中的 manifest 与 checkout 逐字节比对。版本号只是发布标签，不是契约。

| 插件版本 | 桌面版本 | 状态 | 依据 |
|---|---|---|---|
| 0.8.2 | 0.2.2-rc.5（npm/tag 构建）与 master 构建两代 | 已按源码核对，**未在 tag 构建的桌面上跑 live 门** | `inject` 只声明 `['webServer','connection']`，两者在每一代宿主上都由顶层插件提供；准入走 `admit`，缺失时回落 `requestRejection`；`auth: 'anonymous'` 在新代生效、旧代忽略。离线门钉住 inject 白名单与四种准入句柄的行为 |
| 0.8.1 | 0.2.2-rc.5（仅 master 构建） | **已撤回（缺陷）** | `inject` 含 `'connection.authentication'`，该服务只存在于 master 构建；在所有 npm/tag 发布宿主上插件永久 `pending`，`apply()` 不执行。见下文「0.8.1 的致命缺陷」 |
| 0.8.0 | 0.2.2-rc.5（npm/tag 构建） | 已按源码核对；**是本仓库在发布宿主上最后一个能激活的版本** | `inject = ['webServer','connection']`（两代都提供），准入调 `requestRejection`（发布的每一代都保留它），因此**只在发布代上可用**；路由不声明 `auth`，而 master 代把省略值默认成 `required`，所以 0.8.0 在 master 构建的桌面上会在 handler 之前被拦（这正是 0.8.1 给路由补 `auth: 'anonymous'` 的原因）。降级只对发布代桌面是正确的急救措施 |
| 0.7.6 | 0.2.2-rc.1 | 已实测 | 契约面全绿：`verify-host-contract` 48/48（10 个 `HOST_IMPORTS` 导出对 0.2.2-rc.1 的包逐一可解析）、`verify-modules` 入口对真实依赖加载通过、`verify-client-ui` 48 + `verify-client-dom` 86、活体投放的 client bundle 200 且 4 个必需标记齐全。两处宿主漂移已登记：`ui-primitives` 图标按 `artwork.ts` 重构（`project-add-outline` 与 `folder-open(-outline)` 符号名仍在，触发器与行图标两代都认）；`fs-local` `writeFileAtomic` 把首步 `mkdir` 包进「catch 只重抛」的 try（`8f798da97d`），发布序列钉已改为两代都认。live 门未跑满：该 profile 的 `developerTools` 为 false，`bootstrap` 回 401，`verify-route` / `verify-post-restart` 因此未执行 |
| 0.7.2 | 0.2.1-rc.3 | 已实测 | 0.2.1-rc3 的图标 sprite 重构（`ui-primitives` `c3eead771d`）曾让 W 按钮消失，本版按 sprite 符号名识别触发器后恢复；`verify-client-dom` / `verify-client-ui` 全绿 |
| 0.7.0 | 0.2.1-rc.2 | 已实测 | 本机 live 门（`verify-all --live`）与 `verify-post-restart` 全绿 |
| 0.6.0 | 0.2.1-rc.2 | 已实测 | 0.6.0 发布时的完整 live 门 |
| 0.7.2 / 0.7.0 / 0.6.0 | >= 0.1.7 | 声明下限，未在本机逐版实测 | 0.1.7 起有 `wsl-*` 预设的运行时注册；更旧的宿主在激活时明确拒绝（代码行为） |
| 0.7.2 / 0.7.0 / 0.6.0 | < 0.1.7 | 不支持 | 同上：没有运行时注册 |

**版本号不是构建来源。** 同一个 `0.2.2-rc.5` 可以是从 tag 打的包，也可以是从 master 打的包，两者的宿主内部结构不同（见下节）。所以 `engines.dsh` 表达不了这项区分，收紧 semver 范围也挡不住问题；唯一可靠的做法是**只依赖发布版真的提供的东西**，并在实测记录里写明被测二进制的来源。

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

**插件"装了但没反应"时，先看那一行警告。** 如果启动日志里有 `warning: 1 entry did not activate` 与 `pending (waiting for service: …)`，那是插件在等一个宿主从未提供的服务——不是 WSL 没配好，也不是发行版问题。它意味着**这个插件版本和这个宿主不匹配**，唯一的处置是换成与宿主匹配的插件版本（`pending` 里点名的服务就是线索）。0.8.1 就是这样死的：它等 `connection.authentication`，而 npm/官网发布的每一代桌面都不提供它。

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

### 路由准入的两代设计，以及一次"把 master 当成发布版"的误判

宿主有**两代**路由准入实现，版本字符串**区分不了**它们：

| 代次 | `webServer` 路由 | `connection` 的认证 | 出现在 |
|---|---|---|---|
| 发布代（旧） | `WebRoute` 只有 `kind`/`path`/`handler`，**没有 `auth` 字段**，也没有 `webserver/authorize` 事件 | 构造器绑定的 `BrowserAuth`；`admit()` 与 `requestRejection()` **并存** | 全部 0.2.1-rc.x、0.2.2-rc.1…rc.5 的 **npm 包与 tag 构建** |
| master 代（新） | 新增 `auth` 字段（**省略默认 `required`**）与 `webserver/authorize` 事件 | 认证下沉为独立服务 `connection.authentication`；`requestRejection()` 被删 | 从 master 源码构建、但**版本号仍标 `0.2.2-rc.x`** 的桌面二进制；`0.2.3-alpha.*` |

这一代差异来自 harness 提交 `71753fdf91`（2026-11-12，"centralize route admission with required policy"）。它**不是** `dsh-v0.2.2-rc.3`、`rc.4`、`rc.5` 任何一个 tag 的祖先——这些 tag 上连 `packages/client/connection/src/authentication.ts` 这个文件都不存在。但 Desktop 的打包工作流允许从 master 构建，于是本机的 `0.2.2-rc.5` 桌面里装的是**新代**代码，而用户在 npm/官网拿到的同版本号桌面是**旧代**。版本号相同，代码不同。

**逐版核对过的发布代样本**（读 npm 上的 `lib/types/rpc-host.d.ts` + `lib/index.js`）：`@deepseek-ai/dsh-client-connection` 的 `0.2.1-rc.3`、`0.2.2-rc.1`、`0.2.2-rc.3`、`0.2.2-rc.4`、`0.2.2-rc.5` 全部是「构造器绑定 `BrowserAuth` + `admit()` 与 `requestRejection()` 并存 + `inject = ['credentials']`」，没有任何一个提供 `connection.authentication`；`@deepseek-ai/dsh-host-webserver` 同版本的 `0.2.2-rc.3` 与 `rc.5` 都没有 `auth` 字段与 `webserver/authorize` 事件。这正是 0.8.1 在所有发布宿主上失效的证据基础，也是 0.8.2 只依赖 `admit`（两代都有）并为旧代保留 `requestRejection` 回落的原因。

**这是本仓库最贵的一次误判**：2026-11-14 的 GUI 核验失败被记成了「rc.3 的路由准入重构」，处置照此写成 0.8.1：路由补 `auth: 'anonymous'`、改用 `admit`、并**给 `inject` 加上 `'connection.authentication'`**。前两条在两代上都成立，第三条是净损失——见下一节。

**仍然成立的部分（0.8.2 保留）**：路由显式声明 `auth: 'anonymous'`（新代上把准入交回插件自己的围栏，旧代上该字段被忽略）；准入统一走 `lib/host/http.js` 的 `rejectRequest()`（优先 `admit`，旧代回落 `requestRejection`）；handler 的准入段整体包进 try/catch，异常不逃逸成空体 400，改为带 `step` 的 JSON；异常栈写入 `$DSH_HOME/wsl-desktop-route-error.log`。

**教训一（取证）**：新代宿主把逃逸异常变成**空响应体的 400**（`webserver/src/index.ts`：`dispatch().catch(() => res.writeHead(400)`），浏览器只能报 `internal`。定位时连续三次基于推理的改动都改错位置，只有把异常落盘取证才一次命中：**没有证据就改代码，改的是自己以为的病灶。**

**教训二（这条更贵）**：**"本机实测通过"只有在能说出被测二进制的构建来源时才算证据。** 当时没有记录桌面二进制是从 tag 还是从 master 打的，于是 A 代的行为被写成了 B 代的兼容性结论，还变成了代码、注释、验证钉子三处「事实」。取证方法是直接读 `app.asar` 里宿主那两个包的 `lib/index.js`：`connection` 包里出现 `this.authentication = ctx["connection.authentication"]` 或 `new ConnectionAuthentication(ctx)` 就是新代，出现 `browserAuth` 就是旧代；`webServer` 包里有 `authPolicy(auth, request)` 就是新代。两个包的结论一致才能判定代次。

### 0.8.1 的致命缺陷：`inject` 里写了没有发布宿主提供的服务（0.8.2 修正）

0.8.1 的 `export const inject = ['webServer', 'connection', 'connection.authentication']` 让插件在**所有已发布宿主**上完全不激活，而不只是某个版本：

- Cordis 把 `inject` 当**许愿**，不是版本门控：一个永远没人提供的服务名让插件 fiber **永久 `pending`**，没有报错、`apply()` 不执行、路由不注册、`wsl-*` 预设不注册；
- 已发布宿主的 `connection` 把凭据校验器留在自己内部（构造器绑定的 `BrowserAuth`），所以**没有任何 0.1.x/0.2.1/0.2.2 发布包**提供 `connection.authentication`（提供它的是 `0.2.3-alpha.1`、`0.2.3-alpha.2`，也就是上表列为新代的那两支——这正是 0.8.1 在 master 构建的桌面上看起来正常、却在所有 0.2.2 发布宿主上失效的原因）；
- 于是任何宿主都只留下一行 `warning: 1 entry did not activate` / `pending (waiting for service: connection.authentication)`，用户只能看到 W 按钮点了没反应，以及 `Unknown agent preset: wsl-standard`。

**"必须把子服务写进 `inject`"这个理论错在哪，又没有全错**（这是 0.8.1 → 0.8.2 → 0.8.2 修正的第二轮，代价很高）：`connection.admit()` 的**机制**确实经由调用方上下文——master 代把 `this.authentication` 存成服务，`admit()` 里再读一次，而 Cordis 的 traceable proxy 会把 `this` 换成 shadow，让那次读**按调用方 fiber 解析**。所以在 master 代上，调用方自己的 `inject` 里**必须有** `connection.authentication`，否则 `admit()` 从内部抛 `cannot get property "connection.authentication" without inject`（在真实 Cordis 上复现过：模块级 inject 只有 `connection` 时必抛）。

错的只是**结论的落点**：这个需求不能写在**模块级** `inject` 里（那会让插件在发布代上永久 `pending`），而应该用**函数级** `ctx.inject([...], fn)`——它起一个子 fiber，服务缺失只会让这个子 fiber pending，父 fiber 照常 `apply()`、照常注册路由、且**不产生任何日志噪音**（实测 0 行）。于是两代可以同时满足：

| 代次 | `admit()` 怎么读校验器 | 需要的调用方 inject | 本插件的做法 |
|---|---|---|---|
| 发布代 | 构造器绑定的 `BrowserAuth` 字段 | 不需要 | 子 fiber 永远 pending，回落到插件自己的 `connection` 句柄 |
| master 代 | 服务 `connection.authentication`（经调用方上下文） | **需要** | 子 fiber 解析成功，用它自己的句柄调 `admit()` |

**0.8.2 的处置**：

- 模块级 `inject` 保持 `['webServer', 'connection']`，只放**已发布宿主真的提供**的顶层服务；
- 新增 `openAdmission(ctx)`（`lib/host/http.js`）：开一个 `ctx.inject(['connection','connection.authentication'], …)` 子 fiber，请求到达时**优先用子 fiber 的句柄**、拿不到才回落到插件自己的句柄；两条路径最终都走 `rejectRequest()`，所以访问器选择与失败方向只有一处；
- `rejectRequest()`：优先 `admit`（两代都有），旧代回落 `requestRejection`，两者都没有时**显式抛错**；`admit` 返回的形状不在 `{ peer } | { rejection }` 之内时同样抛错——失败方向是关闭；
- `verify-modules` 的防回归：`inject` 白名单（**单双引号都解析**，读不懂即判红）、`rejectRequest` 在四种句柄形态上的行为、`admit` 的每种非法返回形状都必须抛错，以及 `openAdmission` 在「子 fiber 解析成功 / 永不解析 / 回落到无访问器句柄」三种情形下的行为。

**防止再犯**：`inject` 里的名字现在是**白名单**，任何「只有 master 才有」的服务进列表就会判红；同时 live 门测完要记录**被测二进制的构建来源**，否则结论只能表述为「某台机器上某份二进制如此」，不能写成某个版本的行为。

### 0.2.2-rc.5：模块图从 HTTP 流迁到 Remote 服务（2026-11-20）

`/plugins/events` 这个 HTTP SSE 端点被删掉，模块图改由 `pluginEvents` 这个 `TypertRemoteService` 提供（harness 提交 `bd1d6dcd0c`）。**插件本身不受影响**——rc.5 上 `verify-route` 通过，`verify-post-restart` 的 56 项宿主检查全过（预设生成、会话绑定、围栏、PTY、Windows 世界未污染、契约探测）。受影响的是**本仓库的验证工具**：`scripts/live-client.mjs` 还在读那个已经不存在的路径，于是三套件把「读不到图」报成「插件不在图里」。

**处置**：把三种结局分开，只让中间那种变红。

| 结局 | 含义 | 行为 |
|---|---|---|
| 图读得到、插件在 | 正常 | PASS |
| 图读得到、插件不在 | **插件缺陷** | FAIL |
| 图读不到（404 / 连接失败 / 流提前结束） | 该宿主不发布图 | **不可测**，不计入通过也不计入失败 |

`verify-live-env`（整套主题就是被服务的客户端）与 `inspect-live-client` 因此 exit 2，并在 `DECLARED_SKIPS` 里各自带一条点名该宿主的前提；`verify-post-restart` 只把那一组 6 项标成未评估并打印原因，其余 51 项照常给结论。**「测不了」不能报成「坏了」**——这正是这个仓库反复在治的那类谎。

**rc.5 的实测记录（2026-11-20）**：离线门 25/27、0 失败；live 门 27/31、4 个声明性跳过、0 失败；侧栏 W 按钮人工确认正常。**取证条件必须连结论一起写**：那次被测的桌面二进制版本号是 `0.2.2-rc.5`，但宿主包里是 **master 代**代码（`dsh-client-connection/lib/index.js` 里 `this.authentication = ctx["connection.authentication"]`、`new ConnectionAuthentication(ctx)`；`dsh-host-webserver/lib/index.js` 里 `authPolicy(auth, request)`）。所以这条记录证明的是「插件在**新代**宿主上功能正常」，**不能**用来证明它兼容 npm/tag 发布的 rc.5——后者恰好被 0.8.1 的 `inject` 打死，是 issue #3 报告的现场。

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
