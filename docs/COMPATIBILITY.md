# 兼容性与升级 — dsh-wsl-desktop

本文回答两个问题：**这个插件能装在哪个桌面版本上**，以及**桌面或插件升级时按什么顺序做、怎么回退**。它不重复 [发行版支持矩阵](DISTRO-SUPPORT.md)（那是 Linux 发行版一侧）。

## 版本关系

插件通过运行时能力探测判断宿主是否可用，而不是按版本号推断：`bootstrap` 返回 `capabilities`（宿主探测 + 客户端探测的结果），`health` 返回发行版体检，`verify-post-restart` 再把运行中的 manifest 与 checkout 逐字节比对。版本号只是发布标签，不是契约。

| 插件版本 | 桌面版本 | 状态 | 依据 |
|---|---|---|---|
| 0.7.0 | 0.2.1-rc.2 | 已实测 | 本机 live 门（`verify-all --live`）与 `verify-post-restart` 全绿 |
| 0.6.0 | 0.2.1-rc.2 | 已实测 | 0.6.0 发布时的完整 live 门 |
| 0.7.0 / 0.6.0 | >= 0.1.7 | 声明下限，未在本机逐版实测 | 0.1.7 起有 `wsl-*` 预设的运行时注册；更旧的宿主在激活时明确拒绝（代码行为） |
| 0.7.0 / 0.6.0 | < 0.1.7 | 不支持 | 同上：没有运行时注册 |

另外：`engines.node >= 22.19` 是宿主 Node 的下限；`manifestVersion: 1` 是插件元数据版本，不是桌面版本。

## 升级顺序

**桌面先升，插件后升。** 顺序反了会得到一个“插件比宿主新”的中间态：宿主的模块图里可能还没有插件要注入的服务，`bootstrap` 会把缺失的符号列进 `capabilities.missing`，界面进入降级卡。

1. 升级 DSH Desktop，重启。
2. 升级插件（插件市场 / `plugin_manager install_bundle dsh-wsl-desktop@<version>`）。
3. **重启**桌面。宿主半边按 URL 缓存模块，装完不重启仍会服务旧代码；客户端半边刷新页面即可。
4. 跑 `node scripts/verify-post-restart.mjs`（仓库内），或至少打开一次 W 对话框，确认：
   - `bootstrap` 的 `pluginVersion` 等于目标版本；
   - `capabilities.status` 不是 `degraded`；
   - 体检条能渲染，没有 `host-plugin-stale`。
5. 如果是开发代次（`sync.ps1` 的 staged generation），再跑一次 `verify-all --live`。

## 回退

**按相反顺序退：先退插件，再退桌面。**

- 插件回退：`plugin_manager remove_bundle dsh-wsl-desktop` → `install_bundle dsh-wsl-desktop@<旧版本>` → 重启。
- 桌面回退：装回旧桌面 → 重启 → 再把插件降到与它匹配的版本。反过来（旧桌面 + 新插件）通常表现为降级卡或 `host-plugin-stale`，不是可用的中间态。
- 回退后同样跑 `verify-post-restart`：它不信任任何版本声明，只信任运行中的 manifest 与模块图。

## 宿主漂移的历史

0.1.6 → 0.1.7 一次断了四处（预设注册、服务访问、模块导入、客户端注入），这是本插件要求 `>= 0.1.7` 且坚持运行时探测的原因。之后每次桌面大版本适配都升一个 minor：`0.5.1 → 0.6.0`（错误目录/体检/契约）、`0.6.0 → 0.7.0`（完整双语 + 无障碍 + 发布预检）。**桌面大版本变了，先看有没有对应的插件 minor**，不要直接升插件。

## 发布预检

仓库根的 `node scripts/release-check.mjs` 会在发布前检查：npm 登录、registry 最新版、目标版本是否已占用、本地/远端 tag、工作树、pnpm 的 `minimumReleaseAge` 窗口，以及隐私扫描（已跟踪文件里的密钥与本机路径、`npm pack` 清单里的测试产物）。它只读，不改任何东西；输出会直接给出下一步命令。

### 回装顺序（别在窗口外卸载）

发布后把 profile 切回 registry 版本时，**先确认 registry 副本可安装，再卸载已装的插件**：

1. 跑 `node scripts/release-check.mjs --version <目标>`；它会把 `minimumReleaseAge` 的 `readyAt` 算出来。
2. 窗口没开（`ready === false`）就**不要** `remove_bundle`——那样 profile 会在一小时内没有任何插件。
3. 窗口开了再按 `remove_bundle` → `install_bundle <目标>` → 重启 → `verify-post-restart` 的顺序做。

窗口是 pnpm 的供应链策略，不是 bug；绕开它需要显式修改 profile 的 `minimumReleaseAge`，那属于降低供应链保护，要单独决定。
