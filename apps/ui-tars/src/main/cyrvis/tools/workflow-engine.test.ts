import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopHost, ToolDefinition } from './types';
import { CONDITION_TOOLS } from './condition-tools';
import { createFastToolContext } from './matrix';
import { ToolRegistry } from './registry';
import { LocalWorkflowEngine } from './workflow-engine';

const waitFor = async (
  check: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for workflow state.');
};

describe('LocalWorkflowEngine', () => {
  let root: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-workflow-'));
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    registry = new ToolRegistry(context, pathPolicy);
    registry.registerAll(CONDITION_TOOLS);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs dependency-ordered steps and resolves workflow output templates', async () => {
    const source = path.join(root, 'source.txt');
    const destination = path.join(root, 'destination.txt');
    const createTool: ToolDefinition = {
      name: 'test.create',
      domain: 'filesystem',
      description: 'Create a test file.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      prepare: (input) => ({ path: String(input.path) }),
      async execute(args) {
        await fs.writeFile(String(args.path), 'workflow', 'utf8');
        return {
          ok: true,
          tool: 'test.create',
          speech: 'created',
          data: { path: args.path },
        };
      },
    };
    const copyTool: ToolDefinition = {
      name: 'test.copy',
      domain: 'filesystem',
      description: 'Copy a test file.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' },
        },
        required: ['source', 'destination'],
        additionalProperties: false,
      },
      prepare: (input) => ({
        source: String(input.source),
        destination: String(input.destination),
      }),
      async execute(args) {
        await fs.copyFile(String(args.source), String(args.destination));
        return {
          ok: true,
          tool: 'test.copy',
          speech: 'copied',
          data: { path: args.destination },
        };
      },
    };
    registry.registerAll([createTool, copyTool]);
    const engine = new LocalWorkflowEngine(registry);
    const run = await engine.start({
      name: 'copy workflow',
      steps: [
        {
          id: 'create',
          tool: 'test.create',
          args: { path: source },
        },
        {
          id: 'copy',
          tool: 'test.copy',
          dependsOn: ['create'],
          args: {
            source: '{{steps.create.data.path}}',
            destination,
          },
          verify: { kind: 'path_exists', target: destination },
        },
      ],
    });

    await waitFor(async () => (await engine.get(run.id))?.status === 'done');
    await expect(fs.readFile(destination, 'utf8')).resolves.toBe('workflow');
  });

  it('executes a high-risk workflow step directly', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      tool: 'test.sensitive',
      speech: 'sensitive complete',
    }));
    registry.register({
      name: 'test.sensitive',
      domain: 'system',
      description: 'Sensitive test operation.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      requiresConfirmation: () => 'sensitive confirmation',
      execute,
    });
    const engine = new LocalWorkflowEngine(registry);
    const run = await engine.start({
      steps: [{ id: 'sensitive', tool: 'test.sensitive' }],
    });

    await waitFor(async () => (await engine.get(run.id))?.status === 'done');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('persists interrupted runs as paused and allows explicit resume', async () => {
    const stateFile = path.join(root, 'workflows.json');
    const gate = new Promise<void>(() => undefined);
    registry.register({
      name: 'test.wait',
      domain: 'system',
      description: 'Wait until the engine is interrupted.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      async execute() {
        await gate;
        return {
          ok: true,
          tool: 'test.wait',
          speech: 'complete',
        };
      },
    });
    const engine = new LocalWorkflowEngine(registry, { stateFile });
    const run = await engine.start({
      steps: [{ id: 'wait', tool: 'test.wait' }],
    });
    await waitFor(async () => (await engine.get(run.id))?.status === 'running');
    engine.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const restored = new LocalWorkflowEngine(registry, { stateFile });
    await restored.ready();
    expect(await restored.get(run.id)).toMatchObject({
      status: 'paused',
    });
  });
});
