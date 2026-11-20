import type {
  CodingAgentController,
  CodingTaskSnapshot,
  CodingTaskStatus,
} from '../coding-agent';
import type { TaskScheduler } from './task-scheduler';
import type { RuntimeTask, RuntimeTaskEvent } from './types';

const toCodingStatus = (task: RuntimeTask): CodingTaskStatus => {
  if (task.status === 'done') return 'done';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  return 'running';
};

export class ScheduledCodingAgent implements CodingAgentController {
  private readonly progress = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scheduler: TaskScheduler,
    private readonly workspace: string,
  ) {
    this.unsubscribe = scheduler.subscribe((event) => this.handleEvent(event));
  }

  getWorkspace(): string {
    return this.workspace;
  }

  getStatus(): CodingTaskSnapshot {
    const task =
      this.scheduler.latestByKind('coding', true) ||
      this.scheduler.latestByKind('coding', false);
    if (!task) {
      return {
        taskId: null,
        status: 'idle',
        instruction: null,
        workspace: this.workspace,
        startedAt: null,
        endedAt: null,
        lastMessage: '',
        lastEvent: null,
        result: '',
        diff: '',
        changedFiles: [],
        error: null,
      };
    }
    return {
      taskId: task.id,
      status: toCodingStatus(task),
      instruction: task.goal,
      workspace: String(task.payload.workspace || this.workspace),
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      lastMessage:
        this.progress.get(task.id) ||
        task.error ||
        task.result ||
        (task.status === 'queued' ? '编码任务已排队' : '编码任务执行中'),
      lastEvent: null,
      result: task.result || '',
      diff: '',
      changedFiles: [],
      error: task.error,
    };
  }

  isBusy(): boolean {
    const task = this.scheduler.latestByKind('coding', true);
    return Boolean(
      task && !['done', 'failed', 'cancelled'].includes(task.status),
    );
  }

  async start(instruction: string): Promise<CodingTaskSnapshot> {
    await this.scheduler.submit({
      source: 'user-text',
      kind: 'coding',
      goal: instruction.trim(),
      payload: {
        instruction: instruction.trim(),
        workspace: this.workspace,
      },
      priorityClass: 'user-now',
      risk: 'high',
      preemptible: false,
      resources: [`coding.workspace:${this.workspace}`],
    });
    return this.getStatus();
  }

  async cancel(): Promise<CodingTaskSnapshot> {
    const task = this.scheduler.latestByKind('coding', true);
    if (!task) return this.getStatus();
    await this.scheduler.cancel(task.id);
    return this.getStatus();
  }

  dispose(): void {
    this.unsubscribe();
  }

  private handleEvent(event: RuntimeTaskEvent): void {
    if (event.task.kind !== 'coding') return;
    this.progress.set(event.task.id, event.message);
    if (['done', 'failed', 'cancelled'].includes(event.type)) {
      const timer = setTimeout(
        () => this.progress.delete(event.task.id),
        60_000,
      );
      timer.unref?.();
    }
  }
}
