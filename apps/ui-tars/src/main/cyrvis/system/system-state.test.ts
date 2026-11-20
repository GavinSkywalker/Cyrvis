/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from '../tools/types';
import { createFastToolMatrix } from '../tools/matrix';
import { SystemStateStore } from './system-state';

class FakeDesktopHost implements DesktopHost {
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
    return [{ pid: 10, name: 'steam', title: 'Steam' }];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [{ pid: 10, process: 'steam', title: 'Steam' }];
  }

  async controlWindow(query: string): Promise<string> {
    return query;
  }

  async minimizeAllWindows(): Promise<number> {
    return 1;
  }

  async restoreAllWindows(): Promise<number> {
    return 1;
  }

  async createPresentation(): Promise<void> {
    return undefined;
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: 'win32',
      release: 'test',
      architecture: 'x64',
      hostname: 'cyrvis',
      homeDirectory: 'C:\\Users\\test',
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

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemStateStore', () => {
  it('discovers apps and Steam games, exposes capabilities, and launches them', async () => {
    const desktop = new FakeDesktopHost();
    const store = new SystemStateStore(desktop, {
      staleMs: 60_000,
      discoverers: {
        applications: async () => [
          {
            id: 'start-steam',
            name: 'Steam',
            source: 'start-app',
            launchTarget: 'shell:AppsFolder\\Steam',
          },
          {
            id: 'registry-vscode',
            name: 'Visual Studio Code',
            source: 'registry',
            executable: 'C:\\Apps\\Code.exe',
          },
        ],
        steam: async () => ({
          root: 'C:\\Steam',
          games: [
            {
              appId: '570',
              name: 'Dota 2',
              installDirectory: 'C:\\Steam\\dota 2 beta',
              libraryPath: 'C:\\Steam\\steamapps',
            },
          ],
        }),
        disks: async () => [
          { name: 'C:', mountPoint: 'C:\\', totalBytes: 100, freeBytes: 50 },
        ],
        battery: async () => ({ percent: 80, charging: true }),
        services: async () => [
          {
            name: 'SteamClientService',
            displayName: 'Steam Client Service',
            status: 'Running',
            startType: 'Manual',
          },
        ],
        recentFiles: async () => [
          {
            name: 'report.docx',
            path: 'C:\\Users\\test\\report.docx',
            lastUsedAt: 100,
          },
        ],
      },
    });

    const snapshot = await store.refresh(true);
    expect(snapshot.installedApplications.map((app) => app.name)).toContain(
      'Steam',
    );
    expect(snapshot.installedApplications.map((app) => app.name)).toContain(
      'Dota 2',
    );
    expect(snapshot.capabilities).toContain('steam.launch');
    expect(snapshot.capabilities).toContain('service.status');
    expect(snapshot.recentFiles).toContainEqual(
      expect.objectContaining({ name: 'report.docx' }),
    );
    expect(store.searchApplications('steam')).toHaveLength(1);
    expect(store.getContext()).toContain('Visual Studio Code');
    expect(store.getContext()).toContain('report.docx');

    const steam = await store.launchApplication('Steam');
    expect(steam.name).toBe('Steam');
    expect(desktop.openedUrls.at(-1)).toContain('shell:AppsFolder');

    const game = await store.launchSteamGame('Dota 2');
    expect(game.appId).toBe('570');
    expect(desktop.openedUrls.at(-1)).toBe('steam://rungameid/570');

    const matrix = createFastToolMatrix(desktop, process.cwd(), store);
    expect(
      matrix.providerCatalog.tools.map((tool) => tool.function.name),
    ).toContain('cyrvis_software_launch');
    const launched = await matrix.registry.execute(
      'software.launch',
      { query: 'Steam' },
      { confirmed: true },
    );
    expect(launched.ok).toBe(true);
    store.stop();
  });

  it('refreshes runtime state on a timer and performs periodic full scans', async () => {
    vi.useFakeTimers();
    let appScans = 0;
    let runtimeScans = 0;
    const desktop = new FakeDesktopHost();
    desktop.listProcesses = async () => {
      runtimeScans += 1;
      return [];
    };
    const store = new SystemStateStore(desktop, {
      runtimeRefreshMs: 1_000,
      fullRefreshMs: 5_000,
      discoverers: {
        applications: async () => {
          appScans += 1;
          return [];
        },
        steam: async () => ({ root: null, games: [] }),
        disks: async () => [],
        battery: async () => null,
        services: async () => [],
        recentFiles: async () => [],
      },
    });

    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(appScans).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtimeScans).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(appScans).toBeGreaterThanOrEqual(2);
    store.stop();
  });

  it('applies near-real-time runtime observations without waiting for the timer', async () => {
    const desktop = new FakeDesktopHost();
    const store = new SystemStateStore(desktop, {
      staleMs: 60_000,
      discoverers: {
        applications: async () => [],
        steam: async () => ({ root: null, games: [] }),
        disks: async () => [],
        battery: async () => null,
        services: async () => [],
        recentFiles: async () => [],
      },
    });
    await store.refresh(true);
    const fullObservedAt = store.getSnapshot().fullObservedAt;
    const observedAt = Date.now() + 1_000;
    const listener = vi.fn();
    store.onChange(listener);
    store.applyRuntimeObservation({
      observedAt,
      foreground: {
        pid: 20,
        process: 'Code',
        title: 'main.ts - Visual Studio Code',
        handle: 200,
        focused: true,
      },
      processes: [
        {
          pid: 20,
          name: 'Code',
          title: 'main.ts - Visual Studio Code',
          memoryBytes: 100,
        },
      ],
      windows: [
        {
          pid: 20,
          process: 'Code',
          title: 'main.ts - Visual Studio Code',
          handle: 200,
        },
      ],
    });

    expect(store.getSnapshot()).toMatchObject({
      capturedAt: observedAt,
      runtimeObservedAt: observedAt,
      fullObservedAt,
      runningProcesses: [expect.objectContaining({ pid: 20 })],
      windows: [expect.objectContaining({ focused: true })],
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});
