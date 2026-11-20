import type {
  ToolDefinition,
  ToolExecutionContract,
  ToolResult,
} from '../tools/types';
import type {
  AutonomyMode,
  RuntimeTaskKind,
  RuntimeTaskPayload,
  RuntimeTaskSubmitInput,
  TaskPriorityClass,
  TaskSourceKind,
  TaskLane,
} from './types';
import type { PlannedTaskNode } from './task-planner';
import type { OrchestrationRuntime } from './runtime';

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  error: unknown,
  code = 'ORCHESTRATION_TOOL_FAILED',
): ToolResult => ({
  ok: false,
  tool,
  speech: error instanceof Error ? error.message : String(error),
  error: {
    code,
    message: error instanceof Error ? error.message : String(error),
  },
});

const text = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === 'string' ? input[key].trim() : '';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];

const taskKind = (value: unknown): RuntimeTaskKind => {
  const kind = text({ value }, 'value');
  if (['atomic', 'workflow', 'gui', 'coding', 'observe'].includes(kind)) {
    return kind as RuntimeTaskKind;
  }
  return 'atomic';
};

const sourceKind = (value: unknown): TaskSourceKind => {
  const source = text({ value }, 'value');
  if (
    ['user-voice', 'user-text', 'schedule', 'autonomy', 'system'].includes(
      source,
    )
  ) {
    return source as TaskSourceKind;
  }
  return 'user-text';
};

const priorityClass = (value: unknown): TaskPriorityClass => {
  const priority = text({ value }, 'value');
  if (
    ['stop', 'user-now', 'continuation', 'scheduled', 'autonomy'].includes(
      priority,
    )
  ) {
    return priority as TaskPriorityClass;
  }
  return 'user-now';
};

const lane = (value: unknown): TaskLane | undefined => {
  if (value === 'interactive' || value === 'normal' || value === 'background') {
    return value;
  }
  return undefined;
};

const risk = (value: unknown): 'low' | 'medium' | 'high' =>
  value === 'high' || value === 'medium' ? value : 'low';

export const createOrchestrationTools = (
  runtime: OrchestrationRuntime,
): ToolDefinition[] => [
  {
    name: 'task.submit',
    domain: 'system',
    description:
      'Submit a durable task to the central scheduler. Use for user commands, scheduled work, autonomous accepted work, atomic tools, local workflows, GUI tasks, or coding tasks.',
    risk: 'medium',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 99,
      tags: ['task', 'queue', 'schedule', '任务', '队列', '调度'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        kind: { type: 'string' },
        goal: { type: 'string' },
        lane: { type: 'string' },
        idempotencyKey: { type: 'string' },
        contract: { type: 'object', additionalProperties: true },
        priorityClass: { type: 'string' },
        priority: { type: 'number' },
        preemptible: { type: 'boolean' },
        risk: { type: 'string' },
        resources: { type: 'array', items: { type: 'string' } },
        dependsOn: { type: 'array', items: { type: 'string' } },
        payload: { type: 'object' },
      },
      required: ['goal', 'kind'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      source: sourceKind(input.source),
      kind: taskKind(input.kind),
      goal: text(input, 'goal'),
      lane: lane(input.lane),
      idempotencyKey: text(input, 'idempotencyKey') || undefined,
      contract: record(input.contract) as ToolExecutionContract,
      payload: record(input.payload) as RuntimeTaskPayload,
      priorityClass: priorityClass(input.priorityClass),
      priority: typeof input.priority === 'number' ? input.priority : undefined,
      preemptible:
        typeof input.preemptible === 'boolean' ? input.preemptible : undefined,
      risk: risk(input.risk),
      resources: stringArray(input.resources),
      dependsOn: stringArray(input.dependsOn),
    }),
    async execute(args) {
      try {
        const task = await runtime.submitTask(
          args as unknown as RuntimeTaskSubmitInput,
        );
        return success('task.submit', `任务已进入队列：${task.goal}`, { task });
      } catch (error) {
        return failure('task.submit', error);
      }
    },
  },
  {
    name: 'task.plan',
    domain: 'system',
    description:
      'Compile and optionally submit a validated multi-step task DAG with explicit dependencies. Use preview mode before executing complex or risky plans.',
    risk: 'medium',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 98,
      tags: ['task', 'plan', 'dag', 'planner', '任务', '计划', '分解'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        source: { type: 'string' },
        execute: { type: 'boolean' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 48,
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              kind: { type: 'string' },
              goal: { type: 'string' },
              payload: { type: 'object' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
              },
              lane: { type: 'string' },
              priorityClass: { type: 'string' },
              priority: { type: 'number' },
              risk: { type: 'string' },
              resources: {
                type: 'array',
                items: { type: 'string' },
              },
              contract: {
                type: 'object',
                additionalProperties: true,
              },
            },
            required: ['key', 'kind', 'goal'],
            additionalProperties: false,
          },
        },
      },
      required: ['goal', 'steps'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      goal: text(input, 'goal'),
      source: sourceKind(input.source),
      execute: input.execute === true,
      steps: Array.isArray(input.steps)
        ? (input.steps.filter(
            (step) => step && typeof step === 'object',
          ) as PlannedTaskNode[])
        : [],
    }),
    async execute(args) {
      try {
        const plan = await runtime.planner.compile({
          goal: String(args.goal),
          source: args.source as TaskSourceKind,
          execute: args.execute === true,
          steps: args.steps as PlannedTaskNode[],
        });
        return success(
          'task.plan',
          args.execute === true
            ? `计划已提交，共 ${plan.steps.length} 个步骤。`
            : `计划校验通过，共 ${plan.steps.length} 个步骤，尚未执行。`,
          { plan },
        );
      } catch (error) {
        return failure('task.plan', error);
      }
    },
  },
  {
    name: 'task.list',
    domain: 'system',
    description:
      'List scheduled and completed tasks in the central task queue.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 74,
      tags: ['task', 'queue', 'list', '任务', '列表'],
    },
    inputSchema: {
      type: 'object',
      properties: { activeOnly: { type: 'boolean' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ activeOnly: input.activeOnly !== false }),
    async execute(args) {
      const tasks = runtime.tasks(args.activeOnly !== false).tasks;
      return success(
        'task.list',
        tasks.length ? `当前有 ${tasks.length} 个任务。` : '当前没有任务。',
        { tasks },
      );
    },
  },
  {
    name: 'task.status',
    domain: 'system',
    description:
      'Read a task by ID, or the highest-priority active/recent task when taskId is omitted.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 73,
      tags: ['task', 'status', 'progress', '任务', '状态', '进度'],
    },
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ taskId: text(input, 'taskId') || undefined }),
    async execute(args) {
      const task = runtime.scheduler.get(
        typeof args.taskId === 'string' ? args.taskId : undefined,
      );
      return task
        ? success('task.status', `任务状态：${task.status}。`, { task })
        : failure('task.status', '没有找到任务。', 'TASK_NOT_FOUND');
    },
  },
  ...(
    [
      ['task.pause', 'Pause a running task when its executor supports it.'],
      ['task.resume', 'Resume a paused task.'],
      ['task.cancel', 'Cancel a queued, paused, or running task.'],
      ['task.retry', 'Retry a failed task from its persisted checkpoint.'],
    ] as const
  ).map<ToolDefinition>(([name, description]) => ({
    name,
    domain: 'system',
    description,
    risk: 'medium',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 72,
      tags: ['task', name.replace('task.', ''), '任务', '控制'],
    },
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const taskId = text(input, 'taskId');
      if (!taskId) throw new Error('taskId is required');
      return { taskId };
    },
    async execute(args) {
      try {
        const taskId = String(args.taskId);
        const task =
          name === 'task.pause'
            ? await runtime.pauseTask(taskId)
            : name === 'task.resume'
              ? await runtime.resumeTask(taskId)
              : name === 'task.cancel'
                ? await runtime.cancelTask(taskId)
                : await runtime.retryTask(taskId);
        return task
          ? success(name, `任务操作已执行：${task.status}。`, { task })
          : failure(name, '没有找到任务。', 'TASK_NOT_FOUND');
      } catch (error) {
        return failure(name, error);
      }
    },
  })),
  {
    name: 'autonomy.status',
    domain: 'system',
    description:
      'Read autonomy mode, proposals, standing goals, and interruption budget.',
    risk: 'low',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 61,
      tags: ['autonomy', 'proactive', 'status', '自主', '主动', '状态'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const snapshot = runtime.autonomy.snapshot();
      return success('autonomy.status', `自主意图模式：${snapshot.mode}。`, {
        autonomy: snapshot,
      });
    },
  },
  {
    name: 'autonomy.configure',
    domain: 'system',
    description:
      'Set autonomy mode to off, suggest, or low-risk and optionally set hourly proposal budget.',
    risk: 'medium',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 60,
      tags: ['autonomy', 'configure', '自主', '设置', '主动'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['off', 'suggest', 'low-risk'] },
        maxPerHour: { type: 'number', minimum: 1, maximum: 20 },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      mode: text(input, 'mode') as AutonomyMode,
      maxPerHour:
        typeof input.maxPerHour === 'number' ? input.maxPerHour : undefined,
    }),
    async execute(args) {
      try {
        const snapshot = await runtime.autonomy.configure(
          args.mode as AutonomyMode,
          typeof args.maxPerHour === 'number' ? args.maxPerHour : undefined,
        );
        return success(
          'autonomy.configure',
          `自主意图模式已设置为 ${snapshot.mode}。`,
          { autonomy: snapshot },
        );
      } catch (error) {
        return failure('autonomy.configure', error);
      }
    },
  },
  {
    name: 'autonomy.accept',
    domain: 'system',
    description:
      'Accept an autonomy proposal and queue it as an autonomous task.',
    risk: 'medium',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 59,
      tags: ['autonomy', 'accept', '自主', '接受', '建议'],
    },
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ proposalId: text(input, 'proposalId') }),
    async execute(args) {
      const task = await runtime.autonomy.accept(String(args.proposalId));
      return task
        ? success('autonomy.accept', '自主建议已进入任务队列。', { task })
        : failure(
            'autonomy.accept',
            '建议不存在、已过期或已处理。',
            'AUTONOMY_PROPOSAL_UNAVAILABLE',
          );
    },
  },
  {
    name: 'autonomy.reject',
    domain: 'system',
    description: 'Reject an autonomy proposal and record the feedback.',
    risk: 'low',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 58,
      tags: ['autonomy', 'reject', '自主', '拒绝', '建议'],
    },
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ proposalId: text(input, 'proposalId') }),
    async execute(args) {
      return (await runtime.autonomy.reject(String(args.proposalId)))
        ? success('autonomy.reject', '自主建议已拒绝。')
        : failure(
            'autonomy.reject',
            '建议不存在或已处理。',
            'AUTONOMY_PROPOSAL_UNAVAILABLE',
          );
    },
  },
  {
    name: 'autonomy.goal.add',
    domain: 'system',
    description:
      'Add a user-approved standing goal that the autonomy engine can periodically propose.',
    risk: 'medium',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 57,
      tags: ['autonomy', 'goal', '自主', '目标', '长期'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        intervalMs: { type: 'number', minimum: 300000 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      text: text(input, 'text'),
      intervalMs:
        typeof input.intervalMs === 'number' ? input.intervalMs : undefined,
    }),
    async execute(args) {
      try {
        const goal = await runtime.autonomy.addGoal(
          String(args.text),
          typeof args.intervalMs === 'number' ? args.intervalMs : undefined,
        );
        return success('autonomy.goal.add', '长期目标已添加。', { goal });
      } catch (error) {
        return failure('autonomy.goal.add', error);
      }
    },
  },
  {
    name: 'autonomy.goal.remove',
    domain: 'system',
    description: 'Remove a standing autonomy goal.',
    risk: 'medium',
    capability: {
      providerId: 'autonomy',
      tier: 2,
      activation: 'on-demand',
      priority: 56,
      tags: ['autonomy', 'goal', 'remove', '自主', '目标', '删除'],
    },
    inputSchema: {
      type: 'object',
      properties: { goalId: { type: 'string' } },
      required: ['goalId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ goalId: text(input, 'goalId') }),
    async execute(args) {
      return (await runtime.autonomy.removeGoal(String(args.goalId)))
        ? success('autonomy.goal.remove', '长期目标已移除。')
        : failure('autonomy.goal.remove', '没有找到长期目标。');
    },
  },
  {
    name: 'capability.synthesize',
    domain: 'capability',
    description:
      'Ask the capability synthesis agent to propose safe declarative workflow templates for an unmet goal.',
    risk: 'low',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 55,
      tags: ['capability', 'synthesize', 'provider', '能力', '合成', '扩展'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['goal'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      goal: text(input, 'goal'),
      reason: text(input, 'reason'),
    }),
    async execute(args) {
      try {
        const proposals = await runtime.capabilitySynthesis.synthesize(
          String(args.goal),
          String(args.reason || ''),
        );
        return success(
          'capability.synthesize',
          proposals.length
            ? `能力合成生成了 ${proposals.length} 个提案。`
            : '没有生成可安全验证的能力提案。',
          { proposals },
        );
      } catch (error) {
        return failure('capability.synthesize', error);
      }
    },
  },
  {
    name: 'capability.proposals',
    domain: 'capability',
    description:
      'List proposed, approved, or rejected runtime capability proposals.',
    risk: 'low',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 54,
      tags: ['capability', 'proposal', 'list', '能力', '提案', '列表'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['proposed', 'approved', 'rejected'],
        },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({ status: text(input, 'status') || undefined }),
    async execute(args) {
      const status = ['proposed', 'approved', 'rejected'].includes(
        String(args.status),
      )
        ? (args.status as 'proposed' | 'approved' | 'rejected')
        : undefined;
      const proposals = runtime.capabilityProposals(status);
      return success(
        'capability.proposals',
        `当前有 ${proposals.length} 个能力提案。`,
        { proposals },
      );
    },
  },
  {
    name: 'capability.propose-provider',
    domain: 'capability',
    description:
      'Create a reviewed proposal for an external provider manifest. Approval registers it disabled and untrusted until health checks and explicit enablement.',
    risk: 'low',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 54,
      tags: ['capability', 'provider', 'manifest', '能力', '提供者', '接入'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'object', additionalProperties: true },
        reason: { type: 'string' },
      },
      required: ['manifest'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      manifest:
        input.manifest &&
        typeof input.manifest === 'object' &&
        !Array.isArray(input.manifest)
          ? (input.manifest as Record<string, unknown>)
          : {},
      reason: text(input, 'reason'),
    }),
    async execute(args) {
      try {
        const proposal = await runtime.capabilitySynthesis.proposeProvider(
          args.manifest,
          String(args.reason || ''),
        );
        return success(
          'capability.propose-provider',
          'Provider 接入提案已创建。',
          { proposal },
        );
      } catch (error) {
        return failure('capability.propose-provider', error);
      }
    },
  },
  {
    name: 'capability.propose-binding',
    domain: 'capability',
    description:
      'Create a reviewed resource-to-capability binding proposal for an existing tool and resource kind.',
    risk: 'low',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 53,
      tags: ['capability', 'binding', 'resource', '能力', '绑定', '资源'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        resourceKind: { type: 'string' },
        capabilityId: { type: 'string' },
        toolId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['resourceKind', 'capabilityId', 'toolId'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      resourceKind: text(input, 'resourceKind'),
      capabilityId: text(input, 'capabilityId'),
      toolId: text(input, 'toolId'),
      reason: text(input, 'reason'),
    }),
    async execute(args) {
      try {
        const proposal =
          await runtime.capabilitySynthesis.proposeResourceBinding(
            {
              resourceKind: String(args.resourceKind),
              capabilityId: String(args.capabilityId),
              toolId: String(args.toolId),
            },
            String(args.reason || ''),
          );
        return success('capability.propose-binding', '资源绑定提案已创建。', {
          proposal,
        });
      } catch (error) {
        return failure('capability.propose-binding', error);
      }
    },
  },
  {
    name: 'capability.approve',
    domain: 'capability',
    description:
      'Approve and activate a validated runtime workflow-template capability.',
    risk: 'medium',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 53,
      tags: ['capability', 'approve', 'activate', '能力', '批准', '启用'],
    },
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ proposalId: text(input, 'proposalId') }),
    requiresConfirmation: () => '批准后会注册新的运行时能力。',
    async execute(args) {
      try {
        const proposal = await runtime.capabilitySynthesis.approve(
          String(args.proposalId),
        );
        return proposal
          ? success('capability.approve', '运行时能力已批准并激活。', {
              proposal,
            })
          : failure(
              'capability.approve',
              '提案不存在或已处理。',
              'CAPABILITY_PROPOSAL_UNAVAILABLE',
            );
      } catch (error) {
        return failure('capability.approve', error);
      }
    },
  },
  {
    name: 'capability.reject',
    domain: 'capability',
    description: 'Reject a runtime capability proposal.',
    risk: 'low',
    capability: {
      providerId: 'synthesized',
      tier: 2,
      activation: 'on-demand',
      priority: 52,
      tags: ['capability', 'reject', '能力', '拒绝'],
    },
    inputSchema: {
      type: 'object',
      properties: { proposalId: { type: 'string' } },
      required: ['proposalId'],
      additionalProperties: false,
    },
    prepare: (input) => ({ proposalId: text(input, 'proposalId') }),
    async execute(args) {
      return (await runtime.capabilitySynthesis.reject(String(args.proposalId)))
        ? success('capability.reject', '能力提案已拒绝。')
        : failure(
            'capability.reject',
            '提案不存在或已处理。',
            'CAPABILITY_PROPOSAL_UNAVAILABLE',
          );
    },
  },
  {
    name: 'world.snapshot',
    domain: 'context',
    description:
      'Read the unified world state: system facts, user context, intent, task queue, autonomy, capabilities, proposals, memory revision, and health.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 70,
      tags: ['world', 'state', 'snapshot', '世界', '状态', '总览'],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      return success('world.snapshot', '统一世界状态已读取。', {
        world: runtime.snapshot(),
      });
    },
  },
  {
    name: 'world.context',
    domain: 'context',
    description:
      'Read the compact unified context used by planners: system, user intent, tasks, autonomy, capability proposals, and episodic memory.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 69,
      tags: ['world', 'context', 'prompt', '世界', '上下文'],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      return success('world.context', '统一上下文已读取。', {
        context: runtime.getContext(),
      });
    },
  },
  {
    name: 'trace.list',
    domain: 'context',
    description:
      'List recent runtime trace events across system, context, perception, intent, tasks, tools, autonomy, capabilities, and memory.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 68,
      tags: ['trace', 'audit', 'replay', '轨迹', '审计', '回放'],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 1000 },
        taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      limit:
        typeof input.limit === 'number' && Number.isFinite(input.limit)
          ? Math.max(1, Math.min(1_000, Math.floor(input.limit)))
          : 100,
      taskId: text(input, 'taskId') || undefined,
    }),
    async execute(args) {
      const events = runtime.trace.list({
        limit: Number(args.limit),
        taskId: args.taskId ? String(args.taskId) : undefined,
      });
      return success('trace.list', `已读取 ${events.length} 条运行轨迹。`, {
        events,
      });
    },
  },
  {
    name: 'trace.replay',
    domain: 'context',
    description:
      'Replay a bounded runtime trace without executing side effects, check task lifecycle continuity, and report gaps.',
    risk: 'low',
    capability: {
      providerId: 'orchestration',
      tier: 2,
      activation: 'on-demand',
      priority: 67,
      tags: ['trace', 'replay', 'diagnostic', '轨迹', '回放', '诊断'],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'number' },
        to: { type: 'number' },
        taskId: { type: 'string' },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      from:
        typeof input.from === 'number' && Number.isFinite(input.from)
          ? input.from
          : undefined,
      to:
        typeof input.to === 'number' && Number.isFinite(input.to)
          ? input.to
          : undefined,
      taskId: text(input, 'taskId') || undefined,
    }),
    async execute(args) {
      const replay = runtime.trace.replay({
        from: typeof args.from === 'number' ? args.from : undefined,
        to: typeof args.to === 'number' ? args.to : undefined,
        taskId: args.taskId ? String(args.taskId) : undefined,
      });
      return success(
        'trace.replay',
        replay.gaps.length
          ? `轨迹回放完成，发现 ${replay.gaps.length} 个生命周期缺口。`
          : '轨迹回放完成，未发现生命周期缺口。',
        { replay },
      );
    },
  },
];
