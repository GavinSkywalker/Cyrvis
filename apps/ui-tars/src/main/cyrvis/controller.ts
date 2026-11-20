/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { randomUUID } from 'node:crypto';

import type {
  ControllerEvent,
  GUIAdapter,
  TaskSnapshot,
  TaskSource,
  TaskStatus,
} from './types';

export class TaskBusyError extends Error {
  readonly code = 'TASK_BUSY';

  constructor(readonly activeTaskId: string) {
    super(`A GUI task is already running: ${activeTaskId}`);
    this.name = 'TaskBusyError';
  }
}

export class EmptyInstructionError extends Error {
  readonly code = 'EMPTY_INSTRUCTION';

  constructor() {
    super('GUI task instruction is empty');
    this.name = 'EmptyInstructionError';
  }
}

interface TaskRecord {
  taskId: string;
  instruction: string;
  source: TaskSource;
  createdAt: number;
  status: TaskStatus;
  step: number;
  lastSummary: string | null;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelRequested: boolean;
}

export interface CyrvisControllerOptions {
  /** Emit `task_stalled` after this many ms without a step. 0 disables it. */
  stallTimeoutMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export interface TaskController {
  onEvent(listener: (event: ControllerEvent) => void): () => void;
  getStatus(): TaskSnapshot;
  isBusy(): boolean;
  startTask(instruction: string, source?: TaskSource): TaskSnapshot;
  cancelTask(taskId?: string): Promise<TaskSnapshot>;
  pauseTask(taskId?: string): Promise<TaskSnapshot>;
  resumeTask(taskId?: string): Promise<TaskSnapshot>;
  dispose(): void;
}

const TERMINAL_STATUSES: TaskStatus[] = ['idle', 'done', 'failed', 'cancelled'];

const isTerminal = (status: TaskStatus) => TERMINAL_STATUSES.includes(status);

export class CyrvisController implements TaskController {
  private current: TaskRecord | null = null;
  private readonly listeners = new Set<(event: ControllerEvent) => void>();
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly stallTimeoutMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly adapter: GUIAdapter,
    options: CyrvisControllerOptions = {},
  ) {
    this.stallTimeoutMs = options.stallTimeoutMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  onEvent(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): TaskSnapshot {
    if (!this.current) {
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

    return {
      taskId: this.current.taskId,
      status: this.current.status,
      instruction: this.current.instruction,
      source: this.current.source,
      step: this.current.step,
      lastSummary: this.current.lastSummary,
      error: this.current.error,
      startedAt: this.current.startedAt,
      endedAt: this.current.endedAt,
    };
  }

  isBusy(): boolean {
    return !!this.current && !isTerminal(this.current.status);
  }

  startTask(instruction: string, source: TaskSource = 'voice'): TaskSnapshot {
    const trimmed = instruction.trim();
    if (!trimmed) {
      throw new EmptyInstructionError();
    }

    if (this.current && !isTerminal(this.current.status)) {
      throw new TaskBusyError(this.current.taskId);
    }

    const taskId = this.idFactory();
    this.current = {
      taskId,
      instruction: trimmed,
      source,
      createdAt: this.now(),
      status: 'starting',
      step: 0,
      lastSummary: null,
      error: null,
      startedAt: this.now(),
      endedAt: null,
      cancelRequested: false,
    };

    this.emit({
      type: 'task_started',
      taskId,
      instruction: trimmed,
      source,
    });

    void Promise.resolve()
      .then(() => this.adapter.start(trimmed, this.createCallbacks(taskId)))
      .then(() => this.ensureTerminal(taskId))
      .catch((error: unknown) => this.fail(taskId, error));

    return this.getStatus();
  }

  async cancelTask(taskId?: string): Promise<TaskSnapshot> {
    const task = this.requireActiveTask(taskId);
    if (!task || isTerminal(task.status)) {
      return this.getStatus();
    }

    task.cancelRequested = true;
    task.status = 'cancelling';
    this.clearStallTimer();
    this.emit({ type: 'task_cancelling', taskId: task.taskId });

    try {
      await this.adapter.cancel();
    } catch (error) {
      this.fail(task.taskId, error);
      return this.getStatus();
    }

    // The adapter usually emits onCancelled. If it did not, do not leave the
    // controller stuck in `cancelling`.
    if (
      this.current?.taskId === task.taskId &&
      this.current.status === 'cancelling'
    ) {
      this.finishCancelled(task.taskId);
    }

    return this.getStatus();
  }

  async pauseTask(taskId?: string): Promise<TaskSnapshot> {
    const task = this.requireActiveTask(taskId);
    if (!task || task.status !== 'executing') {
      return this.getStatus();
    }

    task.status = 'paused';
    this.clearStallTimer();
    this.emit({ type: 'task_paused', taskId: task.taskId });

    try {
      await this.adapter.pause();
    } catch (error) {
      this.fail(task.taskId, error);
    }

    return this.getStatus();
  }

  async resumeTask(taskId?: string): Promise<TaskSnapshot> {
    const task = this.requireActiveTask(taskId);
    if (!task || task.status !== 'paused') {
      return this.getStatus();
    }

    task.status = 'executing';
    this.emit({ type: 'task_resumed', taskId: task.taskId });
    this.armStallTimer(task.taskId);

    try {
      await this.adapter.resume();
    } catch (error) {
      this.fail(task.taskId, error);
    }

    return this.getStatus();
  }

  dispose(): void {
    this.clearStallTimer();
    this.listeners.clear();
  }

  private createCallbacks(taskId: string) {
    return {
      onStarted: () => {
        const task = this.match(taskId);
        if (!task || task.status !== 'starting') {
          return;
        }
        task.status = 'executing';
        this.emit({ type: 'task_executing', taskId });
        this.armStallTimer(taskId);
      },
      onStep: (step: {
        index: number;
        summary: string;
        actionType: string;
      }) => {
        const task = this.match(taskId);
        if (!task || task.status !== 'executing') {
          return;
        }
        task.step = Math.max(task.step, step.index);
        task.lastSummary = step.summary;
        this.emit({
          type: 'step_update',
          taskId,
          step: task.step,
          summary: step.summary,
          actionType: step.actionType,
        });
        this.armStallTimer(taskId);
      },
      onNeedsUser: (question: string) => {
        const task = this.match(taskId);
        if (!task || isTerminal(task.status)) {
          return;
        }
        this.emit({ type: 'task_needs_user', taskId, question });
      },
      onPaused: () => {
        const task = this.match(taskId);
        if (!task || task.status === 'paused' || isTerminal(task.status)) {
          return;
        }
        task.status = 'paused';
        this.clearStallTimer();
        this.emit({ type: 'task_paused', taskId });
      },
      onResumed: () => {
        const task = this.match(taskId);
        if (!task || task.status !== 'paused') {
          return;
        }
        task.status = 'executing';
        this.emit({ type: 'task_resumed', taskId });
        this.armStallTimer(taskId);
      },
      onDone: (summary: string) => {
        const task = this.match(taskId);
        if (!task || isTerminal(task.status)) {
          return;
        }
        task.status = 'done';
        task.endedAt = this.now();
        this.clearStallTimer();
        this.emit({ type: 'task_done', taskId, summary });
      },
      onFailed: (error: string) => {
        const task = this.match(taskId);
        if (!task || isTerminal(task.status)) {
          return;
        }
        task.status = 'failed';
        task.error = error;
        task.endedAt = this.now();
        this.clearStallTimer();
        this.emit({ type: 'task_failed', taskId, error });
      },
      onCancelled: () => {
        this.finishCancelled(taskId);
      },
    };
  }

  private finishCancelled(taskId: string): void {
    const task = this.match(taskId);
    if (!task || isTerminal(task.status)) {
      return;
    }
    task.status = 'cancelled';
    task.endedAt = this.now();
    this.clearStallTimer();
    this.emit({ type: 'task_cancelled', taskId });
  }

  private ensureTerminal(taskId: string): void {
    const task = this.match(taskId);
    if (!task || isTerminal(task.status)) {
      return;
    }
    this.fail(
      taskId,
      new Error('GUI agent finished without a terminal status event'),
    );
  }

  private fail(taskId: string, error: unknown): void {
    const task = this.match(taskId);
    if (!task || isTerminal(task.status)) {
      return;
    }
    task.status = 'failed';
    task.error = error instanceof Error ? error.message : String(error);
    task.endedAt = this.now();
    this.clearStallTimer();
    this.emit({ type: 'task_failed', taskId, error: task.error });
  }

  private match(taskId: string): TaskRecord | null {
    return this.current?.taskId === taskId ? this.current : null;
  }

  private requireActiveTask(taskId?: string): TaskRecord | null {
    if (!this.current) {
      return null;
    }
    if (taskId && this.current.taskId !== taskId) {
      return null;
    }
    return this.current;
  }

  private armStallTimer(taskId: string): void {
    this.clearStallTimer();
    if (this.stallTimeoutMs <= 0) {
      return;
    }

    this.stallTimer = setTimeout(() => {
      const task = this.match(taskId);
      if (!task || task.status !== 'executing') {
        return;
      }
      this.emit({ type: 'task_stalled', taskId, step: task.step });
      this.armStallTimer(taskId);
    }, this.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private emit(event: ControllerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop task lifecycle updates.
      }
    }
  }
}
