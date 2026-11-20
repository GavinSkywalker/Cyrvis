import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFastToolContext } from './matrix';
import { ToolRegistry } from './registry';
import type { DesktopHost, ToolDefinition } from './types';

describe('tool verification contracts', () => {
  let root: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-verify-'));
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    registry = new ToolRegistry(context, pathPolicy);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('turns a failed postcondition into a failed tool result', async () => {
    const tool: ToolDefinition = {
      name: 'test.verify_failure',
      domain: 'system',
      description: 'Verification failure.',
      risk: 'low',
      contract: { verification: 'required' },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () => ({
        ok: true,
        tool: 'test.verify_failure',
        speech: 'executed',
      }),
      verify: async () => ({ ok: false, message: 'postcondition failed' }),
    };
    registry.register(tool);
    const result = await registry.execute('test.verify_failure', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_VERIFICATION_FAILED');
  });

  it('attaches successful verification evidence to result data', async () => {
    const tool: ToolDefinition = {
      name: 'test.verify_success',
      domain: 'system',
      description: 'Verification success.',
      risk: 'low',
      contract: { verification: 'required' },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      execute: async () => ({
        ok: true,
        tool: 'test.verify_success',
        speech: 'executed',
        data: { value: 1 },
      }),
      verify: async () => ({ ok: true, message: 'verified' }),
    };
    registry.register(tool);
    const result = await registry.execute('test.verify_success', {});
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      value: 1,
      verification: { ok: true, message: 'verified' },
    });
  });
});
