import type { ToolDefinition, ToolResult } from './types';
import {
  LocalWorkflowEngine,
  type WorkflowCondition,
  type WorkflowRetryPolicy,
  type WorkflowRun,
  type WorkflowStartInput,
  type WorkflowStepInput,
} from './workflow-engine';

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  speech: string,
  code: string,
  message = speech,
): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code, message },
});

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const condition = (value: unknown): WorkflowCondition | undefined => {
  const input = record(value);
  const kind = text(input.kind);
  const target = input.target;
  if (
    ![
      'path_exists',
      'path_missing',
      'path_is_file',
      'path_is_directory',
      'process_running',
      'process_missing',
      'window_exists',
      'window_missing',
    ].includes(kind) ||
    (typeof target !== 'string' && typeof target !== 'number')
  ) {
    return undefined;
  }
  return {
    kind: kind as WorkflowCondition['kind'],
    target,
    timeoutMs:
      typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
        ? input.timeoutMs
        : undefined,
    intervalMs:
      typeof input.intervalMs === 'number' && Number.isFinite(input.intervalMs)
        ? input.intervalMs
        : undefined,
  };
};

const retryPolicy = (value: unknown): WorkflowRetryPolicy | undefined => {
  const input = record(value);
  if (!Object.keys(input).length) return undefined;
  return {
    maxAttempts:
      typeof input.maxAttempts === 'number'
        ? Math.max(1, Math.min(5, Math.floor(input.maxAttempts)))
        : undefined,
    backoffMs:
      typeof input.backoffMs === 'number'
        ? Math.max(0, Math.min(60_000, Math.floor(input.backoffMs)))
        : undefined,
  };
};

const prepareStart = (input: Record<string, unknown>): WorkflowStartInput => {
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  const steps: WorkflowStepInput[] = rawSteps.map((value, index) => {
    const step = record(value);
    const when = condition(step.when);
    const verify = condition(step.verify);
    return {
      id: text(step.id) || `step-${index + 1}`,
      tool: text(step.tool),
      args: record(step.args),
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.map(text).filter(Boolean)
        : [],
      ...(when ? { when } : {}),
      ...(verify ? { verify } : {}),
      retry: retryPolicy(step.retry),
    };
  });
  return {
    name: text(input.name) || undefined,
    goal: text(input.goal) || undefined,
    steps,
    maxDurationMs:
      typeof input.maxDurationMs === 'number' ? input.maxDurationMs : undefined,
  };
};

const runData = (run: WorkflowRun | null) => ({
  run,
});

export const createWorkflowTools = (
  engine: LocalWorkflowEngine,
): ToolDefinition[] => [
  {
    name: 'workflow.start',
    domain: 'system',
    description:
      'Start a durable local multi-step workflow for deterministic non-GUI tasks. Steps use registered local tools, support dependencies, condition-based waits, retries, output templates like {{steps.step_id.data.path}}, and execute sensitive steps directly when requested by the user.',
    risk: 'medium',
    capability: {
      providerId: 'workflow',
      tier: 2,
      activation: 'on-demand',
      priority: 93,
      tags: [
        'workflow',
        'multi-step',
        'automation',
        'pipeline',
        '工作流',
        '多步骤',
        '自动化',
      ],
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        goal: { type: 'string' },
        maxDurationMs: { type: 'number' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              tool: { type: 'string' },
              args: { type: 'object' },
              dependsOn: {
                type: 'array',
                items: { type: 'string' },
              },
              when: { type: 'object' },
              verify: { type: 'object' },
              retry: { type: 'object' },
            },
            required: ['id', 'tool'],
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    prepare: (input) =>
      prepareStart(input) as unknown as Record<string, unknown>,
    async execute(args) {
      try {
        const run = await engine.start(args as unknown as WorkflowStartInput);
        return success(
          'workflow.start',
          `已启动工作流 ${run.name}，共 ${run.steps.length} 个步骤。`,
          runData(run),
        );
      } catch (error) {
        return failure(
          'workflow.start',
          `工作流启动失败：${error instanceof Error ? error.message : String(error)}`,
          'WORKFLOW_START_FAILED',
        );
      }
    },
  },
  {
    name: 'workflow.status',
    domain: 'system',
    description:
      'Read a workflow run by ID, or the most recently created workflow when runId is omitted.',
    risk: 'low',
    capability: {
      providerId: 'workflow',
      tier: 2,
      activation: 'on-demand',
      priority: 63,
      tags: ['workflow', 'status', 'progress', '工作流', '进度', '状态'],
    },
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ runId: text(input.runId) || undefined }),
    async execute(args) {
      const run = await engine.get(text(args.runId) || undefined);
      return run
        ? success(
            'workflow.status',
            `工作流状态：${run.status}。`,
            runData(run),
          )
        : failure('workflow.status', '没有找到工作流。', 'WORKFLOW_NOT_FOUND');
    },
  },
  {
    name: 'workflow.list',
    domain: 'system',
    description: 'List active workflows or all recent workflow runs.',
    risk: 'low',
    capability: {
      providerId: 'workflow',
      tier: 2,
      activation: 'on-demand',
      priority: 56,
      tags: ['workflow', 'list', '工作流', '列表'],
    },
    inputSchema: {
      type: 'object',
      properties: { activeOnly: { type: 'boolean' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ activeOnly: input.activeOnly !== false }),
    async execute(args) {
      const runs = await engine.list(args.activeOnly !== false);
      return success(
        'workflow.list',
        runs.length ? `当前有 ${runs.length} 个工作流。` : '当前没有工作流。',
        { runs },
      );
    },
  },
  {
    name: 'workflow.cancel',
    domain: 'system',
    description:
      'Cancel a queued, paused, waiting, or running workflow. Omit runId to cancel the latest active workflow. A currently executing atomic tool is allowed to finish before cancellation takes effect.',
    risk: 'medium',
    capability: {
      providerId: 'workflow',
      tier: 2,
      activation: 'on-demand',
      priority: 62,
      tags: ['workflow', 'cancel', 'stop', '工作流', '取消', '停止'],
    },
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ runId: text(input.runId) || undefined }),
    async execute(args) {
      const run = await engine.cancel(text(args.runId));
      return run
        ? success('workflow.cancel', '已请求取消工作流。', runData(run))
        : failure('workflow.cancel', '没有找到工作流。', 'WORKFLOW_NOT_FOUND');
    },
  },
  {
    name: 'workflow.resume',
    domain: 'system',
    description:
      'Resume a paused or interrupted workflow. Omit runId to resume the latest paused workflow. The interrupted atomic step may be retried.',
    risk: 'medium',
    capability: {
      providerId: 'workflow',
      tier: 2,
      activation: 'on-demand',
      priority: 55,
      tags: ['workflow', 'resume', 'continue', '工作流', '恢复', '继续'],
    },
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
    prepare: (input) => ({ runId: text(input.runId) || undefined }),
    async execute(args) {
      try {
        const run = await engine.resume(text(args.runId) || undefined);
        return run
          ? success('workflow.resume', '工作流已恢复。', runData(run))
          : failure(
              'workflow.resume',
              '没有找到工作流。',
              'WORKFLOW_NOT_FOUND',
            );
      } catch (error) {
        return failure(
          'workflow.resume',
          error instanceof Error ? error.message : String(error),
          'WORKFLOW_RESUME_FAILED',
        );
      }
    },
  },
];
