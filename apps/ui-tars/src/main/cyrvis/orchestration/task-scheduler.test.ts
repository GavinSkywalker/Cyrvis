import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFastToolContext } from '../tools/matrix';
import { ToolRegistry } from '../tools/registry';
import type { DesktopHost, ToolDefinition } from '../tools/types';
import { AtomicTaskExecutor } from './executors';
import {
  TaskScheduler,
  type TaskExecutionResult,
  type TaskExecutor,
} from './task-scheduler';
import type { RuntimeTask } from './types';

class GatedExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  readonly started: string[] = [];
  private resolvers = new Map<string, (result: TaskExecutionResult) => void>();

  async start(task: RuntimeTask): Promise<TaskExecutionResult> {
    this.started.push(task.id);
    return new Promise((resolve) => this.resolvers.set(task.id, resolve));
  }

  async cancel(task: RuntimeTask): Promise<void> {
    this.resolvers.get(task.id)?.({ ok: false, summary: 'cancelled' });
  }

  async pause(): Promise<boolean> {
    return true;
  }

  async resume(): Promise<boolean> {
    return true;
  }

  finish(taskId: string): void {
    this.resolvers.get(taskId)?.({ ok: true, summary: 'done' });
  }
}

class ConfirmationRaceExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  private confirmResolver: (() => void) | null = null;

  async start(
    _task: RuntimeTask,
    callbacks: {
      waitingConfirmation(message: string): void;
    },
  ): Promise<TaskExecutionResult> {
    callbacks.waitingConfirmation('confirm');
    await new Promise<void>((resolve) => {
      this.confirmResolver = resolve;
    });
    return { ok: true, summary: 'confirmed and finished' };
  }

  async cancel(): Promise<void> {}

  async confirm(): Promise<boolean> {
    this.confirmResolver?.();
    return true;
  }
}

class ResumeRaceExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  private finishResolver: (() => void) | null = null;

  async start(): Promise<TaskExecutionResult> {
    await new Promise<void>((resolve) => {
      this.finishResolver = resolve;
    });
    return { ok: true, summary: 'resumed and finished' };
  }

  async cancel(): Promise<void> {}

  async pause(): Promise<boolean> {
    return true;
  }

  async resume(): Promise<boolean> {
    this.finishResolver?.();
    return true;
  }
}

class CancelOnlyExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  started = 0;
  cancelled = 0;

  async start(): Promise<TaskExecutionResult> {
    this.started += 1;
    return new Promise(() => undefined);
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
  }
}

class RetryVerificationExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  starts = 0;

  async start(
    _task: RuntimeTask,
    callbacks: {
      checkpoint(phase: string, data: Record<string, unknown>): void;
    },
  ): Promise<TaskExecutionResult> {
    this.starts += 1;
    callbacks.checkpoint('attempt', { starts: this.starts });
    if (this.starts === 1) {
      return {
        ok: false,
        summary: 'temporary failure',
        retryable: true,
      };
    }
    return {
      ok: true,
      summary: 'verified',
      verification: { ok: true, message: 'verified' },
    };
  }

  async cancel(): Promise<void> {}
}

class TimeoutExecutor implements TaskExecutor {
  readonly kind = 'observe' as const;
  cancelled = 0;

  async start(): Promise<TaskExecutionResult> {
    return new Promise(() => undefined);
  }

  async cancel(): Promise<void> {
    this.cancelled += 1;
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out.');
};

describe('TaskScheduler', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-scheduler-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('enforces resource locks across tasks', async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 2 });
    const executor = new GatedExecutor();
    scheduler.registerExecutor(executor);
    const first = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'first',
      priorityClass: 'user-now',
      resources: ['shared'],
    });
    const second = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'second',
      priorityClass: 'user-now',
      resources: ['shared'],
    });
    await waitFor(() => executor.started.includes(first.id));
    expect(executor.started).not.toContain(second.id);
    executor.finish(first.id);
    await waitFor(() => executor.started.includes(second.id));
    executor.finish(second.id);
    await waitFor(() => scheduler.get(second.id)?.status === 'done');
  });

  it('allows concurrent readers and blocks a writer', async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 4 });
    const executor = new GatedExecutor();
    scheduler.registerExecutor(executor);
    const first = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'reader one',
      resources: ['read:file:shared'],
    });
    const second = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'reader two',
      resources: ['read:file:shared'],
    });
    const writer = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'writer',
      resources: ['write:file:shared'],
    });
    await waitFor(
      () =>
        executor.started.includes(first.id) &&
        executor.started.includes(second.id),
    );
    expect(executor.started).not.toContain(writer.id);
    executor.finish(first.id);
    expect(executor.started).not.toContain(writer.id);
    executor.finish(second.id);
    await waitFor(() => executor.started.includes(writer.id));
    executor.finish(writer.id);
  });

  it('deduplicates repeated idempotency keys', async () => {
    const scheduler = new TaskScheduler();
    const executor = new GatedExecutor();
    scheduler.registerExecutor(executor);
    const first = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'one',
      idempotencyKey: 'same-operation',
    });
    const second = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'different goal',
      idempotencyKey: 'same-operation',
    });
    expect(second.id).toBe(first.id);
    await waitFor(() => executor.started.includes(first.id));
    executor.finish(first.id);
  });

  it('retries idempotent tasks and persists checkpoints plus verification', async () => {
    const scheduler = new TaskScheduler();
    const executor = new RetryVerificationExecutor();
    scheduler.registerExecutor(executor);
    const task = await scheduler.submit({
      source: 'system',
      kind: 'observe',
      goal: 'retry',
      contract: {
        sideEffect: 'read',
        idempotent: true,
        retryable: true,
        maxAttempts: 2,
        retryBackoffMs: 0,
        timeoutMs: 1_000,
        resumePolicy: 'restart',
        verification: 'required',
      },
    });
    await waitFor(() => scheduler.get(task.id)?.status === 'done');
    const completed = scheduler.get(task.id);
    expect(completed?.attempts).toBe(2);
    expect(completed?.checkpoint?.revision).toBeGreaterThanOrEqual(1);
    expect(completed?.verification.status).toBe('passed');
  });

  it('times out stalled executors and invokes cancellation', async () => {
    const scheduler = new TaskScheduler();
    const executor = new TimeoutExecutor();
    scheduler.registerExecutor(executor);
    const task = await scheduler.submit({
      source: 'system',
      kind: 'observe',
      goal: 'timeout',
      contract: {
        sideEffect: 'read',
        idempotent: true,
        retryable: false,
        maxAttempts: 1,
        timeoutMs: 50,
        resumePolicy: 'restart',
        verification: 'none',
      },
    });
    await waitFor(() => scheduler.get(task.id)?.status === 'failed');
    expect(scheduler.get(task.id)?.error).toContain('TASK_TIMEOUT');
    expect(executor.cancelled).toBe(1);
  });

  it('retries a failed task without creating a duplicate', async () => {
    const scheduler = new TaskScheduler();
    const executor = new RetryVerificationExecutor();
    scheduler.registerExecutor(executor);
    const task = await scheduler.submit({
      source: 'system',
      kind: 'observe',
      goal: 'manual retry',
      contract: {
        sideEffect: 'read',
        idempotent: true,
        retryable: false,
        maxAttempts: 1,
        timeoutMs: 1_000,
        resumePolicy: 'restart',
        verification: 'required',
      },
    });
    await waitFor(() => scheduler.get(task.id)?.status === 'failed');
    const retried = await scheduler.retry(task.id);
    expect(retried?.status).toBe('queued');
    await waitFor(() => scheduler.get(task.id)?.status === 'done');
    expect(executor.starts).toBe(2);
    expect(
      scheduler.list().filter((entry) => entry.id === task.id),
    ).toHaveLength(1);
  });

  it('preempts a preemptible autonomy task for a direct user task', async () => {
    const scheduler = new TaskScheduler({ maxConcurrent: 1 });
    const executor = new GatedExecutor();
    scheduler.registerExecutor(executor);
    const autonomy = await scheduler.submit({
      source: 'autonomy',
      kind: 'observe',
      goal: 'background',
      priorityClass: 'autonomy',
      resources: ['shared'],
      preemptible: true,
    });
    await waitFor(() => executor.started.includes(autonomy.id));
    const user = await scheduler.submit({
      source: 'user-voice',
      kind: 'observe',
      goal: 'user',
      priorityClass: 'user-now',
      resources: ['shared'],
    });
    await waitFor(() => scheduler.get(autonomy.id)?.status === 'paused');
    await waitFor(() => executor.started.includes(user.id));
    executor.finish(user.id);
    executor.finish(autonomy.id);
  });

  it('executes high-risk atomic tools directly', async () => {
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    const registry = new ToolRegistry(context, pathPolicy);
    const tool: ToolDefinition = {
      name: 'test.confirm',
      domain: 'system',
      description: 'Test confirmation.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      requiresConfirmation: () => 'confirm test',
      async execute() {
        return { ok: true, tool: 'test.confirm', speech: 'done' };
      },
    };
    registry.register(tool);
    const scheduler = new TaskScheduler();
    scheduler.registerExecutor(new AtomicTaskExecutor(registry));
    const task = await scheduler.submit({
      source: 'user-text',
      kind: 'atomic',
      goal: 'confirm',
      payload: { tool: 'test.confirm', args: {} },
      risk: 'high',
    });
    await waitFor(() => scheduler.get(task.id)?.status === 'done');
  });

  it('does not overwrite completion when confirmation resolves immediately', async () => {
    const scheduler = new TaskScheduler();
    scheduler.registerExecutor(new ConfirmationRaceExecutor());
    const task = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'confirm race',
    });
    await waitFor(
      () => scheduler.get(task.id)?.status === 'waiting_confirmation',
    );
    await scheduler.confirm(task.id);
    await waitFor(() => scheduler.get(task.id)?.status === 'done');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.get(task.id)?.status).toBe('done');
  });

  it('does not overwrite completion when resume resolves immediately', async () => {
    const scheduler = new TaskScheduler();
    scheduler.registerExecutor(new ResumeRaceExecutor());
    const task = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'resume race',
    });
    await waitFor(() => scheduler.get(task.id)?.status === 'running');
    await scheduler.pause(task.id);
    await scheduler.resume(task.id);
    await waitFor(() => scheduler.get(task.id)?.status === 'done');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.get(task.id)?.status).toBe('done');
  });

  it('finalizes cancellation even when an executor reports no completion event', async () => {
    const scheduler = new TaskScheduler();
    const executor = new CancelOnlyExecutor();
    scheduler.registerExecutor(executor);
    const task = await scheduler.submit({
      source: 'user-text',
      kind: 'observe',
      goal: 'cancel without callback',
    });
    await waitFor(() => executor.started === 1);
    await scheduler.cancel(task.id);
    expect(scheduler.get(task.id)?.status).toBe('cancelled');
    expect(executor.cancelled).toBe(1);
  });
});
