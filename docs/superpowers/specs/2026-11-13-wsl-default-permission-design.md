# WSL 会话的默认权限姿态 — 设计

日期：2026-11-13
状态：待批准（第二版，已按第一轮 builder-check 修正）
关联：`SECURITY.md`、`README.md` / `README.en.md`、`docs/COMPATIBILITY.md`、`docs/ARCHITECTURE.md`、`docs/PERSISTENT-SHELL.md`、`docs/FS-FENCE.md`、`lib/wsl/shell.js`、`lib/wsl/fs.js`

## 1. 问题与来由

这个插件目前只面向「作者本人或同信任级别的操作者」。要往第三方分发，第一个挡住陌生用户的不是功能，而是**装完跑不起来的门槛**：

- 受限模式（`read-only` / `workspace-write`）要求会话用户**免密 sudo**、`bash`、`python3`，以及 util-linux 的 `unshare`/`setpriv`/`findmnt`。
- 缺任何一项，`lib/wsl/sandbox.js` 的 `confine()` 都按接缝契约 **fail-closed** 抛 `SandboxUnavailableError`。这是正确的行为，但用户看到的是「装完了，什么都干不了」。
- 结果：用户被迫去选 `danger-full-access` 才能干活。

**也就是说，今天实际发生的默认结果，已经是「完全放开」了** —— 只是它发生在一个坏路径上：用户先撞墙、再自己去发现。本设计把这个既成事实变成**显式的默认**。

### 1.1 一个必须先承认的事实

宿主的 `permission-presets` 会给**每个新会话**无条件写入一条 `sandbox/mode` 覆盖值（`packages/interaction/permission-presets/src/index.ts:233-235` → `pinInitialPermission` → `:442` `setSandboxMode(session, spec.sandbox)`），且以 `{ prepend: true }` 注册。而 `SandboxPolicyService.resolve()` 的优先级是：

```ts
// sandbox-policy/src/index.ts:214-219
mode: request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode
```

**显式 mode > 会话日志覆盖 > defaultMode**。

因此：**改宿主的 `defaultMode` 对真实会话无效**，因为每个会话都会被写一条 `workspace-write`。这是本设计放弃「隔离 `sandboxPolicy`」路线的根本原因（详见 §3.2）。

## 2. 目标与非目标

**目标**

1. WSL 会话的默认权限姿态是 `danger-full-access`，装完即可用，不需要免密 sudo。
2. `read-only` 与 `workspace-write` 两个档**完全保留**，用户选中时行为与今天一致（照旧 fail-closed，不降级、不静默放行）。
3. 默认姿态**对模型公开**，不是静默放开。
4. Windows 工作区的权限姿态**完全不受影响**。

**非目标**

- 不移除、不弱化任何现有围栏代码。
- 不引入 `bubblewrap` 之类的新依赖。
- 不改 `SandboxEnforcement` 的类型或语义（见 §3.1）。
- 不改 `lib/wsl/fence.js` 的判定逻辑。
- 不与宿主 `permission-presets` 抢写 `sandbox/mode` 事件（见 §3.3、§3.4）。

## 3. 已排除的方案与理由

### 3.1 「如实声明 `enforcement: 'unconfined'`」—— 不可能

宿主契约 `packages/sandbox/sandbox/src/index.ts`：

```ts
export type SandboxEnforcement = 'full' | 'partial'
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>
```

`confine()` 的契约是「must return enforcing argv or fail closed … **silent unconfined passthrough is forbidden**」。`'unconfined'` 不是合法值。

> **顺带修正一处既有文档错误**：`docs/COMPATIBILITY.md:28,33` 描述的 `enforcement: unconfined` 在宿主类型里**没有任何对应值**（全仓 `unconfined` 只出现在注释与错误文案中，`sandbox-windows-acl` 也只报 `'partial'`）。那两行是**待独立修正的文档错误**，本设计不依赖它，也不在本设计范围内修。

### 3.2 「把 `sandboxPolicy` 隔离进 `wsl-world`」—— 机制上不成立

主张是：在 `wsl-world` 组里挂一个 `sandbox-policy` 行，配 `mode: 'danger-full-access'`，并给 `isolate` 加 `sandboxPolicy: true`。

三处技术前提**是对的**（已逐条核实）：

- 投影 key 按 refs 共享：`session-projection/src/index.ts:408-422`，`stateVersion` 与 `wire.summary` 一致时 `existing.refs += 1` 复用，不抛错；
- prompt context 在 scoped 层**遮蔽**而非冲突：`core/system-prompt/src/index.ts:515-516`「Scoped entries shadow global entries with the same name」；重名抛错只在同一 `PromptLayer` 内（`PromptLayer` 定义见同文件 `:402-433`，报错文案在 `:417-419`）；
- 隔离组的注册带 mount scope：`agent-preset-registry/src/mount.ts:205` 要求 `scopeOf(ctx) !== undefined`，该 tag 从 mount ctx 继承。

**但结论不成立**，因为 §1.1 的优先级：隔离实例的 `defaultMode` 在**有会话覆盖值时永远不被采用**。每个新 WSL 会话都会被 `permission-presets` 写入 `workspace-write`，于是：

- 系统提示显示 `workspace-write`（目标 3 落空）；
- `shell.js:164` 取到 `workspace-write` → `confine()` → 没 sudo 就 `SandboxUnavailableError`（目标 1 落空）。

**这条路整体作废，不是缺少配置而是机制冲突。**

### 3.3 「在 `agent/created` 上抢先写 `danger-full-access`」—— 不可靠

`permission-presets` 以 **`{ prepend: true }`** 注册（`permission-presets/src/index.ts:233-235`）。插件若也注册同事件监听，两者相对顺序取决于**插件加载顺序**，不由我们控制，且被覆盖时**没有任何报错**。

这个项目在 0.1.6 → 0.1.7 的迁移中正因为依赖宿主内部时序「一次断了四处」。**不采用。**

### 3.4 「在会话创建请求里带初始权限模式」—— 接口不存在

`packages/api/session-controller/src/types.ts:268-277`：

```ts
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}
```

内层 `ApiSessionCreateRequest`（`src/agent.ts:56-69`）同样只有 `sessionId` / `cwd` / `agentPreset` / `reusable`。**没有 sandbox 或权限字段。**

> **重新评估的触发条件**：若宿主未来在创建接口开放初始权限模式，§3.3 / §3.4 应重新评估——那时这条路会优于本设计采纳的 §4。

## 4. 采纳的方案：插件内部判定默认档

### 4.1 做法

不碰宿主任何服务。插件自己决定「**未显式传入 policy 时用什么档**」，落点在**两个纯函数级的小改**：

**(a) `lib/wsl/shell.js` 的 `resolve()`（:164）**

现在：

```js
sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
```

改为：当调用方**未传** `sandboxPolicy`，且本 realm 配置的默认档是 `danger-full-access` 时，用插件构造的完全放开 policy 取代 `ctx.sandboxPolicy.resolve()`。

**(b) `lib/wsl/fs.js` 的 `checkedTarget()`（:243）**

现在：

```js
const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
```

同样改为：未传 policy 时用插件的默认档，而不是 `ctx.sandboxPolicy.resolve()`。

**(c) 默认档的来源：插件自己的 Config。**

新增一个配置项（名字待定，建议 `defaultPermissionMode`），枚举与宿主一致（`'read-only' | 'workspace-write' | 'danger-full-access'`），**默认值 `'danger-full-access'`**。

**关键区分：** 只有「调用方没传 policy」这一条路径被改写。调用方（`tool-bash-persistent`、`tool-fs` 等宿主工具）**传**了 policy 时——也就是用户真的通过 Permissions 菜单选择了模式——插件**原样尊重**，不做任何覆盖。

### 4.2 为什么这是对的

- **不与宿主抢同一个事件**：插件只读，宿主只写；没有时序竞争。
- **用户显式选择仍然生效**：`permission-presets` 写进日志的值，经 `tool-fs` / `tool-bash-persistent` 的 `policy.resolve({session})` 传到插件，**调用方传了 policy，插件就用它**。受限模式照旧可用。
- **改动面最小**：两处 `??` 右侧的表达式 + 一个 Config 字段。不改 `fence.js`、不改 `confinement.js`、不改预设、不改隔离键。
- **可测试**：两个纯逻辑分支，`verify-preset` 式的离线断言即可覆盖。

### 4.3 必须承认的代价：双轨

采纳本方案后存在一个**刻意的**不一致：

- 会话日志、`permission-presets` 投影、UI 的 Permissions 菜单都会显示 **`workspace-write`**（宿主写入的）；
- 而插件的 shell / fs 在**没有调用方 policy** 时按 **`danger-full-access`** 执行。

也就是说 **UI 显示与实际行为在默认路径上不一致**。

**缓解（必须全部做到）：**

1. 插件在 `bootstrap` / `health` 的返回里暴露它实际采用的默认档，让 UI 或诊断能读到；
2. W 对话框的环境检查里显示一行「本插件的默认档 = X」；
3. README 与 `SECURITY.md` 显式写出这条不一致，而不是让用户自己发现；
4. 这一条**列为已知缺陷**，并在 §7 给出未来消除它的条件（宿主开放创建期权限）。

**如果产品不能接受这条双轨，那么本设计不应实施**——因为 §3 的其余路线都已被证伪，剩下的唯一选择是「保持现状（默认受限 + 要求 sudo）」。

### 4.4 对模型可见性（目标 3）

**双轨的一个直接后果：模型看到的系统提示来自 `sandbox-policy` 的 `renderPolicyContext`，它读的是宿主 `resolve()`，即 `workspace-write`。** 所以默认档下**模型会被告知「当前工作区受限」**，而实际执行是完全放开。

这与「默认姿态对模型公开」这个目标**冲突**。处理方式二选一（**需产品决定**）：

- **(i)** 插件自己注册一个 systemPrompt context（在 mount scope 内，遮蔽宿主的 `sandbox:policy`），如实告知实际档位；
- **(ii)** 接受不一致，只在用户侧文档披露。

**我建议 (i)**，因为它让「对模型公开」成立；但它要新增一个 prompt 注册点，且遮蔽行为依赖 §3.2 里已核实的作用域语义。若选 (ii)，目标 3 需要从目标里删掉。

## 5. 对现有文档与代码的影响（完整清单）

第一轮 builder-check 指出漏项，以下为**逐项核对后**的完整清单。所有 `.md` 都成对存在，`scripts/verify-docs.mjs` 校验双语结构对等，**必须成对修改**。

| # | 位置 | 现在写的 | 必须改成 |
|---|---|---|---|
| 1 | `SECURITY.md` 部署前提第 2 条 | 把免密 sudo 列为**部署**前提 | 改为「**受限模式**的前提」，默认档不需要 |
| 2 | `SECURITY.md`「三层边界」表 | shell / fs 围栏**无条件**成立 | 加条件：仅当调用方带 policy（即用户显式选择）时成立 |
| 3 | `SECURITY.md`「适合谁用」 | 「分发给第三方用户尚不适合（缺桌面版本门控与发行版矩阵）」 | **两条理由都不由本设计闭合**。本设计只改默认姿态，不提供版本门控，也不扩发行版矩阵。**保留这句话**，另立工作处理 |
| 4 | `README.md` / `README.en.md` 「装之前要有什么」 | 「**会话用户能免密 sudo**……这一条最容易卡住」 | 改为「受限模式需要；默认档不需要」，并说明默认档是什么 |
| 5 | `README.md` / `README.en.md`「会意外的地方」 | 缺默认姿态披露 | 新增一条：默认档下达不到围栏；要围栏请显式选受限模式 |
| 6 | `docs/COMPATIBILITY.md` / `.en.md` | 无默认姿态表 | 新增「插件版本 × 默认档」小节（**两版同改，标题数对等**） |
| 7 | `docs/ARCHITECTURE.md` / `.en.md:66` | 「realm 的 `isolate` 是**五**个键」 | **本设计不改 isolate**，此条**无需修改**（第一轮审阅的这条建立在 §3.2 方案上，方案作废后不再适用） |
| 8 | `docs/PERSISTENT-SHELL.md` / `.en.md:61` | 「`isolate` 的五个键」 | 同上，**无需修改** |
| 9 | `docs/diagrams-src/architecture.json:32,519` | 「隔离 shell、fs、subprocess、terminals 与 sandbox 五个键」 | 同上，**无需修改** |
| 10 | `docs/FS-FENCE.md` / `.en.md:7` | 「`WslFileSystem` 自带围栏」 | 加条件：默认档下无调用方 policy 时放行 |
| 11 | `docs/COMPATIBILITY.md:28,33` | `enforcement: unconfined` | **既有错误**，本设计不修；在 §8 记为独立待办 |

> 第 7–9 项是**第一轮审阅基于已作废方案提出的**。本设计不新增 isolate 键，因此它们不改。列出是为了让后续读者知道这些项被考虑过、且为什么不改。

## 6. 验收标准

1. **新建 WSL 会话**，读取该会话 `systemPrompt.assemble()` 的 `sandbox:policy` 段——**注意不是在 `bootstrap` 里看**：`bootstrap`（`lib/index.js:372-385`）只返回 `pluginVersion` / `catalog` / `capabilities`，不含系统提示；且 `renderPolicyContext` 在 `session === undefined` 时返回空串（`sandbox-policy:186-190`）。验收值为 §4.4 选定的结果。
2. **在打开任何常驻 shell 之前**把权限切到 `workspace-write`：文件工具恢复工作区围栏，shell 按既有逻辑要求 sudo 并 fail-closed。
   **必须写「之前」**：`terminal-bash` 在存在活动 PTY 时**拒绝**模式变更（`packages/terminal/terminal-bash/src/index.ts:49-59`，`cannot change sandbox mode … while persistent terminal sessions are open`）。
3. Windows 工作区会话的默认模式**不变**（仍为 `workspace-write`）。
4. `node scripts/verify-preset.mjs` 通过。**本设计不改 isolate，`verify-preset.mjs:193` 的精确字符串断言保持原样**；新增的是一条配置默认值与两个分支的断言。
5. `node scripts/verify-all.mjs` 仍 **exit 0**，且 `verify-docs` / `verify-preset` 全绿。
   「24/26、2 个跳过」是**当前机器的观测值，不是不变式**：`STANDALONE` 恰 26 个（`verify-all.mjs:85-112`），跳过的 2 个来自本机缺 icon 源与 jsdom。文档改动若让 `verify-docs` 红，聚合会变成 23/26 且 exit 1——所以 §5 的双语同改是硬要求。
6. `scripts/verify-client-ui.mjs` / `verify-client-dom.mjs` 不受影响。
7. **`verify-post-restart.mjs:321` 必须同步修改**：`check('a write outside the workspace is refused', confined?.sandbox?.denied === true)` 依赖 `lib/index.js:842` 那条**不带 `sandboxPolicy`** 的 `shell.confined` 探测，默认档放开后它**必然红**。
   **修法（需产品决定）**：
   - **(i)** 给该探测显式带 `workspace-write` policy，继续测「围栏在受限模式下仍然生效」——保留这条断言的原有价值；
   - **(ii)** 改成断言「默认档下不再拒绝」，另加一条带 policy 的围栏断言。
   **我建议 (i) + (ii) 都做**：一条证明围栏仍可用，一条证明默认档确实变了。

## 7. 未验证项与后续

- **未做运行时实测。** 本设计的两处改动是纯逻辑分支，但「用户通过 UI 选模式后，调用方确实会传 policy」这一前提来自读 `tool-fs` / `tool-bash-persistent` 的 `resolve({session})` 调用链（`tool-fs/src/sandbox.ts`、`sandbox-policy:208-220`），**需在实装后跑一次真实会话确认**：选 `workspace-write` 时插件确实收到 policy 而不是走默认分支。
- **消除双轨（§4.3）的条件**：宿主在会话创建接口开放初始权限模式（§3.4），或 `sandboxPolicy` 提供会话级默认解析扩展点。届时本设计应被替换。
- **`writableRoots`**：与本设计正交。它让 `workspace-write` 下能写 `~/.npm` 等缓存；本设计处理默认要不要围栏。两者互不替代。
- **升级路径（可写死，不是待验证）**：`materializePresets` 只在插件 apply 时跑一次（`lib/index.js:216-308`），`refreshPresets` 另由 developer-token 触发；已存在的会话持有已 composition 的 generation（`agent-preset-registry/src/index.ts:248-306`），不会因变体重新注册而换树。**所以：已有 WSL 会话保持旧行为，新会话才用新默认。**
- **`DSH_PERMISSION_MODE` 不一致（接受的取舍）**：base bundle 的根行仍读它（`base/cordis.patch.yml:246`）。于是 `DSH_PERMISSION_MODE=read-only` 的部署会得到「Windows 会话只读、WSL 会话默认放开」。**本设计接受这条不一致**；若不可接受，需让插件配置也读该环境变量。
- **`additionalWritableRoots` 不会带入**：插件构造的默认 policy 若只含 `mode`，环境里配置的额外可写根在 WSL 侧不生效。默认档下无影响；用户切受限模式后需注意。实装时应把宿主的 `additionalWritableRoots` 一并带过来。

## 8. 独立待办（不在本设计范围）

1. `docs/COMPATIBILITY.md:28,33` 的 `enforcement: unconfined` 在宿主类型中无对应值，是既有文档错误，需单独修正。
2. `SECURITY.md` 的「缺桌面版本门控与发行版矩阵」两条分发障碍，本设计**不闭合**，需另立工作（`engines.dsh` 与发行版矩阵）。
3. `README.md:111` 让第三方运行 `node scripts/verify-post-restart.mjs`，而 `scripts/` **不随 npm 包发布**（`files` 只含 `lib`、`cordis.patch.yml`、两个 README、`LICENSE`）。文档可达性问题，需单独处理。

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户误以为仍有围栏（双轨） | **高危**：UI 显示受限、实际放开 | §4.3 的四条缓解全部做到；否则不实施 |
| 模型被告知错误档位（§4.4） | 中：模型据错误前提行动 | 选 §4.4(i) 自己注册 prompt context |
| `verify-post-restart` 未同步 | 中：live 门红 | §6.7 列为必改项，两条断言同批改 |
| 与 `dsh-plugin-wsl-env` 的安全立场相反 | 低：用户比较后质疑 | 文档正面说明取舍 |
| 默认档配置项被误配 | 中：`read-only` 会让用户撞墙 | 配置校验 + W 对话框显示实际档位 |
