# 上游设计提案 — 面向执行世界类插件的 0.1.7+ API 缺口

> 提出方：`dsh-wsl-desktop` 插件（一个把会话执行世界搬进 WSL 发行版的桌面插件——bash/fs/subprocess 提供者 + 运行时注册的派生预设）。
> 基线：DSH Desktop 0.1.7-rc.2（win-x64），插件 HEAD fe072d2。本提案的所有证据都来自我们在 0.1.6 → 0.1.7 迁移中实际踩到的断裂，以及为兼容而被迫采取的三处「 reach into 内部结构 / 动态导入宿主包」的权宜实现。
> 目标：让下一版执行世界类插件**不需要任何私有结构访问**就能正确工作，并把 0.1.7 已有但难发现的 API 正式化。

---

## 提案 A：`agentPresets.readDefinition(agentPreset)` — 以对象形式公开预设声明

### 问题

0.1.7 的派生预设插件需要读取基础预设的**声明行对象树**（`PresetDefinition.config.plugins`），按模块名递归剪枝宿主执行世界行、附加 isolate 组，再通过 `register()` 注册变体。现有公开 API 只有：

- `readDocument(agentPreset)` → 返回 Loader 方言**重新 dump 的 YAML 文本**。文本形态对派生变换不友好：对象身份丢失、`!!js` 表达式的往返不可靠（我们实测 YAML round-trip 与对象树不等价），任何基于对象行的变换都要先引入一个 YAML 解析器再承担解析歧义。
- 事实上的数据在 `agentPresets.definitions`（TypeScript **private** Map，`index.ts:59`）里，形状是 `{ id, config: PresetDefinition, ready }`。

`dsh-wsl-desktop` 当前的兼容实现直接读了这个私有 Map（`lib/index.js:148`：`presets.definitions?.get?.(id)?.config?.plugins`）。它能工作，但：(1) TS private 意味着任何重构都可能破坏它；(2) 我们必须对 registry 的 `register`/`unregister`/mount 语义做逐行源码核验（`index.ts:80-109`、`mount.ts` 的 standing mount fiber 语义）才能确认读到的定义与 `select`/mount 看到的**完全一致**——这个一致性保证应该由 API 本身给出，而不是由插件作者读源码背书。

### 提案

```ts
/** 读取一个预设的声明（含子插件行对象树），deep-frozen。 */
readDefinition(agentPreset: string): Promise<Readonly<PresetDefinition>>
// 返回 { agentPreset, id, name?, description?, plugins, ... } —— 即 register() 收到的同一棵对象树。
```

- 与 `readDocument` 并存：`readDocument` 面向「查看」，`readDefinition` 面向「程序化派生」。
- 派生类插件（执行世界、语言变体、合规变体……）是这类 API 的共同受益者：任何「从基础预设派生变体」的场景都需要行对象树。

### 顺带请求：`serviceForAgent` 的可发现性

0.1.7 把 mount 作用域的服务从 `agent.ctx.get` 的可见域里移走了（standing mount 的服务活在 mount 自己的 fiber 下，`agent.ctx.get('shell')` 解析到**宿主根服务**——我们的会话自检曾因此拿到 bash-local 而不是 realm 的执行器，直到读 `mount.ts` 源码才发现 `serviceForAgent(ctx, agent, name)`（`mount.ts` 导出、包入口再导出）才是正确访问器）。请求：

1. 在 0.1.x 迁移文档中明确：「mount 作用域服务的唯一访问器是 `serviceForAgent`；`agent.ctx.get` 对 mount 内服务不可用」。
2. 考虑在 `AgentPresetRegistry` 上提供实例方法包装（`registry.serviceFor(agent, name)` 委托 `serviceForAgent(ctx, agent, name)`），让动态导入整个包都不再必要。

### 附带问题：插件对宿主包的静态导入解析

`serviceForAgent` 目前通过 `await import('@deepseek-ai/dsh-agent-preset-registry')` 动态导入——从插件的安装目录（`$DSH_HOME/profiles/<p>/plugins/<gen>/`）出发按 Node 标准算法解析。它在宿主进程内**能**解析（宿主的模块钩子覆盖插件图），但这依赖宿主实现细节。请求在插件 SDK 文档中明确：**宿主包从插件模块内动态导入的解析保证**（或提供 `hostImport(specifier)` 之类的官方通道）。背景：把这类包声明为插件 `dependencies` 会导致 pnpm 安装第二份副本——类身份（`instanceof`/`extends` 基类）与单例服务（cordis `Service`）都会漂移。

---

## 提案 B：`SubprocessRuntime` 的沙箱奇偶性 — 显式语义或显式边界

### 问题（审计 run-2 的 deferred 单元，经源码核验）

同一会话里两条执行路径的沙箱待遇不对等：

- **bash 工具**（`ShellExecutor.execute` → confinement）：read-only / workspace-write 模式下进 mount namespace（workspace bind、tmpfs /tmp、ro /、findmnt sweep、read-back postconditions、失败即 exit 97），`enforcement: 'partial'` 如实上报。
- **`SubprocessRuntime.spawn`**（语言服务器、MCP stdio、工作流子进程等**基础设施消费方**）：完全没有沙箱概念——`spawn(spec)` 委托宿主 provider，argv 经语法校验，进程在发行版内**无围栏**运行。

以 WSL 插件为例：模型经 bash 工具写 `/etc` 会被 EROFS 拒绝（97），但一个读取模型可写工作区配置文件的 LSP 进程（基础设施面）对同样的写入不受任何约束。两条路径的信任来源相同（会话），边界承诺却不同——而 **`SubprocessRuntime` 的类型面没有任何字段声明这种差异**（对比 `ShellExecutor.sandboxMode`），插件作者与审计者都只能靠读两边的实现来发现。

### 提案（分两步，均不需要破坏现有插件）

1. **声明面（0.1.x 内可做）**：给 `SubprocessRuntime` 加一个与 `ShellExecutor.sandboxMode` 对偶的**只读事实声明**——例如 `sandboxExposure(): 'unconfined' | SandboxMode`（或文档化的常量）。WSL 插件如实报 `'unconfined'`。这让审计者与工具层能**从类型面**读出两条路径的边界差异，而不是逐实现比对。
2. **执行面（需要产品决策，建议单独立项）**：是否让基础设施 spawn 在受限模式下继承会话围栏。权衡：LS/MCP 是**配置派生**（不是模型每次调用派生）的进程，围栏它们可能破坏 LSP 的正常写入（编译数据库、索引）；但完全不围栏意味着「受限模式的会话里，模型可以通过操纵工作区配置间接影响一个无围栏进程的行为」。这项决策需要 harness 对「基础设施进程」的信任模型表态——插件两边都能适配。

### 我们（插件侧）的当前处置（供参考）

- `README` 与审计报告将 subprocess 面披露为 **disclosed-deferred**（设计决定，非缺陷）：bash 工具围栏是安全边界；spawn 面是基础设施。
- 插件的 spawn 面仍做**语法层校验**（distro/username 语法在 spawn 前验证）并如实转发。

---

## 迁移证据（0.1.6 → 0.1.7 实际断裂清单，作为上述提案的动机附录）

| # | 断裂 | 插件被迫的权宜实现 | 对应提案 |
|---|---|---|---|
| 1 | `agentPresets.read(id)` 移除 → `readDocument`（返回重 dump 文本） | 需要对象树 → 读私有 `definitions` Map | 提案 A |
| 2 | mount 作用域服务离开 `agent.ctx.get` 可见域 | 动态导入 `serviceForAgent` + `ctx.get` 回退 | 提案 A（可发现性） |
| 3 | 预设不再从 `~/.agent-presets` 目录加载 | 运行时 `register()` + 自持 disposer（这本身是更干净的架构 ✓） | — |
| 4 | 行模块名必须可被 loader 以 URL/裸名导入（反斜杠路径双败） | 行名改 `file://` URL 拼写 | — |
| 5 | `ShellExecutor.run` → `execute`，且返回从 settled 结果变为**活动句柄**（`result()` 投影） | execute 重写为句柄；selftest/套件改经 `result()` 取结果 | 建议迁移文档列出句柄字段 |
| 6 | 宿主根作用域注册 `shell`（bash-local）——Windows 会话的 `ctx.get('shell')` 从 undefined 变为宿主执行器 | 自测的 shell 断言从 `found === false` 改为「proto 不含 confinementFor」 | 提案 B（声明面对偶） |

## 请求的裁定

- 提案 A：`readDefinition` 是否纳入 0.1.x 后续版本？（小 API 面，registry 内已有数据。）
- 提案 A 附带：`serviceForAgent` 迁移文档化 + 实例包装是否可接受？
- 提案 B 第 1 步：`SubprocessRuntime` 的沙箱暴露声明（只读事实）是否纳入？
- 提案 B 第 2 步：基础设施 spawn 的围栏语义由谁裁定（harness 产品侧）——若裁定「不围栏为正式语义」，我们将把披露升级为正式契约文档。
