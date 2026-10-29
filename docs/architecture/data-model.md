# 数据模型与持久化

Orca 的状态分三层:渲染进程内存态(zustand)、渲染进程↔主进程的会话持久化
(经 schema 清洗落盘)、主进程/守护进程自有状态。路径相对仓库根目录。

## 渲染进程根状态(单一 zustand store)

组装于 `src/renderer/src/store/index.ts`,约 45 个切片合成一个 `AppState`
(类型见 `store/types.ts`)。核心域:

| 切片(状态类型文件)                                         | 主要字段                                                                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo — `store/repos/repo-state.ts`                         | `repos`、`projects`、`projectGroups`、`folderWorkspaces`、`activeRepoId`                                                                                                           |
| Worktree — `store/slices/worktree-helpers.ts`              | `worktreesByRepo`、`worktreeLineageById`、`activeWorktreeId`、`activeWorkspaceKey`、`activeWorkspaceExecutionHostId`                                                               |
| Terminal — `store/terminals/terminal-state.ts`             | `tabsByWorktree`、`activeTabIdByWorktree`、`ptyIdsByTabId`、`terminalLayoutsByTabId`、`pendingReconnectPtyIdByTabId`、`deferredSshSessionIdsByTabId` 等                            |
| Tabs(统一标签)— `store/slices/tabs/tabs-slice-contract.ts` | `unifiedTabsByWorktree`(终端/浏览器/编辑器/内容统一视图)、`groupsByWorktree`、`layoutByWorktree`                                                                                   |
| UI — `store/slices/ui/ui-slice-contract-core.ts`           | `activeView`、侧栏开合/宽度、分组与排序偏好、引导状态                                                                                                                              |
| Settings — `store/slices/settings.ts`                      | `settings: GlobalSettings`、按主机的可见性默认                                                                                                                                     |
| 其余                                                       | `editor`、`browser`、`ssh`、`runtime-status`、`agent-status`(约 50 个文件)、`github`/`hosted-review`/`linear`/`jira`、用量切片(`usage-provider-slices.ts`)、`workspace-cleanup` 等 |

不在 zustand 里的状态:`ssh/plain-ssh-terminal-panels.ts`(模块级外部 store,
遗留逃生舱面板,头注释明确"不持久化、不恢复、不同步")、
`lib/pane-manager/pane-manager.ts`(`PaneManager` 类,命令式 pane 树)、
插件面板 store。

### 核心实体:`TerminalTab`

定义在 `src/shared/terminal-tab-types.ts`:`id`、`ptyId`、`worktreeId`、标题
族(`title`/`defaultTitle`/`generatedTitle`/`customTitle`)、`color`、
`isPinned`、`viewMode`、`sortOrder`、启动描述(`startupCwd`、`launchAgent`、
`directSsh?: { targetId }`)、恢复账本(`recovery`)。每个 tab 的 pane 树是
`TerminalLayoutSnapshot`(`root` 为 leaf/split 二叉树,leaf 携带
`ptyIdsByLeafId`、`buffersByLeafId`、`scrollbackRefsByLeafId`)。

pty id 命名空间约定(见 `src/shared/direct-ssh-pty-id.ts`、
`remote-runtime-pty-id.ts`):本地守护 PTY 为普通 id,远程运行时为
`remote:<env>@@<handle>`,直连 SSH 为 `direct-ssh:<uuid>`——所有 ptyId 形状
的消费者因此无需分支。

## 会话持久化(每个工作区一份)

- **Schema**:`src/shared/workspace-session-schema.ts`。保存:活动
  repo/workspace/host、`tabsByWorktree`(`terminalTabSchema`,含
  `ptyId`、`directSsh`)、`terminalLayoutsByTabId`(含 leaf 的 `ptyId`
  绑定)、编辑器/浏览器会话、统一标签与分组、`sleepingAgentSessionsByPaneKey`
  等。
- **写入**:`src/renderer/src/lib/workspace-session-host-persistence.ts` 按
  `ExecutionHostId` 分区(`get/patch/set/flush`);分区归属规则在
  `src/shared/workspace-session-partition-owner.ts`(`local` 持有旧版
  `workspaceSession`,`runtime:<id>`/`ssh:<id>` 各自持有分区)。
- **落盘**:主进程 `src/main/persistence/loading-store/session-snapshot-operations.ts`
  写 `<userData>/orca-data.json`;较新的域(repos、settings、ui、sshTargets、
  automations 等)在 sqlite `profile-state.db`
  (`persistence/profile-state/`)。
- **清洗层**:`src/shared/workspace-layout/workspace-layout-disk-fields.ts`
  把每个磁盘字段映射到唯一内存来源(`from`/`via`)或 `'unwritten'`;
  `'unwritten'` 字段永不从布局回写——`directSsh` 的注释说明"直连描述符保持
  主机本地:配对主机布局镜像绝不重新拨号"。渲染坏数据由逐字段 salvage
  (`src/shared/zod-salvage.ts`)打捞,不会整体重置。

### 持久化边界:什么进磁盘,什么不进

| 数据                          | 是否持久化                                   | 位置                                                                                    |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| 标签身份、布局、分组          | 是                                           | 会话 schema                                                                             |
| 直连 SSH 的 `targetId` 描述符 | 是(仅本地;不进配对镜像)                      | `terminalTabSchema.directSsh`                                                           |
| 直连 SSH 逻辑会话 id          | 否(主进程内存态,重启后对账)                  | `DirectSshTerminalSessions`                                                             |
| leaf 的 `ptyId` 绑定          | 是(重启后可能失效,reattach 流程负责清理重开) | layout leaf 字段                                                                        |
| `localOnlyScrollbackByTabId`  | 仅本地("远程投影不上传")                     | 会话 schema                                                                             |
| 设置 / UI 偏好                | 是                                           | settings → main;`PersistedUIState` 经 `src/main/ipc/ui.ts`                              |
| 终端滚动快照                  | 是                                           | `<userData>/terminal-scrollback/<ref>.bin`(`src/main/terminal-scrollback-snapshots.ts`) |
| 守护进程会话历史/检查点       | 是                                           | `<userData>/terminal-history/`(`meta.json`、`checkpoint.json`、`output.log`)            |
| 凭据                          | 加密                                         | `safeStorage` 信封(`src/main/credentials/`、`orca-profiles/`)                           |

## 配对主机 / 移动端同步

- 主机→客户端投影:`RuntimeMobileSession*Tab` 契约
  (`src/shared/runtime-mobile-session-tab-contracts.ts`),这是镜像的"词汇表"。
- 主机为每个环境存一份**仅展示用**的 `RemoteLayoutSnapshot`
  (`src/shared/remote-layout-snapshot.ts`,注释明确"绝不编辑或回传")。
- 客户端→主机的待办动作:成对的关闭意图
  (`paired-terminal-tab-close-intent.ts`,上限 256 条/30 天)。
- 设备维度的标签选择跨主机重启持久
  (`src/main/runtime/client-session-tab-selection.ts`)。
- 直连 SSH 描述符被排除在镜像外(见上),移动端/配对主机永不拿到。

## 版本与迁移

- 主状态文件带 `PersistedState.schemaVersion`
  (`src/shared/persisted-state-types.ts`);各域独立版本:
  `profile-state.db` schema 3、编排 DB 43、AI vault 会话搜索 8、agent 会话
  记录 2 等。
- 加载期迁移集中在 `src/main/persistence/loading-store/`
  (`loaded-cohort-migrations.ts`、`loaded-state-adaptation.ts`)与
  `persistence/migrating-orcad-catalog/`(orcad 迁移回执)。
- 写入有闸门:关闭标签写栅栏
  (`persistence/closed-terminal-tab-write-fence.ts`)、WSL 迁移会话冻结、
  原子换新(`flushFinalOrThrowAsync`/`freezeWritesAsync`)。
