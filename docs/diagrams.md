# 架构与流程图

本目录下的五份交互图由 [Archify](https://github.com/tt-a1i/archify) 生成（showcase 品质，9/9 构件检查），并经真实浏览器（Chromium）在 1440×900 / 1600×1000 / 1920×1080 / 2048×1320 明暗双主题下验证：无溢出、文字可读、图例与导航坞无遮挡。每份 HTML 自包含，双击即开，内置主题切换、缩放、搜索、路径追踪与 PNG/SVG 导出。

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

`*.visual-check.json` 为逐图的自动化浏览器回执（containment / readability / viewerChrome 三项），`*.visual-check.<viewport>.<theme>.png` 为对应截图，`*.visual-check.html` 为证据聚合页。感知层人工复核仍建议在常用浏览器里过一遍。

本机没有 Google Chrome/Chromium，而 Archify 的 `findChrome` 只认这两个（win32 下没有 Edge 候选），所以重新收集这些回执时必须显式指向本机的 Edge：`$env:ARCHIFY_CHROME = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'`。不设置时命令以 exit 2 退出、回执为 skipped，并会删掉已有截图。
