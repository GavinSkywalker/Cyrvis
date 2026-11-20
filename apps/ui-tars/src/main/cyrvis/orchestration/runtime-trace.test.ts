import { describe, expect, it } from 'vitest';

import { RuntimeTraceStore } from './runtime-trace';

describe('RuntimeTraceStore', () => {
  it('records bounded events and detects incomplete task lifecycles', () => {
    let now = 1_000;
    const trace = new RuntimeTraceStore({
      now: () => now,
      maxEvents: 100,
    });
    trace.record({
      category: 'task',
      name: 'submitted',
      summary: 'submitted',
      taskId: 'task-1',
    });
    now += 1;
    trace.record({
      category: 'task',
      name: 'started',
      summary: 'started',
      taskId: 'task-1',
    });
    now += 1;
    trace.record({
      category: 'task',
      name: 'done',
      summary: 'done',
      taskId: 'task-1',
    });
    now += 1;
    trace.record({
      category: 'intent',
      name: 'episode.changed',
      summary: 'editing',
    });

    const replay = trace.replay();
    expect(replay.taskLifecycles[0]).toMatchObject({
      taskId: 'task-1',
      complete: true,
      states: ['submitted', 'started', 'done'],
    });
    expect(replay.gaps).toEqual([]);
    expect(trace.list({ limit: 2 })).toHaveLength(2);
  });

  it('redacts sensitive summaries and data', () => {
    const trace = new RuntimeTraceStore();
    const event = trace.record({
      category: 'tool',
      name: 'network.request',
      summary: 'api key: sk-secret-value',
      // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
      data: { password: 'hidden', value: 1 },
    });
    expect(event.summary).toBe('[敏感轨迹已过滤]');
    expect(event.data).toMatchObject({ redacted: true });
  });
});
