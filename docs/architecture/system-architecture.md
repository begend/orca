# 系统架构

Orca 是一个 Electron 桌面应用(macOS / Linux / Windows),带一个进程外的终端
守护进程、面向手机/Web 的配对客户端运行时,以及各操作系统专属的原生辅助模块。
路径均相对仓库根目录。

## 进程拓扑

```
┌──────────────────────────── Electron 应用 ───────────────────────────┐
│  渲染进程 (src/renderer/src)           主进程 (src/main)             │
│  - React UI、zustand store             - 窗口/IPC/持久化              │
│  - pane 管线 + PTY 传输层  ◄──────────► - DirectSshTerminalSessions   │
│    (经 window.api preload 桥)          - runtime RPC 服务(配对)      │
│                                        - 各 agent CLI、git、ssh       │
│  Preload (src/preload):contextBridge 暴露约 140 个领域桥              │
└──────────────┬───────────────────────────────────┬───────────────────┘
               │ NDJSON 帧协议 RPC                  │ WebSocket(配对)
┌──────────────▼───────────────┐   ┌───────────────▼───────────────────┐
│ orcad 守护进程 (src/main/orcad,│   │ 配对客户端:移动端 (mobile/,       │
│ 运行时 src/main/daemon)       │   │ Expo) 与 Web 客户端               │
│ 进程外 PTY 提供方、持久化      │   │ (src/renderer/src/web),经        │
│ 历史与检查点、会话所有权       │   │ Orca 中继 (cloud/) + 推送         │
└──────────────────────────────┘   └───────────────────────────────────┘
```

- **渲染进程**持有全部 UI 状态(单一 zustand store)和终端 pane 管线,按 pane
  选择 `PtyTransport`——它从不直接拥有进程。
- **主进程**负责操作系统集成:窗口、IPC 处理器、持久化、SSH 连接、agent CLI
  提供方、凭据、runtime RPC 服务。
- **orcad 守护进程**(`src/main/daemon/daemon-spawner.ts` 负责拉起,在
  `src/main/startup/main-process-pty-startup.ts` 安装为 PTY 提供方)让终端
  在渲染进程刷新、应用更新期间保持存活,并落盘持久历史
  (`daemon-pty-checkpoint-persistence.ts`、`history-manager.ts`)。启动失败时
  由 `DegradedDaemonPtyProvider` 降级为无持久化的本地 PTY。守护进程客户端使用
  NDJSON 帧协议 RPC(`daemon-client-*`)。

## 渲染进程 ⇄ 主进程边界

`src/preload/index.ts` 组装 `window.api`,各桥实现位于 `src/preload/api/`
(`*-bridge.ts` 实现通道,`*-api.ts` 复导出类型)。领域包括:`pty`(spawn/
attach/write/resize/snapshot)、`session`(工作区会话持久化)、`ui`、
`settings`、`worktrees`、`repos`、`ssh`、`plainSsh` + `directSshFiles`
(直连主机终端与 SFTP)、`runtime`/`runtimeEnvironments`、`git`/`gh`/各代码
托管平台、`mobile`、agent-status/awake/hooks/usage、browser、emulator、
updater、wsl、telemetry。通道处理器在 `src/main/ipc/**`,按相同领域分组。

## PTY 传输层(渲染进程侧)

选择顺序见
`src/renderer/src/components/terminal-pane/pty-connection/pty-input-recovery.ts`;
接口定义在 `pty-transport-types.ts`。

| 传输层        | 文件                                | 适用场景                                                                                                                     |
| ------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| IPC           | `pty-transport.ts`                  | 默认:本地或 SSH 拨入的守护进程 PTY,走 `window.api.pty`                                                                       |
| 远程运行时    | `remote-runtime-pty-transport.ts`   | pane 位于配对的运行时主机(有 `runtimeEnvironmentId`);id 形如 `remote:<env>@@<handle>`(`src/shared/remote-runtime-pty-id.ts`) |
| 直连 SSH      | `direct-ssh-pty-transport.ts`       | 标签带 `TerminalTab.directSsh`;与主进程 `DirectSshTerminalSessions` 通信,走 `window.api.plainSsh`                            |
| 旧版中继桥    | `legacy-relay-bridge-transport.ts`  | 兼容:接管仍由旧版 Orca 中继持有的终端                                                                                        |
| 未服务 SSH 行 | `unserved-ssh-pane-connect.ts`      | 目标主机尚未由本桌面接管服务                                                                                                 |
| 未解析属主    | `unresolved-owner-pty-transport.ts` | 惰性桩,仅展示"属主未解析"错误                                                                                                |

## 直连 SSH 主机终端

- 主进程注册表:`src/main/ssh/direct-ssh/direct-ssh-terminal-sessions.ts`
  (IPC 在 `src/main/ipc/ssh/plain-ssh-terminal-handlers.ts`)。语义:`open`
  (新建 / 按 id 附着 / 收养无属主会话)、`write`、`ack`(512 KiB 背压)、
  `resize`、`close`;每个主机同时只允许一个存活属主窗口(否则报
  `already-open`);渲染进程刷新或崩溃会**解除附着**(会话在主进程存活),
  显式 close 才结束;SSH 重连时轮换 ssh2 通道但会话 id 不变。
- 渲染进程:`src/renderer/src/ssh/direct-ssh-terminal-tabs.ts` 创建规范标签;
  `src/shared/direct-ssh-pty-id.ts` 对 pty id 加命名空间前缀,让标准 pane
  管线无需改动即可工作。
- 另有"普通 SSH"逃生舱(`src/main/ssh/plain-ssh-terminal/`),其会话与属主
  窗口绑定:刷新或崩溃即结束。

## 配对客户端、移动端与中继

- `OrcaRuntimeRpcServer`(`src/main/runtime/runtime-rpc.ts`)提供 WebSocket
  RPC;配对前仅监听回环地址(`runtime-rpc-network-exposure.ts`)。
- 配对与端到端加密:`runtime-rpc-mobile-pairing.ts`,以及 `src/shared/` 的
  `mobile-e2ee-v2-*` / `paired-e2ee-*` 契约。
- 手机经 **Orca 中继**(`cloud/`,独立 pnpm workspace)连接:两端各自向中继
  cell 发起出站 WebSocket,由 cell 拼接帧;director 负责把主机分配到 cell。
  推送通知走推送服务(`src/main/startup/main-process-push-startup.ts`)。
- 客户端看到的是投影:`RuntimeMobileSession*Tab` 契约
  (`src/shared/runtime-mobile-session-tab-contracts.ts`);主机为每个环境保存
  仅用于展示的 `RemoteLayoutSnapshot`。详见 [data-model.md](./data-model.md)
  与 [core-flows.md](./core-flows.md)。

## Agent 生态

每个 agent CLI 一个提供方目录(claude、codex、cursor、gemini、copilot、droid、
amp、opencode、kimi、grok 等),位于 `src/main/<provider>/`,并有 `*-accounts`
(认证)、`*-usage`(用量)同级目录。共享机制:`src/main/agent-launch/`、
`src/main/agent-hooks/`(回环 hook 服务)、`src/main/agent-awake-service.ts`
(操作系统唤醒锁)、agent 信任与状态文件读取。休眠与冷恢复唤醒见
[core-flows.md](./core-flows.md)。

## 平台层

跨平台规则见
[`../reference/cross-platform-support.md`](../reference/cross-platform-support.md)。

- **Windows**:`src/main/win32-utils.ts`、`windows-*`(进程树终止、注册表
  addon、PTY 根身份、安全)、WSL 管理(`wsl*.ts`,guest 侧钩子在
  `src/wsl-guest/`)。
- **macOS**:TCC 提权提示/监听、钥匙串(`macos-keychain/`)、shipit 更新暂存
  (`src/main/updater/`),原生 addon 在 `native/`(`computer-use-macos`、
  `notification-status-macos`、`keyboard-layout-macos`)。
- **Linux**:AppImage 运行时身份、包管理器更新(`linux-package-*`)、Wayland
  剪贴板(`native/wayland-clipboard`)。
- Shell 集成:zsh/fish/powershell 包装与启动扫描(`zsh-*`、`shell-startup-*`、
  `powershell-osc133-bootstrap.ts`),Ghostty 主题(`ghostty/`、
  `warp-themes/`)。

## 横切服务

持久化(`src/main/persistence/`,见 [data-model.md](./data-model.md))、更新
(`src/main/updater.ts` + `updater/`)、遥测/诊断/崩溃上报(`telemetry/`、
`observability/`、`crash-reporting/`)、菜单/托盘/Dock、i18n(`src/main/i18n`
与 `src/renderer/src/i18n` 对应)、自动化(`automations/` + 渲染层
`components/automations/`)、插件(`plugins/`,宿主 API 在 preload 的
`plugin-host-api.ts`)、浏览器 sidecar(`browser/`)、AI vault(`ai-vault/`

- sqlite 搜索)、原生会话(`native-chat/`)。
