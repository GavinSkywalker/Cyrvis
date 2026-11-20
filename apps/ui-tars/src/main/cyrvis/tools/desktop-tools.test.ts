import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_TOOLS } from './desktop-tools';
import { LocalDesktopHost } from './desktop-host';
import type {
  DesktopHost,
  ToolContext,
  ToolResourceHint,
  WindowInfo,
} from './types';

const tool = (name: string) => {
  const definition = DESKTOP_TOOLS.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Missing tool: ${name}`);
  }
  return definition;
};

const createContext = (
  controlWindow: (query: string, action: string) => Promise<string>,
  resources: ToolResourceHint[] = [],
  windows: WindowInfo[] = [],
): ToolContext => {
  const desktop = {
    controlWindow,
    listWindows: async () => windows,
  } as unknown as DesktopHost;
  return {
    cwd: process.cwd(),
    homeDirectory: 'C:\\Users\\test',
    platform: process.platform,
    desktop,
    resolvePath: (input) => input,
    getRecentResources: () => resources,
  };
};

describe('desktop window tools', () => {
  it.runIf(process.platform === 'win32')(
    'protects CYRVIS from application close calls',
    async () => {
      await expect(
        new LocalDesktopHost().closeApplication('Cyrvis'),
      ).rejects.toThrow('protected');
    },
  );

  it('expands a broad close target from the most recent document resource', async () => {
    const fileName = 'Cyrvis-原子基础工具说明.md';
    const filePath = path.join('C:\\Users\\test\\Desktop', fileName);
    const controlWindow = vi.fn(async (query: string) => {
      if (query === fileName) {
        return `${fileName} - 记事本`;
      }
      throw new Error(`unexpected query: ${query}`);
    });
    const context = createContext(controlWindow, [
      {
        kind: 'file',
        name: fileName,
        aliases: [filePath],
        metadata: { path: filePath },
        updatedAt: Date.now(),
      },
    ]);

    const result = await tool('window.close').execute(
      { query: 'Cyrvis' },
      context,
    );

    expect(controlWindow).toHaveBeenCalledTimes(1);
    expect(controlWindow).toHaveBeenCalledWith(fileName, 'close');
    expect(result).toMatchObject({
      ok: true,
      data: {
        query: 'Cyrvis',
        resolvedQuery: fileName,
      },
    });
  });

  it('does not choose an arbitrary document when the target is ambiguous', async () => {
    const resources: ToolResourceHint[] = [
      {
        kind: 'file',
        name: 'first.md',
        aliases: [],
        metadata: { path: 'C:\\Users\\test\\Desktop\\first.md' },
        updatedAt: Date.now(),
      },
      {
        kind: 'file',
        name: 'second.md',
        aliases: [],
        metadata: { path: 'C:\\Users\\test\\Desktop\\second.md' },
        updatedAt: Date.now(),
      },
    ];
    const controlWindow = vi.fn(async () => {
      throw new Error('Window target is ambiguous');
    });
    const context = createContext(controlWindow, resources);

    await expect(
      tool('window.close').execute({ query: 'md' }, context),
    ).rejects.toThrow('ambiguous');
    expect(controlWindow).toHaveBeenCalledWith('md', 'close');
  });

  it('hides CYRVIS own windows from the model-facing window list', async () => {
    const context = createContext(
      async () => '',
      [],
      [
        {
          pid: process.pid,
          process: 'electron',
          title: 'Cyrvis Companion',
        },
        {
          pid: process.pid + 2,
          process: 'electron',
          title: 'Cyrvis',
        },
        {
          pid: process.pid + 1,
          process: 'notepad',
          title: 'notes.md - 记事本',
        },
      ],
    );

    const result = await tool('window.list').execute({}, context);

    expect(result.data).toEqual({
      windows: [
        {
          pid: process.pid + 1,
          process: 'notepad',
          title: 'notes.md - 记事本',
        },
      ],
    });
  });

  it('closes a named browser page through the native tab fallback', async () => {
    const closeBrowserPage = vi.fn(async () => ({
      title: 'Project Docs',
      process: 'msedge',
    }));
    const context = createContext(async () => '');
    context.desktop = {
      ...context.desktop,
      closeBrowserPage,
    } as DesktopHost;

    const result = await tool('browser.close_page').execute(
      { query: 'Project Docs' },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      data: { title: 'Project Docs', process: 'msedge' },
    });
    expect(closeBrowserPage).toHaveBeenCalledWith('Project Docs');
    expect(tool('browser.close_page').requiresConfirmation).toBeUndefined();
  });
});
