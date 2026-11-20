import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SystemStateStore } from '../system/system-state';
import { createFastToolMatrix, type FastToolMatrix } from '../tools/matrix';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  ToolDefinition,
  WindowInfo,
} from '../tools/types';

class ContextDesktopHost implements DesktopHost {
  foreground: WindowInfo | null;
  readonly urls: string[] = [];

  constructor(foreground: WindowInfo | null) {
    this.foreground = foreground;
  }

  async openPath(): Promise<void> {
    return undefined;
  }
  async openUrl(url: string): Promise<void> {
    this.urls.push(url);
  }
  async clipboardRead(): Promise<string> {
    return '';
  }
  async clipboardWrite(): Promise<void> {
    return undefined;
  }
  async launchApplication(name: string): Promise<string> {
    return name;
  }
  async closeApplication(name: string): Promise<string> {
    return name;
  }
  async listProcesses(): Promise<ProcessInfo[]> {
    return this.foreground
      ? [
          {
            pid: this.foreground.pid,
            name: this.foreground.process,
            title: this.foreground.title,
          },
        ]
      : [];
  }
  async listWindows(): Promise<WindowInfo[]> {
    return this.foreground ? [this.foreground] : [];
  }
  async getForegroundWindow(): Promise<WindowInfo | null> {
    return this.foreground;
  }
  async controlWindow(query: string): Promise<string> {
    return query;
  }
  async minimizeAllWindows(): Promise<number> {
    return 0;
  }
  async restoreAllWindows(): Promise<number> {
    return 0;
  }
  async createPresentation(): Promise<void> {
    return undefined;
  }
  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: process.platform,
      release: 'test',
      architecture: 'x64',
      hostname: 'cyrvis-test',
      homeDirectory: os.homedir(),
      cpuCount: 8,
      totalMemoryBytes: 16,
      freeMemoryBytes: 8,
      uptimeSeconds: 100,
    };
  }
  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 100, freeBytes: 50 };
  }
}

const createStore = async (
  host: ContextDesktopHost,
  applications: Array<{ id: string; name: string }>,
): Promise<SystemStateStore> => {
  const store = new SystemStateStore(host, {
    staleMs: 60_000,
    discoverers: {
      applications: async () =>
        applications.map((application) => ({
          ...application,
          source: 'registry' as const,
        })),
      steam: async () => ({ root: null, games: [] }),
      disks: async () => [],
      battery: async () => null,
      services: async () => [],
      recentFiles: async () => [],
    },
  });
  await store.refresh(true);
  return store;
};

const vscodeTool: ToolDefinition = {
  name: 'vscode.open_folder',
  domain: 'filesystem',
  description: 'Open a folder in the active Visual Studio Code window.',
  risk: 'low',
  capability: {
    providerId: 'vscode',
    tier: 2,
    activation: 'on-demand',
    priority: 68,
    requirements: { applications: ['Visual Studio Code'] },
  },
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  prepare: (input) => ({ path: String(input.path || '') }),
  async execute(args) {
    return {
      ok: true,
      tool: 'vscode.open_folder',
      speech: `已打开 ${String(args.path)}。`,
      data: {
        path: String(args.path),
        verification: {
          kind: 'window_exists',
          target: 'Visual Studio Code',
        },
      },
    };
  },
};

const noBuiltinProviders = { tools: [], manifests: [] };

describe('DynamicContextStore', () => {
  let matrix: FastToolMatrix | null = null;
  let store: SystemStateStore | null = null;

  const dispose = () => {
    matrix?.dispose();
    store?.stop();
    matrix = null;
    store = null;
  };

  it('binds provider capabilities to the active application and boosts them', async () => {
    const host = new ContextDesktopHost({
      pid: 42,
      process: 'Code',
      title: 'project - Visual Studio Code',
      handle: 100,
      focused: true,
    });
    store = await createStore(host, [
      { id: 'vscode', name: 'Visual Studio Code' },
    ]);
    matrix = createFastToolMatrix(host, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
    });
    matrix.registry.register(vscodeTool, 'vscode');
    matrix.providerRegistry.register(
      {
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'vscode',
        name: 'Visual Studio Code',
        version: '1.0.0',
        trust: 'builtin',
        requirements: { applications: ['Visual Studio Code'] },
        transport: { type: 'builtin', toolIds: ['vscode.open_folder'] },
      },
      'test',
    );
    matrix.providerRegistry.updateStatus('vscode', {
      availability: 'available',
      toolIds: ['vscode.open_folder'],
    });
    matrix.dynamicContext.refresh();

    try {
      const snapshot = matrix.dynamicContext.getSnapshot();
      const active = snapshot.resources.find((resource) => resource.active);
      expect(active).toMatchObject({
        kind: 'application',
        name: 'Visual Studio Code',
      });
      expect(active?.providerIds).toContain('vscode');
      expect(snapshot.user.activeApplication?.value).toBe(active?.id);
      expect(snapshot.bindings).toContainEqual(
        expect.objectContaining({
          capabilityId: 'vscode.open_folder',
          resourceId: active?.id,
          active: true,
        }),
      );
      expect(
        matrix.dynamicContext.getCapabilityBoost('vscode.open_folder'),
      ).toBeGreaterThanOrEqual(45);
      expect(matrix.surface.isVisible('vscode.open_folder')).toBe(true);
      expect(matrix.surface.isVisible('context.snapshot')).toBe(true);

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-binding-'));
      try {
        const execution = await matrix.dynamicContext.executeBinding(
          active!.id,
          'vscode.open_folder',
          { path: root },
        );
        expect(execution.result.ok).toBe(true);
        expect(execution.verification).toMatchObject({
          ok: true,
          kind: 'window_exists',
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }

      host.foreground = {
        pid: 88,
        process: 'UnknownEditor',
        title: 'Another window',
        handle: 300,
        focused: true,
      };
      await store.refresh(true);
      expect(
        matrix.dynamicContext.getSnapshot().fallbackResourceIds,
      ).toHaveLength(1);
      expect(matrix.surface.isVisible('vscode.open_folder')).toBe(false);
    } finally {
      dispose();
    }
  });

  it('marks unknown active applications for UI Automation fallback', async () => {
    const host = new ContextDesktopHost({
      pid: 77,
      process: 'UnknownEditor',
      title: 'Untitled Document',
      handle: 200,
      focused: true,
    });
    store = await createStore(host, []);
    matrix = createFastToolMatrix(host, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
    });

    try {
      const snapshot = matrix.dynamicContext.getSnapshot();
      expect(snapshot.fallbackResourceIds).toHaveLength(1);
      expect(
        snapshot.resources.find((resource) => resource.active),
      ).toMatchObject({
        health: 'unknown',
        providerIds: [],
      });
      expect(
        snapshot.bindings.some(
          (binding) => binding.capabilityId === 'ui.inspect' && binding.active,
        ),
      ).toBe(process.platform === 'win32');
      if (process.platform === 'win32') {
        expect(matrix.surface.isVisible('ui.inspect')).toBe(true);
        expect(matrix.surface.isVisible('ui.action')).toBe(true);
      }
    } finally {
      dispose();
    }
  });

  it('exposes dynamic resources and bindings through context tools', async () => {
    const host = new ContextDesktopHost({
      pid: 42,
      process: 'Code',
      title: 'project - Visual Studio Code',
      handle: 100,
      focused: true,
    });
    store = await createStore(host, [
      { id: 'vscode', name: 'Visual Studio Code' },
    ]);
    matrix = createFastToolMatrix(host, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
    });

    try {
      const result = await matrix.registry.execute('context.resources', {
        query: 'visual studio',
        activeOnly: true,
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        resources: expect.arrayContaining([
          expect.objectContaining({
            name: 'Visual Studio Code',
            active: true,
          }),
        ]),
      });
      matrix.dynamicContext.recordUserText('这个函数怎么修改');
      const intent = await matrix.registry.execute('context.intent', {});
      expect(intent).toMatchObject({
        ok: true,
        data: {
          activity: 'coding',
          recentUtterance: {
            text: '这个函数怎么修改',
          },
          candidateIntents: [
            expect.objectContaining({
              kind: 'edit',
            }),
          ],
        },
      });
    } finally {
      dispose();
    }
  });

  it('adds recently opened files and websites as transient resources', async () => {
    const host = new ContextDesktopHost(null);
    store = await createStore(host, []);
    matrix = createFastToolMatrix(host, process.cwd(), store, {
      builtinProviders: noBuiltinProviders,
    });
    matrix.registry.register({
      name: 'test.open_resource',
      domain: 'filesystem',
      description: 'Test-only resource opener.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          url: { type: 'string' },
        },
        additionalProperties: false,
      },
      prepare: (input) => input,
      async execute(args) {
        return {
          ok: true,
          tool: 'test.open_resource',
          speech: 'opened',
          data: args,
        };
      },
    });

    try {
      await matrix.registry.execute('test.open_resource', {
        path:
          process.platform === 'win32'
            ? 'C:\\work\\notes.txt'
            : '/work/notes.txt',
      });
      await matrix.registry.execute('test.open_resource', {
        url: 'https://example.com/docs',
      });
      const snapshot = matrix.dynamicContext.getSnapshot();
      expect(snapshot.resources).toContainEqual(
        expect.objectContaining({
          kind: 'file',
          name: 'notes.txt',
        }),
      );
      expect(snapshot.resources).toContainEqual(
        expect.objectContaining({
          kind: 'website',
          name: 'example.com',
        }),
      );
      expect(snapshot.user.recentResourceIds).toHaveLength(2);
    } finally {
      dispose();
    }
  });
});
