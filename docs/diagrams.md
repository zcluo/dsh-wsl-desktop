# 架构与流程图

本目录下的五份交互图由 [Archify](https://github.com/tt-a1i/archify) 生成（showcase 品质，9/9 构件检查）。**当前五份全部通过真实自动化浏览器评审**：`archify browser-check` 在每张图上报 `ok: true`、**0 项 error**（Archify **3.0.1** 产出）。此前它们不是全绿——2.14.0 产出的页面上，architecture 有 7 项、其余四张各有 6 项导航坞与受保护 SVG 舞台的越界；换成 3.0.1 后全部清零，来龙去脉见下文「图的视觉状态」。每份 HTML 自包含，双击即开，内置主题切换、缩放、搜索、路径追踪与 PNG/SVG 导出。

| 文件 | 类型 | 内容 |
|---|---|---|
| [architecture.html](architecture.html) | architecture | 双半边架构总览：浏览器半边 / 宿主进程 / isolate realm / wsl.exe / 受约束发行版；fs 走 9P UNC（过围栏），命令执行统一经 wsl.exe |
| [sequence-session-create.html](sequence-session-create.html) | sequence | WSL 会话创建链：`wslPresetFor` → 创建请求携带 `agentPreset` → `presets.mount` 组合发布；`api-session/added` 兜底与 `agent-preset/locked` 语义 |
| [dataflow-terminal-pty.html](dataflow-terminal-pty.html) | dataflow | 终端双通道：字节流（数据进程 → pty.fork）与控制协议（带 id 的 JSON 行经 FIFO，应答回显、超时摘除） |
| [lifecycle-pty.html](lifecycle-pty.html) | lifecycle | PTY 分配生命周期：spawn → started 应答 → 控制进程 → 就绪；清理契约与 SIGKILL 残留 |
| [workflow-update-discipline.html](workflow-update-discipline.html) | workflow | 桌面更新纪律（强制）：更新 → `verify-post-restart.mjs` 全绿门 → 继续使用；任何一红先修再干 |

## 源与再生成

- 源 spec：[`diagrams-src/*.json`](diagrams-src)——图与文案的唯一事实来源。
- **`sources` 是证据行，钉在 `meta.repository.revision` 这个提交上**：被引用文件一改（**只改注释也算**），就要重钉到包含该改动的提交并重新交付，否则页面上的链接指向旧代码。`scripts/verify-diagrams.mjs` 按这条逐条校验；它只保证"变了会被看见"，图仍然成不成立要人重新读一遍。
- 修改 spec 后用 Archify 重新校验与交付：

  ```bash
  # 四张没有仓库证据的图（sequence / dataflow / lifecycle / workflow）：
  archify validate <type> docs/diagrams-src/<spec>.json --quality showcase --json
  archify deliver  <type> docs/diagrams-src/<spec>.json docs/<output>.html --quality showcase --json

  # architecture 声明了仓库证据（component `sources`），必须追加 `--repo-root <仓库根>`：
  archify validate architecture docs/diagrams-src/architecture.json --quality showcase --repo-root . --json
  archify deliver  architecture docs/diagrams-src/architecture.json docs/architecture.html --quality showcase --repo-root . --json
  ```

  **两条分支是硬性的，不是风格差异（逐条实测 exit code）**：architecture 不带 `--repo-root` 时 validate
  以 exit 1 失败（`repository-evidence/root-required`："This diagram declares source evidence. Pass
  --repo-root <repository> so Archify can verify it before rendering."）；反过来，把 `--repo-root` 用在另外四张图上
  则以 exit 2 失败（"--repo-root is currently supported for architecture diagrams only."）。validate 与 deliver
  的分支规则相同，两条路径都实测过，所以不要"统一加一个参数"——上面四条命令是按图分别给出的。

- workflow 图在源里显式写了 `meta.viewBox`（844×480）。本机 Archify 的 workflow 默认画布是 720×528，宽高比 1.364 低于查看器的 `WIDE_RATIO = 1.55`：低于它就没有 data-reader-layout，自适应阅读宽度整套不生效，1440×900 起页面纵向滚动。改回默认值即可复现该溢出，所以这一行不是可选装饰。

## 浏览器证据

`*.visual-check.json` 是**打包记录（packaging record），不是浏览器视觉评审**：它的字段只有
`schemaVersion / ok / command / status / visualReview / artifact / state / chrome / containment /
captures / sidecars`——**没有 `diagnostics`**，`visualReview` 是 `"pending"`，`status` 是 `"pass"`。
那个 `pass` 说的是"页面被交付了、截图被写了"，**不是**"有人在浏览器里看过并且没有遮挡"。
`*.visual-check.<viewport>.<theme>.png` 为对应截图，`*.visual-check.html` 为证据聚合页。

要拿到真正的视觉结论，必须跑自动化浏览器评审（`archify visual-check`，回执里才有
`evidenceKind: "automated-browser"` 和 `diagnostics` 数组）。感知层人工复核仍建议在常用浏览器里过一遍。

本机没有 Google Chrome/Chromium，而 Archify 的 `findChrome` 只认这两个（win32 下没有 Edge 候选），所以重新收集这些回执时必须显式指向本机的 Edge：`$env:ARCHIFY_CHROME = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`。不设置时命令以 exit 2 退出、回执为 skipped，并会删掉已有截图。

## architecture 图的视觉状态

**当前状态：`ok: true`，0 项 error**（真机自动化浏览器评审，`archify browser-check`，四个视口 × 明暗共六个状态，Edge 作为 Chromium）。这是本仓库第一次让这张图的视觉结论落绿，下面是它的来龙去脉。

**它之前是红的，红了 6 项。** 同一张图在先前的评审里得到 **`ok: false` / 6 项 error**，全部是同一类：`viewer/chrome-stage-clearance`，报文逐字为

```
Navigation Dock enters the protected SVG stage at 1440x900 (light).
```

按视口各一条：1440×900、1600×1000、1920×1080、2048×1320（light）以及 1440×900、2048×1320（dark）。前四个视口的 `dockStageGap` 实测 **-40.78125px**（`dockStageIntersectionArea` 11693.15283203125），2048×1320 的明暗两条为 **-30.78125px**（9034.77783203125）；要求是 `dockStageGap >= 0` 且交集面积为 0。

**更早还有第 7 项，那项是另一个原因。** 同一轮评审在此之前先得到 **7 项**——上面 6 条加上 **1 条 `viewer/projected-text-readability`**：1440×900 下最小的节点文字投影只有 **5.864864864864865px**，低于 6px 下限（该文字是 realm 节点的 `context` 行）。把 realm 标签收敛成五个 isolate key 的写法、并把字号从 **7px 提到 7.4px** 之后，四个视口的投影变成 1440×900 **6.2px**、1600×1000 **7.2266666666666675px**、1920×1080 **7.4px**、2048×1320 **7.4px**，那一条消失。**这一项早已修掉。**

**剩下 6 项怎么修的：换生成器，不是加 CSS。** 它们不是文案问题，是导航坞与舞台的几何预留，只能由 Archify 重新渲染。当前页面现在由 **archify 3.0.1** 产出（`@tt-a1i/archify-dsh@1.0.0` 里的 `skills/archify`，入口 `bin/archify.mjs`，不在 PATH 上），实测：

- 同一份 spec 在 **3.0.1** 下 `finalize --quality showcase --repo-root .` **exit 0**；
- 随后的 `archify browser-check` 是 **`ok: true` / `status: "pass"` / 0 diagnostics**，六个状态的 `dockStageGap` 都是 **+10px**、`dockStageIntersectionArea` **0**；
- 代价是**换掉整页渲染**：页面从 **643423 字节（2.14.0 产出）** 变成 **768655 字节（3.0.1 产出）**，`docs/architecture.visual-check.json` 的 `artifact.bytes`/`artifact.sha256` 跟着换。`<meta name="generator">` 现在是 `archify 3.0.1`。
- **2.14.0 装不回来**：npm 上叫 `archify` 的包是 0.0.4、与本项目无关（仓库 `justin-calleja/archify`）；`@tt-a1i/archify` 在 npm 上不存在（404）。所以这不是"要不要升级"的选择题，是"新版本能修、旧版本拿不到"。

**3.0.1 不渲染 `meta.views`，所以那些旁注被挪进了 `cards`。** `guidedViews.note` 在 3.0.1 的 schema 里仍然合法（`maxLength: 140`），但 3.0.1 **不把它渲染进页面**——实测三个视图标签在新页面里出现 0 次。为了不丢语义，「会话创建请求命名 WSL 预设，是唯一无竞态的绑定缝」与「fs 走 9P UNC 且过围栏；命令执行走 wsl.exe」两句被写进新的 `cards` 条目（「两条接缝」），isolate 五键与宿主 ACL 那句本来就在「执行世界」卡里。`views[]` 本身保留在 spec 中，将来渲染器恢复该功能时可直接再用。

**这次换代有一个必须说清的代价：查看器少了三个功能。** 逐段对比 2.14.0 与 3.0.1 的页面可见文本，2.14.0 有而 3.0.1 没有的是 **`Share Card` / `Copy Share Card`（分享卡）**、**`Guided views` / `Beat` / `Next` / `Play story`（引导视图，即 `meta.views` 的界面）** 与 **深链 / `Copy moment`**；3.0.1 新增的是 **`SVG · Auto / Light / Dark`** 主题化导出（`Matches host theme` / `Always light`）。**图的语义没有损失**——节点、连线、标签与 `cards` 都在，少的是查看器的三个交互入口。这是用「6 项越界清零」换「三个查看器功能」，不是免费升级；如果哪天需要这三个功能，得回到 2.14.0，而那意味着同时接受 6 项越界。

**所有五张图都经历同一次换代。** architecture 之外的四张（sequence / dataflow / lifecycle / workflow）用的是同一个判断：换代前各有 6 项 `viewer/chrome-stage-clearance`，换代后为 0。它们的 spec 没有 `repository.revision`（没有 `sources` 证据块），所以换代不涉及重钉，只换了页面与回执的 `artifact.bytes`/`artifact.sha256`。


**五张图现在都有真实评审记录，且都是 `ok: true` / 0 项 error。** 它们的 `*.visual-check.json` 仍然是打包记录（见上一节），真机结论要跑 `archify browser-check` 才拿得到——每张图都跑过，逐张见下文。另外四张（sequence / dataflow / lifecycle / workflow）在与 architecture 相同的 3.0.1 换代里一并清零：换代前它们各有 6 项 `viewer/chrome-stage-clearance`，换代后为 0。



**上面那 7→6 的两次读数量的都是 2.14.0 那版页面（逐字节核定，属历史记录）。** 它们不在 `docs/` 里，而在本机的
`.superpowers/sdd/WSL-PERSIST/artifacts/t7-visual-before.json` / `t7-visual-after.json`（该目录被
`.superpowers/sdd/.gitignore` 的 `*` 整体排除，**不随仓库发布**；它们是观察记录，不是交付
产物）。两份都是 `evidenceKind: "automated-browser"`、`provenance: "unknown"`，截图在各自 `--out-dir`。
`before` 量的是 **643433 字节**、`sha256 5a8c14db…` 的页面（提交 `5565e49`）；`after` 量的是
**643423 字节**、`sha256 8484f482…` 的页面（提交 `6a56dba`）。当时提交的 `docs/architecture.html` 也是
**643423 字节**、`sha256 ce55fe8b…`；把 `after` 量的那一版里的 revision 串等长替换（**11 处 40 位
`bb3aa4f…` 加 1 处 `shortRevision`**，换成 `6a56dba…`）后，**逐字节等于**当时提交的那一份。即两者
只差证据 blob 里指向哪个提交，几何、字号、DOM 完全相同。

**这些数字描述的已经不是现在的 `docs/architecture.html`。** 那版页面（643423 字节、2.14.0 产出）在换成 3.0.1 渲染时被整体替换，现在是 **768655 字节**。上面这些读数在本节里作为「修复前」的对照保留，不是当前状态；当前状态是本节开头那句：**`ok: true`，0 项 error**。



