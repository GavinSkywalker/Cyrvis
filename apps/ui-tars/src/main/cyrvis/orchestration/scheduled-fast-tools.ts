import type { FastToolExecutionScheduler } from '../tools/router';
import type {
  FastToolRoute,
  FastToolOutcome,
  ToolResult,
} from '../tools/types';
import type { TaskScheduler } from './task-scheduler';
import type { RuntimeTask, RuntimeTaskStatus, TaskSourceKind } from './types';

const TERMINAL_STATUSES = new Set<RuntimeTaskStatus>([
  'done',
  'failed',
  'cancelled',
]);

export interface ScheduledFastToolOptions {
  source?: TaskSourceKind;
}

export class ScheduledFastToolExecutor implements FastToolExecutionScheduler {
  private readonly source: TaskSourceKind;

  constructor(
    private readonly scheduler: TaskScheduler,
    options: ScheduledFastToolOptions = {},
  ) {
    this.source = options.source || 'user-voice';
  }

  dispose(): void {
    // Kept for lifecycle symmetry with the other execution adapters.
  }

  async execute(route: FastToolRoute): Promise<FastToolOutcome> {
    const task = await this.scheduler.submit({
      source: this.source,
      kind: route.tool.startsWith('context.') ? 'observe' : 'atomic',
      goal: route.summary,
      payload: {
        tool: route.tool,
        args: route.args,
        metadata: {
          fastTool: true,
          userVisible: true,
          confirmationReason: route.confirmationReason,
        },
      },
      priorityClass: 'user-now',
      preemptible: false,
      risk: route.risk,
    });
    return this.toOutcome(await this.waitForTerminal(task.id), route);
  }

  private waitForTerminal(taskId: string): Promise<RuntimeTask> {
    return this.waitForTask(taskId, (task) =>
      TERMINAL_STATUSES.has(task.status),
    );
  }

  private waitForTask(
    taskId: string,
    predicate: (task: RuntimeTask) => boolean,
  ): Promise<RuntimeTask> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const inspect = () => {
        const task = this.scheduler.get(taskId);
        if (!task || !predicate(task)) return false;
        unsubscribe();
        resolve(task);
        return true;
      };
      unsubscribe = this.scheduler.subscribe((event) => {
        if (event.task.id === taskId) inspect();
      });
      if (!inspect()) {
        const current = this.scheduler.get(taskId);
        if (!current) {
          unsubscribe();
          reject(new Error(`Scheduled fast tool ${taskId} disappeared.`));
        }
      }
    });
  }

  private toOutcome(task: RuntimeTask, route: FastToolRoute): FastToolOutcome {
    const ok = task.status === 'done';
    const speech =
      task.result ||
      task.error ||
      (task.status === 'cancelled' ? '任务已取消。' : '任务执行结束。');
    const result: ToolResult = {
      ok,
      tool: route.tool,
      speech,
      ...(task.data === null ? {} : { data: task.data }),
      ...(ok
        ? {}
        : {
            error: {
              code:
                task.status === 'cancelled' ? 'TASK_CANCELLED' : 'TASK_FAILED',
              message: task.error || speech,
            },
          }),
    };
    return {
      handled: true,
      ok,
      speech,
      result,
      route,
    };
  }
}
