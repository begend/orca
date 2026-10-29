# 核心流程

端到端流程,每步标注实现文件。配合
[system-architecture.md](./system-architecture.md) 的拓扑图阅读。

## 1. 冷启动

1. `src/main/index.ts` — 主进程入口:preflight(`startup/main-process-preflight.ts`,
   含单实例锁)、注册 IPC 与 quit 处理器,`app.whenReady()` 后进入
   `initializeMainProcessReady`。
2. `startup/main-process-ready-foundation.ts` — hang watchdog、profile 选择、
   profile-state store、代理、SSH host-key store、协议处理器。
3. `startup/main-process-ready-runtime.ts` — 运行时服务:观察者、账号服务、
   `initializeMainProcessRuntime()`(`src/main/runtime/`)、automations、
   插件、浏览器/模拟器桥。
4. `startup/main-process-pty-startup.ts` — 拉起 orcad 守护进程
   (`daemon/daemon-spawner.ts`)并安装 `DaemonPtyAdapter` 为 PTY 提供方;
   失败降级 `DegradedDaemonPtyProvider`。
5. `startup/main-process-runtime-launch.ts` — `openMainWindow()`
   (`window/createMainWindow.ts`,加载 `src/preload` 的构建产物
   `preload/index.js`)与 `OrcaRuntimeRpcServer` 启动并行。
6. 渲染进程 `main.tsx` — 崩溃诊断、键盘路由、主题,挂载 `App`;
   WebGL addon 延迟加载(`primeTerminalWebglAddon()`)。
7. `app-shell/use-app-startup-hydration.ts` — 顺序注水:settings → UI →
   repos/工作区 → `window.api.session` 会话读取 → 工作树 →
   `hydrateTabsSession/EditorSession/BrowserSession` → 终端恢复准备 → SSH
   重连 → `reconnectPersistedTerminals` → `setHydrationSucceeded(true)`
   (此后才允许写会话;失败进 `startup/startup-degraded-recovery.ts` 只读
   模式)。

## 2. 打开工作区/工作树

1. `store/slices/worktrees/session/set-active-worktree.ts` — 设
   `activeWorktreeId`/`activeWorkspaceKey`/`activeWorkspaceExecutionHostId`,
   调和标签模型,恢复该工作树的上次活动标签。
2. `lib/worktree-sleep-intent.ts` — 清除休眠意图,等待唤醒的 pane
   重新连接。
3. `components/terminal-pane/terminal-pane-mount-preparation.ts` — 解析
   worktree 路径、WSL 发行版、`runtimeEnvironmentId`(执行主机 id 见
   `src/shared/execution-host.ts`)。
4. `app-shell/AppWorkspaceShell.tsx` — `shouldMountTerminalWorkbench` 时挂载
   工作台,pane 经 `lib/pane-manager/` 创建 DOM 并进入连接管线。

## 3. 创建终端标签并连接 PTY

1. `store/terminals/terminal-tab-creation.ts` — `createTab(...)`:铸 id、初始
   leaf、单 pane 布局快照;`directSsh`/`launchAgent` 描述符必须在首次 pane
   挂载前就位,否则 pane 会向该标签派生本地 shell。
2. `components/terminal-pane/pty-connection/connect-pane-pty.ts` — 构建
   `ConnectPanePtySession`,安装延迟连接与输入恢复。
3. `pty-connection/run-deferred-connect.ts` — 等待唤醒意图/cwd promise/首次
   fit,然后进入 `deferred-session-attach.ts` 分支:旧版中继 PTY → 重附着;
   未服务 SSH → 行连接;否则 `deferred-session-reattach-choice.ts`。
4. **传输层选择**(`pty-connection/pty-input-recovery.ts`,顺序即优先级):
   `tab.directSsh` → 直连 SSH;属主未解析 → 惰性错误桩;未服务 SSH → 行
   传输;有 `runtimeEnvironmentId` → 远程运行时(必要时包旧版中继桥);否则
   IPC(`pty-transport.ts`)。
5. 重附着裁决(`deferred-session-reattach-choice.ts`):恢复的 leaf 绑定/tab
   级 ptyId → 延迟重附着(经
   `hidden-agent-resume-deferral.ts` 检查隐藏 pane 的持有);存活 eager 缓冲
   → `transport.attach` 收养;无候选 → 新鲜派生。
6. 重附着连接(`deferred-session-reattach-connect.ts`):声明挂起 pane 序列化
   器 → `transport.connect({ sessionId, coldRestore ... })`;失败分支:守护
   进程版本持有、pane 属主未验证/变更重试、会话消失 → 清绑定后重新派生
   (直接 SSH 的死会话也走该 `.catch` 路径)。
7. IPC 派生(新鲜路径):`ipc-pty-connect.ts` → `window.api.pty.spawn` →
   `src/main/ipc/pty/ipc/spawn.ts` → 守护进程
   (`daemon/daemon-pty-adapter.ts`)或本地提供方。
8. 数据面:输出经 `pty-dispatcher.ts`(单监听、ACK 门、投递 watchdog、eager
   缓冲)写入 xterm;输入经写队列 `window.api.pty.write`;resize 走
   `resize-visibility.ts`。滚动历史恢复:eager 缓冲回放 + 主进程快照/回放
   (`pty:replay`、冷恢复检查点)。

## 4. 直连 SSH 主机终端

1. Settings SSH 连接成功后调
   `src/renderer/src/ssh/direct-ssh-terminal-tabs.ts` 的
   `openDirectSshTerminal(targetId, hostLabel)`:同主机已有标签则复用,否则
   `createTab(..., { directSsh })` 落入当前工作树(无工作区时落
   `FLOATING_TERMINAL_WORKTREE_ID` 浮动面板),并激活终端视图。
2. `direct-ssh-pty-transport.ts` 把标准 pane 管线桥到 `window.api.plainSsh`:
   `connect` 新开/按 id 附着、`sendInput`→`write`、`resize`、输出 ACK 流控
   (pane 投递门暂停时停 ACK,触发主进程 512 KiB 背压)。
3. 主进程 `src/main/ssh/direct-ssh/direct-ssh-terminal-sessions.ts`:
   单窗口属主(否则 `already-open`)、`detach` 后会话存活、显式 `close` 才
   结束、SSH 重连轮换 ssh2 通道(渲染层表现为传输内部恢复,绝不作为 PTY
   退出)。
4. 重启 vs 刷新:刷新时主进程 `did-start-navigation`/`render-process-gone`
   触发 `detachDirect()`;重启后逻辑会话已死,重附着连接抛 `cancelled`,
   `.catch` 清除陈旧绑定并重新派生 shell。

## 5. 刷新 / 会话恢复

1. 渲染进程刷新时主进程标记预期刷新,PTY 归守护进程所有,继续存活;直连
   SSH 会话解除附着。
2. 新渲染进程走流程 1 的注水链:会话 payload 带回标签、`ptyIdsByLeafId`
   绑定、编辑器/浏览器状态、`activeConnectionIdsAtShutdown`。
3. `reconnectPersistedTerminals`
   (`store/terminals/workspace-terminal-reconnect.ts`)重新登记映射;pane
   挂载读取 `restoredPtyIdByLeafId` 进入重附着裁决:存活会话收养,死会话
   清理后重新派生。
4. `startup/startup-ssh-connection-restore.ts` 先恢复阻塞集合内的 SSH 连接
   (立即挂载的 pane 所需),其余在聚焦时恢复。

## 6. 配对客户端(手机/Web)

1. 主机 `OrcaRuntimeRpcServer`(`src/main/runtime/runtime-rpc.ts`)启动
   WebSocket;配对前仅回环监听。
2. 配对与 E2EE:`runtime-rpc-mobile-pairing.ts` + `mobile-e2ee-v2-*` 契约。
3. 手机看到的是投影:`RuntimeMobileSession*Tab`;终端 I/O 走运行时自己的
   terminal driver/守护 PTY,不经渲染层 IPC。
4. 中继:`startup/main-process-relay-startup.ts` 列出可中继的运行时环境,
   `cloud/` 的 relay cell 拼接手机与桌面帧;推送经 push 服务。
5. 反向动作(手机关闭标签等)以"携带的关闭意图"持久化,桌面下一次会话写入
   时执行(见 data-model)。

## 7. Agent 会话生命周期(概要)

1. 启动:`createTab(..., { launchAgent, agentLaunchPane })` → 主进程
   `agent-launch/` 计划并派生,提示词经启动令牌投递。
2. 钩子:启动时调和受管 agent 钩子(`agent-hooks/server.ts` 回环服务),
   状态回报按 pane 路由(`agent-completion-*.ts`)。
3. 休眠:工作区休眠由 `src/main/runtime/workspaces/workspace-sleep-runtime.ts`
   协调,守护进程对会话做持久检查点;渲染层保存 sleeping 记录并设休眠意图
   (pane 显示"WAIT FOR WAKE");`agent-awake-service.ts` 防系统睡眠打断。
4. 唤醒/冷恢复:pane 退出产生 sleeping 记录(`pty-exit-hibernate.ts`);
   重挂载时 `cold-restore-resume-startup.ts` 解析 agent 与 providerSession
   为恢复命令;隐藏 pane 由 `hidden-agent-resume-deferral.ts` 持有到可见
   (仅主机证实死亡才延迟)。
5. 用量:`claude-usage/`、`codex-usage/` 等服务在退出时统一 flush。

## 8. 退出 / 清理

1. `startup/main-process-quit.ts`:`before-quit` 标记退出、flush 云会话、
   中继栅栏关闭;渲染层 `beforeunload` 可否决。
2. `will-quit`(由 `quit-teardown-start-gate.ts` 保证一次):flush pane
   网格、停推送/自动化、注销插件宿主。
3. 最终落盘:SSH 关机标记 + `killAllPty()` →
   `store.flushFinalOrThrowAsync()` + `freezeWritesAsync()`(原子换新)。
4. 全程受 `quit-teardown-deadline.ts` 死限约束,超时项记录后强制退出。
   `window-all-closed` 策略见 `startup/window-all-closed-quit-policy.ts`
   (serve 模式保持 RPC 存活)。

## 9. 更新

1. `updater.ts` + `updater/`:electron-updater,`autoDownload=false`,
   GitHub release feed,prerelease 通道逻辑在 `updater-prerelease-feed.ts`。
2. 后台定时检查(`updater-scheduling.ts`,指数退避、持久化检查时间);手动
   检查走菜单。
3. 下载后 macOS 走 shipit 进程内暂存(`updater-mac-install.ts`),Linux 走
   包管理器(`linux-package-*`);安装退出前
   `src/main/update-restart-preservation.ts` 先保全 agent 认证并做全量
   checkpoint;`will-quit` 对更新退出特殊处理(守护进程 disconnect 而非
   shutdown,以便热重附着)。
