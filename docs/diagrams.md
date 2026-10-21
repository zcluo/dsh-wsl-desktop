# 架构与流程图

本目录下的五份交互图由 [Archify](https://github.com/tt-a1i/archify) 生成（showcase 品质，9/9 构件检查）。**它们的视觉状态不是全绿**：在唯一做过真实自动化浏览器评审的那张图（architecture）上，容器（containment）与文字可读性（readability）实测通过，但导航坞与受保护的 SVG 舞台之间仍有 **6 项未修**（7 → 6，逐条见下文「architecture 图的视觉状态」）。每份 HTML 自包含，双击即开，内置主题切换、缩放、搜索、路径追踪与 PNG/SVG 导出。

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

最近一次**真实**的自动化浏览器评审（`architecture.html`，四个视口，明暗合计**六个状态**）结论是
**`ok: false`，6 项 error**，全部是同一类：`viewer/chrome-stage-clearance`。报文逐字为

```
Navigation Dock enters the protected SVG stage at 1440x900 (light).
```

按视口各一条：1440×900（light）、1600×1000（light）、1920×1080（light）、2048×1320（light）、
1440×900（dark）、2048×1320（dark）。前四个视口的 `dockStageGap` 实测 **-40.78125px**
（`dockStageIntersectionArea` 11693.15283203125），2048×1320 的明暗两条为 **-30.78125px**
（9034.77783203125）；要求是 `dockStageGap >= 0` 且交集面积为 0。

**7 → 6 的来龙去脉**：同一轮评审在此之前先得到 **7 项 error**——上面 6 条 `chrome-stage-clearance`
加上 **1 条 `viewer/projected-text-readability`**（1440×900 下最小的节点文字投影只有
**5.864864864864865px**，低于 6px 下限；该文字是 realm 节点的 `context` 行
`preset.js · shell/fs/subprocess 隔离`）。把 realm 标签收敛成五个 isolate key 的写法
（`shell/fs/subproc/term/sandbox 隔离`）、并把字号从 **7px 提到 7.4px** 之后，四个视口的投影分别是
1440×900 **6.2px**、1600×1000 **7.2266666666666675px**、1920×1080 **7.4px**、2048×1320 **7.4px**，
**那一条不再出现**，于是 6 项、全部是导航坞与舞台的间距。这一项是**已修**，其余 6 项**未修**。

所以本页的诚实状态是 **"outstanding, tool required"**，不是"passing"。

五张图里只有 architecture 有真实评审记录，另外四张的视觉状态**未评审**——它们的
`*.visual-check.json` 也只是打包记录。别把 architecture 的结论外推到那四张。

**这两份回执量的是哪一版页面（逐字节核定）。** 它们不在 `docs/` 里，而在本机的
`.superpowers/sdd/WSL-PERSIST/artifacts/t7-visual-before.json` / `t7-visual-after.json`（该目录被
`.superpowers/sdd/.gitignore` 的 `*` 整体排除，**不随仓库发布**；它们是本轮引用的观察记录，不是交付
产物）。两份都是 `evidenceKind: "automated-browser"`、`provenance: "unknown"`，截图在各自 `--out-dir`。
`before` 量的是 **643433 字节**、`sha256 5a8c14db…` 的页面（提交 `5565e49`）；`after` 量的是
**643423 字节**、`sha256 8484f482…` 的页面（提交 `6a56dba`）。当前提交的 `docs/architecture.html` 是
**643423 字节**、`sha256 ce55fe8b…`；把 `after` 量的那一版里的 revision 串等长替换（**11 处 40 位
`bb3aa4f…` 加 1 处 `shortRevision`**，换成 `6a56dba…`）后，**逐字节等于**当前提交的这一份。即两者
只差证据 blob 里指向哪个提交，几何、字号、DOM 完全相同。所以这 6 项结论对**现在这一版页面**成立，
不是对某一版旧页面成立。

**为什么这 6 项没顺手修掉。** 它们不是文案问题，是导航坞与舞台的几何预留，只能由 Archify 重新
渲染解决——而**生成当前这份页面的那个版本本机没有、也拿不到**。实测（不是推断）：

- 当前提交的 `docs/architecture.html` 里 `<meta name="generator">` 写的是 **archify 2.14.0**。
- npm 上叫 `archify` 的包是 **0.0.4**，是与本项目无关的另一个包（仓库 `justin-calleja/archify`）；
  按本项目名字发布的 `@tt-a1i/archify` 在 npm 上**不存在**（404）。所以 2.14.0 **装不回来**。
- 本机确实装着 Archify，但装在 DSH 的 skill 形态里：`@tt-a1i/archify-dsh@1.0.0` 里的
  **3.0.1**，入口 `bin/archify.mjs`，**不在 PATH 上**（`archify` 命令本身找不到）。用它对当前 spec 跑
  `archify validate architecture docs/diagrams-src/architecture.json --quality showcase --repo-root . --json`
  是 **ok（9/9 检查，0 error）**。
- **3.0.1 交付出来的是另一个页面，而且那个页面是干净的**：同一份 spec 在 3.0.1 下是 **768304 字节**，
  对它再跑 `archify visual-check` 是 **`ok: true` / `status: "pass"` / 0 diagnostics**，四个视口连同
  两张暗色截图共六处 `dockStageGap` 都是 **+10px**、`dockStageIntersectionArea` **0**（当前这版是
  -40.78125 / -30.78125）。而当前提交的是 **643423 字节**。

所以结论不是"多加一行 CSS"，也不是"没有工具"：**要修这 6 项，得先决定这个仓库的图由哪个 Archify
版本产出**——2.14.0 已不可得，3.0.1 会换掉整页（643423 → 768304 字节）、并让 `docs/` 下的四张截图、
回执的 `artifact.sha256`/`bytes`、以及 `verify-diagrams.mjs` 的逐字节校验一起改口径。那是产品决定。
本页因此只**记录**这 6 项，不假装已修。

