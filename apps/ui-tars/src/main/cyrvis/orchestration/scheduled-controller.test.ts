import { describe, expect, it, vi } from 'vitest';

import type { ControllerEvent } from '../types';
import { ScheduledTaskController } from './scheduled-controller';
import { TaskScheduler, type TaskExecutorCallbacks } from './task-scheduler';

describe('ScheduledTaskController', () => {
  it('maps the central GUI task lifecycle to the legacy controller contract', async () => {
    const scheduler = new TaskScheduler();
    let finish!: (value: { ok: boolean; summary: string }) => void;
    scheduler.registerExecutor({
      kind: 'gui',
      async start() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      async cancel() {},
    });
    await scheduler.ready();
    const controller = new ScheduledTaskController(scheduler);
    const events: ControllerEvent[] = [];
    controller.onEvent((event) => events.push(event));
    const task = controller.startTask('整理窗口', 'voice');
    expect(task).toMatchObject({
      status: 'starting',
      instruction: '整理窗口',
    });
    await vi.waitFor(() =>
      expect(controller.getStatus().status).toBe('executing'),
    );
    finish({ ok: true, summary: '任务完成' });
    await vi.waitFor(() => expect(controller.getStatus().status).toBe('done'));
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_started', 'task_executing', 'task_done']),
    );
  });

  it('gives every progress event a new step for throttled speech', async () => {
    const scheduler = new TaskScheduler();
    let progress!: TaskExecutorCallbacks['progress'];
    scheduler.registerExecutor({
      kind: 'gui',
      async start(_task, callbacks) {
        progress = callbacks.progress;
        return new Promise(() => undefined);
      },
      async cancel() {},
    });
    await scheduler.ready();
    const controller = new ScheduledTaskController(scheduler);
    const events: ControllerEvent[] = [];
    controller.onEvent((event) => events.push(event));
    controller.startTask('整理窗口', 'voice');
    await vi.waitFor(() => expect(progress).toBeTypeOf('function'));

    progress('第一步');
    progress('第二步');

    await vi.waitFor(() => {
      const updates = events.filter((event) => event.type === 'step_update');
      expect(updates.map((event) => event.step)).toEqual([1, 2]);
    });
  });
});
