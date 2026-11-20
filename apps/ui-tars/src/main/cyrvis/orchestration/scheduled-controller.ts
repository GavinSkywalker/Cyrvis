import type { TaskController } from '../controller';
import type {
  ControllerEvent,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from '../types';
import type { TaskScheduler } from './task-scheduler';
import type { RuntimeTask, RuntimeTaskEvent } from './types';

const activeStatuses = [
  'queued',
  'running',
  'waiting_confirmation',
  'paused',
  'cancelling',
];

const toTaskStatus = (status: RuntimeTask['status']): TaskStatus => {
  if (status === 'queued') return 'starting';
  if (status === 'running') return 'executing';
  if (status === 'waiting_confirmation') return 'paused';
  if (status === 'paused') return 'paused';
  if (status === 'cancelling') return 'cancelling';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'idle';
};

export class ScheduledTaskController implements TaskController {
  private readonly progressSteps = new Map<string, number>();

  constructor(private readonly scheduler: TaskScheduler) {}

  onEvent(listener: (event: ControllerEvent) => void): () => void {
    return this.scheduler.subscribe((event) => {
      if (event.task.kind !== 'gui') return;
      const mapped = this.toControllerEvent(event);
      if (mapped) listener(mapped);
    });
  }

  getStatus(): TaskSnapshot {
    const task =
      this.scheduler.latestByKind('gui', true) ||
      this.scheduler.latestByKind('gui', false);
    if (!task) {
      return {
        taskId: null,
        status: 'idle',
        instruction: null,
        source: null,
        step: 0,
        lastSummary: null,
        error: null,
        startedAt: null,
        endedAt: null,
      };
    }
    return this.toSnapshot(task);
  }

  isBusy(): boolean {
    return activeStatuses.includes(
      this.scheduler.latestByKind('gui', true)?.status || 'done',
    );
  }

  startTask(instruction: string, source: TaskSource = 'voice'): TaskSnapshot {
    const task = this.scheduler.submitSync({
      source: source === 'text' ? 'user-text' : 'user-voice',
      kind: 'gui',
      goal: instruction.trim(),
      payload: { instruction: instruction.trim() },
      priorityClass: 'user-now',
      risk: 'medium',
      preemptible: false,
    });
    return this.toSnapshot(task);
  }

  async cancelTask(taskId?: string): Promise<TaskSnapshot> {
    const id = taskId || this.getStatus().taskId;
    if (!id) return this.getStatus();
    const task = await this.scheduler.cancel(id);
    return task ? this.toSnapshot(task) : this.getStatus();
  }

  async pauseTask(taskId?: string): Promise<TaskSnapshot> {
    const id = taskId || this.getStatus().taskId;
    if (!id) return this.getStatus();
    const task = await this.scheduler.pause(id);
    return task ? this.toSnapshot(task) : this.getStatus();
  }

  async resumeTask(taskId?: string): Promise<TaskSnapshot> {
    const id = taskId || this.getStatus().taskId;
    if (!id) return this.getStatus();
    const task = await this.scheduler.resume(id);
    return task ? this.toSnapshot(task) : this.getStatus();
  }

  dispose(): void {}

  private toSnapshot(task: RuntimeTask): TaskSnapshot {
    return {
      taskId: task.id,
      status: toTaskStatus(task.status),
      instruction: task.goal,
      source: task.source === 'user-text' ? 'text' : 'voice',
      step: this.currentStep(task),
      lastSummary: task.result,
      error: task.error,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
    };
  }

  private toControllerEvent(event: RuntimeTaskEvent): ControllerEvent | null {
    const task = event.task;
    if (event.type === 'submitted') {
      this.progressSteps.delete(task.id);
      return {
        type: 'task_started',
        taskId: task.id,
        instruction: task.goal,
        source: task.source === 'user-text' ? 'text' : 'voice',
      };
    }
    if (event.type === 'started') {
      return { type: 'task_executing', taskId: task.id };
    }
    if (event.type === 'progress') {
      const step = (this.progressSteps.get(task.id) || 0) + 1;
      this.progressSteps.set(task.id, step);
      return {
        type: 'step_update',
        taskId: task.id,
        step,
        summary: event.message,
        actionType: 'dispatch',
      };
    }
    if (event.type === 'waiting_confirmation') {
      return {
        type: 'task_needs_user',
        taskId: task.id,
        question: event.message,
      };
    }
    if (event.type === 'paused') {
      return { type: 'task_paused', taskId: task.id };
    }
    if (event.type === 'resumed') {
      return { type: 'task_resumed', taskId: task.id };
    }
    if (event.type === 'done') {
      this.progressSteps.delete(task.id);
      return {
        type: 'task_done',
        taskId: task.id,
        summary: task.result || event.message,
      };
    }
    if (event.type === 'failed') {
      this.progressSteps.delete(task.id);
      return {
        type: 'task_failed',
        taskId: task.id,
        error: task.error || event.message,
      };
    }
    if (event.type === 'cancelled') {
      this.progressSteps.delete(task.id);
      return { type: 'task_cancelled', taskId: task.id };
    }
    return null;
  }

  private currentStep(task: RuntimeTask): number {
    const mapped = this.progressSteps.get(task.id) || 0;
    const checkpoint = Number(task.checkpoint?.data.step);
    if (Number.isFinite(checkpoint) && checkpoint >= 0) {
      return Math.max(mapped, Math.floor(checkpoint));
    }
    return mapped || (task.status === 'running' ? 1 : 0);
  }
}
