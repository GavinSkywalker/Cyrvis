# 系统感知与任务交互

> 状态：2026-11-18 已实现基础版本。

## 1. 目标

CYRVIS 不应只依赖写死的应用别名和正则命令。它需要持续感知当前电脑中
可安全读取的系统状态，并从真实软件、硬件和运行状态中生成可用能力。

同时，GUI 任务不能只启动不反馈。任务开始、关键进度、用户确认、完成、
失败和取消都必须进入聊天和语音链路。

## 2. 总体结构

```text
Windows / macOS / Linux
  -> System Observer
       ├─ OS / CPU / memory / uptime
       ├─ disks / battery / network interfaces
       ├─ installed applications
       ├─ Steam libraries and games
       └─ running processes / visible windows
  -> SystemStateStore
       ├─ periodic refresh
       ├─ capability derivation
       ├─ application search / resolution
       └─ dynamic LLM context
  -> DynamicContextStore
       ├─ UserContextStore
       ├─ ResourceCatalog
       ├─ BindingResolver
       └─ RelevanceEngine
  -> ToolRegistry
       ├─ system.snapshot
       ├─ system.search_apps
       ├─ software.launch
       ├─ steam.list_games
       └─ ...
  -> Qwen / Cascade LLM
  -> Tool / GUI / Task Conversation Coordinator
  -> UI + TTS
```

## 3. 系统感知数据

### 3.1 当前采集

| 类别       | 内容                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| 操作系统   | 平台、版本、架构、主机名、运行时间                                          |
| 硬件       | CPU 型号/核心数、总内存/可用内存、磁盘容量                                  |
| 电源       | 电池百分比、充电状态、预计续航                                              |
| 网络       | 网卡名称、地址、family、是否内部接口                                        |
| 已安装应用 | Windows Start Apps、注册表卸载项、macOS Applications、Linux desktop entries |
| 最近文件   | Windows Recent 快捷方式的真实目标路径，过滤敏感文件名                       |
| Steam      | 安装目录、库目录、AppID、游戏名、安装目录、占用空间                         |
| 运行状态   | 进程、PID、标题、内存，可见窗口                                             |
| 动态能力   | software.launch、steam.launch、storage.status、power.status 等              |

Windows 默认启用常驻运行态观察器，每 500ms 检查进程、窗口和前台状态的语义
变化，并把变化直接写入 `SystemStateStore`。内存数值自身的波动不会触发刷新，
安装应用、Steam、磁盘、电池和服务仍保持低频全量扫描。

```env
CYRVIS_RUNTIME_MONITOR=1
CYRVIS_RUNTIME_MONITOR_INTERVAL_MS=500
```

启用统一运行时后，文件观察 Provider 默认监控桌面、下载、文档和当前工作区，
使用文件事件唤醒并在 2 秒周期内刷新直属文件元数据。文件内容和敏感路径不会
自动进入模型上下文。

不会采集密码、Token、Cookie、浏览器历史、键盘输入、聊天内容、私钥或
凭据文件。

### 3.2 刷新策略

| 数据                             | 默认策略                         |
| -------------------------------- | -------------------------------- |
| 前台窗口                         | Windows 原生前台事件，轮询兜底   |
| 进程/窗口                        | 常驻观察器 500ms，周期扫描兜底   |
| 已安装应用、Steam 库、磁盘、电池 | 启动全扫，每 10 分钟刷新         |
| 工具读取                         | 优先使用缓存；缓存过期时按需刷新 |

配置：

```env
CYRVIS_SYSTEM_RUNTIME_REFRESH_MS=30000
CYRVIS_SYSTEM_FULL_REFRESH_MS=600000
CYRVIS_FOREGROUND_REFRESH_MS=2000
CYRVIS_NATIVE_FOREGROUND_EVENTS=1
```

动态用户上下文、资源绑定和工具面排序见
[dynamic-tool-context.md](./dynamic-tool-context.md)。

## 4. 软件发现与启动

### 4.1 Windows

- `Get-StartApps`：获取 Windows 可启动的桌面/UWP 应用。
- 注册表 Uninstall 项：获取名称、版本、发行商、安装目录和图标可执行文件。
- 进程与窗口：确认应用是否已运行以及当前可见窗口。

启动优先级：

```text
Start Apps 启动目标
  -> 注册表可执行文件/安装目录
  -> Steam URI
  -> 明确失败，不猜测执行
```

### 4.2 Steam

```text
注册表 SteamPath
  -> steamapps/libraryfolders.vdf
  -> 所有库目录中的 appmanifest_*.acf
  -> AppID / 游戏名 / installdir / SizeOnDisk
  -> steam://rungameid/<AppID>
```

只读取公开安装元数据，不读取账号、好友、聊天或令牌。

## 5. 动态能力与工具

系统不直接为每个已安装软件生成一个永久函数。这样会导致几百个工具、
上下文爆炸和授权难以管理。当前采用：

> 稳定工具 + 动态资源库 + 动态能力描述

例如：

```text
稳定工具:
  system.search_apps
  software.launch
  steam.list_games
  steam.launch_game

动态数据:
  Steam
  Visual Studio Code
  Dota 2
  Stellaris
```

模型先搜索或读取当前系统快照，再调用稳定工具操作真实软件。

新增系统工具：

| 工具                      | 能力                            |
| ------------------------- | ------------------------------- |
| `system.snapshot`         | 完整非敏感系统快照              |
| `system.capabilities`     | 当前动态能力列表                |
| `system.search_apps`      | 模糊搜索已安装应用和 Steam 游戏 |
| `system.list_services`    | 查询非敏感系统服务状态          |
| `software.list_installed` | 列出或过滤应用                  |
| `software.launch`         | 启动发现的应用                  |
| `system.refresh`          | 强制刷新系统状态                |
| `steam.list_games`        | 查询 Steam 游戏                 |
| `steam.launch_game`       | 启动 Steam 游戏                 |

系统工具始终通过 Registry 校验，模型不能直接执行任意扫描脚本。

## 6. LLM 上下文

系统状态会转换成紧凑文本注入模型上下文：

- 系统与硬件摘要；
- 磁盘和电源状态；
- 前 80 个已发现应用；
- Steam 游戏名和 AppID；
- 当前可见窗口；
- 可用动态能力。

完整应用清单不直接塞进每轮提示词，模型通过 `system.search_apps` 按需查询。
这允许扩大 Token 使用量，同时避免无边界上下文增长。

## 7. 任务交互

任务由 `TaskConversationCoordinator` 统一处理，不再依赖模型是否顺手回复。

| 事件       | 交互                                         |
| ---------- | -------------------------------------------- |
| 任务开始   | 700ms 内没有模型回复时，自动确认“任务已开始” |
| 关键步骤   | 至少间隔 10 秒播报一次进度                   |
| 任务停滞   | 20 秒冷却后说明仍在处理                      |
| 需要用户   | 立即播报问题                                 |
| 暂停/继续  | 播报状态变化                                 |
| 完成       | 必须播报完成摘要                             |
| 失败       | 必须播报失败原因                             |
| 取消       | 必须播报已取消                               |
| 用户查进度 | 确定性返回当前步骤和最后摘要                 |

模型已经产生回复时，开始确认定时器会被取消，避免双重播报。

编码、工作流和云端 PPT 等长程任务同样必须主动播报关键进度。桌宠窗口会同步
显示活动任务栈，包括任务名称、状态和最近动作；打开设置页时桌宠保持可见。

## 8. 验证

2026-11-18 真机扫描结果：

- 已发现 323 个应用入口；
- 4 个去重后的 Steam 游戏；
- 334 个 Windows 服务；
- 369 个运行进程；
- 8 个可见窗口；
- 动态能力包括软件启动、Steam、电源、存储、网络、进程和窗口。

自动验证：

- CYRVIS 主进程测试：106 passed，5 skipped；
- Node/Web 类型检查通过；
- 生产构建通过。
