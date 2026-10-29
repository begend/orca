# Direct SSH 终端与 Files 入口设计

## 目标

direct SSH 必须是 Orca 的正常终端，而不是附加在普通终端旁边的第二套界面。它应复用普通终端的标签、右键菜单、重命名、颜色、分屏、拖拽、关闭和焦点行为；同时保留主机级 SFTP 文件浏览、上传、下载、进度与取消能力。

Files 不是标签，也不是 SSH 连接的替代入口。它是“当前激活 direct SSH 终端”的固定 contextual action。

## 核心模型

```text
unified Tab / TabGroup                 TerminalTab / TerminalLayoutSnapshot
──────────────────────                ──────────────────────────────────
显示标签、顺序、焦点、右键菜单          终端 transport、pane tree、生命周期
Tab.entityId ───────────────────────► TerminalTab.id
                                           │
                                           └── directSsh.targetId
                                                │
                                                └── SFTP / DirectSshTerminalSessions
```

- `TerminalTab.directSsh.targetId` 是唯一可持久化、可用于 SFTP 的 direct SSH 身份。
- `direct-ssh:<logical-session-uuid>` 只是运行期 pane binding，用于 renderer reload 时重新认领 main 进程 session；不能作为普通 provider PTY，也不能持久化到磁盘。
- unified `Tab` 不存 direct target。因此不能根据 `label`、`customLabel`、IP、用户名或 `direct-ssh:*` 字符串反推主机。

两条记录必须满足：一个可见 terminal unified tab 对应一个 `TerminalTab`，并以 `Tab.entityId === TerminalTab.id` 相连。

## 创建与连接通路

```text
Settings / SshPane
  → openDirectSshTerminal(targetId, hostLabel)
  → createTab({ directSsh: { targetId }, activate: true })
  → 同步创建 TerminalTab + unified Tab + TabGroup + 单 leaf layout
  → TerminalPane 识别 tab.directSsh
  → createDirectSshPtyTransport
  → window.api.plainSsh
  → main: DirectSshTerminalSessions
  → ssh2 shell channel
```

`TerminalTab` 必须在第一个 pane mount 前存在。否则 pane 会走普通 IPC PTY，错误地在 direct SSH 标签中创建本地 shell。

## 为什么此前看不到 Files

发布版本默认 `ORCA_LAYOUT_OWNER=window`。一个工作区只有一种可见 tab strip：

| 场景              | 实际 strip 宿主                                  | Files 应放的位置                |
| ----------------- | ------------------------------------------------ | ------------------------------- |
| 普通非分屏工作区  | `TerminalTitlebarTabs` → portal `#titlebar-tabs` | `TabBar` 旁的固定 action chrome |
| 分屏工作区        | `TabGroupPanel`                                  | focused group 的 action chrome  |
| Floating terminal | `FloatingTerminalPanelSurface`                   | floating titlebar controls 旁   |

此前 Files 仅放进了分屏 `TabGroupPanel` 与 floating panel。截图属于普通非分屏工作区，实际渲染的是 `TerminalTitlebarTabs`，其之前只 portal 一个裸 `TabBar`，所以入口不可能出现。

以前的 `trailingItems` / Files pseudo-tab 方案不能恢复：它在可滚动 tab strip 内，视觉和行为都像第二套标签，不能参加 canonical active/order/split 规则，也会重新引入双标签体系。

最终固定布局是：

```text
[ 可滚动、可拖拽的 TabBar ] [ 固定、不可拖拽的 DirectSshTabActions ]
```

`DirectSshTabActions` 只接收已解析的 `{ targetId, targetLabel }`，并组合现有 `DirectSshFilesDialog`。不同宿主自行决定当前 active terminal 与焦点规则，但都使用同一个 resolver：

```ts
terminal.directSsh
  ? {
      targetId: terminal.directSsh.targetId,
      targetLabel: terminal.customTitle ?? terminal.title
    }
  : undefined
```

## SFTP 生命周期

`DirectSshFilesDialog` → `DirectSshFileBrowser` 继续复用；main 进程负责文件选择器、SFTP、临时文件、上传下载任务、进度、错误与取消。

- 关闭 dialog 不会取消已经开始的 transfer。
- 当前 dialog 关闭时 browser 卸载，因此本地浏览路径和 transfer progress UI 不跨关闭恢复；这是后续 UX 改进，不改变本轮入口架构。
- action 以 `targetId` 为 key，切换 direct hosts 时必须关闭/重建 dialog，不能把一个已打开的 browser 指到另一个 target。
- transfer event 当前不带 target id；若未来允许同一 renderer 同时打开多个 Files browser，需要扩展 event contract 并按 target 过滤。

## 生命周期与恢复

### renderer reload / pane remount

```text
renderer navigation / crash
  → main detachOwner（不 close session）
  → renderer 启动后 plainSsh:list
  → 仅按 exact targetId + tabId + leafId 认领 session
  → pane 重新 attach
```

自动认领不能使用“相同 terminal grid”或“创建顺序”回退：多个 SSH shell 可能有相同网格，错误认领比不认领更危险。

### app restart

```text
main quit → closeAll direct sessions
磁盘仅恢复 directSsh.targetId
下次打开 terminal → newSession
```

不会盲目连接已经消失的 logical session UUID。

### 连接状态与关闭

- target 临时断线：保留 canonical tab 与 target descriptor，pane 显示 reconnecting/ended 状态。
- remote shell exit：清理该 pane/session binding，不能通过普通 `onPtyExit → closeTerminalTab` 抹掉 target identity。
- 用户显式关闭 tab 或最后 pane：同时关闭 main direct session、`TerminalTab`、unified `Tab`、layout 与相关临时状态。
- target rename：仅精确更新 `directSsh.targetId`。
- confirmed target removal：以精确 `directSsh.targetId` 原子删除 direct terminal 的两套记录及所有 group/layout 引用。

## 一致性与历史残留

direct SSH 在 opening、detached 或 reconnecting 时没有 daemon PTY 是正常状态，不能被 orphan sweep 当作死亡终端删除。

修复历史残留只能使用稳定 id：

1. `TerminalTab` 存在、unified tab 缺失：安全地由 row 恢复 unified projection/group order。
2. unified terminal tab 存在、`TerminalTab` 缺失：不能从显示名猜 target；安全清理该 ghost tab 及 group/layout 引用，让用户从 Settings 重新打开主机。
3. detached main session 缺 `targetId + tabId + leafId`：不挂给任意 tab，按 main-side grace policy 清理或提供明确 ended 状态。

## 验收标准

1. Settings 打开 direct host 后，普通非分屏顶栏立即显示 Files。
2. 切到普通 terminal 时 Files 消失；切回 direct tab 后恢复。
3. 分屏仅 focused direct group 显示；floating panel 在自己的 titlebar 显示。
4. Files 可上传、下载、显示进度、取消。
5. Ctrl+R 后只认领 exact tab/leaf session，不串 shell。
6. direct tab opening/reconnect/remote exit 不会变成 unified-only ghost tab。
7. 显式 Close 会同时移除 tab、layout 与 direct main session。
