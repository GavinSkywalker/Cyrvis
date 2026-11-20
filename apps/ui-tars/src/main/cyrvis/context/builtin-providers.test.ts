import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  ToolContext,
  WindowInfo,
} from '../tools/types';
import {
  createBrowserTools,
  createBuiltinProviderBundle,
} from './builtin-providers';

class ProviderDesktop implements DesktopHost {
  readonly urls: string[] = [];

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
      cpuCount: 4,
      totalMemoryBytes: 8,
      freeMemoryBytes: 4,
      uptimeSeconds: 1,
    };
  }
  async diskInfo(target: string): Promise<DiskInfo> {
    return { path: target, totalBytes: 1, freeBytes: 1 };
  }
}

const createContext = (desktop: DesktopHost): ToolContext => ({
  cwd: process.cwd(),
  homeDirectory: os.homedir(),
  platform: process.platform,
  desktop,
  resolvePath: (input) => path.resolve(process.cwd(), input),
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('builtin dynamic providers', () => {
  it('opens a real folder through the VS Code URI handler', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-vscode-'));
    const desktop = new ProviderDesktop();
    const context = createContext(desktop);
    const tool = createBuiltinProviderBundle().tools.find(
      (entry) => entry.name === 'vscode.open_folder',
    )!;

    try {
      const args = await tool.prepare({ path: root }, context);
      const result = await tool.execute(args, context);
      expect(result.ok).toBe(true);
      expect(desktop.urls[0]).toMatch(/^vscode:\/\/file\//);
      expect(result.data).toMatchObject({
        path: path.resolve(root),
        verification: {
          kind: 'window_exists',
          target: 'Visual Studio Code',
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('lists tabs through the configured browser DevTools endpoint', async () => {
    vi.stubEnv('CYRVIS_BROWSER_DEBUG_URL', 'http://127.0.0.1:9222');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 'tab-1',
              title: 'Example',
              url: 'https://example.com',
              type: 'page',
            },
          ]),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const tool = createBrowserTools({ fetch: fetchMock }).find(
      (entry) => entry.name === 'browser.list_tabs',
    )!;
    const result = await tool.execute({}, createContext(new ProviderDesktop()));

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      tabs: [
        {
          id: 'tab-1',
          title: 'Example',
          url: 'https://example.com',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('closes the uniquely matching page directly without confirmation', async () => {
    vi.stubEnv('CYRVIS_BROWSER_DEBUG_URL', 'http://127.0.0.1:9222');
    let closed = false;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/json/close/tab-docs')) {
        closed = true;
        return new Response('', { status: 200 });
      }
      const tabs = closed
        ? [
            {
              id: 'tab-mail',
              title: 'Inbox',
              url: 'https://mail.example.com',
              type: 'page',
            },
          ]
        : [
            {
              id: 'tab-docs',
              title: 'Project Docs',
              url: 'https://docs.example.com',
              type: 'page',
            },
            {
              id: 'tab-mail',
              title: 'Inbox',
              url: 'https://mail.example.com',
              type: 'page',
            },
          ];
      return new Response(JSON.stringify(tabs), { status: 200 });
    }) as unknown as typeof fetch;
    const tool = createBrowserTools({ fetch: fetchMock }).find(
      (entry) => entry.name === 'browser.close_tab',
    )!;
    const context = createContext(new ProviderDesktop());
    const args = await tool.prepare({ query: 'Project Docs' }, context);

    expect(tool.requiresConfirmation).toBeUndefined();
    const result = await tool.execute(args, context);

    expect(result).toMatchObject({
      ok: true,
      data: { tabId: 'tab-docs', title: 'Project Docs' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/json/close/tab-docs'),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
