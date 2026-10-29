# 架构文档

面向开发者的 Orca 代码架构地图。用户功能文档见 `docs/site/`;UI 设计规范见
[`../STYLEGUIDE.md`](../STYLEGUIDE.md)。

| 文档                                               | 内容                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [system-architecture.md](./system-architecture.md) | 进程拓扑:Electron main/preload/renderer、`orcad` PTY 守护进程、runtime RPC、配对客户端与中继、PTY 传输层、平台层 |
| [directory-map.md](./directory-map.md)             | 顶层目录以及 `src/main` / `src/renderer` 各业务域的职责定位                                                      |
| [data-model.md](./data-model.md)                   | 渲染层 store 切片、会话持久化与清洗层、磁盘布局、配对主机/移动端同步、版本与迁移                                 |
| [core-flows.md](./core-flows.md)                   | 端到端流程:启动、打开工作区、终端连接管线、直连 SSH 终端、刷新恢复、配对、休眠/唤醒、退出、更新                  |

新成员建议阅读顺序:system-architecture → directory-map → core-flows →
data-model。每篇文档都标注了对应的源码路径,可对照代码验证;当流程或边界
发生变化时请同步更新。
