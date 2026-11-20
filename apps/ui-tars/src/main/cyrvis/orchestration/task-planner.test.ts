import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityCatalog } from '../tools/capability-catalog';
import { createFastToolContext } from '../tools/matrix';
import { ToolRegistry } from '../tools/registry';
import type { DesktopHost, ToolDefinition } from '../tools/types';
import { AtomicTaskExecutor } from './executors';
import { TaskPlanner } from './task-planner';
import { TaskScheduler } from './task-scheduler';

describe('TaskPlanner', () => {
  let root: string;
  let scheduler: TaskScheduler;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-planner-'));
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    registry = new ToolRegistry(context, pathPolicy);
    const tool: ToolDefinition = {
      name: 'test.noop',
      domain: 'system',
      description: 'No-op test tool.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () => ({
        ok: true,
        tool: 'test.noop',
        speech: 'done',
      }),
    };
    registry.register(tool);
    scheduler = new TaskScheduler();
    scheduler.registerExecutor(new AtomicTaskExecutor(registry));
  });

  afterEach(async () => {
    scheduler.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('previews a validated plan without submitting tasks', async () => {
    const planner = new TaskPlanner(scheduler, new CapabilityCatalog(registry));
    const plan = await planner.compile({
      goal: 'preview',
      execute: false,
      steps: [
        {
          key: 'first',
          kind: 'atomic',
          goal: 'first',
          payload: { tool: 'test.noop' },
        },
      ],
    });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].taskId).toBeNull();
  });

  it('submits dependencies in topological order', async () => {
    const planner = new TaskPlanner(scheduler, new CapabilityCatalog(registry));
    const plan = await planner.compile({
      goal: 'execute',
      execute: true,
      steps: [
        {
          key: 'child',
          kind: 'atomic',
          goal: 'child',
          dependsOn: ['parent'],
          payload: { tool: 'test.noop' },
        },
        {
          key: 'parent',
          kind: 'atomic',
          goal: 'parent',
          payload: { tool: 'test.noop' },
        },
      ],
    });
    expect(plan.steps.map((step) => step.key)).toEqual(['parent', 'child']);
    expect(plan.steps.every((step) => Boolean(step.taskId))).toBe(true);
  });
});
