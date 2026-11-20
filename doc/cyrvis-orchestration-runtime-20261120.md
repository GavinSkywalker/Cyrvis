# CYRVIS 统一感知、意图与执行控制面

> 实现日期：2026-11-20
>
> 目标：在现有系统感知、动态上下文、工具矩阵、工作流、GUI 和编码 Agent 之上建立统一控制面。

## 1. 总体结构

```text
系统事件 / 周期扫描 / 文件观察 / 浏览器 Provider
                         ↓
                     WorldState
                         ↑
眼动 / 语音 / 操作历史 / 偏好 / 当前任务
                         ↓
                  IntentFusionStore
                         ↓
                  OrchestrationRuntime
             /             |              \
      TaskScheduler   CapabilitySynthesis  AutonomyEngine
             ↓
 Atomic / Workflow / GUI / Coding / Observe Executors
             ↓
        ToolRegistry + Provider + Verification
```

三个主要功能区：

- 感知区：`SystemStateStore`、运行态监视器、文件观察 Provider、动态上下文、用户意图融合。
- 意图与调度区：统一 `RuntimeTask`、优先级队列、资源锁、自主建议、能力提案。
- 执行区：原子工具、本地工作流、GUI Controller、Coding Agent。

两个横向层：

- 状态与记忆：统一世界快照、运行记忆、TTL、敏感信息过滤。
- 能力与权限：`CapabilityCatalog`、Provider、路径与风险策略、运行能力审批。

### V2 可靠性执行层

- 每个任务包含执行契约：副作用等级、幂等性、可重试性、最大尝试次数、
  超时、恢复策略和验证要求。
- 同一 `idempotencyKey` 的未完成或近期任务只保留一份。
- 执行器可以持续写入 `checkpoint`；应用中断后任务进入暂停，用户可以从持久的
  工作流/任务检查点恢复。
- 执行完成后可进行独立验证。文件工具已经验证目标存在、目标缺失、源目标迁移
  等后置条件；验证失败不会被报告为成功。
- 队列分为 `interactive`、`normal`、`background` 三道，分别设置并发上限。
- 资源锁区分共享读和独占写；两个读任务可以并行，写任务会与同资源读写互斥。
- 失败任务支持手动重试；重试复用原任务和检查点，不创建重复任务或副作用。

## 2. 统一世界状态

`WorldStateStore` 将以下数据合成为统一快照：

- 操作系统、进程、窗口、前台应用和运行态新鲜度。
- 动态应用、窗口、文件、标签页和资源绑定。
- 当前用户活动、候选意图、焦点和眼动目标。
- 任务队列、资源锁和任务状态。
- 自主建议、长期目标和打扰预算。
- 能力目录和运行时能力提案。
- 运行记忆版本和健康状态。

`world.snapshot` 和 `world.context` 提供结构化快照和模型上下文。

## 3. 感知循环

### 系统感知

- Windows 常驻进程/窗口观察器默认每 500ms 检查语义变化。
- 前台窗口原生事件立即更新状态。
- 文件观察 Provider 默认监控桌面、下载、文档和当前工作目录。
- 文件观察使用 `fs.watch` 唤醒，按 2 秒节流生成有界资源列表。
- 浏览器标签页继续使用 DevTools Provider。
- 焦点控件、选中文本、OCR、截图和 UI Automation 保持按需读取。

文件监听、剪贴板和敏感路径属于隐私边界，不把文件内容或剪贴板内容默认写入模型上下文。

### 用户感知

意图融合输入：

- 当前应用和窗口。
- 焦点控件和选中文本。
- 最近用户语音和近期用户回合。
- 当前 GUI、编码、workflow 和 Scheduler 任务。
- 最近眼动对象。
- 最近工具动作和执行结果。
- 合并后的用户活动片段和接受、拒绝反馈。

输出：

- 活动类型和置信度。
- 当前对象和候选意图。
- 证据来源。
- 短暂工作记忆。
- 持久化活动时间线，用于区分编码、比较、阅读、等待结果等连续状态。

眼动和推断活动只用于消歧，不单独授权执行。

## 4. 运行记忆

`RuntimeMemoryStore` 保存有界情景记忆：

- 用户请求和助手最终回复。
- 任务生命周期和工具结果摘要。
- 自主建议、接受和拒绝反馈。
- 长期目标。
- 运行时能力变化。

7 天默认 TTL，最多 1000 条。API Key、密码、Token 和明显凭据不会写入。每 5 分钟执行一次去重和清理。

记忆按 `working`、`episodic`、`semantic` 分层，并结合词面相关性、时近性、
显著度和层级检索，而不是把全部历史直接塞入提示词。

### 事件轨迹与无副作用回放

`RuntimeTraceStore` 记录系统、上下文、感知、意图、任务、工具、自主、能力和
记忆事件，并持久化到 `trace.json`。

`trace.list` 读取最近轨迹；`trace.replay` 只做无副作用回放，检查“终态缺少
started”“任务缺少终态”等生命周期缺口。敏感摘要和数据会先过滤。

## 5. 统一任务模型

任务包含：

```ts
interface RuntimeTask {
  id: string;
  source: 'user-voice' | 'user-text' | 'schedule' | 'autonomy' | 'system';
  kind: 'atomic' | 'workflow' | 'gui' | 'coding' | 'observe';
  goal: string;
  priorityClass:
    | 'stop'
    | 'user-now'
    | 'continuation'
    | 'scheduled'
    | 'autonomy';
  lane: 'interactive' | 'normal' | 'background';
  idempotencyKey: string | null;
  contract: Required<ToolExecutionContract>;
  checkpoint: TaskCheckpoint | null;
  verification: TaskVerificationSnapshot;
  preemptible: boolean;
  risk: 'low' | 'medium' | 'high';
  resources: string[];
  dependsOn: string[];
  status:
    | 'queued'
    | 'running'
    | 'waiting_confirmation'
    | 'paused'
    | 'cancelling'
    | 'done'
    | 'failed'
    | 'cancelled';
  result: string | null;
  data: unknown | null;
  error: string | null;
}
```

调度优先级：

1. 停止和安全控制。
2. 用户当前直接命令。
3. 当前任务确认和继续。
4. 用户计划任务。
5. 自主任务。

资源锁使用 `read:` / `write:` 模式，并细化到实际资源：

- `desktop.gui`
- `file:{path}`
- `coding.workspace:{path}`
- `network`
- `clipboard`
- `perception.local`

暂停任务时释放资源锁，恢复时重新申请。用户直接任务可以抢占可暂停的自主任务。

### 计划编译

`TaskPlanner` 将复杂目标编译为有向无环任务图，校验重复 key、未知工具、未知依赖
和循环依赖。`task.plan` 默认只预览计划，只有显式 `execute=true` 才按拓扑顺序
提交到 Scheduler。

## 6. 执行器

### AtomicTaskExecutor

调用 `ToolRegistry`。需要确认的工具会暂停任务，确认后继续。

原有 `FastToolRouter` 的确定性快速工具、Provider 调用和 `capability.invoke`
现在也会进入 Scheduler；确认、取消和结果数据仍保持原接口语义。低延迟工具不再绕过
统一资源锁、优先级和审计记录。

### WorkflowTaskExecutor

调用 `LocalWorkflowEngine`，把工作流等待确认、完成、失败和取消映射到统一任务生命周期。

### GUITaskExecutor

调用原 `CyrvisController`。语音侧使用 `ScheduledTaskController` 兼容原有 Controller 接口，因此原有语音 GUI 入口现在先进入 Scheduler。

### CodingTaskExecutor

调用原 `CodingAgentService`。语音侧使用 `ScheduledCodingAgent`，编码任务同样进入统一队列。

### ObserveTaskExecutor

执行只读观察工具，默认使用独立感知资源锁。

## 7. 自主意图

自主意图模式：

- `off`：停止自主建议。
- `suggest`：只生成建议。
- `low-risk`：低风险建议可以自动进入队列。

当前规则来源：

- 用户配置的长期目标到期。
- 任务失败后的诊断建议。
- 当前活动与眼动目标稳定且没有用户任务。
- 前台窗口标题出现错误、失败或无响应。

约束：

- 每小时最多提案数量可配置。
- 提案 5 分钟后过期。
- 同目标 10 分钟内去重。
- 用户可以直接接受、拒绝或关闭自主模式。
- 自主任务优先级低于所有用户任务。
- 高风险动作仍需执行时确认。
- 新建议会广播到“运行”面板；用户任务或编码任务未占用交互时主动语音提示。
- 新能力提案同样进入面板，并在空闲时提示用户审核。

## 8. 运行时能力合成

当任务失败或用户明确提出能力缺口时，可以调用能力合成：

```text
失败/缺口
-> CapabilitySynthesisAgent
-> 只使用现有工具生成 WorkflowTemplate
-> 结构和工具存在性校验
-> 风险重新计算
-> 用户批准
-> 注册为 synthesized.workflow.*
```

当前只允许生成声明式工作流，不允许生成并热加载任意代码。批准的能力重新启动后自动恢复注册。

能力提案还支持：

- `resource-binding`：把资源种类绑定到已有能力和工具。
- `provider-manifest`：接入 MCP/API Provider。批准后只注册为
  `untrusted + disabled + unknown`，必须显式启用并通过健康检查。

`capability.route` 根据语义匹配、可用性、历史成功率、延迟、成本和风险生成
可解释候选路由，并优先本地执行，其次远端能力，最后 GUI。

## 9. 控制面接口

新增工具：

- `task.submit/list/status/pause/resume/cancel/confirm`
- `autonomy.status/configure/accept/reject/goal.add/goal.remove`
- `task.plan/retry/trace.*`
- `capability.route/synthesize/proposals/propose-provider/propose-binding/approve/reject`
- `world.snapshot/context`

基础工具矩阵为 89 个，控制面新增 25 个运行时工具，完整运行态基线为 114 个。
模型可见工具仍限制在动态工具面预算内，深层能力通过搜索和按需激活进入。

主界面新增“运行”面板：

- 系统与用户活动。
- 任务队列和资源锁状态。
- 任务暂停、继续、取消、确认和失败重试。
- 任务车道、检查点、验证状态和读/写资源锁。
- 用户活动片段、感知 Provider 健康状态和最近运行轨迹。
- 自主建议接受和拒绝。
- 能力提案批准和拒绝。
- 自主模式切换。
- 临时运行记忆清理。

桌面宽度下运行面板与眼动面板并排显示；窄窗口下二者自动互斥，避免遮挡和误点。

## 10. 当前边界

- 进程和窗口仍使用常驻观察器，不是完整 ETW/WinEvent 事件流。
- 文件 Provider 只读取受控目录的直属文件，不递归索引全部文件内容。
- 剪贴板默认只持续记录长度、变化哈希和状态；内容进入上下文必须显式开启，
  敏感内容仍会过滤。
- Windows 焦点控件和选中文本使用低频 UIAutomation Provider，尚未替换为原生
  WinEvent/UIA 事件订阅。
- 自主活动分类仍是规则与时间片模型，尚未训练为个性化分类器。
- 自主建议规则和评估指标仍较保守，尚未形成可回放的行为评估集。
- 工作流运行时通过中央 Scheduler 启动，但底层 WorkflowEngine 仍保留直接入口供测试和内部调用。
- TaskPlanner 已支持 DAG 编译、预览和提交，但还没有独立的图形化计划编辑器。
- 能力合成依赖会话模型 API；未配置时不会生成提案。
- 生成的运行时能力以声明式工作流模板为主；Provider manifest 和资源绑定通过
  明确工具提案，不从自然语言自动安装。
- 当前 Provider 覆盖进程、窗口、文件、浏览器、剪贴板元数据、焦点和选中文本；
  服务、电源和网络仍以周期快照为主。
- “感知用户可以直接感知的一切”不能作为无边界承诺；第三方应用必须通过 Provider、辅助功能接口或显式授权接入。
- 真实摄像头、麦克风、扬声器、第三方应用和远端模型仍需现场验收。
