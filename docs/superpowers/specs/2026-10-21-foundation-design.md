# 0.6 Foundation — 可读失败、宿主契约、发行版体检

- 状态：设计已确认（2026-10-21），待实现规划
- 范围：A1（错误目录与安全错误码）+ A2（发行版体检）+ C1（宿主契约层与探测）
- 版本：0.6.0（minor）。不改变围栏、预设语义与各 provider 的既有契约。
- 来源：2026-10-21 头脑风暴的 20 项候选；本包为其中三项的组合。A3–A7、C2–C5、D1/D2 不在本包内。

## 1. 背景

三个已测量的问题，决定这个包先做：

1. **浏览器侧失败不可读。** 路由对非开发调用者只回 `{ ok: false, code: 'method-failed' }`，把 message 整段抹掉（`lib/index.js:1541-1549`）；浏览器于是把任何失败渲染成 `… 失败（HTTP 400）`（`lib/client.js:156`）。真正可行动的文本只存在于宿主侧，例如 `lib/wsl/confinement.js:432` 的 `NO_NEW_PRIVS` 说明。
2. **宿主 API 漂移只能靠事后撞墙。** 0.1.7 一次断了四处；DSH 0.2.1-alpha.1 静默删除了 `serviceForAgent` 导出，插件先在 `ctx.get` 回退里量到宿主的 shell 才在注释里补上兜底（`lib/index.js:587-604`）。预设派生仍要读 TS private 的 `definitions` Map（`lib/index.js:220`），`readDocument` 的版本门只有一次（`lib/index.js:269-271`）。
3. **安全边界已披露但不可见。** `enforcement: 'partial'`、runner 选择、helper 版本、NO_NEW_PRIVS 状态都写在 `SECURITY.md`、`docs/CONFINEMENT.md` 与 `lib/wsl/confinement.js:43` 里，产品界面没有任何一处能让人看到它们此刻是什么状态。

## 2. 目标

- **G1** 任何浏览器可达方法的失败都带一个稳定 `code` 与一条可行动 remedy；浏览器不再只看到 HTTP 状态。
- **G2** 宿主符号缺失或形状变化时，插件按 feature 降级并给出可见原因，而不是静默消失或半工作。
- **G3** 用户能在 W 对话框里对选中的发行版跑一次体检，逐项得到 pass/warn/fail 与修复命令。
- **G4** 浏览器响应不携带 wsl.exe stderr、宿主路径、堆栈或未允许的参数。
- **G5** 新增逻辑尽可能离线可测；必须依赖真机/真宿主的行按仓库惯例声明 SKIP 前提。

## 3. 非目标

- 不改变文件围栏、受限模式、预设行集合、各 provider 的执行语义。
- 不自动安装发行版前提，不自动执行 sudo（只复用现有的 `sudo -n` 探针）。
- 体检是**建议性**的，不阻断创建。
- 不改 `dsh.client.inject` 清单；客户端注入失败导致 `apply` 不被调用，属于外部边界，只在宿主日志与文档披露。
- 不处理 A3–A7、C2–C5、D1/D2 的功能。
- 不新增依赖，不改 Node 下限（>=22.19）。

## 4. 已定决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 文案归属 | 宿主权威目录，浏览器经 `bootstrap` 拉取并缓存 | 单一来源；doctor 与路由错误共用同一张表 |
| 契约层形态 | 声明式 manifest + 运行时 probe + 离线 verifier | 一张表三处复用；能按 feature 降级 |
| 体检探测 | 一条批处理脚本 + 复用已有缓存探针 | 一次 spawn 拿 userland 事实，runner/NNP 走缓存 |
| 体检语义 | 建议性，不阻断创建 | 受限模式不可用时 `danger-full-access` 仍可建 |
| 主入口缺失 | 可关闭的浮动「WSL」入口，只在失败路径出现 | 满足「可见降级」，又不在正常路径加 DOM |
| 文案语言 | 从第一天 zh/en 双语 | 避免 A6 时二次返工 |

## 5. 架构总览

```
browser half (lib/client.js)
  W click
    ├─ bootstrap ────────────────► host route (lib/index.js)
    │                               ├─ lib/protocol.js         (catalog: codes/remedies/features/checks)
    │                               ├─ lib/host/contract.js    (manifest + probeHost)
    │                               └─ lib/wsl/doctor.js       (health probe, on demand)
    ├─ dialog phases: pick-user → (health strip in browse) → browse
    ├─ degraded phase when picker features are missing
    └─ floating entry when the sidebar anchor is not found

host half
  METHODS (existing) ── route-errors classify ──► { ok:false, code, params } to browser
  new browser-reachable: bootstrap, health
  dev-token callers keep the human message for debugging
```

新增/改动模块：

| 路径 | 角色 |
|---|---|
| `lib/protocol.js` | 纯目录：错误码、zh/en 文案、remedy、feature/check id。无宿主依赖。 |
| `lib/route-errors.js` | 纯分类器：把域错误映射为 `WslRouteError`，并过滤 params。 |
| `lib/host/contract.js` | 声明式宿主/客户端符号清单、`probeHost`、feature 聚合。纯数据，probe 接收 ctx。 |
| `lib/wsl/doctor.js` | 批处理脚本、解析器、`healthFor`、缓存。 |
| `lib/index.js` | 路由映射、`bootstrap`、`health`、probe 接线。 |
| `lib/client.js` | catalog 缓存、code 渲染、degraded phase、health strip、浮动入口。 |
| `scripts/verify-protocol.mjs` | 目录完整性、分类器、params 过滤。 |
| `scripts/verify-host-contract.mjs` | manifest 与代码互查、宿主导入形状、SKIP。 |
| `scripts/verify-doctor.mjs` | 解析器、缓存、health 组装；live 行可 SKIP。 |
| `docs/DIAGNOSTICS.md` / `.en.md` | 错误码、体检、降级、隐私边界。 |

## 6. A1 — 协议与错误映射

### 6.1 `lib/protocol.js`

纯模块，只导出冻结数据；不 import `node:*`，不 import 宿主包。

```js
export const ERROR_CODES = Object.freeze({
  'wsl-not-available': {
    zh: '找不到可用的 WSL。',
    en: 'No usable WSL installation was found.',
    remedy: { kind: 'link', href: 'docs/DISTRO-SUPPORT.md' },
    doc: 'DIAGNOSTICS.md#wsl-not-available',
  },
  // ...
})

export const FEATURE_IDS = Object.freeze([...])
export const FEATURE_LABELS = Object.freeze({
  picker: { zh: '工作区选择', en: 'Workspace picker' },
  // ...
})
export const CHECK_IDS = Object.freeze([...])
export const CHECK_LABELS = Object.freeze({
  bash: { zh: 'bash', en: 'bash' },
  // ...
})
export const CHECK_REMEDIES = Object.freeze({
  bash: { kind: 'command', families: { debian: 'sudo apt-get install -y bash', /* ... */ } },
  python3: { kind: 'command', families: { /* ... */ } },
  'util-linux': { kind: 'command', families: { /* ... */ } },
  getent: { kind: 'text', value: '...' },
  runner: { kind: 'text', value: '...' },
  nnp: { kind: 'text', value: '...' },
  helper: { kind: 'text', value: '...' },
})
export const SAFE_PARAMS = Object.freeze({
  'distro-unknown': ['distro'],
  'user-unknown': ['user'],
  // ...
})
```

规则：

- 文案是静态句子，不做 `{param}` 插值；params 由 UI 单独以 key/value 展示，避免注入与拼接歧义。
- remedy 三种：`{ kind: 'command', value, families? }`、`{ kind: 'link', href }`（只接受 http/https 与仓库相对文档路径）、`{ kind: 'text', value }`。
- 命令类 remedy 用 `families` 给发行版族（debian/fedora/arch/alpine/suse）覆盖；没有匹配时用 `value`。
- 体检的修复建议走 `CHECK_REMEDIES`，不强行把每个检查项塞进 `ERROR_CODES`；`CHECK_IDS` 与它的 key 必须一一对应。
- UI 文案（feature 名、检查项名）来自 `FEATURE_LABELS` / `CHECK_LABELS`；每一对都有 zh/en，verifier 钉住。
- 每个 code 的 `doc` 指向 `docs/DIAGNOSTICS.md` 的锚点。

### 6.2 错误码表

| code | 触发点 | 浏览器 params | 语义 |
|---|---|---|---|
| `wsl-not-available` | `listDistros` 等 spawn/registry 失败 | 无 | 没有可用的 WSL2 或 `wsl.exe` 不可执行 |
| `distro-unknown` | 请求的发行版不在清单 | `distro` | 发行版被删除或名字过期 |
| `distro-unreachable` | 探针超时、WSL 服务瞬时不可达 | `distro` | 发行版存在但当前无法访问 |
| `user-unknown` | `getent` 无此用户 | `user` | 用户门控失败 |
| `path-invalid` | 输入不是绝对 Linux 路径/含控制字符 | `path` | 语法层拒绝 |
| `path-not-found` | `listDir` / `checkPath` 目标不存在 | `path` | 目录/路径不存在 |
| `path-not-directory` | `checkPath` 目标不是目录 | `path` | 不能作为工作区 |
| `preset-not-ready` | `wslPresetFor` 找不到/变体 broken | `preset` | 预设尚未生成或无法挂载 |
| `host-capability-missing` | C1 命中缺失 feature | `feature` | 当前桌面版本缺少插件依赖的符号 |
| `host-plugin-stale` | 客户端调 `bootstrap` 收到 `unknown-method` | `method` | 宿主半边还是旧版，需要重启桌面 |
| `too-busy` | 路由 8 个在途调用已满 | 无 | 稍后重试 |
| `internal` | 未分类异常 | `ref` | 宿主日志用 `ref` 关联完整堆栈 |
| `transport` | 客户端网络/解析失败 | 无 | 只存在于客户端兜底 |
| `catalog-unavailable` | 客户端拉不到目录 | 无 | 只存在于客户端兜底 |

`no-distros` 不作为错误码：`listDistros` 返回空数组仍是成功，界面用客户端内置的空状态文案（zh/en），避免把正常状态当失败。

### 6.3 `lib/route-errors.js`

```js
export class WslRouteError extends Error {
  constructor(code, params = {}, options = {}) { /* code 必须在 ERROR_CODES 中 */ }
}
export function classifyRouteFailure(error, context) { /* -> WslRouteError */ }
export function browserFailure(error) { /* -> { code, params } */ }
```

- `WslRouteError` 构造时校验 code；未知 code 归 `internal`。
- `params` 只保留 `SAFE_PARAMS[code]` 允许的键，值转成字符串并截断（例如 200 字符）；其余丢弃。
- `classifyRouteFailure` 的显式规则（不靠全局字符串匹配）：
  - 已是 `WslRouteError` → 原样返回。
  - `error.timedOut === true` 或 `error.code === 'ETIMEDOUT'` → `distro-unreachable`。
  - `error.code === 'ENOENT'` 且 context 是发现类 → `wsl-not-available`。
  - context 自带分类器（每个方法传入 `onKnown`）：`user-unknown` / `path-invalid` / `path-not-found` / `path-not-directory` / `preset-not-ready`。
  - 默认 → `internal`，生成 6 位 `ref`。`classifyRouteFailure` 保持纯函数（只分类、生成 `ref`）；日志由路由 catch 写（`ctx.logger?.error?.`，没有就 `console.error`），把原错误与 `ref` 一起记下。
- `browserFailure(error)` 返回 `{ code, params }`，**绝不**返回 `error`/`message`/`stack`。

### 6.4 路由接线

- `METHODS` 的浏览器可达方法在各自域内把可识别失败转成 `WslRouteError`；路由 dispatch 的 catch 调 `browserFailure`。
- 开发调用者仍拿到 `{ ok:false, code, params, error: <message> }`，保留调试能力。
- admission 失败（`unknown-method`、`method-forbidden`、`too-busy` 等）沿用现有形状；这些 message 不含 wsl 输出。客户端只用 `code`。
- `too-busy` 仍是 HTTP 503；其余方法失败仍是 HTTP 400。
- 新增 `BROWSER_METHODS`：`bootstrap`、`health`。两者只读。

### 6.5 `bootstrap`

```js
// BROWSER_METHODS 新增
bootstrap: async () => ({
  pluginVersion: <package.json version>,
  catalog: { codes: ERROR_CODES, features: FEATURE_IDS, checks: CHECK_IDS, clientSymbols: CLIENT_SYMBOLS },
  capabilities: await probeHostWhenReady(), // 见 7.2
})
```

- 无参数。
- `probeHostWhenReady()` 最多等待 5s，等 `agentPresets` 注入完成；未就绪返回 `{ status: 'pending', features: {} }`，客户端 1s 后重试一次，仍 pending 则按「状态未知」处理（不判降级）。
- 结果缓存 5s；`bootstrap` 不触碰磁盘、不执行命令。
- 返回里不含宿主路径、模块 URL、堆栈。

### 6.6 客户端目录缓存与渲染

- 对话框打开时调 `bootstrap`；会话内缓存 5 分钟；失败重试一次。
- `renderFailure(code, params)`：
  1. 查 catalog；命中则渲染 message + remedy + params key/value + doc 链接。
  2. `unknown-method` 且 method 是 `bootstrap` → 覆盖为 `host-plugin-stale`（宿主半边未更新）。
  3. catalog 拉不到 → 用内置的 `transport` / `catalog-unavailable` / HTTP 状态兜底；仍显示 `code`（便于报告）。
  4. 未知 code → `internal` 文案 + 原 code 文本。
- 浏览器响应里的 `error` 字段一律不渲染（即使未来路由误带）。
- remedy `command` 给「复制」按钮；`link` 给可点链接；`text` 直接显示。
- 参数值以文本节点插入，不拼 HTML。

### 6.7 隐私与边界

- 浏览器响应只允许 `{ ok:false, code, params }`。
- params 白名单见 `SAFE_PARAMS`；`path` 只回显调用者自己提交的路径，不回显解析后的宿主路径。
- `ref` 只用于把浏览器侧错误与宿主日志对上；日志内容留在宿主。
- 体检只返回命令是否存在、版本字符串、runner 类型；不返回 home、挂载点、stderr。

## 7. C1 — 宿主契约层

### 7.1 manifest 数据模型

`lib/host/contract.js`：

```js
export const FEATURES = Object.freeze({
  picker: {
    required: ['workspaces.list', 'workspaces.create', 'uiWorkspace.openSession', 'remote.session.create'],
    optional: ['sessions.create'],
    remedyCode: 'host-capability-missing',
  },
  'preset-generation': { required: ['agentPresets.readDocument', 'agentPresets.register', 'agentPresets.definitions', 'agentPresets.resolve', 'agentPresets.list'], optional: [], remedyCode: 'host-capability-missing' },
  'session-create': { required: ['remote.session.create'], optional: ['sessions.create'], remedyCode: 'host-capability-missing' },
  terminal: { required: ['subprocess.spawnTerminal'], optional: [], remedyCode: 'host-capability-missing' },
  search: { required: ['tools.register', 'systemPrompt.section'], optional: [], remedyCode: 'host-capability-missing' },
  selftest: { required: ['agents.create', 'agentPresets.serviceFor'], optional: [], remedyCode: 'host-capability-missing' },
})

export const HOST_SYMBOLS = Object.freeze([
  { id: 'agentPresets.readDocument', feature: 'preset-generation', kind: 'method', path: ['agentPresets', 'readDocument'], required: true },
  // ...
])

// 静态导入的宿主符号：模块导入时就决定插件能否加载，运行时不探，只由离线 verifier 检查。
export const HOST_IMPORTS = Object.freeze([
  { id: 'dsh-subprocess:SubprocessRuntime', module: '@deepseek-ai/dsh-subprocess', export: 'SubprocessRuntime' },
  // ...
])

export const CLIENT_SYMBOLS = Object.freeze([
  { id: 'workspaces.list', feature: 'picker', kind: 'member', path: ['workspaces', 'list', 'getSnapshot'] },
  // ...
])
```

- `kind`：`service`（`ctx.get(name)` 非空）、`method`（父对象上函数）、`member`（路径逐级存在）、`event`（声明存在但不可探测，标记 `unprobeable`）。
- `path` 从 `hostCtx`（宿主）或客户端 `ctx`（浏览器）出发。
- `FEATURES[x].required` 里的 id 必须出现在 `HOST_SYMBOLS` 或 `CLIENT_SYMBOLS` 中；verifier 钉住。
- `agentPresets.definitions` 是 private Map，作为 `preset-generation` 的 required 如实声明；它是已知的脆弱点，C1 只是把它变成可见的失败，不解决上游 API（提案 A 仍在 `docs/UPSTREAM-PROPOSALS.md`）。

### 7.2 `probeHost`

```js
export async function probeHost(hostCtx) // -> { status:'ok'|'degraded'|'pending', features:{[id]:'ok'|'degraded'|'unknown'}, missing:[{id, feature, reason}] }
```

- `status` 只看**宿主侧**的 required feature：`preset-generation`（`picker` / `session-create` 的 required 符号都在浏览器侧，宿主返回 `unknown`，由客户端合并）。`ok` / `degraded` / `pending` 由此得出；其余 feature 只进 `features` / `missing`，不改变 `status`。

- 幂等、5s TTL；并发调用共享同一个 in-flight promise。
- 逐条解析 `HOST_SYMBOLS`；解析失败不抛，记入 `missing`。
- `unprobeable`（`api-session/added`）不参与 required 判定；只记录 `unknown`。
- feature 状态：所有 required 命中 → `ok`；任一缺失 → `degraded`；未探测 → `unknown`。
- 结果不缓存到磁盘；重启桌面即重算。

### 7.3 运行时接线与降级矩阵

- `apply` 后（`ctx.inject(['agentPresets'])` 完成）跑一次 `probeHost`，写一行结构化日志：`wsl-desktop: capabilities <json>`；不重复刷屏。
- `bootstrap` 再取一次（TTL 内复用）。
- 浏览器侧：`bootstrap.catalog.clientSymbols` 给出要检查的 `CLIENT_SYMBOLS`；客户端只实现 `member` 路径解析（约 20 行），manifest 本身由 bootstrap 下发、不复制；结果与宿主结果合并。合并规则：同一 feature 任一侧 `degraded` → `degraded`；否则任一侧 `unknown` → `unknown`；两边都 `ok` → `ok`。

| feature 缺失 | W 按钮 | 点击 | 创建 | post-restart |
|---|---|---|---|---|
| `picker` / `preset-generation` / `session-create` | 仍挂载 | `degraded` phase，不发 distro 请求 | 不可用 | FAIL（required） |
| `terminal` | 正常 | 正常 | 允许；会话内终端/常驻 bash 可能不可用 | WARN |
| `search` | 正常 | 正常 | 允许；grep/glob 可能不可用 | WARN |
| `selftest` | 正常 | 正常 | 不受影响 | 仅 dev 报告 |

- `fs` 的 class 级形状（`LocalFileSystem` 等）不在运行时 probe 里：它在模块导入时就决定插件能否加载，运行时已经没有对象可探；由 7.4 的导入检查与 post-restart 的加载失败覆盖。
- 「picker 三个必需 feature」判定：`picker`、`preset-generation`、`session-create` 任一 `degraded` → degraded phase。
- 客户端注入清单不动。某个注入不出现时 cordis 不会调用 `apply`，这一层没有产品内信号；文档明确这是外部边界。
- 静态导入失败（宿主包删了导出）发生在 probe 之前，由 `verify-host-contract` 的导入检查与 post-restart 的加载失败覆盖。

### 7.4 `verify-host-contract.mjs`

静态（总是运行）：

1. manifest 完整性：id 唯一；feature 引用存在；required 列表非空；每个 symbol 有 feature/kind/path。
2. 使用互查：
   - `lib/` 中每个 `hostCtx.get('x')` / `serviceFor(agent, 'x')` 必须由 `HOST_SYMBOLS` 声明；每个宿主包的静态 import 必须由 `HOST_IMPORTS` 声明。
   - 每条 `HOST_SYMBOLS` / `HOST_IMPORTS` 必须在 `lib/` 源码中出现（通过 `scripts/source-text.mjs` 的 `blankLiterals` 读，避免注释满足）。
   - 允许的例外表（如 `ctx.get('agents')` 只在 selftest 用）显式列出并注释。
3. 客户端：`lib/client.js` 访问的宿主服务（`ctx.workspaces`、`ctx.remote` 等）必须由 `CLIENT_SYMBOLS` 声明；`ctx.effect` / `ctx.get` / `ctx.on` 等 cordis 成员走白名单；`package.json` 的 `dsh.client.inject` 不变。

导入检查（宿主依赖可达时）：

- 对 `HOST_IMPORTS` 的每条执行 `await import(module)`，断言 `export` 存在；模块名要与 `lib/` 的静态 import 语句互相对上（不在 manifest 里的宿主 import → 红）。
- 断言插件实际使用的宿主符号存在：`SubprocessRuntime`、`ShellExecutor`、`LocalFileSystem`、`SandboxProvider`、`defineTool` 等；缺失时点名导入路径与符号。
- 宿主依赖不可达 → 按仓库惯例 SKIP（exit 2），前提写入 `DECLARED_SKIPS`。

**能失败**：至少两条 mutation proof（删一条被使用的 manifest 条目 → 红；加一处未声明的 `hostCtx.get` → 红；恢复后绿）。

### 7.5 `verify-post-restart.mjs` 增段

在现有 binding 段之后：

- 经 dev token 调 `bootstrap`。
- `unknown-method` → FAIL「宿主半边未更新，请重启桌面」。
- `pluginVersion` 必须等于 `package.json` 的 `version`。
- `capabilities.status === 'ok'` 且 `capabilities.features['preset-generation'] === 'ok'`；这是 post-restart 能看到的那一半。`picker` / `session-create` 是浏览器侧符号，由 `bootstrap` 下发的 `clientSymbols` 与客户端的 probe 负责，post-restart 不代它声明。
- `terminal` / `search` 缺失 → WARN（不判红），与 7.3 的矩阵一致。
- `catalog.codes` 至少包含客户端会渲染的固定集合（`wsl-not-available`、`distro-unreachable`、`user-unknown`、`path-not-found`、`preset-not-ready`、`too-busy`、`internal`）；少一个即 FAIL。

## 8. A2 — 发行版体检

### 8.1 `health` 方法

```js
// BROWSER_METHODS 新增
health: async ({ distro, username }) => healthFor({ distro, username, wslPath: routeWslPath })
```

返回：

```js
{
  distro, user, checkedAt, cached,
  runner: 'helper' | 'sudo-unshare' | null,
  ok: true,         // 没有 fail（bash 这类硬前提）
  restricted: true, // runner/nnp/util-linux 都通过；false 表示受限模式不可用
  checks: [
    { id: 'bash', status: 'pass'|'warn'|'fail'|'skip'|'unknown', code?, detail?, remedy? },
    // ...
  ],
}
```

- distro/username 先过现有语法（`DISTRO_NAME` / `LINUX_USER`）：非法 distro → `distro-unknown`，非法 username → `user-unknown`。
- `detail` 只放短安全文本（命令名、版本号、runner 类型）；不放 home、挂载点、stderr。
- `remedy` 来自 `protocol.CHECK_REMEDIES[id]`（路由失败才用 `ERROR_CODES[code].remedy`），命令按发行版族选择。

### 8.2 批处理脚本

一次 `runWslShell({ distro, loginShell: false, timeoutMs: 15_000 })`：

```sh
for c in bash python3 unshare setpriv findmnt mount getent; do
  printf '%s\t%s\n' "$c" "$(command -v "$c" 2>/dev/null || true)"
done
printf 'python3-version\t%s\n' "$(python3 -V 2>&1 || true)"
printf 'nnp\t%s\n' "$(setpriv --help 2>&1 | grep -c -- '--no-new-privs' || true)"
```

- 输出按 `key<TAB>value` 解析；未知 key 忽略；缺 key 记 `unknown`；格式损坏 → `internal` + `ref`。
- `command -v` 的路径只用于判断非空，不返回。
- `nnp` 为 `1` 表示 setpriv 帮助里出现该标志；`0` 表示不支持；setpriv 缺失 → `unknown`。
- 冷启动超时重试一次；批处理本身的预算 15s。

### 8.3 复用缓存探针

- `detectRunner({ distro, username, run })`：返回 `helper` / `sudo-unshare` / `null`（不可用）；helper 的版本、属主、权限已在其中校验。命中缓存。
- `detectNoNewPrivs`：返回 `true` / `false` / `null`（未测到答案）；只缓存已测到的答案。
- 两者内部各有 60s 上限 + 1s 后一次重试；doctor 再用 20s race 包住：`detectRunner` 返回 `null` → runner 记 `warn`（受限模式不可用）；`detectNoNewPrivs` 返回 `null` → 记 `unknown`；race 超时 → 都记 `unknown`（附「探针超时」），不缓存。

### 8.4 检查项

| id | 通过条件 | 失败级别 | 说明 |
|---|---|---|---|
| `bash` | `command -v bash` 非空 | fail | shell/常驻 bash 依赖 |
| `python3` | 非空且 `python3 -V` >= 3.8 | warn | 终端/PTY 桥依赖；缺失时 fs/grep 仍可用 |
| `util-linux` | unshare/setpriv/findmnt/mount 都在 | warn（受限模式） | `danger-full-access` 仍可建；文案写明 |
| `getent` | 非空 | warn | 缺失时回落到 provider 默认 shell |
| `runner` | helper 或 sudo-unshare | warn（受限模式） | 与 util-linux 同一句提示 |
| `helper` | 已装且版本 = `HELPER_VERSION`（v1.2） | warn | 缺失但 sudo 可用时仍可运行 |
| `nnp` | true | false → warn（受限模式），null → unknown | 与 runner 同一提示 |

- `wsl` / `distro` 是方法的前置条件：失败时方法本身返回 `wsl-not-available` / `distro-unknown`，不出现在 `checks` 里。
- `ok` = 没有 `fail`（只有 `bash` 这类硬前提会 fail）；`warn`/`unknown` 不影响。`restricted` = util-linux、runner、nnp 三项都 pass；`false` 时 UI 明说「受限模式不可用」。
- 缓存：`${distro}\0${username ?? ''}`，60s；in-flight 去重；`clearHealthCache()` 供测试。
- 超时：批处理 15s；缓存探针各自 20s race；整体 35s 上限，超出的检查项记 `unknown`。路由 8 槽上限保护并发。

### 8.5 UI

- 在 `browse` phase 顶部加一条可折叠的「环境检查」条；确认用户后并行拉 health，不阻塞目录浏览。
- 摘要行：`环境检查：N 项通过，M 项建议处理`；展开后逐项显示状态、短说明、remedy 的「复制」按钮。
- 加载中：`role="status"` 的「检查中…」。
- `fail` 不禁用「创建并打开」；条内文案说明「受限模式可能不可用；danger-full-access 仍可创建」。
- health 本身失败：显示 `renderFailure(code)` + 「重试」；创建仍可继续。

## 9. 客户端 UI

### 9.1 状态

- `bootstrapState`: `loading | ready | failed` + catalog + capabilities + errorCode。
- `healthState`: `idle | loading | ready | failed` + data + errorCode。
- 对话框立即打开，不阻塞在 bootstrap 上；loading 时显示骨架行。
- 点击 W 时若 bootstrap 未完成，先发起，不等待。

### 9.2 `degraded` phase

- 触发：`picker` / `preset-generation` / `session-create` 任一 degraded。
- 内容：标题「插件已降级」；缺失 feature 的人类可读名称；remedy（通常为「升级桌面 / 重启桌面 / 查看诊断文档」）；「复制诊断」按钮（版本 + feature 状态 + missing id，无路径）；「关闭」。
- 不发 `listDistros` / `listDir` / `resolveHome` / `wslPresetFor`。
- 焦点移到卡片标题（`tabindex="-1"`），关闭后焦点回 W 按钮。

### 9.3 浮动入口

- 现有 5s 锚点探测失败后创建：`button.wsl-desktop-fallback-entry`，`position:fixed; right:16px; bottom:16px; z-index:9998`，文本「WSL」，`aria-label="打开 WSL 工作区（入口降级）"`。
- 点击打开同一对话框；右上角「×」关闭并在本次页面会话内不再出现（仅内存）。
- 若真实锚点后来出现，移除浮动入口。
- teardown 移除；不引入定时器轮询（沿用现有 MutationObserver/rAF 通道）。

### 9.4 可访问性与语言

- 错误容器：`role="alert"`；加载/状态行：`role="status"`、`aria-live="polite"`。
- 所有新按钮有文本或 `aria-label`；健康条可键盘展开/收起。
- 关闭对话框后焦点回到 W 按钮（补现有缺口）。
- 新文案全部 zh/en；按 `navigator.language` 选择，默认 en。

### 9.5 错误渲染

- `renderFailure(code, params)`：message → remedy → params key/value → doc 链接；未知 code 用 `internal` 文案并显示原 code。
- 不渲染响应里的 `error` 字段。
- `internal` 显示 `ref`，并给「复制 ref」。

## 10. 安全与兼容

- 两个新方法都是只读；`bootstrap` 不执行命令，`health` 只运行固定的只读探针与现有缓存探针。
- 浏览器响应不含 wsl.exe stderr、宿主路径、堆栈、模块 URL。
- `SAFE_PARAMS` 是硬白名单；新增 param 必须同时改表与测试。
- 旧宿主半边（没有 `bootstrap`）：客户端收到 `unknown-method` → `host-plugin-stale`，文案「重启桌面以加载新宿主半边」。
- 旧 catalog（缺某个 code）：客户端走 `internal` 兜底并显示 code。
- 宿主下限仍是 0.1.7；`dsh.client.inject` 不变；无新依赖。

## 11. 验证计划

### 11.1 新增套件

- `scripts/verify-protocol.mjs`（纯，从不 SKIP）
  - 每个 code 有 zh/en；remedy 形状合法；`families` key 合法。
  - `FEATURE_IDS` / `CHECK_IDS` / `CHECK_REMEDIES` 与 contract/doctor 的引用一致；`CHECK_IDS` 与 `CHECK_REMEDIES` 的 key 一一对应；`FEATURE_LABELS` / `CHECK_LABELS` 覆盖所有 id 且 zh/en 齐全。
  - `WslRouteError` 未知 code → internal；params 白名单过滤。
  - 分类器 fixtures：timeout、ENOENT、user-unknown、path-invalid、path-not-found、preset-not-ready、默认 internal+ref。
  - **能失败**：删一条 en → 红；允许一个不安全 param → 红。
- `scripts/verify-host-contract.mjs`（静态总是跑；导入检查可 SKIP）
  - 见 7.4。SKIP 前提写入 `DECLARED_SKIPS`。
  - **能失败**：删 manifest 条目 → 红；加未声明访问 → 红。
- `scripts/verify-doctor.mjs`（纯解析/缓存总是跑；live 行可 SKIP）
  - 解析器 fixtures：全有、缺项、坏格式、nnp 0/1/unknown。
  - 缓存：相同 key 60s 内只跑一次；in-flight 去重；过期重跑。
  - 组装：每个 check 的 status 与 code 对应；`ok` 只由 fail 决定。
  - live 行：`DSH_WSL_DISTRO` 可达时跑 `health`，否则 SKIP（前提声明）。

### 11.2 扩展套件

- `verify-client-ui.mjs`：调 `bootstrap`；不渲染 `error`；degraded phase 存在；浮动入口源码；新双语文案。
- `verify-client-dom.mjs`：jsdom 场景——degraded 不发请求；bootstrap 失败走兜底；锚点缺失出现浮动入口、可关闭；code 渲染不显示 raw message；health 条渲染。
- `verify-route.mjs`：`bootstrap` / `health` 的浏览器可达性与 dev-token 规则；两者只读。
- `verify-post-restart.mjs`：见 7.5。
- `verify-all.mjs`：`STANDALONE` 加三个新套件；`DECLARED_SKIPS` 加 host-contract/doctor 的前提。
- `verify-modules.mjs`：新纯模块加入 `PURE`/`ALL`（现有硬编码清单，手动加）。
- `verify-docs.mjs`：`DOC_PAIRS` 加 `['docs/DIAGNOSTICS.md', 'docs/DIAGNOSTICS.en.md']`。

### 11.3 验收命令

```text
node scripts/verify-all.mjs
node scripts/verify-all.mjs --live
node scripts/verify-post-restart.mjs
```

全绿（含已声明 SKIP）才算完成；live 需要安装插件并运行宿主。

## 12. 文档与版本

- 新增 `docs/DIAGNOSTICS.md` / `docs/DIAGNOSTICS.en.md`：错误码表、remedy、体检、降级矩阵、隐私边界、常见修法。
- README（中/英）：在「会意外的地方」加一条「失败现在带 code，可在对话框里跑体检」，链接 DIAGNOSTICS。
- `docs/ARCHITECTURE.md` / `.en.md`：加一段「契约层与降级」。
- `docs/UPSTREAM-PROPOSALS.md`：修正 A2 的过时描述（`serviceFor` 实例包装现在已在用）。
- 版本 0.6.0；`package.json` 的 `files` 已包含 `lib/`，新模块自动入包；`scripts/` 不入包。

## 13. 实施顺序

1. **A1**：`protocol.js` + `route-errors.js` + 路由映射 + `bootstrap` + 客户端 catalog + `verify-protocol`。
2. **C1**：`host/contract.js` + `probeHost` + 客户端能力检查 + degraded phase + `verify-host-contract` + post-restart 增段。
3. **A2**：`wsl/doctor.js` + `health` + 对话框检查条 + `verify-doctor` + 文档。
4. **收尾**：浮动入口、a11y/焦点、双语文案、全量验证。

每一步都可独立交付；第 2 步依赖第 1 步的 code/remedy 表，第 3 步依赖前两步。

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| bootstrap 本身失败 | 客户端兜底 code；重试一次；对话框仍可打开 |
| probe 时机早于服务就绪 | `pending` + 1s 重试；不把未知误判为降级 |
| 体检慢 | 批处理 + 缓存 + 与目录浏览并行；批处理 15s、整体 35s 上限 |
| 体检误报 | 建议性；每项给测量依据；NNP 未知不判 fail |
| 浮动入口侵入 | 只在锚点缺失时出现、可关闭、不重复 |
| 新套件维护成本 | 沿用现有 checker/`skip()` 约定；C5 再做公共 harness |
| 参数泄露 | 白名单 + verify-protocol 负例 |
| 文档双语漂移 | 加入 `DOC_PAIRS`，`verify-docs` 钉住 |

## 15. 验收标准

1. 浏览器可达方法的失败只回 `{ok:false, code, params}`；`error` 不出现；未知异常带 `ref`。
2. `bootstrap` 返回 catalog + capabilities；客户端用它渲染文案与 remedy。
3. picker 必需 feature 缺失时，点击 W 进入 degraded phase，且不发任何 distro 请求。
4. 锚点缺失时 6s 内出现浮动入口；点击打开对话框；关闭后本次会话不再出现。
5. `health` 对每个检查项返回状态与 remedy；建议性；60s 缓存；无路径/stderr。
6. `verify-protocol`、`verify-host-contract`、`verify-doctor` 以及扩展后的 client/post-restart 套件全绿，且每项有能失败的 mutation proof。
7. `verify-all` 与 `--live` 全绿（含已声明 SKIP）。
8. 文档双语对一致；`verify-docs` 绿。
9. 无新依赖；`dsh.client.inject` 未变；宿主下限未变。

## 16. 后续（不在本包）

- C2 原语收敛、C3 模块拆分、C4 传输缝、C5 验证收敛。
- A3–A7、D1/D2。
- `docs/WATCH.md` 已声明的 in-distro inotify 桥（等触发条件）。
