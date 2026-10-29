# 目录地图

按目录说明职责定位。原则:目录以具体业务域命名(如 `tab-group-state`、
`terminal-orphan-cleanup`),而不是 `helpers`/`utils` 一类泛化名称;找文件时
先按域定位。

## 顶层

| 目录                                     | 用途                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`                               | Electron 主进程(见下文"src/main 业务域")                                                                                                        |
| `src/preload`                            | contextBridge 层:`index.ts` 组装 `window.api`,`api/*-bridge.ts` 实现通道,`api/*-api.ts` 复导出类型                                              |
| `src/renderer`                           | 渲染进程:桌面 UI(`src/`)、配对 Web 客户端(`src/renderer/src/web/`)、仪表盘弹出窗口(`popout.tsx`)                                                |
| `src/shared`                             | main/renderer/CLI 共享的类型与 zod schema(会话 schema、tab 类型、pty id 命名、契约文件)                                                         |
| `src/cli`                                | `orca` CLI(orchestration、worktree、automation、skill 等子命令)                                                                                 |
| `src/packages/process-host`              | 内部 workspace 包:进程宿主                                                                                                                      |
| `src/wsl-guest`                          | WSL 发行版 guest 侧执行的钩子/脚本                                                                                                              |
| `src/types`                              | 环境与模块声明类型                                                                                                                              |
| `mobile/`                                | Expo/React Native 移动 App(经 Orca 中继连桌面)                                                                                                  |
| `native/`                                | 各 OS 原生 addon:computer-use(macos/linux/windows)、macOS 通知/键盘布局/shipit 调度、windows-registry、windows-agent-hook、wayland-clipboard 等 |
| `cloud/`                                 | Orca 中继(独立 pnpm workspace):手机与桌面间的帧拼接、director、cell                                                                             |
| `config/`                                | 构建/CI/lint/docker 配置、`config/scripts/*` 开发脚本、agent 插件                                                                               |
| `resources/`                             | 应用图标与打包资源                                                                                                                              |
| `skills/` `skill-guides/` `skill-stubs/` | 内置 agent skill 及其说明/占位                                                                                                                  |
| `tests/`                                 | Playwright E2E(`tests/e2e`,配套 `tests/AGENTS.md`)                                                                                              |
| `docs/`                                  | 本文档、`STYLEGUIDE.md`、`reference/`、用户站 `site/`                                                                                           |
| `examples/plugins`                       | 插件示例                                                                                                                                        |
| `Casks/`                                 | Homebrew Cask 定义                                                                                                                              |

## src/main 业务域(按前缀/目录归组)

- **启动与生命周期**:`startup/`(preflight、单实例锁、ready foundation/
  runtime/launch、主窗口控制器、quit 处理器、中继与推送启动)、`window/`
  (创建/加载主窗口、更新接线)、`hang-watchdog/`、`quit-teardown-*.ts`。
- **IPC 与 preload 对应面**:`ipc/**` 按领域分目录(`pty/` 含 spawn/write/
  resize/投递,`ssh/plain-ssh-terminal-handlers.ts`,`mobile.ts`,`ui.ts` 等)。
- **守护进程与 PTY**:`orcad/`(进程外产物)、`daemon/`(PTY 提供方、检查点
  持久化、历史、会话所有权)、`pty/`(PTY 进程管理、后代进程终止、shell
  包装)、`terminal-history*.ts`、`terminal-scrollback-snapshots.ts`。
- **SSH**:`ssh/`(targets、连接、`ssh/direct-ssh/` 直连会话注册表、
  `ssh/plain-ssh-terminal/` 逃生舱、target id 迁移)。
- **Agent 生态**:`agent-launch/`、`agent-hooks/`、`agent-awake-service.ts`、
  `agent-*`(状态文件、信任、CLI 探测),每个 CLI 一个提供方目录
  (`claude/`、`codex/`、`cursor/`、`gemini/`、`copilot/`、`droid/`、
  `opencode/`、`opencode2/`、`kimi/`、`grok/`、`muse/` 等)及
  `*-accounts`、`*-usage`。
- **持久化**:`persistence/`(`orca-data.json` + `profile-state.db`、
  loading-store、迁移、orcad 目录迁移)、`sqlite/`(共享 sqlite 基建)、
  `credentials/`、`protected-secret-persistence.ts`、`macos-keychain/`。
- **代码托管与源控**:`git/`、`source-control/`,以及 `github/`、`gitlab/`、
  `gitea/`、`bitbucket/`、`azure-devops/`、`linear/`、`jira/`。
- **工作区/工作树**:`worktree-create-*`、`worktree-removal-*`、
  `worktree-retirement-*`、`worktree-lineage-*`、`repo-*`(身份/图标/工作树
  扫描)、`workspace-space-*`(空间扫描)、`folder-*`(文件夹工作区)、
  `project-groups/`。
- **运行时与配对**:`runtime/`(OrcaRuntime、RPC 服务、移动会话投影、工作区
  休眠、编排 DB、客户端会话选择)、`remote-layout-snapshot/`。
- **平台适配**:`wsl*.ts`(发行版管理/迁移/UNC)、`win32-*`、`macos-*`、
  `linux-*`、`ghostty/`、`powershell-osc133-bootstrap.ts`、`shell-startup-*`、
  `zsh-*`。
- **横切**:`updater.ts` + `updater/`(electron-updater、mac shipit、Linux 包
  管理)、`telemetry/`、`observability/`、`crash-reporting/`、`diagnostics/`、
  `menu/`、`tray/`、`dock/`、`i18n/`、`automations/`、`plugins/`、`skills/`、
  `browser/`(sidecar)、`emulator/`、`computer/`、`speech/`、`media/`、
  `notebook/`、`memory/`、`ai-vault/`(+`ai-vault-search/`)、`native-chat/`、
  `external-conversations/`、`network/`、`ports/`、`worker-thread-*`、
  `ripgrep/`、`node-runtime/`。

## src/renderer/src 业务域

| 目录                                                                                                                       | 用途                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx` / `App.tsx`                                                                                                     | 入口与根组件:挂载 provider、启动 hook 链、全局对话框、`AppWorkspaceShell`                                                             |
| `app-shell/`                                                                                                               | 应用外壳:布局(`use-app-chrome-layout.ts`)、标题栏、浮动工作区面板、启动注水(`use-app-startup-hydration.ts`)、会话持久化订阅           |
| `store/`                                                                                                                   | 单一 zustand store:`index.ts` 组装约 45 个切片;`slices/` 按域拆分;大跨域选择器在 `selectors.ts`、`active-terminal-chrome-selector.ts` |
| `components/terminal-pane/`                                                                                                | 终端 pane 管线:连接会话(`pty-connection/`)、传输层实现、pane 生命周期、输出调度、隐藏投递门控(DECSET 2031)、agent 恢复                |
| `lib/pane-manager/`                                                                                                        | 命令式 pane 树管理(`PaneManager` 类):DOM 创建、分割、拖拽、fit、WebGL 渲染                                                            |
| `components/tab-group/` `components/tab-bar/`                                                                              | 统一标签模型 UI:拖拽分组、条渲染、`#titlebar-tabs` portal                                                                             |
| `components/browser-pane/`                                                                                                 | 内嵌浏览器:host/guest 消息、提示、profile;guest 侧在启动时安装                                                                        |
| `components/editor/`                                                                                                       | Monaco 编辑器、diff 视图、Markdown/CSV 预览                                                                                           |
| `components/plain-ssh-terminal/`                                                                                           | 直连 SSH 文件浏览器(SFTP)、逃生舱按钮、遗留面板卡片                                                                                   |
| `components/settings/` `components/activity/` `components/automations/` `components/workspace-space/` `components/mobile/` | 各顶级页面                                                                                                                            |
| `components/source-control/` `components/github/` 等                                                                       | 评审/源控 UI                                                                                                                          |
| `runtime/`                                                                                                                 | runtime RPC 客户端、远程终端多路复用、`sync-runtime-graph/`(运行时图与移动端会话同步)                                                 |
| `ssh/`                                                                                                                     | `direct-ssh-terminal-tabs.ts`(直连标签入口)、`plain-ssh-terminal-panels.ts`(遗留外部 store)                                           |
| `startup/`                                                                                                                 | 启动步骤:诊断、SSH 连接恢复、降级恢复、Web 主机不可达分类                                                                             |
| `web/`                                                                                                                     | 配对 Web 客户端运行时(独立入口 `main.tsx`):配对、E2EE、连接帧路由                                                                     |
| `i18n/`                                                                                                                    | I18nProvider 与语言目录;key 形如 `auto.<file>.<hash>`                                                                                 |
| `hooks/` `lib/` `constants/`                                                                                               | 通用 hooks、工具(命名具体)、共享常量                                                                                                  |

## src/shared 关键文件

- `workspace-session-schema.ts` — 会话持久化 zod schema(含 salvage)。
- `terminal-tab-types.ts` — `TerminalTab`、pane 树与 `DirectSshTransport`。
- `workspace-layout/workspace-layout-disk-fields.ts` — 磁盘字段↔内存来源的
  唯一映射表(`'unwritten'` 需编译期证明)。
- `direct-ssh-pty-id.ts`、`remote-runtime-pty-id.ts` — pty id 命名空间。
- `plain-ssh-terminal.ts` — 直连 SSH IPC 契约与事件。
- `runtime-mobile-session-tab-contracts.ts`、`remote-layout-snapshot.ts`、
  `paired-*`、`mobile-e2ee-v2-*` — 配对/移动端契约。
- `persisted-state-types.ts`、`global-settings-types.ts`、
  `persisted-ui-state-types.ts` — 主进程落盘状态与设置/UI 类型。
- `zod-salvage.ts` — 逐字段打捞,坏数据不整体重置。
