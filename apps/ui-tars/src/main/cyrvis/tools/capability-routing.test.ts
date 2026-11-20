import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityBroker } from './capability-broker';
import { CapabilityCatalog } from './capability-catalog';
import { createFastToolContext } from './matrix';
import { ToolRegistry } from './registry';
import { ToolSurface } from './tool-surface';
import type { DesktopHost, ToolDefinition } from './types';

describe('capability routing', () => {
  let root: string;
  let broker: CapabilityBroker;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-route-'));
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    const registry = new ToolRegistry(context, pathPolicy);
    const primary: ToolDefinition = {
      name: 'test.primary',
      domain: 'system',
      description: 'Primary provider route.',
      risk: 'low',
      capability: {
        providerId: 'primary',
        priority: 60,
        fallbackToolIds: ['test.fallback'],
        latencyClass: 'fast',
        costClass: 'free',
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () => ({
        ok: false,
        tool: 'test.primary',
        speech: 'primary unavailable',
        error: { code: 'PRIMARY_FAILED', message: 'primary unavailable' },
      }),
    };
    const fallback: ToolDefinition = {
      name: 'test.fallback',
      domain: 'system',
      description: 'Fallback provider route.',
      risk: 'low',
      capability: {
        providerId: 'fallback',
        priority: 50,
        latencyClass: 'normal',
        costClass: 'low',
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () => ({
        ok: true,
        tool: 'test.fallback',
        speech: 'fallback complete',
        data: { route: 'fallback' },
      }),
    };
    registry.register(primary);
    registry.register(fallback);
    const catalog = new CapabilityCatalog(registry);
    const surface = new ToolSurface(registry, catalog);
    broker = new CapabilityBroker(registry, catalog, surface);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns explainable ranked routes', () => {
    const routes = broker.route('test primary');
    expect(routes[0].capability.id).toBe('test.primary');
    expect(routes[0].reasons).toContain('latency=fast');
    expect(routes[0].score).toBeGreaterThan(0);
  });

  it('uses a declared fallback when the primary provider fails', async () => {
    const result = await broker.invoke(
      'test.primary',
      {},
      { allowFallbacks: true },
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      toolId: 'test.primary',
      fallbackToolId: 'test.fallback',
    });
  });
});
