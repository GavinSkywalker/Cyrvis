import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFastToolContext } from '../tools/matrix';
import { FastToolRouter } from '../tools/router';
import { ToolRegistry } from '../tools/registry';
import type { DesktopHost, ToolDefinition } from '../tools/types';
import { AtomicTaskExecutor } from './executors';
import { ScheduledFastToolExecutor } from './scheduled-fast-tools';
import { TaskScheduler } from './task-scheduler';
import type { FastToolRoute } from '../tools/types';

const route = (
  tool: string,
  risk: FastToolRoute['risk'] = 'low',
): FastToolRoute => ({
  kind: 'execute',
  tool,
  args: {},
  summary: `run ${tool}`,
  requiresConfirmation: false,
  confirmationReason: null,
  risk,
  domain: 'filesystem',
});

const registerTools = (registry: ToolRegistry, executed: string[]): void => {
  const lowRisk: ToolDefinition = {
    name: 'test.low',
    domain: 'filesystem',
    description: 'Low risk test tool.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      executed.push('low');
      context.reportProgress?.('half complete', 50);
      return {
        ok: true,
        tool: 'test.low',
        speech: 'low complete',
        data: { value: 7 },
      };
    },
  };
  const highRisk: ToolDefinition = {
    name: 'test.high',
    domain: 'filesystem',
    description: 'High risk test tool.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    requiresConfirmation: () => 'high risk confirmation',
    async execute() {
      executed.push('high');
      return {
        ok: true,
        tool: 'test.high',
        speech: 'high complete',
      };
    },
  };
  registry.register(lowRisk);
  registry.register(highRisk);
};

describe('ScheduledFastToolExecutor', () => {
  let root: string;
  let registry: ToolRegistry;
  let scheduler: TaskScheduler;
  let executor: ScheduledFastToolExecutor;
  let executed: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-fast-scheduler-'));
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    registry = new ToolRegistry(context, pathPolicy);
    executed = [];
    registerTools(registry, executed);
    scheduler = new TaskScheduler({ maxConcurrent: 2 });
    scheduler.registerExecutor(new AtomicTaskExecutor(registry, 'atomic'));
    executor = new ScheduledFastToolExecutor(scheduler);
  });

  afterEach(async () => {
    executor.dispose();
    scheduler.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs a fast tool as a scheduler task and preserves result data', async () => {
    const outcome = await executor.execute(route('test.low'));

    expect(outcome.ok).toBe(true);
    expect(outcome.result?.data).toEqual({ value: 7 });
    expect(executed).toEqual(['low']);
    expect(scheduler.list().map((task) => task.kind)).toContain('atomic');
    expect(scheduler.list()[0]?.status).toBe('done');
    expect(scheduler.list()[0]?.payload.metadata?.userVisible).toBe(true);
    expect(scheduler.list()[0]?.progress).toMatchObject({
      message: 'half complete',
      percent: 50,
    });
  });

  it('executes a high-risk scheduled tool without a confirmation barrier', async () => {
    const outcome = await executor.execute(route('test.high', 'high'));

    expect(outcome.ok).toBe(true);
    expect(executed).toEqual(['high']);
  });

  it('routes a high-risk router call through the scheduler immediately', async () => {
    const { context } = createFastToolContext({} as DesktopHost, root);
    const router = new FastToolRouter(registry, context, {
      providerCatalog: undefined,
    });
    router.setExecutionScheduler(executor);

    const outcome = await router.execute(route('test.high', 'high'));
    expect(outcome.ok).toBe(true);
    expect(executed).toEqual(['high']);
  });
});
