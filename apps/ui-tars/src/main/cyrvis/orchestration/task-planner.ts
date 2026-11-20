import { randomUUID } from 'node:crypto';

import type { CapabilityCatalog } from '../tools/capability-catalog';
import type { ToolExecutionContract, ToolRisk } from '../tools/types';
import type { TaskScheduler } from './task-scheduler';
import type {
  RuntimeTask,
  RuntimeTaskKind,
  RuntimeTaskPayload,
  TaskLane,
  TaskPriorityClass,
  TaskSourceKind,
} from './types';

export interface PlannedTaskNode {
  key: string;
  kind: RuntimeTaskKind;
  goal: string;
  payload?: RuntimeTaskPayload;
  dependsOn?: string[];
  lane?: TaskLane;
  priorityClass?: TaskPriorityClass;
  priority?: number;
  risk?: ToolRisk;
  resources?: string[];
  contract?: ToolExecutionContract;
}

export interface TaskPlanInput {
  goal: string;
  source?: TaskSourceKind;
  steps: PlannedTaskNode[];
  execute?: boolean;
}

export interface CompiledTaskPlan {
  planId: string;
  goal: string;
  steps: Array<PlannedTaskNode & { order: number; taskId: string | null }>;
  warnings: string[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class TaskPlanner {
  private readonly plans = new Map<string, CompiledTaskPlan>();

  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly catalog: CapabilityCatalog,
  ) {}

  async compile(input: TaskPlanInput): Promise<CompiledTaskPlan> {
    const goal = input.goal.trim();
    if (!goal) throw new Error('计划目标不能为空。');
    if (!input.steps.length || input.steps.length > 48) {
      throw new Error('计划步骤数必须在 1 到 48 之间。');
    }
    const keys = new Set<string>();
    for (const step of input.steps) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(step.key)) {
        throw new Error(`无效计划步骤 key：${step.key}`);
      }
      if (keys.has(step.key)) throw new Error(`重复计划步骤：${step.key}`);
      keys.add(step.key);
      if (!step.goal.trim()) throw new Error(`步骤 ${step.key} 缺目标。`);
      if (step.kind === 'atomic' && step.payload?.tool) {
        const capability = this.catalog.get(step.payload.tool);
        if (!capability) {
          throw new Error(
            `步骤 ${step.key} 使用未知工具：${step.payload.tool}`,
          );
        }
      }
    }
    for (const step of input.steps) {
      for (const dependency of step.dependsOn || []) {
        if (!keys.has(dependency)) {
          throw new Error(`步骤 ${step.key} 依赖未知步骤：${dependency}`);
        }
      }
    }
    const ordered = this.topologicalOrder(input.steps);
    const planId = randomUUID();
    const compiled: CompiledTaskPlan = {
      planId,
      goal,
      steps: ordered.map((step, order) => ({
        ...clone(step),
        order,
        taskId: null,
      })),
      warnings: [],
    };
    for (const step of compiled.steps) {
      if (step.risk === 'high' && (step.dependsOn || []).length === 0) {
        compiled.warnings.push(`高风险步骤 ${step.key} 没有前置验证或依赖。`);
      }
      if (step.kind === 'gui') {
        compiled.warnings.push(
          `步骤 ${step.key} 使用 GUI 兜底，执行成本较高。`,
        );
      }
    }
    this.plans.set(planId, compiled);
    if (input.execute !== false) {
      const taskIds = new Map<string, string>();
      for (const step of compiled.steps) {
        const task = await this.scheduler.submit({
          source: input.source || 'user-text',
          kind: step.kind,
          goal: step.goal,
          payload: {
            ...step.payload,
            metadata: {
              ...(step.payload?.metadata || {}),
              planId,
              planStep: step.key,
            },
          },
          lane: step.lane,
          idempotencyKey: `${planId}:${step.key}`,
          priorityClass: step.priorityClass,
          priority: step.priority,
          risk: step.risk,
          resources: step.resources,
          dependsOn: (step.dependsOn || []).map((dependency) => {
            const taskId = taskIds.get(dependency);
            if (!taskId) {
              throw new Error(`依赖步骤尚未提交：${dependency}`);
            }
            return taskId;
          }),
          contract: step.contract,
        });
        taskIds.set(step.key, task.id);
        step.taskId = task.id;
      }
    }
    return clone(compiled);
  }

  get(planId: string): CompiledTaskPlan | null {
    return clone(this.plans.get(planId) || null);
  }

  tasks(planId: string): RuntimeTask[] {
    return this.scheduler
      .list()
      .filter((task) => task.payload.metadata?.planId === planId);
  }

  private topologicalOrder(steps: PlannedTaskNode[]): PlannedTaskNode[] {
    const byKey = new Map(steps.map((step) => [step.key, step]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const ordered: PlannedTaskNode[] = [];
    const visit = (key: string) => {
      if (visiting.has(key)) throw new Error('任务计划存在循环依赖。');
      if (visited.has(key)) return;
      visiting.add(key);
      const step = byKey.get(key);
      for (const dependency of step?.dependsOn || []) visit(dependency);
      visiting.delete(key);
      visited.add(key);
      if (step) ordered.push(step);
    };
    for (const step of steps) visit(step.key);
    return ordered;
  }
}
