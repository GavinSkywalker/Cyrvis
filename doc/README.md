# CYRVIS 文档索引

CYRVIS 是在 UI-TARS Desktop 基础上构建的**语音优先桌面 Agent**：
Voice Agent（Qwen Realtime）↔ VoiceBrain ↔ Controller ↔ ElectronGUIAdapter ↔ UI-TARS GUIAgent。

> 所有过程文档遵循 `doc/` 目录约定；`docs/` 是上游 UI-TARS 自带文档，勿混用。

## 先看这几份

| 文档                                                                                   | 内容                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [architecture.md](./architecture.md)                                                   | 整体分层、状态机、接口、早期可行性分析                              |
| [voice-architecture.md](./voice-architecture.md)                                       | **当前语音实现权威说明**：采集/播放分进程、打断、双模式、阈值、实测 |
| [fast-tool-matrix.md](./fast-tool-matrix.md)                                           | 前方快速工具矩阵：能力、Router、安全策略、MCP 与扩展方式            |
| [tool-matrix-capability-map.md](./tool-matrix-capability-map.md)                       | 基础 89、统一运行时 114 个工具的分类、层级、边界和项目定位          |
| [qwen-doc-ppt.md](./qwen-doc-ppt.md)                                                   | Qwen-Doc-Turbo PPT 生成协议、配置和降级链                           |
| [dynamic-tool-context.md](./dynamic-tool-context.md)                                   | 用户上下文、动态资源、能力绑定、相关性排序和 Provider 激活          |
| [dynamic-perception.md](./dynamic-perception.md)                                       | 通用感知 Provider、增量资源、刷新调度、浏览器标签页和验证闭环       |
| [cyrvis-orchestration-runtime-20261120.md](./cyrvis-orchestration-runtime-20261120.md) | 统一世界状态、任务调度、自主意图与能力合成控制面                    |
| [provider-manifests.md](./provider-manifests.md)                                       | 动态 Provider manifest、签名、权限、MCP 生命周期与审计              |
| [system-awareness.md](./system-awareness.md)                                           | 系统状态感知、软件发现、Steam、动态能力和任务交互                   |
| [roadmap.md](./roadmap.md)                                                             | 后续重点：GUI 加速 + MCP + 简单任务直连、UI、眼动、主动性/记忆      |
| [development.md](./development.md)                                                     | 环境、启动、测试、日志、密钥与常见故障                              |

## 过程记录

| 文档                                   | 用途                                       |
| -------------------------------------- | ------------------------------------------ |
| [plan.md](./plan.md)                   | 项目计划与文档索引（含当前阶段）           |
| [progress.md](./progress.md)           | 按时间推进的完成项与待办                   |
| [findings.md](./findings.md)           | 排障结论、模型/接口/音频事实，避免重复踩坑 |
| [travel-search.md](./travel-search.md) | 多站旅行比价骨架、站点适配器状态与下一步   |

`progress.md` / `findings.md` 是**实时记录**：开发过程中直接追加，不要事后补录。

## 历史归档

| 文档                                                                       | 说明                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [archive/product-vision-v1.md](./archive/product-vision-v1.md)             | 2026-11-14 初始产品愿景与 14 天计划；已被实现文档取代，保留背景 |
| [archive/architecture-v1.md](./archive/architecture-v1.md)                 | 2026-11-14 v1 整体设计（接口/目录已部分被实现取代）             |
| [archive/voice-plan-v1.md](./archive/voice-plan-v1.md)                     | 早期语音方案对比（端到端 vs 级联）                              |
| [archive/voice-implementation-v1.md](./archive/voice-implementation-v1.md) | 首版语音任务清单与排期                                          |

## 代码地图

```
apps/ui-tars/src/main/cyrvis/          # CYRVIS 主进程
  controller.ts                        # 单任务状态机
  gui-adapter.ts                       # 包装 runAgent / GUIAgent
  voice-brain.ts                       # 意图路由、唤醒、确定性控制、主动播报
  search-intent.ts                     # 统一意图分类（导航/搜索/比价/任务）
  site-registry.ts                     # 常用站点别名与站内搜索 URL
  travel-search.ts                     # 多站比价骨架（适配器 + 推荐）
  desktop-actions.ts                   # 搜索/开 URL/开应用快速工具
  capture-service.ts                   # 隐藏采集窗口 + 本地 HTTP/WS
  voice-service.ts                     # 单例、IPC、打断检测、双模式
  voice/                               # Qwen Realtime Provider、工具定义
  context/                             # 用户上下文、资源目录、绑定和相关度
  tools/                               # 前方快速工具矩阵、Router、MCP facade
  types.ts                             # 共享类型
  # 已有：memory/ proactivity/；后续：gui/ gaze/
apps/ui-tars/src/renderer/src/components/CyrvisVoice/   # 语音条、WAV 播放器
apps/ui-tars/src/preload/index.ts      # voice IPC 桥
doc/                                   # 本目录
scripts/cyrvis/                        # 启动脚本
```

## 文档规则

1. 不提交任何真实 Key、Token、Cookie、日志和个人路径。
2. 新增能力先改 `roadmap.md` 的模块/接口，再落代码。
3. 关键排障结论写入 `findings.md`，带日志证据和时间。
4. 对外/组内演示前更新 `progress.md` 的“已完成/待办”。
