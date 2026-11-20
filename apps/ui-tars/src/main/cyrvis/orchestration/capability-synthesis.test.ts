import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: llm.create,
      },
    };
  },
}));

import { CapabilityCatalog } from '../tools/capability-catalog';
import { createFastToolContext } from '../tools/matrix';
import { ToolRegistry } from '../tools/registry';
import { ProviderRegistry } from '../tools/provider-registry';
import type { DesktopHost, ToolDefinition } from '../tools/types';
import { LocalWorkflowEngine } from '../tools/workflow-engine';
import { CapabilitySynthesisService } from './capability-synthesis';
import { RuntimeMemoryStore } from './runtime-memory';

describe('CapabilitySynthesisService', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-capability-'));
    llm.create.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              proposals: [
                {
                  title: '运行测试流程',
                  reason: '用户反复需要运行测试',
                  risk: 'low',
                  workflow: {
                    name: '运行测试流程',
                    steps: [
                      {
                        id: 'echo',
                        tool: 'test.echo',
                        args: { text: 'ok' },
                      },
                    ],
                  },
                },
              ],
            }),
          },
        },
      ],
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('validates a synthesized workflow and activates it as a runtime tool', async () => {
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    const registry = new ToolRegistry(context, pathPolicy);
    const echo: ToolDefinition = {
      name: 'test.echo',
      domain: 'system',
      description: 'Echo text.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      prepare: (input) => ({ text: String(input.text) }),
      async execute(args) {
        return {
          ok: true,
          tool: 'test.echo',
          speech: String(args.text),
        };
      },
    };
    registry.register(echo);
    const catalog = new CapabilityCatalog(registry);
    const workflow = new LocalWorkflowEngine(registry);
    const memory = new RuntimeMemoryStore();
    const synthesis = new CapabilitySynthesisService(
      registry,
      catalog,
      workflow,
      undefined,
      undefined,
      memory,
      { apiKey: 'test-key', model: 'test-model' },
    );
    await synthesis.ready();
    const proposals = await synthesis.synthesize('运行测试');
    expect(proposals).toHaveLength(1);
    const approved = await synthesis.approve(proposals[0].id);
    expect(approved).toMatchObject({
      status: 'approved',
      activatedToolId: expect.stringContaining('synthesized.workflow.'),
    });
    expect(approved?.activatedToolId).not.toBeNull();
    expect(registry.get(approved!.activatedToolId!)).toBeTruthy();
    const result = await registry.execute(approved!.activatedToolId!, {});
    expect(result.ok).toBe(true);
  });

  it('registers an approved provider proposal as untrusted and disabled', async () => {
    const { context, pathPolicy } = createFastToolContext(
      {} as DesktopHost,
      root,
    );
    const registry = new ToolRegistry(context, pathPolicy);
    const catalog = new CapabilityCatalog(registry);
    const workflow = new LocalWorkflowEngine(registry);
    const memory = new RuntimeMemoryStore();
    const providers = new ProviderRegistry();
    const synthesis = new CapabilitySynthesisService(
      registry,
      catalog,
      workflow,
      undefined,
      undefined,
      memory,
      { providers },
    );
    const proposal = await synthesis.proposeProvider(
      {
        id: 'test-provider',
        name: 'Test Provider',
        version: '1.0.0',
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
      'test',
    );
    await synthesis.approve(proposal.id);
    expect(providers.get('test-provider')).toMatchObject({
      availability: 'unknown',
      manifest: {
        trust: 'untrusted',
        enabled: false,
      },
    });
  });
});
