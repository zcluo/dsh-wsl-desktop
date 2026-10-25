# `sandbox-windows-acl` 在 WSL 9P 工作区上必然失败：9P 不提供 Windows 安全描述符

## 摘要

Windows 上，当会话工作区是 WSL 的 9P UNC 路径（`\\wsl.localhost\<distro>\...` 或 `\\wsl$\<distro>\...`）时，每一次 `workspace-write` 沙箱授权都在构造阶段失败：

```
GetNamedSecurityInfoW failed (Win32 1): \\wsl.localhost\<distro>\home\<user>\<project>
```

命令从未运行。`run_code` 把它报告为 `code run failed (worker-exit)`。

## 根因

9P 文件系统**不提供 Windows 安全描述符**，而 `sandbox-windows-acl` 的能力授权正是建立在该描述符之上：

```
AclSandbox 构造
  → grantWrite(path, ...)                    packages/sandbox/sandbox-windows-acl/src/acl.ts:377
  → readCurrentSecurity(api, path)           acl.ts:141
  → GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL|LABEL, ...)   acl.ts:150
  → 返回 Win32 error 1，抛错                  acl.ts:154
```

该包内**没有任何 UNC / 9P 检测**。

## 实测数据

环境：Windows 11，WSL 6.18.5.4，两种共享拼写均测试。

| 路径 | `Get-Acl` 结果 |
|---|---|
| `C:\Users\<user>`（本地 NTFS） | **成功** |
| `\\localhost\C$\Users\<user>`（SMB UNC） | **成功** —— SMB **确实**带安全描述符 |
| `\\wsl.localhost\<distro>\...` | **失败**，Win32 error 1（0x1509 / 5385） |
| `\\wsl$\<distro>\...` | **失败**，同上 |
| `\\wsl.localhost\<other-distro>\...`（第二个发行版） | **失败**，同上 |
| 读取 / 列出同一目录的**文件内容** | **成功** —— 数据访问完全正常 |

所以这是 **9P 的能力缺口**，不是权限配置错误；也**不是**“所有 UNC 都坏”——SMB UNC 是好的。任何 `isWsl9pPath()` 判定都必须**只**匹配这两种 WSL 共享前缀；匹配任意 UNC 会削弱一个本来有效的围栏。

`realpathSync.native` 对这些路径**原样返回**（不加 `\\?\` 扩展前缀），所以基于共享前缀的判定能稳定穿过 `canonicalPath()` 那一步。

## 为什么插件的 realm 隔离不能覆盖它

`dsh-wsl-desktop` 在 `wsl-world` 组里 isolate 了 `shell`、`fs`、`subprocess`、`terminals`、`sandbox`，使 realm 内的工具解析到插件自己的 `WslSandboxProvider`（围栏发生在发行版内部），而不是宿主的 ACL runner。这对它替换的那 5 个工具行有效。

但它**不覆盖 `run_code`**：`@deepseek-ai/dsh-tool-executor-ptc` 和 `@deepseek-ai/dsh-ptc-runtime-node` 不在插件的替换名单里，因此它们留在宿主 realm，解析到宿主的 `sandbox-local` → `windows-acl` → 就是这个崩溃。

### 为什么插件无法自行修复

我尝试过把 ptc 搬进 realm（因为 `ptc-runtime` 声明 `static inject = ['fs','subprocess','sandbox','sandboxPolicy']`，而前三项 realm 已提供）。但验证后发现语义冲突：

```ts
// ptc-runtime-node/src/index.ts:219
const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, undefined, signal)
const argv = [executable, '--max-old-space-size=...', ...bootstrapArgs(...)]
confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, {...policy}, signal)
```

`executable` 是 **Windows 的 `node.exe` 绝对路径**。若 `ctx.sandbox` 换成 `WslSandboxProvider`，它会把这个 argv 包成“在发行版内执行”——而发行版里没有那个 exe。这只会把 `GetNamedSecurityInfoW` 错误换成 `No such file or directory`。

`ptc-runtime` 的 worker 刻意跑在宿主 Node 进程（`isolation = 'process'`），这与“argv 在发行版内执行”在语义上直接冲突。**所以这个缺口不能下推给插件作者。**

## 建议的修法（由上游选择）

**方案 A —— 识别 9P 并声明式降级（最小改动）**

加一个只匹配 `\\wsl.localhost\` 和 `\\wsl$\`（大小写不敏感）的判定，然后：

- 在 `runner.ts` 里于构造 `AclSandbox` 之前，对 9P 的 `workspace-write` 以点名原因的方式拒绝（exit 127，沿用现有的 runner-failure 契约）；
- 在 `sandbox-local.confine()` 里把这一种组合降级为**声明式的** unconfined 结果，而不是抛错。

第二半需要一个第三种 `SandboxEnforcement` 值，因为“完全无法治理”与 `partial`（治理得比承诺的少）以及 `SandboxUnavailableError`（拒绝执行）是不同的事实。静默的无围栏放行正是该接缝自己的契约所禁止的；一个消费方必须上报的值才是“声明式”的形式。

**方案 B —— 9P 工作区跳过 ACL 档**。同样的判定；`sandbox-local` 为 9P 工作区选择不挂 runner。仍需要上面那个声明式值，理由相同。

**方案 C —— 文档化并在会话开始时拒绝**。最省事，但 9P 工作区依旧不可用，也就是现在的行为。

## ⚠️ 如果采用方案 A/B，请注意这两个陷阱（我实现时踩到了）

**陷阱 1：`ConfinedArgv` 的必填字段**

`denialSignatures` 和 `runnerFailureRules` 是**必填**字段（无 `?`），且有 3 处消费方**无条件**解引用前者（行号已对照源码核实）：

```
packages/ptc-runtime/ptc-runtime-node/src/persistent.ts:90
packages/ptc-runtime/ptc-runtime-node/src/index.ts:286
packages/experimental/ptc-runtime-python/src/index.ts:1808
```

我最初的实现漏了这两个字段，实测抛 `Cannot read properties of undefined (reading 'some')` —— 这会把“清晰的 ACL 失败”换成“上一层莫名其妙的 TypeError”，**比原 bug 更糟**。正确做法是携带空数组。

**陷阱 2：运行时枚举，不只是类型**

`tool-executor-ptc/src/ptc.ts:328` 有一个**运行时** JSON Schema 枚举：

```ts
enforcement: { type: 'string', enum: ['full', 'partial'] },
```

只改 TypeScript 类型不够——新值会被当作 invalid output 拒绝，在渲染之前就失败。

## 影响面

任何在 Windows 上把 WSL 目录作为工作区、并在插件 realm 之外使用 `run_code`、`bash` 或 `fs` 的用户都会撞上。插件自身的 realm 不受影响。

## 当前可用的绕过方式

使用 WSL agent 预设（围栏在发行版内完成），或把会话切到 `danger-full-access`（该模式完全跳过 `confine()`：`ptc-runtime-node/src/index.ts:219`）。

注意第二种绕过的前提：**该会话尚未跑过终端命令**。`terminal-bash` 的守卫会在 `hasOwnerActivity(owner)` 为真时拒绝切换沙箱模式（`packages/terminal/terminal-bash/src/index.ts:54`），而持久终端是在**第一次执行 bash 类命令时**才懒加载创建的（`tool-bash-persistent/src/index.ts:258`）。所以新会话可以直接切，跑过命令后需要先关掉终端再切。
