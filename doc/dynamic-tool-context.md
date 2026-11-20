# CYRVIS 动态工具上下文

> 状态：2026-11-19 已实现核心版本。
>
> 定位：系统资源动态增长，用户状态持续变化，但工具协议保持稳定。动态变化只影响
> 资源目录、能力绑定、工具排序和模型可见面。

## 1. 总体结构

```text
SystemStateStore ─┐
NativeForeground ├─> UserContextStore
ForegroundMonitor│        │
Tool executions   │        │
Task events       │        ▼
ProviderRegistry ─┴─> ResourceCatalog
                           │
                           ▼
                    BindingResolver
                           │
                           ▼
                    RelevanceEngine
                           │
                           ▼
                      ToolSurface
                           │
                           ▼
                  Qwen / Cascade / MCP
```

工具不再按每个安装软件生成一个永久函数。当前模型为：

```text
稳定动作协议 + 动态资源 + 动态能力绑定 + 状态驱动工具面
```

通用应用状态由 `context/perception/` 管理。`PerceptionScheduler` 调度浏览器等
`PerceptionProvider`，通过 `IncrementalResourceStore` 生成增量资源和 TTL，再进入
`ResourceCatalog`、`BindingResolver` 和 `ToolSurface`。详见
[dynamic-perception.md](./dynamic-perception.md)。

## 2. 三个核心模型

### 2.1 SystemState

负责当前机器环境：

- 硬件、磁盘、电池、网络；
- 已安装应用和 Steam 游戏；
- 进程、可见窗口、前台窗口；
- 服务和非敏感系统状态。

默认刷新：

- 进程和窗口：10 秒；
- 安装应用、Steam、磁盘、电池、服务：10 分钟；
- 前台窗口：Windows 原生前台事件；事件桥不可用时使用 2 秒轮询兜底。
- 最近文件：启动和每 10 分钟读取 Windows Recent，过滤敏感文件名。

环境变量：

```env
CYRVIS_SYSTEM_RUNTIME_REFRESH_MS=10000
CYRVIS_SYSTEM_FULL_REFRESH_MS=600000
CYRVIS_FOREGROUND_REFRESH_MS=2000
CYRVIS_NATIVE_FOREGROUND_EVENTS=1
CYRVIS_CONTEXT_MAX_CHARS=12000
```

### 2.2 UserContextState

负责用户当前正在做什么，保存在内存中，不作为长期画像直接持久化：

- 当前应用和窗口；
- 焦点控件和选中文本；
- 最近用户请求；
- 最近工具动作；
- 当前任务、状态和步骤；
- 最近打开的文件和网址。

临时状态全部带 TTL：

- 活动窗口：15 秒；
- 焦点控件：5 秒；
- 选中文本：30 秒；
- 最近用户请求和动作：10 分钟。

包含密码、API Key、Token 等特征的内容不会写入用户上下文。

### 2.3 CapabilityBinding

负责把动态资源连接到真实工具：

```text
Visual Studio Code
  -> application:registry:vscode
  -> provider: vscode
  -> vscode.open_folder
```

绑定记录：

- 能力 ID；
- 资源 ID；
- Provider ID；
- 工具方法；
- 默认参数；
- 可用性；
- 是否对当前活动资源生效；
- 绑定原因。

## 3. 动态工具面

`ToolSurface` 仍然限制模型最多看到 24 个工具。排序因素包括：

- 当前前台资源匹配；
- 当前任务匹配；
- 最近成功使用和调用频率；
- 固定优先级和 Tier；
- 最近文件和网址；
- 风险、失败次数和 Provider 健康度。

候选工具分三类：

1. 稳定核心工具：文件、应用、窗口、剪贴板、系统等。
2. 动态资源工具：软件启动、Steam 游戏、最近文件、网站等。
3. Provider 专用工具：仅在 Provider 可用并且与当前资源相关时激活。

系统状态每次刷新不会自动更新模型工具表。只有资源、绑定、可用性或排序的
语义结果发生变化时，`ToolSurface` 才发出新快照。

## 4. Provider 动态激活

Provider manifest 可以声明前台激活策略：

```json
{
  "activation": {
    "mode": "foreground",
    "applications": ["Visual Studio Code"],
    "processes": ["Code"]
  }
}
```

`mode=foreground` 的外部 Provider 在匹配应用进入前台前不会连接，能力仍保留在
Catalog 中并标记为等待状态。应用进入前台后，`DynamicContextStore` 发出
`foreground_changed`，ProviderManager 重新协调并加载对应工具。

内置试点 Provider：

| Provider        | 工具                                                         | 依赖                 |
| --------------- | ------------------------------------------------------------ | -------------------- |
| `vscode`        | `vscode.open_folder`、`vscode.open_file`                     | Visual Studio Code   |
| `browser-debug` | `browser.list_tabs`、`open_tab`、`activate_tab`、`close_tab` | Chrome/Edge 调试端口 |

浏览器 Provider 只接受 loopback DevTools 地址：

```env
CYRVIS_BROWSER_DEBUG_URL=http://127.0.0.1:9222
```

## 5. 未知应用兜底

没有 Provider 的活动应用不会从系统中消失，而是进入 UI Automation 兜底：

```text
Provider 专用能力
  -> 通用应用/窗口工具
  -> ui.inspect
  -> screen.capture / screen.ocr
  -> ui.action
```

未知应用的活动资源会提高 `ui.inspect`、`ui.action`、截图和 OCR 的排序。
操作后仍应通过 `condition.check`、再次 `ui.inspect` 或截图验证结果。

## 6. 绑定执行与验证

`DynamicContextStore.executeBinding(resourceId, capabilityId, args)` 提供不涉及
任务 Router 的执行接口：

```text
查找绑定
  -> 合并 defaultArgs
  -> ToolRegistry.prepare
  -> ToolRegistry.executePrepared
  -> 根据 verification plan 验证结果
```

验证支持路径存在、进程运行、窗口存在和工具自报已验证结果。高风险工具仍经过
ToolRegistry 的统一确认策略，绑定接口不能绕过确认。

## 7. 上下文工具与界面

新增三个稳定工具：

| 工具                | 作用                                             |
| ------------------- | ------------------------------------------------ |
| `context.snapshot`  | 读取用户状态、活动资源、最近动作、绑定和兜底资源 |
| `context.resources` | 搜索应用、窗口、文件、网站等动态资源及其绑定能力 |
| `context.intent`    | 融合系统、语音历史、任务和眼动得到活动与候选意图 |

这两个工具按上下文激活，不会无条件占用模型工具预算。

语音条通过 `cyrvis:voice:context` 显示当前活动应用，并提供清除临时上下文的
入口。清除操作保留活动窗口和当前任务，只清除最近请求、选中文本、动作和最近
资源。模型上下文按 `CYRVIS_CONTEXT_MAX_CHARS` 限制总长度。

### 7.1 确认意图仲裁

高风险操作的确认采用分级处理：

```text
确定性确认/取消词
  -> 绑定 pending action memory
  -> 规则不确定时调用轻量 LLM 分类
  -> confirm / cancel / new_command / unclear
  -> 只有高置信度 confirm 才执行原 pending action
```

LLM 只产生结构化意图，不接触工具参数，也不能直接执行操作。高风险动作要求
置信度至少 `0.9`，普通确认要求至少 `0.82`。可通过
`CYRVIS_PENDING_INTENT_LLM=0` 关闭该回退。

## 8. 通知与计时器

| 工具                  | 作用           |
| --------------------- | -------------- |
| `system.notification` | 本地桌面通知   |
| `timer.create`        | 创建一次性提醒 |
| `timer.cancel`        | 取消提醒       |
| `timer.list`          | 列出活动提醒   |

计时器只存在于当前应用进程，退出 CYRVIS 后不会恢复。

## 9. 文档与压缩

| 工具                    | 作用                                                   |
| ----------------------- | ------------------------------------------------------ |
| `document.extract_text` | 文本文件及 DOCX/XLSX/PPTX 文本提取                     |
| `pdf.extract_text`      | 通过本机 `pdftotext` 提取 PDF 文本，未安装时能力不可用 |
| `archive.create`        | 创建 ZIP 压缩包                                        |
| `archive.extract`       | 解压 ZIP，覆盖前需要确认                               |

Open XML 提取不依赖 Microsoft Office，但当前只解析文本内容，不保留复杂样式和布局。

## 10. 原生前台事件

Windows 使用 `scripts/cyrvis/foreground-events.ps1` 注册
`EVENT_SYSTEM_FOREGROUND`。事件触发后读取完整窗口信息并更新 UserContext。
事件桥不可用时保留轮询兜底。

## 11. 运行文件

| 文件                                   | 职责                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `context/dynamic-context.ts`           | 统一上下文、事件、资源、绑定和刷新                        |
| `context/user-context.ts`              | 用户临时状态、TTL、隐私过滤                               |
| `context/foreground-monitor.ts`        | 前台窗口轻量轮询和变化检测                                |
| `context/windows-foreground-events.ts` | Windows 原生前台事件桥                                    |
| `context/builtin-providers.ts`         | VS Code 和浏览器 Provider 试点                            |
| `context/context-budget.ts`            | 模型上下文长度预算                                        |
| `context/resource-catalog.ts`          | 应用、窗口、文件、网站资源目录                            |
| `context/binding-resolver.ts`          | 资源到工具/Provider 的绑定                                |
| `context/relevance-engine.ts`          | 上下文相关性评分和 UI 兜底能力                            |
| `context/tools.ts`                     | `context.snapshot`、`context.resources`、`context.intent` |
| `system/system-state.ts`               | 系统快照、刷新和前台窗口合并                              |
| `system/reminders.ts`                  | 通知和本地一次性计时器                                    |
| `tools/document-tools.ts`              | 文档文本提取、PDF 提取和 ZIP 操作                         |
| `tools/tool-surface.ts`                | 动态工具预算、激活和排序                                  |
| `tools/provider-manager.ts`            | Provider 生命周期和前台延迟激活                           |

## 12. 性能基准

运行：

```bash
cd apps/ui-tars
npx tsx scripts/cyrvis/benchmark-dynamic-context.ts
```

本机 381 个资源、2206 个绑定、89 个基础注册工具：

```text
visible tools: 24
refresh P50: 19.1 ms
refresh P95: 32.7 ms
```

## 13. 当前限制

- 选中文本和焦点控件在调用 `ui.inspect` 后更新，不是持续监听。
- 浏览器试点目前提供标签页管理，不包含 DOM 读取、Cookie、上传下载和完整页面自动化。
- Provider 专用能力仍需要实际 Provider manifest，不能自动理解任意软件全部 API。
- 未知应用通过 UI Automation 提供通用操作，不等同于应用原生功能的完整覆盖。
- 绑定执行接口已完成，但哪个请求使用哪个绑定仍由后续 Router 决定。
- 应用内部深层状态仍需要应用 Provider 或按需 UI 检查。
- DOCX/XLSX/PPTX 当前支持文本提取，不支持完整样式编辑；扫描 PDF 仍依赖 OCR 方案。
- OAuth 账号服务和第三方 Provider 生态仍未接入。
