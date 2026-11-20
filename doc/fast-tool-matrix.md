# CYRVIS 前方快速工具矩阵

> 状态：2026-11-18 已实现。
>
> 定位：在复杂 Router、GUI Agent 和 Codex 之前，拦截参数明确、风险可控、
> 可通过本地系统直接完成的简单指令，目标是把高频操作从秒级代理流程降到
> 百毫秒级本地执行。

## 1. 设计目标

1. 简单指令优先于大模型工具调用和 GUI Agent。
2. 本地直接执行，MCP 只作为同一能力矩阵的协议出口。
3. 语音命中后立即取消当前模型响应，避免 GUI 与本地工具重复执行。
4. 文件、应用、窗口、剪贴板、系统、进程和网页操作使用统一协议。
5. 用户明确提出的打开、关闭、复制、写入、覆盖、删除和系统操作都直接执行；
   只有目标确实缺少必要参数时才追问。
6. 当前 Router 只负责确定性语法，不替代后方复杂语义 Router。
7. 全量能力目录始终可感知，但模型只接收有限、分层、随系统状态更新的工具面。

## 2. 总体结构

```text
ASR final transcript
  -> VoiceBrain
  -> 入口 1：FastToolRouter 确定性快速通道
       -> 命中后取消当前模型响应
       -> FastToolRouter.match
       -> ToolRegistry.prepare / execute
       -> ToolResult.speech -> provider.speak

  -> 入口 2：Qwen / Cascade LLM 工具选择
       -> 模型看到 10 个语音工具 + 最多 24 个动态 cyrvis_* 本地工具
       -> 模型返回 function call + JSON 参数
       -> VoiceBrain 解析回本地工具名
       -> ToolRegistry.prepare / execute
       -> tool result 回传模型
       -> 模型生成简短语音回答

  -> 动态能力层
       -> CapabilityCatalog：全量能力、可用性、风险、层级
       -> ToolSurface：按状态计算模型可见工具
       -> CapabilityBroker：搜索、描述、调用隐藏能力

同一 ToolRegistry
  -> FastTool MCP Server
  -> ListTools / CallTool
```

关键文件：

| 文件                                         | 职责                                     |
| -------------------------------------------- | ---------------------------------------- |
| `main/cyrvis/tools/router.ts`                | 确定性语音指令解析与直接执行             |
| `main/cyrvis/tools/registry.ts`              | 工具注册、准备、政策检查、执行           |
| `main/cyrvis/tools/path-policy.ts`           | 路径归一化、根目录与敏感路径策略         |
| `main/cyrvis/tools/filesystem.ts`            | 文件与目录工具                           |
| `main/cyrvis/tools/desktop-tools.ts`         | 应用、窗口、剪贴板、系统、进程、网页工具 |
| `main/cyrvis/tools/desktop-host.ts`          | Windows/Unix 系统调用适配器              |
| `main/cyrvis/tools/matrix.ts`                | 统一组装 context、registry、router       |
| `main/cyrvis/tools/mcp-server.ts`            | 同源 MCP Server facade                   |
| `main/cyrvis/tools/llm-tools.ts`             | 本地工具到 Qwen function schema 的映射   |
| `main/cyrvis/tools/capability-catalog.ts`    | 全量能力、状态可用性、健康度             |
| `main/cyrvis/tools/tool-surface.ts`          | 分层暴露、工具数量预算、按需激活         |
| `main/cyrvis/tools/capability-broker.ts`     | 深层能力搜索、描述和受控自调用           |
| `main/cyrvis/tools/capability-tools.ts`      | `capability.*` 稳定元工具                |
| `main/cyrvis/tools/provider-manager.ts`      | manifest Provider 生命周期和健康检查     |
| `main/cyrvis/tools/provider-manifest.ts`     | manifest 校验、版本和签名验证            |
| `main/cyrvis/tools/external-mcp-provider.ts` | 隔离 MCP Provider 工具适配               |
| `main/cyrvis/tools/tool-usage.ts`            | 调用统计、近期排序和 JSONL 审计          |
| `main/cyrvis/voice-brain.ts`                 | 最终转写短路、响应取消和 GUI 防重复调用  |
| `main/cyrvis/voice-service.ts`               | 启动时创建工具矩阵并注入 VoiceBrain      |

## 3. 路由执行逻辑

语音到本地工具有两条入口。

### 3.1 确定性快速入口

`VoiceBrain` 在最终转写后调用 `FastToolRouter.canHandle(text)`。这一步是同步
的确定性语法判断，不请求云端模型。

支持中文和常用英文命令词，支持去掉“请、帮我、麻烦、CYRVIS”等前缀。
路径包含空格时建议加引号：

```text
创建文件 "D:\work\my note.txt" 内容 "hello world"
```

### 3.2 LLM 工具选择入口

Qwen Omni 和 Cascade 文本 LLM 会收到当前 ToolSurface 中的分层工具定义。
完整能力仍保存在 CapabilityCatalog。工具名转换为 Qwen/OpenAI 可接受的函数名：

```text
window.minimize_all -> cyrvis_window_minimize_all
fs.create_file      -> cyrvis_fs_create_file
app.launch          -> cyrvis_app_launch
```

模型只负责选择工具和生成参数，不能绕过本地执行政策。`VoiceBrain` 将
`cyrvis_*` 调用映射回 Registry，执行后再把结构化结果返回模型。

`start_gui_task` 已降级为复杂任务兜底：本地工具可用时必须优先本地工具；
只有需要视觉检查、现有 UI 点击、登录、弹窗、拖拽或多步骤 GUI 时才进入 GUI。

### 3.3 防重复执行

命中后 `VoiceBrain` 立即：

1. 设置 8 秒快速工具保护窗；
2. 调用当前 Provider 的 `cancelResponse()`；
3. 异步执行工具；
4. 如果语音模型随后仍调用 `start_gui_task`，直接返回
   `ALREADY_HANDLED_BY_FAST_TOOL`，不会启动 GUI Agent。

工具完成后通过现有 TTS 链路播报结果，保护窗缩短为 3 秒。

### 3.4 参数准备与政策检查

Router 只解析出候选工具和参数。真正执行前必须经过：

1. `ToolDefinition.prepare`：类型校验、默认值、路径绝对化；
2. `PathPolicy.inspect`：路径规范化、symlink 收敛、根目录判断；
3. `ToolRegistry.execute`：用户明确指令即授权，直接执行并标准化结果。

### 3.5 直接执行策略

工具注册表不再把高风险、敏感路径、删除、覆盖、进程或电源操作转换成待确认状态。
用户明确发出的操作请求会直接执行。

```text
用户：删除文件 D:\work\a.txt
CYRVIS：已将 a.txt 移到回收站。
```

旧版本遗留的等待确认工作流会在加载时迁移为待执行状态；新产生的工具调用不会
再进入 `waiting_confirmation`。如果缺少文件名、目标行号、路径或操作对象等必要
参数，系统仍会追问这些参数，但不会在参数齐全后再次询问“是否执行”。

### 3.6 动态能力和分层暴露

工具注册分为“全量目录”和“模型工具面”两层：

```text
CapabilityCatalog（全量）
  -> 识别所有已注册工具
  -> 保留隐藏、状态门控、降级和不可用能力

ToolSurface（模型可见）
  -> Tier 0：capability.search / describe / invoke，始终可见
  -> Tier 1：文件、应用、窗口、剪贴板和高频系统工具
  -> Tier 2：按系统状态出现的 Steam、Office 等能力
  -> Tier 3/4：深层编辑和破坏性能力，默认隐藏
```

`SystemStateStore` 更新后，CapabilityCatalog 重新计算可用性。只有可见工具
集合或能力状态发生变化时，才刷新 Qwen/Cascade 工具表，避免进程和窗口的
每次变化都触发无意义的 `session.update`。

当前模型工具面默认最多 24 个。模型看不到深层工具时，可以先调用：

```text
capability.search("steam")
capability.describe("steam.launch_game")
capability.invoke("steam.launch_game", {"query":"Dota 2"})
```

`capability.invoke` 不是绕过安全策略的后门。目标工具仍经过参数准备、路径和
风险检查；用户明确请求后 Broker 直接执行目标工具，不再进入确认状态。

## 4. 工具能力矩阵

当前基础矩阵注册约 90 个工具，其中 9 个工具读取动态系统快照和软件能力，
另有 6 个工作流工具、1 个多模态意图工具和能力路由工具。启用统一运行时后
还会注册计划、任务、自主意图、能力生命周期、轨迹和世界状态工具，
总计约 113 个。
默认只向语言模型暴露最多 24 个，完整能力仍可通过 CapabilityCatalog 和
`capability.*` 元工具访问。

### 4.1 文件系统

| 工具                  | 能力                           | 风险 | 执行策略      |
| --------------------- | ------------------------------ | ---- | ------------- |
| `fs.list_directory`   | 列出目录直属内容               | 低   | 直接执行      |
| `fs.directory_tree`   | 生成有界目录树                 | 低   | 直接执行      |
| `fs.get_info`         | 查看文件/目录类型、大小、时间  | 低   | 直接执行      |
| `fs.read_file`        | 读取 UTF-8 文本，最大 256 KB   | 低   | 直接执行      |
| `fs.create_file`      | 创建文本文件，覆盖前自动备份   | 低   | 直接执行      |
| `fs.write_file`       | 覆盖写入文本文件，自动备份     | 中   | 直接执行      |
| `fs.append_file`      | 追加文本                       | 中   | 直接执行      |
| `fs.replace_text`     | 精确替换文件内文本             | 中   | 直接执行      |
| `fs.delete_lines`     | 按行号、范围或文本匹配删除行   | 中   | 直接执行+备份 |
| `fs.create_directory` | 递归创建文件夹                 | 低   | 直接执行      |
| `fs.copy`             | 复制文件或目录                 | 中   | 直接执行      |
| `fs.move`             | 移动文件或目录，支持跨卷回退   | 中   | 直接执行      |
| `fs.rename`           | 同目录重命名                   | 中   | 直接执行      |
| `fs.delete_to_trash`  | 删除到回收站                   | 高   | 直接执行      |
| `fs.search`           | 按文件名或文本内容搜索         | 低   | 直接执行      |
| `fs.open_random`      | 从目录随机打开指定扩展名文件   | 低   | 直接执行      |
| `fs.open`             | 使用系统默认程序打开文件或目录 | 低   | 直接执行      |

语音示例：

```text
在 D:\work 创建文件 todo.txt 内容 今天先完成工具矩阵
读取文件 D:\work\todo.txt
把文件 D:\work\todo.txt 中的 今天 替换为 本周
查看 D:\work 下有什么
搜索文件 D:\work 中的 todo
复制 D:\work\todo.txt 到 D:\backup\todo.txt
移动 D:\backup\todo.txt 到 D:\archive\todo.txt
重命名 D:\archive\todo.txt 为 todo-2026.txt
删除文件 D:\archive\todo-2026.txt
打开文件 D:\work\report.pdf
```

### 4.2 应用与窗口

| 工具                  | 能力                   | 风险 | 确认 |
| --------------------- | ---------------------- | ---- | ---- |
| `app.launch`          | 打开受支持的应用别名   | 中   | 否   |
| `app.list`            | 列出运行进程与可见标题 | 低   | 否   |
| `app.close`           | 按别名或进程名关闭应用 | 高   | 否   |
| `browser.close_page`  | 按标签标题直接关闭网页 | 中   | 否   |
| `window.list`         | 列出可见顶层窗口       | 低   | 否   |
| `window.focus`        | 聚焦匹配窗口           | 中   | 否   |
| `window.close`        | 按文件名/标题关闭窗口  | 中   | 否   |
| `window.minimize_all` | 最小化全部桌面窗口     | 中   | 否   |
| `window.restore_all`  | 恢复全部桌面窗口       | 中   | 否   |
| `window.minimize`     | 最小化匹配窗口         | 中   | 否   |
| `window.maximize`     | 最大化匹配窗口         | 中   | 否   |

内置应用别名包括记事本、计算器、画图、资源管理器、终端、PowerShell、
VS Code、Chrome、Edge、Word、Excel、PowerPoint、VLC 和微信。

语音示例：

```text
打开记事本
启动 Chrome
切换到窗口 demo.txt
最小化窗口 Visual Studio Code
把所有桌面窗口最小化
恢复所有窗口
关闭应用记事本
```

### 4.3 剪贴板

| 工具              | 能力             | 风险 |
| ----------------- | ---------------- | ---- |
| `clipboard.read`  | 读取纯文本剪贴板 | 中   |
| `clipboard.write` | 覆盖剪贴板纯文本 | 中   |

语音示例：

```text
读取剪贴板
把 hello CYRVIS 写入剪贴板
```

### 4.4 系统、进程与网络

| 工具           | 能力                            | 风险 |
| -------------- | ------------------------------- | ---- |
| `system.info`  | 操作系统、CPU、内存、运行时间   | 低   |
| `system.disk`  | 指定路径所在磁盘容量            | 低   |
| `process.list` | 按内存占用列出进程              | 低   |
| `web.open_url` | 用默认浏览器打开 HTTP/HTTPS URL | 中   |
| `web.search`   | 用默认浏览器打开 Bing 搜索      | 中   |

语音示例：

```text
查看系统信息
磁盘空间 D:\
列出进程
打开网址 https://example.com
搜索网页 MCP TypeScript SDK
```

### 4.5 Office

| 工具                         | 能力                                                  | 风险 | 确认 |
| ---------------------------- | ----------------------------------------------------- | ---- | ---- |
| `office.create_presentation` | 复杂需求优先云端 `qwen-doc-turbo`，基础需求可本机降级 | 中   | 否   |

语音示例：

```text
在桌面创建一个关于人工智能的 PPT
在桌面创建演示文稿 内容主题是季度总结
```

复杂演示文稿不会静默降级为本机单页 PowerPoint。云端失败时会返回具体错误；
基础演示文稿才允许尝试本机 PowerPoint。已有目标文件会先备份。

### 4.6 动态系统感知与软件

| 工具                      | 能力                                       |
| ------------------------- | ------------------------------------------ |
| `system.snapshot`         | 读取系统、硬件、磁盘、进程、窗口和应用快照 |
| `system.capabilities`     | 读取当前动态能力                           |
| `system.search_apps`      | 搜索真实已安装应用和 Steam 游戏            |
| `system.list_services`    | 查询系统服务状态                           |
| `software.list_installed` | 列出或过滤已安装软件                       |
| `software.launch`         | 启动动态发现的应用                         |
| `system.refresh`          | 强制刷新系统感知                           |
| `steam.list_games`        | 查询 Steam 库                              |
| `steam.launch_game`       | 启动 Steam 游戏                            |

### 4.7 工作流与意图

| 工具              | 能力                                           |
| ----------------- | ---------------------------------------------- |
| `workflow.start`  | 启动最多 32 步的本地依赖工作流                 |
| `workflow.status` | 查询状态和当前步骤                             |
| `workflow.list`   | 列出活动或历史工作流                           |
| `workflow.cancel` | 取消工作流                                     |
| `workflow.resume` | 恢复暂停或应用重启时中断的工作流               |
| `context.intent`  | 融合系统状态、语音历史、任务和眼动得到候选意图 |

## 5. 安全边界

### 5.1 默认允许根目录

- 用户主目录；
- 当前工作目录；
- 识别到的项目根目录；
- 系统临时目录；
- `CYRVIS_FAST_TOOL_ROOTS` 中配置的额外根目录。

`桌面`、`下载`、`文档`、`图片`、`音乐`、`视频`以及对应英文名称会自动
映射到当前用户的已知文件夹。

多个根目录使用分号分隔：

```env
CYRVIS_FAST_TOOL_ROOTS=D:\work;E:\assets
```

### 5.2 路径与高风险操作

- 用户明确给出的工作区外路径、敏感目录和敏感文件不再二次询问。
- 删除、结束进程、关机、重启等操作按用户明确指令直接执行。
- 覆盖写入和按行删除会先创建 `.cyrvis-backup-*` 备份。

关闭应用、窗口和网页同样按用户明确指令直接执行。

### 5.3 当前明确不允许

- 任意 shell 字符串执行；
- 任意进程强制结束 API；
- 永久删除；
- 无大小限制的文本读取；
- 在 Router 未命中时猜测工具。

`direct-tool` 当前只处理确定性命令。其他自然语言继续走现有 VoiceBrain、
GUI 或后续复杂 Router。

## 6. MCP 复用

### 语音导航入口（2026-11-19）

语音模型保留功能较完整的 `search_web`、`open_url`、`open_app`、`open_site`。
`voice/tool-surface.ts` 在初次连接和动态刷新时过滤重复的
`cyrvis_web_search`、`cyrvis_web_open_url`、`cyrvis_app_launch`；这些底层能力
仍存在于 Registry/MCP 中。旧动态名字和 broker 间接调用在 VoiceBrain 中按
实际目标进行意图检查，再转到同一个语义入口。

语义入口负责站点别名、站内搜索、静默打开和 `task_instruction`；执行通过
`FastToolRouter.executeNavigationTool` → capability broker → Registry，应用
目标路径经过统一的路径解析。`web.search` 支持 `engine` / `site`，`app.launch`
支持 `target`。LocalDesktopHost 复用已有浏览器前台化和已知应用启动实现。

确定性命令执行后，旧语音入口也受防重复保护；同回合相同导航调用在执行前
去重。新用户回合清除导航去重状态。关闭 `CYRVIS_FAST_TOOLS` 时，语义入口仍
保留原有直接执行回退。

`createFastToolMcpServer(registry)` 使用与语音 Router 完全相同的 Registry，
通过 MCP `tools/list` 和 `tools/call` 暴露能力，避免两套工具定义漂移。

本地语音路径不经过 MCP 传输，原因如下：

- 避免 stdio/HTTP 序列化往返；
- 避免每次请求启动子进程；
- 保持直接文件和应用操作的低延迟；
- MCP 仍可用于其他 Agent、测试工具和后续远程接入。

MCP 与语音路径使用同一套直接执行策略。旧客户端即使传入 `__confirmed`，该字段
也只会被清理，不再决定是否执行。工具参数齐全时直接执行，缺少必要参数时返回
具体的参数错误。

## 7. 配置与关闭

```env
# 完全关闭前方工具矩阵，回退到原 VoiceBrain 路由
CYRVIS_FAST_TOOLS=0

# 增加允许直接操作的工作根目录
CYRVIS_FAST_TOOL_ROOTS=D:\work;E:\assets
```

默认开启。

## 8. 扩展新工具

新增工具需要同时完成：

1. 在 `types.ts` 的 `ToolDomain` 中确定领域，必要时扩展。
2. 新建或复用 Host 方法，避免工具直接拼接 shell 字符串。
3. 定义 `ToolDefinition`：名称、风险、JSON Schema、prepare、execute。
4. 可选填写 `capability.providerId/tier/activation/priority/tags`，否则使用
   CapabilityCatalog 的默认分类。
5. 为路径参数实现 `pathArgs`，接入统一路径政策。
6. 为破坏性操作实现 `requiresConfirmation`。
7. 在 `matrix.ts` 或动态 Provider 中注册工具。
8. 只为稳定高频命令在 `FastToolRouter` 增加确定性语法；深层工具通过
   CapabilityBroker 按需调用，不需要继续堆叠正则。
9. 增加 Router、执行、确认、状态变化、工具面刷新和 MCP 测试。
10. 更新本文能力表。

工具结果统一返回：

```ts
interface ToolResult {
  ok: boolean;
  tool: string;
  speech: string;
  data?: unknown;
  error?: { code: string; message: string };
}
```

`speech` 必须是适合直接朗读的短句；大列表和结构化结果放在 `data`。

## 9. 验证

```bash
cd apps/ui-tars
npx vitest run src/main/cyrvis
npx vitest run src/main/cyrvis/tools/fast-tool-router.test.ts
npx tsc --noEmit -p tsconfig.node.json --pretty false --composite false
```

2026-11-18 当前验证结果：

- CYRVIS 主进程测试：128 passed，5 skipped；
- 动态能力矩阵：4 passed；
- Provider/manifest/MCP 生命周期：6 passed；
- 快速工具矩阵：14 passed；
- VoiceBrain 本地工具执行：11 passed；
- Qwen/Cascade 动态工具面刷新测试通过；
- MCP `tools/list` 与 `tools/call` 在内存传输测试通过。

## 10. 已知限制

1. 桌面应用控制和窗口控制在 Windows 上最完整。
2. 应用启动采用受控别名，不会执行任意用户命令。
3. 文本读取上限 256 KB，搜索扫描上限 8,000 项、100 个结果。
4. 确定性模板只负责低延迟快速通道；未命中时由 LLM 工具选择补足语义变化。
5. 路径有空格时建议使用引号，否则语音转写本身可能产生歧义。
6. Web 搜索当前只负责打开浏览器，不抓取网页内容。
7. 外部 API 工具尚未接入；可通过内置 Host、Provider manifest 或 MCP 扩展。
8. Provider manifest、Ed25519/RSA 签名、stdio/HTTP/SSE MCP Provider、
   健康检查和热重载已经接入；完整协议见 `doc/provider-manifests.md`。
9. 工具使用统计会持久化并参与动态排序，但不会突破权限、Tier 或工具数量预算。
