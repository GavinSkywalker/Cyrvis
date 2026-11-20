/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SystemStateStore } from '../system/system-state';
import type { SteamGame } from '../system/types';
import { createFastToolMatrix } from './matrix';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  ToolDefinition,
  WindowInfo,
} from './types';

class DynamicDesktopHost implements DesktopHost {
  readonly openedPaths: string[] = [];
  readonly openedUrls: string[] = [];

  async openPath(target: string): Promise<void> {
    this.openedPaths.push(target);
  }

  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
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
    return [];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [];
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

const createStateStore = async (
  desktop: DesktopHost,
  games: SteamGame[],
): Promise<SystemStateStore> => {
  const store = new SystemStateStore(desktop, {
    staleMs: 60_000,
    discoverers: {
      applications: async () => [
        {
          id: 'registry-powerpoint',
          name: 'Microsoft PowerPoint',
          source: 'registry',
        },
      ],
      steam: async () => ({ root: games.length ? 'C:\\Steam' : null, games }),
      disks: async () => [],
      battery: async () => null,
      services: async () => [],
      recentFiles: async () => [],
    },
  });
  await store.refresh(true);
  return store;
};

describe('dynamic capability matrix', () => {
  it('keeps a full capability catalog while updating the model tool surface', async () => {
    const desktop = new DynamicDesktopHost();
    const games: SteamGame[] = [];
    const store = await createStateStore(desktop, games);
    const matrix = createFastToolMatrix(desktop, process.cwd(), store);
    const updates: string[][] = [];
    const unsubscribe = matrix.providerCatalog.subscribe?.((tools) => {
      updates.push(tools.map((tool) => tool.function.name));
    });

    try {
      expect(matrix.registry.list()).toHaveLength(90);
      const initialTools = matrix.providerCatalog.tools.map(
        (tool) => tool.function.name,
      );
      expect(initialTools.length).toBeLessThanOrEqual(24);
      expect(initialTools).toContain('cyrvis_capability_search');
      expect(initialTools).not.toContain('cyrvis_steam_launch_game');
      expect(matrix.capabilityCatalog.get('steam.launch_game')).toMatchObject({
        availability: 'unavailable',
      });
      const searched = await matrix.registry.execute('capability.search', {
        query: 'steam',
      });
      const searchResults = searched.data as {
        capabilities: Array<{ id: string; inputSchema?: unknown }>;
      };
      expect(searchResults.capabilities).toContainEqual(
        expect.objectContaining({ id: 'steam.launch_game' }),
      );
      expect(
        searchResults.capabilities.find(
          (capability) => capability.id === 'steam.launch_game',
        )?.inputSchema,
      ).toBeUndefined();

      games.push({
        appId: '570',
        name: 'Dota 2',
        installDirectory: 'C:\\Steam\\dota 2 beta',
        libraryPath: 'C:\\Steam\\steamapps',
      });
      await store.refresh(true);

      const refreshedTools = matrix.providerCatalog.tools.map(
        (tool) => tool.function.name,
      );
      expect(refreshedTools).toContain('cyrvis_steam_launch_game');
      expect(matrix.capabilityCatalog.get('steam.launch_game')).toMatchObject({
        availability: 'available',
      });
      expect(updates.at(-1)).toContain('cyrvis_steam_launch_game');
      expect(matrix.surface.isVisible('steam.launch_game')).toBe(true);
    } finally {
      unsubscribe?.();
      matrix.dispose();
      store.stop();
    }
  });

  it('invokes a hidden capability through the broker and activates it', async () => {
    const desktop = new DynamicDesktopHost();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-dynamic-'));
    const source = path.join(root, 'demo.txt');
    const destination = path.join(root, 'demo-copy.txt');
    await fs.writeFile(source, 'demo', 'utf8');
    const matrix = createFastToolMatrix(desktop, root);

    try {
      expect(matrix.surface.isVisible('fs.copy')).toBe(false);
      const execution = await matrix.router.executeProviderToolCall(
        'cyrvis_capability_invoke',
        {
          toolId: 'fs.copy',
          arguments: { source, destination },
        },
      );

      expect(execution?.outcome.ok).toBe(true);
      expect(execution?.outcome.result?.tool).toBe('capability.invoke');
      expect(execution?.outcome.result?.data).toMatchObject({
        toolId: 'fs.copy',
      });
      expect(await fs.readFile(destination, 'utf8')).toBe('demo');
      expect(matrix.surface.isVisible('fs.copy')).toBe(true);
      expect(matrix.providerCatalog.tools.length).toBeLessThanOrEqual(24);
    } finally {
      matrix.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps high-risk broker capabilities behind confirmation', async () => {
    const desktop = new DynamicDesktopHost();
    const matrix = createFastToolMatrix(desktop, process.cwd());
    let executions = 0;
    const dangerousTool: ToolDefinition = {
      name: 'test.dangerous',
      domain: 'system',
      description: 'Test-only dangerous capability.',
      risk: 'high',
      capability: {
        providerId: 'test',
        tier: 4,
        activation: 'on-demand',
      },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      requiresConfirmation: () => '测试操作需要确认。',
      async execute() {
        executions += 1;
        return {
          ok: true,
          tool: 'test.dangerous',
          speech: '测试操作已完成。',
        };
      },
    };
    matrix.registry.register(dangerousTool, 'test');
    matrix.surface.refresh();

    try {
      const execution = await matrix.router.executeProviderToolCall(
        'cyrvis_capability_invoke',
        {
          toolId: 'test.dangerous',
          arguments: {},
        },
      );
      expect(execution?.outcome.ok).toBe(false);
      expect(execution?.outcome.speech).toBe('敏感操作，是否执行？');
      expect(executions).toBe(0);
      expect(matrix.router.hasPendingConfirmation()).toBe(true);
      const confirmed = await matrix.router.handleText('确认执行');
      expect(confirmed.ok).toBe(true);
      expect(executions).toBe(1);
    } finally {
      matrix.dispose();
    }
  });

  it('supports provider replacement in the dynamic registry', async () => {
    const desktop = new DynamicDesktopHost();
    const matrix = createFastToolMatrix(desktop, process.cwd());
    const baseTool: ToolDefinition = {
      name: 'test.base',
      domain: 'system',
      description: 'Base test capability.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      async execute() {
        return { ok: true, tool: 'test.base', speech: 'base' };
      },
    };
    const nextTool: ToolDefinition = {
      ...baseTool,
      name: 'test.next',
      description: 'Replacement test capability.',
    };

    try {
      const revision = matrix.registry.revision;
      matrix.registry.replaceProvider('test-provider', [baseTool]);
      expect(matrix.registry.get('test.base')).toBeDefined();
      expect(matrix.registry.revision).toBeGreaterThan(revision);
      matrix.registry.replaceProvider('test-provider', [nextTool]);
      expect(matrix.registry.get('test.base')).toBeUndefined();
      expect(matrix.registry.get('test.next')).toBeDefined();
    } finally {
      matrix.dispose();
    }
  });
});
