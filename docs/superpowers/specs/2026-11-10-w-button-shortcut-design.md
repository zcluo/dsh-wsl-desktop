# W 按钮快捷键说明与 Ctrl+Alt+W — 设计

- 状态：按用户直接指令进入实现（2026-11-10；用户已指定 TDD + open-code-review-delegate 复盘循环）
- 范围：浏览器半边 `lib/client.js`、两个客户端校验套件、README / DIAGNOSTICS / VERIFICATION 文档对
- 版本：0.7.6 之上的功能改动；不改变宿主路由、围栏、预设或对话框流程

## 1. 背景

侧栏工作区标题栏里，自带的「+」（添加工作区）右边是本插件的 **W** 按钮。自带「+」的
tooltip 由 `ui-workspace` 用 `<Tooltip label={…} shortcutKeys={addShortcut?.keys}>` 渲染，
键帽来自 `workspace.add` 在 `ctx.shortcuts` 里的**有效绑定**（默认 Desktop `Ctrl+O`）。
W 按钮目前只有原生 `title`，既没有键帽，也没有键盘入口。

## 2. 目标

- **G1** W 按钮的悬停/聚焦提示与「+」一致：动作名 + 平台格式的键帽，底部弹出，500ms 悬停延迟。
- **G2** 注册 `Ctrl+Alt+W`（Windows **桌面**配置）打开同一个 WSL 工作区选择器；Web 不声明默认，
  因为 `page.close` 的 Web 组合同样是 `Ctrl+Alt+W`，而注册会校验所有 profile 的默认值。
- **G3** 键帽与 `aria-keyshortcuts` 读快捷键目录的**有效绑定**，用户在「快捷键」设置里改绑后提示随动。
- **G4** 快捷键命令出现在「快捷键」速查/设置里，可改绑、可清除，卸载插件时随命令一起撤回。
- **G5** 注册被拒（与其它插件默认键冲突）时，W 按钮与对话框完全照旧，只是没有键帽；宿主必须提供
  `shortcuts` 服务（0.1.7 起的桌面自带），服务缺失时插件按注入声明等待，这是宿主版本边界。

## 3. 非目标

- 不改宿主 API、路由、围栏、预设生成、W 对话框的阶段与焦点陷阱。
- 不为 W 按钮引入 React / `ui-primitives`：本半边是手写 `window.__ModuleLoader__` factory，
  DSH 客户端规则禁止功能插件运行时引用别的功能插件值；复刻提示视觉用本文件自己的 DOM。
- 不加过渡/动画：`verify-client-ui.mjs` 的既有钢印禁止 `transition:` / `animation:`。
- 不新增依赖、不改 Node 下限。

## 4. 方案与取舍

1. **原生 `title` 拼上按键文字**：最省事，但只有一段纯文本，无法复刻「+」的键帽块，也不能随改绑更新。
2. **复用 React `Tooltip`**：视觉最一致，但本插件是手写 bundle、无模块图，且跨插件值引用被客户端规则禁止。
3. **自建 DOM tooltip + 快捷键服务（选定）**：快捷键服务提供有效键位、可改绑、可出现在速查里；
   提示用本文件既有的主题 token 复刻 `Tooltip`/键帽的布局与配色。代价是要自己管定位、隐藏与清理。

## 5. 已定决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 命令 id | `wsl.workspace.open` | 通过 `ShortcutCommandId` 的 `commandPattern`；域前缀与插件一致 |
| 默认键位 | 仅 `desktop:windows`：`{ code: 'KeyW', modifiers: ['primary','alt'] }` | Windows 桌面即 Ctrl+Alt+W。Web 不声明：`page.close` 的 Web 组合也是 Ctrl+Alt+W，而 `ShortcutRegistry.register()` 校验所有 profile，声明它会令命令在桌面端也注册失败（实测 2026-11-10）。其它平台不声明，避免给不存在的 WSL 主权键位 |
| 输入范围 | `regions: ['page','editable']`，`modals: ['sidebar']` | 与 `workspace.add` 一致：终端里让给本地输入；窄窗/Web 的侧栏本身是模态抽屉时仍能触发 |
| resolve | 恒 `{status:'handled', run: () => openPicker(ctx)}` | `openPicker` 自带幂等（已开则 return）；创建中/降级都由对话框自己表达 |
| 标签 | 复用 `BUTTON_LABEL` | tooltip、aria-label、速查三处同一个动作名，也沿用既有双语 COPY |
| 提示视觉 | 底部、8px 间距、500ms 悬停/0ms 聚焦、portal 到 body、fixed 定位、视口内夹取，空间不足翻到上方 | 复刻 `ui-primitives` Tooltip 的 bottom/portal/延迟语义 |
| 无障碍 | 按钮 `aria-keyshortcuts` 用目录的 `aria`；提示气泡 `role="tooltip"` + `aria-hidden` | 读屏靠 aria-keyshortcuts；视觉气泡不重复朗读 |
| 输入模态 | 焦点由指针取得（`data-input-modality="pointer"`）时不弹提示 | 关闭对话框把焦点还给按钮时，不因点击路径闪出提示 |
| 注册被拒 | 按钮照旧，仅无键帽；记一条 console.warn | W 按钮是主功能，提示是增益，不能反过来拖垮它 |
| 降级入口 | 浮动「WSL」入口只加 `aria-keyshortcuts`，不加视觉气泡 | 失败路径保持最小；快捷键此时仍然可用 |
| 注入 | 在模块 `inject` 里加 `'shortcuts'` | 依赖的桌面最低版本 0.1.7 已带该服务；保证 apply 时目录已就绪 |

## 6. 测试计划（TDD）

先写会红的测试，再实现：

- `scripts/verify-client-ui.mjs`（静态）：`shortcuts` 在 inject 且被读取；命令 id 稳定；默认键位为
  `KeyW` + `primary`/`alt`；键帽来自目录而非硬编码；`aria-keyshortcuts` 由有效绑定写入；
  dispose 撤命令、退订阅、移气泡；不出现 `transition:`/`animation:`。
- `scripts/verify-client-dom.mjs`（jsdom 行为）：注册一条命令且默认 Ctrl+Alt+W；resolve 的 run 打开同一个
  `[role="dialog"]`；悬停 500ms 后出现带 `kbd` 键帽的 tooltip；aria-keyshortcuts 正确；目录改绑后提示与
  aria 随动；dispose 后命令、订阅、气泡都不在；注册抛错或缺服务时 W 按钮仍在且不谎报快捷键。
- 复跑既有套件（`verify-client-ui`、`verify-client-dom`、`verify-docs` 与离线总套件），不允许回归。

## 7. 风险与边界

- **AltGr 布局**：快捷键服务把 `AltGraph` 输入原样放行，Ctrl+Alt 在把 AltGr 映射为 `AltGraph` 的布局上
  不会触发。这是服务己方文档化行为，本插件不绕过。
- **Web 默认冲突（已实测并修复）**：`ui-sidebar-right` 的 `page.close` 在 `web:windows` / `web:macos` 上
  占用 `KeyW + primary + alt`；`ShortcutRegistry.register()` 会校验**所有** profile 的默认值，最初同时声明
  `web:windows` 让本命令在桌面端注册时抛 `Conflicting shortcut defaults`，表现为“有动作名、无键帽、按键无反应”。
  修复：只声明 `desktop:windows`。回归测试用 seed 的 `page.close` 复现该冲突。
- **用户改绑冲突**：改绑到被占用组合时目录行保留请求键位但 `aria` 为 undefined、命令不可执行；
  提示仍显示请求键帽（与「+」一致），不会假装可用。
- **卸载时序**：先退目录订阅，再撤命令，最后移气泡，避免 teardown 期间的回调重建提示。
