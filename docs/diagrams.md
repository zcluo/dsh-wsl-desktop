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
- 修改 spec 后用 Archify 重新校验与交付：

  ```bash
  archify validate <type> docs/diagrams-src/<spec>.json --quality showcase --json
  archify deliver  <type> docs/diagrams-src/<spec>.json docs/<output>.html --quality showcase --json
  ```

  architecture 声明了仓库证据（component `sources`），validate/deliver 需追加 `--repo-root <仓库根>`。

## 浏览器证据

`*.visual-check.json` 为逐图的自动化浏览器回执（containment / readability / viewerChrome 三项），`*.visual-check.<viewport>.<theme>.png` 为对应截图，`*.visual-check.html` 为证据聚合页。感知层人工复核仍建议在常用浏览器里过一遍。
