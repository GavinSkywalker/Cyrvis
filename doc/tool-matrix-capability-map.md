# CYRVIS 工具矩阵能力地图

> 更新时间：2026-11-19
>
> 状态：与当前默认运行态代码对齐
>
> 适用范围：`apps/ui-tars/src/main/cyrvis/tools/`

> 2026-11-21 更新：明确用户指令即授权。工具、深层能力和工作流不再进入
> 二次确认状态；旧版 `waiting_confirmation` 数据在加载时直接迁移或恢复执行。

## 1. 当前规模

基础工具矩阵注册 `89` 个工具；启用统一 OrchestrationRuntime 后为 `113` 个：

- `79` 个基础工具、内置 Provider 和工作流工具；
- `9` 个在 `SystemStateStore` 可用时注册的动态系统工具；
- `18` 个由 OrchestrationRuntime 注册的统一控制面工具；
- 外部 Provider manifest 还可以继续注册工具，因此 `113` 是默认完整基线，不是理论上限；
- 语言模型默认最多同时看到 `24` 个工具，完整目录通过 `capability.*` 元工具访问。

工具矩阵不是“给每个已安装软件生成一个专用函数”。当前模型是：

```text
稳定动作协议
  + 动态资源
  + 动态能力绑定
  + 状态驱动工具排序
```

例如，系统有几百个应用时，不会生成几百个启动函数；模型先查询动态资源，再通过
`software.launch`、`app.launch` 或 Provider 绑定完成启动。

## 2. 能力分类

### 2.1 能力元工具，4 个

| 工具                   | 功能                                         |
| ---------------------- | -------------------------------------------- |
| `capability.search`    | 搜索完整能力目录，包括默认工具面中隐藏的工具 |
| `capability.describe`  | 读取指定工具的完整参数、风险和可用条件       |
| `capability.invoke`    | 调用隐藏工具，并经过统一参数、路径和风险检查 |
| `capability.providers` | 查看 Provider、可用性、权限和工具归属        |

这些工具属于 Tier 0，始终可见。设计原因是完整工具目录可能很大，但 `search / describe / invoke`
足以组成稳定的按需发现协议。

### 2.2 上下文与系统感知，12 个

| 工具                      | 功能                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `system.snapshot`         | 读取系统、硬件、磁盘、电池、网络、应用、Steam、进程和窗口快照 |
| `system.capabilities`     | 读取当前系统能够提供的动态能力                                |
| `system.search_apps`      | 模糊搜索已安装应用和 Steam 游戏                               |
| `system.list_services`    | 查询非敏感 Windows 服务状态、启动类型和显示名称               |
| `software.list_installed` | 列出或过滤已安装软件                                          |
| `software.launch`         | 启动动态发现的应用                                            |
| `system.refresh`          | 强制增量或全量刷新系统状态                                    |
| `steam.list_games`        | 根据 Steam library manifests 列出游戏                         |
| `steam.launch_game`       | 按名称、部分名称或 AppID 启动 Steam 游戏                      |
| `context.snapshot`        | 读取当前用户、前台资源、最近动作、任务和绑定                  |
| `context.resources`       | 搜索应用、窗口、文件、网站等动态资源                          |
| `context.intent`          | 融合系统、焦点、语音、历史和眼动得到活动与候选意图            |

这组工具解决“电脑现在有什么、用户正在做什么”，不把完整系统状态无条件写死进提示词。
进程和窗口默认按 10 秒刷新，应用、Steam、磁盘、电池和服务按 10 分钟全量刷新；前台窗口优先
使用 Windows 原生事件。

### 2.3 文件、文档与归档，22 个

| 工具                    | 功能                               |
| ----------------------- | ---------------------------------- |
| `fs.list_directory`     | 列出目录直属内容                   |
| `fs.directory_tree`     | 生成有深度和数量限制的目录树       |
| `fs.get_info`           | 查询文件或目录类型、大小和时间     |
| `fs.exists`             | 检查路径是否存在及类型             |
| `fs.hash`               | 流式计算 SHA-256、SHA-1 或 MD5     |
| `fs.read_file`          | 读取有大小上限的 UTF-8 文本        |
| `fs.create_file`        | 创建文本文件，默认不覆盖           |
| `fs.write_file`         | 覆盖写入文本                       |
| `fs.append_file`        | 追加文本                           |
| `fs.replace_text`       | 精确替换文本                       |
| `fs.create_directory`   | 递归创建目录                       |
| `fs.copy`               | 复制文件或目录                     |
| `fs.move`               | 移动文件或目录，支持跨卷回退       |
| `fs.rename`             | 同目录重命名                       |
| `fs.delete_to_trash`    | 将目标移入回收站                   |
| `fs.search`             | 按文件名或文本内容搜索             |
| `fs.open_random`        | 从目录随机打开指定扩展名文件       |
| `fs.open`               | 使用系统默认程序打开文件或目录     |
| `document.extract_text` | 提取文本、DOCX、XLSX、PPTX 文本    |
| `pdf.extract_text`      | 使用本机 `pdftotext` 提取 PDF 文本 |
| `archive.create`        | 创建 ZIP 压缩包                    |
| `archive.extract`       | 解压 ZIP                           |

这些操作通常有明确的输入和可验证输出，适合绕过截图和 GUI 循环。读取、写入、覆盖、移动和删除
分别经过路径解析；敏感路径、覆盖和删除按明确请求直接执行。

### 2.4 应用与窗口，10 个

| 工具                  | 功能                                   |
| --------------------- | -------------------------------------- |
| `app.launch`          | 启动内置别名应用                       |
| `app.list`            | 列出运行进程和可见窗口标题             |
| `app.close`           | 按受支持名称或进程名关闭应用           |
| `window.list`         | 列出可操作窗口，不暴露 CYRVIS 自身窗口 |
| `window.focus`        | 聚焦匹配窗口                           |
| `window.close`        | 关闭文件或文档窗口，不直接强杀应用进程 |
| `window.minimize_all` | 最小化全部可见窗口                     |
| `window.restore_all`  | 恢复全部窗口                           |
| `window.minimize`     | 最小化匹配窗口                         |
| `window.maximize`     | 最大化匹配窗口                         |

应用 Native API 或窗口消息能够稳定完成的操作，不应交给视觉 Agent。关闭工具会保护 CYRVIS
自身进程和窗口；目标不唯一时拒绝猜测。

### 2.5 视觉观察与 UI，4 个

| 工具             | 功能                                                   |
| ---------------- | ------------------------------------------------------ |
| `screen.capture` | 截取全屏或指定区域并保存 PNG                           |
| `screen.ocr`     | 使用 Windows 原生 OCR 识别截屏或图片                   |
| `ui.inspect`     | 读取前台窗口可访问性树、控件、边界、焦点和选中文本     |
| `ui.action`      | 点击、双击、右键、中键、移动、输入、快捷键、滚动和拖拽 |

这组工具是未知应用和缺少专用 Provider 时的通用兜底。标准顺序是：

```text
Provider 专用能力
  -> ui.inspect
  -> screen.capture / screen.ocr
  -> ui.action
  -> condition.check 或再次观察验证
```

### 2.6 条件与验证，2 个

| 工具              | 功能                         |
| ----------------- | ---------------------------- |
| `condition.check` | 检查当前条件是否成立         |
| `condition.wait`  | 在超时时间内轮询等待条件成立 |

支持的断言：

- `path_exists`
- `path_missing`
- `path_is_file`
- `path_is_directory`
- `process_running`
- `process_missing`
- `window_exists`
- `window_missing`

执行工具和验证工具分离，便于工作流独立确认结果，而不是依赖执行工具的口头成功状态。

### 2.7 进程执行，5 个

| 工具              | 功能                                               |
| ----------------- | -------------------------------------------------- |
| `process.list`    | 按内存占用列出运行进程                             |
| `process.inspect` | 检查 PID 是否存在并读取进程元数据                  |
| `process.run`     | 使用 executable 和 args 同步执行程序，不经过 shell |
| `process.start`   | 启动分离的后台程序并返回 PID                       |
| `process.stop`    | 按 PID 结束进程                                    |

`run / start / stop` 是 Tier 4 高风险工具，用户在明确请求时直接执行。`run` 不接受任意 shell 字符串，
避免命令拼接和隐式 shell 注入。

### 2.8 网络、网页与浏览器，9 个

| 工具                   | 功能                                          |
| ---------------------- | --------------------------------------------- |
| `web.search`           | 使用默认浏览器打开搜索引擎结果页              |
| `web.open_url`         | 使用默认浏览器打开 HTTP/HTTPS 地址            |
| `web.fetch`            | 读取网页或 API 的状态、类型和有大小上限的内容 |
| `web.download`         | 下载资源到本地，超限时拒绝写入不完整文件      |
| `network.interfaces`   | 枚举本机网络接口、地址、类型和内外网状态      |
| `browser.list_tabs`    | 通过本机 DevTools 端点列出浏览器标签页        |
| `browser.open_tab`     | 通过 DevTools 打开标签页                      |
| `browser.activate_tab` | 切换标签页                                    |
| `browser.close_tab`    | 关闭标签页                                    |

简单数据读取使用 `web.fetch`，避免打开浏览器和调用视觉模型。浏览器 Provider 当前只提供标签页
管理，要求配置本机回环 DevTools 地址 `CYRVIS_BROWSER_DEBUG_URL`，不包含完整 DOM 自动化和
登录会话能力。

### 2.9 剪贴板，2 个

| 工具              | 功能             |
| ----------------- | ---------------- |
| `clipboard.read`  | 读取纯文本剪贴板 |
| `clipboard.write` | 覆盖纯文本剪贴板 |

### 2.10 系统基础、媒体与提醒，9 个

| 工具                  | 功能                                       |
| --------------------- | ------------------------------------------ |
| `system.info`         | 读取操作系统、CPU、内存和运行时间          |
| `system.disk`         | 查询指定路径所在磁盘容量                   |
| `system.time`         | 查询当前日期、时间、时区和时间戳           |
| `system.media`        | 播放暂停、停止、上一首、下一首、音量和静音 |
| `system.power`        | 锁屏、睡眠、重启和关机                     |
| `system.notification` | 发送桌面通知                               |
| `timer.create`        | 创建一次性本地提醒                         |
| `timer.cancel`        | 取消提醒                                   |
| `timer.list`          | 列出活动提醒                               |

`system.power` 属于 Tier 4，按明确请求直接执行。计时器当前只存在当前 Electron 进程内，重启后不会恢复。

### 2.11 Office，1 个

| 工具                         | 功能                                               |
| ---------------------------- | -------------------------------------------------- |
| `office.create_presentation` | 调用本机 Microsoft PowerPoint COM 创建基础 `.pptx` |

当前只适合生成基础标题页，不等于完整 PowerPoint 编辑器。未安装 PowerPoint 时能力不可用，
不会伪造文件。

### 2.12 专用 Provider，2 个

| 工具                 | 功能                      |
| -------------------- | ------------------------- |
| `vscode.open_file`   | 使用 VS Code 打开文件     |
| `vscode.open_folder` | 使用 VS Code 打开项目目录 |

### 2.13 本地工作流，6 个

| 工具              | 功能                       |
| ----------------- | -------------------------- |
| `workflow.start`  | 启动依赖 DAG 工作流        |
| `workflow.status` | 查询工作流状态和当前步骤   |
| `workflow.list`   | 列出活动或历史工作流       |
| `workflow.cancel` | 取消工作流                 |
| `workflow.resume` | 恢复暂停或应用重启后的任务 |

### 2.14 统一控制面，25 个

| 类别       | 工具                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 任务       | `task.submit/plan/list/status/pause/resume/cancel/retry`                          |
| 自主意图   | `autonomy.status/configure/accept/reject/goal.add/goal.remove`                    |
| 运行时能力 | `capability.synthesize/proposals/propose-provider/propose-binding/approve/reject` |
| 世界与轨迹 | `world.snapshot/context`、`trace.list/replay`                                     |

VS Code 和浏览器 DevTools 是 Provider 模型的试点。Provider 可以由 manifest 声明 application、
process、service、environment、executable、权限和前台激活条件，并支持 builtin、stdio、
streamable-http 和 SSE 传输。可信外部 manifest 需要签名验证，未信任 Provider 默认拒绝。

## 3. 分层与安全设计

### 3.1 暴露层级

| Tier   | 定位                     | 典型能力                                       |
| ------ | ------------------------ | ---------------------------------------------- |
| Tier 0 | 能力发现和隐藏工具调用   | `capability.search/describe/invoke/providers`  |
| Tier 1 | 高频、低歧义、可快速执行 | 文件读取、应用启动、窗口列表、搜索             |
| Tier 2 | 状态相关或需要观察       | 截屏、OCR、UI 检查、文档提取、通知             |
| Tier 3 | 高级写入或中等破坏性     | 复制、移动、重命名、UI 输入、下载、应用关闭    |
| Tier 4 | 强破坏性或系统级操作     | 进程终止、电源操作、回收站删除及其他高风险变更 |

`ToolSurface` 默认最多选择 `24` 个工具。排序参考前台资源、当前任务、最近使用、频率、Tier、
Provider 健康和失败次数。

### 3.2 安全边界

- 所有工具调用统一经过 `ToolRegistry`；
- 参数先经过 schema、默认值和路径绝对化；
- 路径参数经过 `PathPolicy`，敏感目录和工作区外路径可直接访问；
- 高风险、覆盖、删除、关闭应用和电源操作按明确指令直接执行；
- `capability.invoke` 与直接工具调用共享同一参数和路径策略；
- 本地语音、MCP 和 Provider 共用同一 Registry；
- 工具调用成功、失败、耗时和错误写入审计；
- CYRVIS 自身窗口和进程不能通过通用窗口/应用关闭工具操作。

### 3.3 为什么采用稳定工具而不是无限动态函数

- 防止工具 schema 数量随“软件数 × 子操作数”爆炸；
- 避免每次系统变化都刷新几百个函数定义；
- 让权限、风险和确认策略可以稳定复用；
- 让同一动作可绑定到不同应用和 Provider；
- 让模型先查询当前资源，再调用通用协议；
- 为未来 Codex、远程 MCP 和其他执行器保留相同能力接口。

真正的应用专用深度操作仍需由 Provider 发布，而不是硬编码进核心工具矩阵。

## 4. 当前缺口

| 缺口               | 当前状态                                                                                | 归属与优先级         |
| ------------------ | --------------------------------------------------------------------------------------- | -------------------- |
| 目标身份和消歧     | 浏览器标签页已有稳定 target ID；普通窗口仍主要依赖标题/进程名，控件也缺少跨会话持久 UID | 工具矩阵内，P0       |
| 完整浏览器自动化   | 只有标签页管理，缺少 DOM、可访问性树、元素操作、表单、上传下载、Cookie                  | 工具矩阵内，P1       |
| 文档和 Office 深度 | 缺少 PDF 版面/表格/扫描、Excel 单元格和公式、复杂 Word/PPT 编辑                         | 工具矩阵内，P1       |
| 系统高级控制       | 缺少 Wi-Fi、蓝牙、VPN、代理、打印机、显示/音频设备和录屏                                | 工具矩阵内，P1/P2    |
| 持久记忆工具 API   | 项目已有内部持久记忆，但没有 `memory.*` 工具供模型显式查询、写入、更新和删除            | 工具矩阵内，P1       |
| 调度与主动性       | 提醒只在当前进程内，缺少跨重启恢复、重复提醒、日程触发和免打扰                          | 工具矩阵加策略层，P2 |
| 高级文件能力       | 缺少文件监听、回收站枚举恢复、版本、检查点、加密归档和事务                              | 工具矩阵内，P2       |
| Provider 生态      | 只有 VS Code 和浏览器 DevTools 试点，缺少邮件、日历、IM、云盘、联系人和任意软件 API     | Provider 生态，P1    |
| 跨平台深度         | OCR、UI Automation、窗口、电源和归档等能力仍以 Windows 为主                             | 平台适配，P2         |

### 4.1 不属于工具矩阵的内容

以下能力不应继续塞进原子工具：

- 多步骤任务规划和 DAG；
- 条件分支、循环、并行、依赖和超时编排；
- 执行器选择，例如本地工具、GUI Agent、Codex；
- 多执行器队列和任务生命周期；
- 跨工具事务、重试、回滚和检查点策略；
- 哪些请求应该调用哪个工具或绑定；
- 一次性确认、时间窗授权和用户授权记忆。

这些属于 Router、Workflow、Executor 或 Policy 层。工具矩阵向上提供稳定能力，
但不负责决定完整任务如何执行。

## 5. 在项目中的定位

工具矩阵是 CYRVIS 的本地能力执行层和快速路径：

1. 位于 Voice/LLM 决策和 GUI Agent、Codex 等重型执行器之间；
2. 优先直接完成参数明确、风险可控、结果可验证的确定性操作；
3. 为 Qwen、Cascade、MCP、GUI Agent 和未来 Codex Executor 提供统一能力协议；
4. 负责能力发现、资源绑定、权限、风险、确认、执行和审计；
5. 不负责复杂意图路由、任务规划、执行器选择和多任务生命周期。

目标不是建立一个枚举所有软件所有子操作的巨大脚本库，而是建立一个：

```text
稳定、原子、可发现、可授权、可验证、可扩展
```

的桌面能力层。

## 6. 代码入口

| 文件                          | 职责                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `tools/matrix.ts`             | 组装 Context、Registry、Router、Catalog、Surface 和 Provider |
| `tools/types.ts`              | ToolDefinition、风险、权限、层级和 ToolContext               |
| `tools/registry.ts`           | 注册、准备、路径策略、确认、执行和审计                       |
| `tools/capability-catalog.ts` | 完整能力目录、可用性、权限、Tier 和优先级                    |
| `tools/tool-surface.ts`       | 动态选择最多 24 个模型可见工具                               |
| `tools/capability-broker.ts`  | 搜索、描述和调用隐藏能力                                     |
| `tools/provider-manager.ts`   | Provider 生命周期、健康检查和前台激活                        |
| `tools/provider-manifest.ts`  | manifest 校验、版本和签名验证                                |
| `context/dynamic-context.ts`  | 用户上下文、资源、绑定、相关性和刷新                         |
| `system/system-state.ts`      | 系统快照和周期刷新                                           |
| `system/tools.ts`             | 9 个动态系统工具                                             |

相关文档：

- [fast-tool-matrix.md](./fast-tool-matrix.md)
- [atomic-foundation-tools.md](./atomic-foundation-tools.md)
- [dynamic-tool-context.md](./dynamic-tool-context.md)
- [provider-manifests.md](./provider-manifests.md)
- [system-awareness.md](./system-awareness.md)

## 7. 维护规则

新增工具时至少同步完成：

1. 定义明确输入 schema、输出 data、风险、权限和确认规则；
2. 设置 `providerId / tier / activation / priority / tags / requirements`；
3. 路径参数接入 `pathArgs` 和 `PathPolicy`；
4. 高风险操作提供可独立验证的结果；
5. 在 `matrix.ts` 或 Provider 中注册；
6. 增加执行、权限、确认和失败路径测试；
7. 更新本文中工具数量、分类和能力缺口；
8. 不把复杂任务编排写入单个工具。
