# 被拒绝的权限切换被静默丢弃，菜单无声回退，用户拿不到任何原因

## 摘要

切换会话的权限预设可能被宿主拒绝。最容易复现的拒绝来自 `terminal-bash` 的沙箱模式守卫：当该会话有持久终端活动时，宿主拒绝改变沙箱模式。这是**正确的行为**。

但客户端把拒绝信息丢掉了：

```ts
// packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:126
const submit = (id: string): void => {
  setPick(id)
  void select(id)
    .catch(() => false)          // ← 原因在这里消失
    .then(() => { setPick(null) })   // ← 乐观值清除，界面回退
}
```

菜单变回原来的值，没有任何提示。对用户而言，这与“这个控件坏了”无法区分——因为没有任何下一步可做。

## 复现

1. 在一个**已经执行过终端命令**的会话里（持久终端此时已存在），打开权限选择器。
2. 选择「完全权限」（`danger-full-access`）。
3. 确认风险对话框。
4. 选择器回退到「工作区内修改」，不显示任何错误。

> 注意前提：新建的会话**可以**正常切换，因为持久终端是懒加载的（`tool-bash-persistent/src/index.ts:258` 在第一次执行命令时才 `ctx.terminals.spawn`）。所以这个 bug 表现为“有时能切、有时不能”，进一步增加了困惑。

## 证据：拒绝是真的，而且能定位到信息在哪里丢失

解码一个会话日志（由多帧串联的 zstd 组成，`session.v4.jsonl.zstd`）可以看到两半分道扬镳：

```
permission/preset  {"preset":"danger-full-access"}   ×5   （已记录）
sandbox/mode       {"mode":"workspace-write"}         ×1   （从未改变）
```

这与 `PermissionPresetService.apply()` 的顺序完全对应——它先追加 `permission/preset`，再调用 `setSandboxMode()`，而后者被守卫拒绝：

```ts
if (current !== name) session.append('permission/preset', { preset: name })  // ① 落地
updateKnobs()   // ② setSandboxMode → 守卫抛错
```

于是预设被记录、旋钮没变、客户端丢弃异常。投影重新折叠回 `workspace-write`，界面显示旧值。

守卫本身是正确的，且有测试（`packages/terminal/terminal-bash/src/index.ts:56`，断言在 `packages/terminal/terminal-bash/tests/index.spec.ts:702`）：

```ts
if (event.data.mode === currentMode || !state.pty.hasOwnerActivity(owner)) return
throw new Error(
  `cannot change sandbox mode from "${currentMode}" to "${event.data.mode}" while persistent
   terminal sessions are open or being created; wait for creation to settle and close them first`,
)
```

## 影响不止于这一种拒绝

`.catch(() => false)` 在这里是一个通用模式，不是针对守卫的临时处理：**任何**来自命令写入方的拒绝都会被吞掉。将来的任何新拒绝原因同样不可见。

有一个需要保留的既有行为，本报告不要求破坏它：现有测试 `falls back to an unknown current value and clears a rejected optimistic choice`（`permission-select.client.spec.tsx:227`）明确断言被拒绝的选择要回退乐观标签。那是正确的。缺的是**原因**。

## 建议的修法

保留乐观值清除，把拒绝原因显示在选择器旁。

```tsx
const [failure, setFailure] = useState<string | null>(null)

const submit = (id: string): void => {
  setPick(id)
  setFailure(null)
  void select(id)
    .catch((error: unknown) => {
      setFailure(describeFailure(error))
      return false
    })
    .then(() => { setPick(null) })
}
```

```tsx
{failure !== null && <p className={css.failure} role="alert">{failure}</p>}
```

`describeFailure` 把已知拒绝翻译成一句可执行的话，其余原样透传，确保再也不会有信息被静默丢失：

```ts
function describeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/persistent terminal sessions are open/.test(text)) {
    return 'Close this session\'s terminal, then set the permission again.'
  }
  return text
}
```

`role="alert"` 很重要：它让拒绝同时到达屏幕阅读器和视觉用户。

配套的服务端小改动（可选但便宜）：让守卫的文案落在**动作**而不是停在**条件**上——`... close them first — then switch again`。现有的宽松匹配（`toThrow('open or being created')`）仍然会通过。

## 影响面

任何在终端活动期间尝试放宽权限的用户都会得到一个“看起来什么都没做”的控件。这是最难产出可操作报告的一类故障：没有错误、没有文字，只有一个自己变回去的菜单。
