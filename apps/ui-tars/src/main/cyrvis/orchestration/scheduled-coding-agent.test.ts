import { describe, expect, it, vi } from 'vitest';

import { ScheduledCodingAgent } from './scheduled-coding-agent';
import { TaskScheduler } from './task-scheduler';

describe('ScheduledCodingAgent', () => {
  it('routes coding starts and cancellation through the task scheduler', async () => {
    const scheduler = new TaskScheduler();
    let finish!: (value: { ok: boolean; summary: string }) => void;
    scheduler.registerExecutor({
      kind: 'coding',
      async start() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      async cancel() {},
    });
    await scheduler.ready();
    const agent = new ScheduledCodingAgent(scheduler, 'D:\\workspace');
    const started = await agent.start('实现测试');
    expect(started).toMatchObject({
      status: 'running',
      instruction: '实现测试',
      workspace: 'D:\\workspace',
    });
    await vi.waitFor(() => expect(scheduler.list(true)).toHaveLength(1));
    finish({ ok: true, summary: '完成' });
    await vi.waitFor(() => expect(agent.getStatus().status).toBe('done'));
    expect(agent.getStatus().result).toBe('完成');
  });
});
