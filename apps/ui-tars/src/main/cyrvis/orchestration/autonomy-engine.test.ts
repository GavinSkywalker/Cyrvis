import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutonomyEngine } from './autonomy-engine';
import { RuntimeMemoryStore } from './runtime-memory';
import { TaskScheduler } from './task-scheduler';

describe('AutonomyEngine', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-autonomy-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates standing-goal proposals and queues accepted work', async () => {
    let now = 100_000;
    const scheduler = new TaskScheduler();
    scheduler.registerExecutor({
      kind: 'gui',
      async start() {
        return { ok: true, summary: 'done' };
      },
      async cancel() {},
    });
    const memory = new RuntimeMemoryStore({
      stateFile: path.join(root, 'memory.json'),
      now: () => now,
    });
    const autonomy = new AutonomyEngine(scheduler, memory, {
      stateFile: path.join(root, 'autonomy.json'),
      now: () => now,
      mode: 'suggest',
    });
    await autonomy.addGoal('整理本周项目进展', 5 * 60_000);
    await autonomy.tick();
    const proposal = autonomy
      .snapshot()
      .proposals.find((entry) => entry.status === 'proposed');
    expect(proposal).toMatchObject({
      taskKind: 'gui',
      goal: '整理本周项目进展',
    });

    const task = await autonomy.accept(proposal!.id);
    expect(task).toMatchObject({
      source: 'autonomy',
      priorityClass: 'autonomy',
      goal: '整理本周项目进展',
    });
    expect(
      autonomy.snapshot().proposals.find((entry) => entry.id === proposal!.id),
    ).toMatchObject({
      status: 'queued',
      queuedTaskId: task!.id,
    });
  });

  it('keeps proposals inert in suggest mode until accepted', async () => {
    const scheduler = new TaskScheduler();
    scheduler.registerExecutor({
      kind: 'gui',
      async start() {
        return { ok: true, summary: 'done' };
      },
      async cancel() {},
    });
    const memory = new RuntimeMemoryStore();
    const autonomy = new AutonomyEngine(scheduler, memory, {
      mode: 'suggest',
    });
    await autonomy.addGoal('检查项目风险', 5 * 60_000);
    await autonomy.tick();
    expect(scheduler.list(true)).toHaveLength(0);
    const proposal = autonomy.snapshot().proposals[0];
    await autonomy.reject(proposal.id);
    expect(autonomy.snapshot().proposals[0].status).toBe('rejected');
  });

  it('marks proposals non-interruptive while the user is focused on work', async () => {
    const scheduler = new TaskScheduler();
    const autonomy = new AutonomyEngine(scheduler, new RuntimeMemoryStore(), {
      mode: 'suggest',
    });
    autonomy.setSignalProvider(() => ({
      activity: 'coding',
      activeApplication: 'Code',
      activeWindow: 'main.ts',
      gazeTarget: 'Editor',
      recentUtterance: '修复这个错误',
      focusedControl: 'Editor',
      recentUtteranceAgeMs: 5_000,
    }));
    await autonomy.tick();
    const proposal = autonomy.snapshot().proposals[0];
    expect(proposal.attentionCost).toBeGreaterThanOrEqual(0.8);
    expect(proposal.interruptive).toBe(false);
  });
});
