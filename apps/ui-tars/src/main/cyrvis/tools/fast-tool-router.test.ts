/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SENSITIVE_CONFIRMATION_PROMPT } from './confirmation-policy';
import { createFastToolMatrix } from './matrix';
import { createFastToolMcpServer } from './mcp-server';
import { PathPolicy } from './path-policy';
import type {
  DesktopHost,
  DiskInfo,
  ProcessInfo,
  SystemInfo,
  WindowInfo,
} from './types';

class FakeDesktopHost implements DesktopHost {
  clipboard = '';
  readonly openedPaths: string[] = [];
  readonly openedUrls: string[] = [];
  readonly launchedApplications: string[] = [];
  readonly closedApplications: string[] = [];
  readonly windowActions: Array<{ query: string; action: string }> = [];
  readonly presentations: Array<{
    path: string;
    title: string;
    subtitle?: string;
  }> = [];
  minimizedAll = 0;
  restoredAll = 0;

  async openPath(target: string): Promise<void> {
    this.openedPaths.push(target);
  }

  async openUrl(url: string): Promise<void> {
    this.openedUrls.push(url);
  }

  async clipboardRead(): Promise<string> {
    return this.clipboard;
  }

  async clipboardWrite(text: string): Promise<void> {
    this.clipboard = text;
  }

  async launchApplication(name: string): Promise<string> {
    this.launchedApplications.push(name);
    return name;
  }

  async closeApplication(name: string): Promise<string> {
    this.closedApplications.push(name);
    return name;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return [
      { pid: 10, name: 'notepad', title: 'demo.txt', memoryBytes: 1024 },
      { pid: 20, name: 'explorer', title: 'Downloads', memoryBytes: 2048 },
    ];
  }

  async listWindows(): Promise<WindowInfo[]> {
    return [
      { pid: 10, process: 'notepad', title: 'demo.txt' },
      { pid: 20, process: 'explorer', title: 'Downloads' },
    ];
  }

  async controlWindow(
    query: string,
    action: 'focus' | 'minimize' | 'maximize' | 'close',
  ): Promise<string> {
    this.windowActions.push({ query, action });
    return `${query} window`;
  }

  async minimizeAllWindows(): Promise<number> {
    this.minimizedAll += 1;
    return 3;
  }

  async restoreAllWindows(): Promise<number> {
    this.restoredAll += 1;
    return 3;
  }

  async createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void> {
    this.presentations.push(input);
    await fs.writeFile(input.path, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }

  async systemInfo(): Promise<SystemInfo> {
    return {
      platform: 'test',
      release: '1.0',
      architecture: 'x64',
      hostname: 'cyrvis-test',
      homeDirectory: os.homedir(),
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeMemoryBytes: 8 * 1024 ** 3,
      uptimeSeconds: 3600,
    };
  }

  async diskInfo(target: string): Promise<DiskInfo> {
    return {
      path: target,
      totalBytes: 100 * 1024 ** 3,
      freeBytes: 40 * 1024 ** 3,
    };
  }
}

describe('FastToolRouter', () => {
  let root = '';
  let desktop: FakeDesktopHost;

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-fast-tools-')),
    );
    desktop = new FakeDesktopHost();
    vi.stubEnv('CYRVIS_QWEN_DOC_API_KEY', '');
    vi.stubEnv('DASHSCOPE_API_KEY', '');
    vi.stubEnv('QWEN_API_KEY', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  const matrix = () => createFastToolMatrix(desktop, root);

  it('intercepts file creation and content operations', async () => {
    const { router } = matrix();
    const file = path.join(root, 'notes.txt');

    const created = await router.handleText(`创建文件 ${file} 内容 第一行`);
    expect(created.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('第一行');

    const appended = await router.handleText(`追加到文件 ${file} 内容 第二行`);
    expect(appended.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('第一行第二行');

    const replaced = await router.handleText(
      `把文件 ${file} 中的 第一行 替换为 开头`,
    );
    expect(replaced.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('开头第二行');

    const read = await router.handleText(`读取文件 ${file}`);
    expect(read.ok).toBe(true);
    expect(read.speech).toContain('开头第二行');

    const overwrite = await router.handleText(
      `写入文件 ${file} 内容 replacement`,
    );
    expect(overwrite.speech).toBe(SENSITIVE_CONFIRMATION_PROMPT);
    expect(await fs.readFile(file, 'utf8')).toBe('开头第二行');
    expect((await router.handleText('执行')).ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('replacement');
    const backups = (await fs.readdir(root)).filter((entry) =>
      entry.includes('.cyrvis-backup-'),
    );
    expect(backups).toHaveLength(1);
  });

  it('deletes requested text lines directly by number, range, or content', async () => {
    const { router } = matrix();
    const file = path.join(root, 'lines.txt');
    await fs.writeFile(file, 'first\nsecond\nremove-me\nfourth', 'utf8');

    const byNumber = await router.handleText(`删除文件 ${file} 第2行`);
    expect(byNumber.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('first\nremove-me\nfourth');

    const byContent = await router.handleText(
      `删除文件 ${file} 中 remove-me 的那一行`,
    );
    expect(byContent.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('first\nfourth');

    const rangeCommand = `把文件 ${file} 第一行到第二行删掉`;
    await expect(router.match(rangeCommand)).resolves.toMatchObject({
      tool: 'fs.delete_lines',
      args: { lineNumbers: [1, 2] },
    });
    const byRange = await router.handleText(rangeCommand);
    expect(byRange.ok).toBe(true);
    expect(byRange.result?.data).toMatchObject({ removedCount: 2 });
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('accepts compact speech-to-text commands and quoted paths with spaces', async () => {
    const { router } = matrix();
    const compact = path.join(root, 'compact.txt');

    const created = await router.handleText(
      `在${root}创建文件compact.txt内容hello world`,
    );
    expect(created.ok).toBe(true);
    expect(await fs.readFile(compact, 'utf8')).toBe('hello world');

    const spacedDirectory = path.join(root, 'folder with spaces');
    await fs.mkdir(spacedDirectory);
    const spacedFile = path.join(spacedDirectory, 'quoted file.txt');
    const quoted = await router.handleText(
      `创建文件 "${spacedFile}" 内容 "quoted content"`,
    );
    expect(quoted.ok).toBe(true);
    expect(await fs.readFile(spacedFile, 'utf8')).toBe('quoted content');

    const textFile = path.join(root, 'brief.txt');
    expect(
      (await router.handleText(`创建文本文件 ${textFile} 内容 brief`)).ok,
    ).toBe(true);
    expect((await router.handleText(`编辑文件 ${textFile}`)).ok).toBe(true);
    expect(desktop.openedPaths.at(-1)).toBe(textFile);
  });

  it('intercepts directory, copy, move, and rename commands', async () => {
    const { router } = matrix();
    const directory = path.join(root, 'workspace');
    await fs.mkdir(directory);
    const source = path.join(directory, 'source.txt');
    await fs.writeFile(source, 'demo', 'utf8');

    const listed = await router.handleText(`查看 ${directory} 下有什么`);
    expect(listed.ok).toBe(true);
    expect(listed.speech).toContain('source.txt');

    const copiedPath = path.join(directory, 'copy.txt');
    const copied = await router.handleText(`复制 ${source} 到 ${copiedPath}`);
    expect(copied.ok).toBe(true);
    expect(await fs.readFile(copiedPath, 'utf8')).toBe('demo');

    const renamedPath = path.join(directory, 'renamed.txt');
    const renamed = await router.handleText(
      `重命名 ${copiedPath} 为 renamed.txt`,
    );
    expect(renamed.ok).toBe(true);
    expect(await fs.readFile(renamedPath, 'utf8')).toBe('demo');
  });

  it('opens a random matching file as one local operation', async () => {
    const { router } = matrix();
    const directory = path.join(root, 'random-files');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'first.txt'), 'one', 'utf8');
    await fs.writeFile(path.join(directory, 'second.txt'), 'two', 'utf8');
    await fs.writeFile(path.join(directory, 'ignored.md'), 'three', 'utf8');

    const opened = await router.handleText(
      `在 ${directory} 里随机打开一个txt文件`,
    );

    expect(opened.ok).toBe(true);
    expect(desktop.openedPaths).toHaveLength(1);
    expect(path.dirname(desktop.openedPaths[0]!)).toBe(directory);
    expect(path.extname(desktop.openedPaths[0]!)).toBe('.txt');
  });

  it('normalizes common random-desktop voice phrasings', async () => {
    const { router } = matrix();
    const desktopFolder = path.join(os.homedir(), 'Desktop');
    for (const phrase of [
      '帮我打开桌面的随机一个TXT文件。',
      '打开桌面的txt，随机打开一个。',
      '帮我把桌面的这随机挑一个txt打开。',
    ]) {
      const route = await router.match(phrase);
      expect(route?.tool).toBe('fs.open_random');
      expect(route?.args).toMatchObject({
        path: desktopFolder,
        extension: 'txt',
      });
    }
  });

  it('requires confirmation before destructive operations', async () => {
    const { router } = matrix();
    const file = path.join(root, 'delete-me.txt');
    await fs.writeFile(file, 'keep', 'utf8');

    const pending = await router.handleText(`删除文件 ${file}`);
    expect(pending.ok).toBe(true);
    expect(pending.speech).toBe(SENSITIVE_CONFIRMATION_PROMPT);
    expect(pending.speech).not.toContain(file);
    expect(router.isPendingConfirmationReply('确认执行')).toBe(true);
    expect(router.isPendingConfirmationReply('执行')).toBe(true);
    expect(router.isPendingConfirmationReply('直行')).toBe(true);
    expect(router.isPendingConfirmationReply('是')).toBe(true);
    expect(router.isPendingConfirmationReply('是的，')).toBe(true);
    expect(
      router.isPendingConfirmationReply('对的对的，你就把这个删掉就可以。'),
    ).toBe(true);
    expect(
      router.isPendingConfirmationReply('直接删除这个文件，我已确认。'),
    ).toBe(true);
    expect(router.isPendingConfirmationReply('取消')).toBe(true);
    expect(router.isPendingConfirmationReply('我在')).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('keep');

    const cancelled = await router.handleText('取消');
    expect(cancelled.ok).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('keep');

    await router.handleText(`删除文件 ${file}`);
    await router.handleText('把 replaced 写入剪贴板');
    expect(await router.handleText('确认执行')).toEqual({ handled: false });
    expect(await fs.readFile(file, 'utf8')).toBe('keep');
  });

  it('executes the pending deletion after a natural-language confirmation', async () => {
    const { router } = matrix();
    const file = path.join(root, 'natural-confirmation.txt');
    await fs.writeFile(file, 'delete', 'utf8');

    const pending = await router.handleText(`删除文件 ${file}`);
    expect(pending.speech).toBe(SENSITIVE_CONFIRMATION_PROMPT);
    const confirmed = await router.handleText('直接删除这个文件，我已确认。');
    expect(confirmed).toMatchObject({
      handled: true,
      ok: true,
    });
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('requires confirmation outside configured roots and for sensitive files', async () => {
    const { router } = matrix();
    const outside =
      process.platform === 'win32'
        ? 'C:\\Windows\\cyrvis-fast-tool-test.txt'
        : '/etc/cyrvis-fast-tool-test.txt';
    const sensitive =
      process.platform === 'win32'
        ? path.join(os.homedir(), '.ssh', 'id_rsa')
        : '~/.ssh/id_rsa';

    expect(
      (await router.match(`创建文件 ${outside} 内容 test`))
        ?.requiresConfirmation,
    ).toBe(true);
    expect(
      (await router.match(`读取文件 ${sensitive}`))?.requiresConfirmation,
    ).toBe(true);
  });

  it('allows read-only system inspection outside configured roots', async () => {
    const { registry } = matrix();
    const directory =
      process.platform === 'win32'
        ? 'C:\\Program Files\\Tencent'
        : '/opt/cyrvis-test';
    const target = path.join(directory, 'QQBrowser.exe');

    await expect(
      registry.prepare('condition.check', {
        kind: 'path_exists',
        target,
      }),
    ).resolves.toMatchObject({ requiresConfirmation: false });
    await expect(
      registry.prepare('fs.list_directory', {
        path: directory,
      }),
    ).resolves.toMatchObject({ requiresConfirmation: false });
    await expect(
      registry.prepare('fs.write_file', {
        path: path.join(directory, 'blocked.txt'),
        content: 'x',
      }),
    ).resolves.toMatchObject({ requiresConfirmation: true });
  });

  it('intercepts application, window, clipboard, system, and web commands', async () => {
    const { router } = matrix();

    expect((await router.handleText('打开记事本')).ok).toBe(true);
    expect((await router.handleText('帮我打开QQ浏览器')).ok).toBe(true);
    expect(desktop.launchedApplications).toEqual(['记事本', 'QQ浏览器']);

    const wordFile = path.join(root, 'word.txt');
    await fs.writeFile(wordFile, 'document', 'utf8');
    expect((await router.handleText(`打开文件 ${wordFile}`)).ok).toBe(true);
    expect(desktop.openedPaths.at(-1)).toBe(wordFile);

    expect((await router.handleText('关闭文件 老八二.txt')).ok).toBe(true);
    expect(desktop.windowActions.at(-1)).toEqual({
      query: '老八二.txt',
      action: 'close',
    });
    expect(desktop.closedApplications).toEqual([]);

    expect(await router.match('关闭这个txt')).toMatchObject({
      tool: 'window.close',
      args: { query: 'txt' },
    });
    expect(await router.match('关闭txt')).toMatchObject({
      tool: 'window.close',
      args: { query: 'txt' },
    });
    expect(await router.match('把老八二.txt关掉')).toMatchObject({
      tool: 'window.close',
      args: { query: '老八二.txt' },
    });
    expect(await router.match('关闭记事本窗口')).toMatchObject({
      tool: 'window.close',
      args: { query: '记事本' },
    });
    expect(await router.match('关闭 Project Docs 网页')).toMatchObject({
      tool: 'browser.close_page',
      args: { query: 'Project Docs' },
    });

    expect((await router.handleText('切换到窗口 demo.txt')).ok).toBe(true);
    expect(desktop.windowActions.at(-1)).toEqual({
      query: 'demo.txt',
      action: 'focus',
    });

    const minimized = await router.handleText('把所有桌面窗口最小化');
    expect(minimized.ok).toBe(true);
    expect(minimized.speech).toContain('3 个');
    expect(desktop.minimizedAll).toBe(1);

    expect((await router.handleText('恢复所有窗口')).ok).toBe(true);
    expect(desktop.restoredAll).toBe(1);

    expect((await router.handleText('把 hello 写入剪贴板')).ok).toBe(true);
    expect(desktop.clipboard).toBe('hello');

    expect((await router.handleText('读取剪贴板')).speech).toContain('hello');
    expect((await router.handleText('查看系统信息')).ok).toBe(true);
    expect((await router.handleText(`磁盘空间 ${root}`)).ok).toBe(true);
    expect((await router.handleText('搜索网页 MCP server')).ok).toBe(true);
    expect(desktop.openedUrls.at(-1)).toContain(
      process.platform === 'darwin' ? 'google.com/search' : 'bing.com/search',
    );

    expect((await router.handleText('打开浏览器搜索网球王子')).ok).toBe(true);
    expect(decodeURIComponent(desktop.openedUrls.at(-1) || '')).toContain(
      '网球王子',
    );

    const presentation = await router.handleText(
      `在 ${root} 创建一个关于人工智能的PPT`,
    );
    expect(presentation.ok, presentation.speech).toBe(true);
    expect(desktop.presentations.at(-1)?.title).toBe('人工智能');
    expect(desktop.presentations.at(-1)?.path).toContain('.pptx');
  });

  it('leaves non-command chat outside the fast tool matrix', async () => {
    const { router } = matrix();
    expect((await router.match('查看桌面下有什么'))?.tool).toBe(
      'fs.list_directory',
    );
    expect(router.canHandle('今天天气怎么样')).toBe(false);
    expect(await router.handleText('给我讲个故事')).toEqual({ handled: false });
  });

  it('exposes the same capability matrix through an in-process MCP server', async () => {
    const { registry, surface } = matrix();
    const server = createFastToolMcpServer(registry, { surface });
    const client = new Client(
      { name: 'cyrvis-fast-tools-test', version: '1.0.0' },
      { capabilities: {} },
    );
    const toolListChanged = vi.fn();
    client.setNotificationHandler(
      ToolListChangedNotificationSchema,
      toolListChanged,
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const tools = await client.listTools();
    expect(tools.tools.length).toBeLessThanOrEqual(24);
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain('fs.create_file');
    expect(names).toContain('capability.invoke');
    expect(names).not.toContain('command.run');
    expect(names).not.toContain('fs.copy');

    const result = await client.callTool({
      name: 'clipboard.write',
      arguments: { text: 'through-mcp' },
    });
    expect(result.isError).not.toBe(true);
    expect(desktop.clipboard).toBe('through-mcp');

    const closed = await client.callTool({
      name: 'app.close',
      arguments: { name: 'notepad' },
    });
    expect(closed.isError).not.toBe(true);
    expect(desktop.closedApplications).toEqual(['notepad']);

    registry.register({
      name: 'test.dynamic',
      domain: 'system',
      description: 'Dynamic test tool.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      prepare: () => ({}),
      async execute() {
        return { ok: true, tool: 'test.dynamic', speech: 'ok' };
      },
    });
    await vi.waitFor(() => {
      expect(toolListChanged).toHaveBeenCalled();
    });

    await client.close();
    await server.close();
  });

  it('exposes a bounded dynamic surface backed by the full capability catalog', async () => {
    const { capabilityCatalog, providerCatalog, registry, surface } = matrix();
    expect(providerCatalog.tools.length).toBeLessThanOrEqual(24);
    expect(providerCatalog.tools.length).toBeLessThan(registry.list().length);
    expect(capabilityCatalog.list()).toHaveLength(registry.list().length);
    expect(providerCatalog.tools.map((tool) => tool.function.name)).toContain(
      'cyrvis_capability_search',
    );
    expect(providerCatalog.resolve('cyrvis_window_minimize_all')).toBe(
      'window.minimize_all',
    );
    expect(surface.isVisible('fs.copy')).toBe(false);
    expect(capabilityCatalog.get('fs.copy')).toMatchObject({
      availability: 'available',
    });
    expect(
      providerCatalog.tools.find(
        (tool) => tool.function.name === 'cyrvis_capability_invoke',
      )?.function.description,
    ).toContain('Invoke any available CYRVIS capability');
    expect(
      new Set(providerCatalog.tools.map((tool) => tool.function.name)).size,
    ).toBe(providerCatalog.tools.length);
  });
});

describe('PathPolicy', () => {
  it('maps common user folder names', () => {
    const policy = new PathPolicy(process.cwd(), os.homedir());
    expect(policy.resolve(path.join('桌面', 'note.txt'), process.cwd())).toBe(
      path.join(os.homedir(), 'Desktop', 'note.txt'),
    );
  });

  it('resolves relative paths from the user home instead of the project', () => {
    const policy = new PathPolicy(process.cwd(), os.homedir());
    expect(policy.resolve('notes.txt')).toBe(
      path.join(os.homedir(), 'notes.txt'),
    );
  });

  it.runIf(process.platform === 'win32')(
    'repairs dropped separators and guessed Windows usernames',
    async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cyrvis-policy-'));
      try {
        const home = path.join(base, 'Users', 'actual-user');
        const desktopFolder = path.join(home, 'Desktop');
        await fs.mkdir(desktopFolder, { recursive: true });
        const policy = new PathPolicy(base, home);
        const guessedUser = `missing-${path.basename(base)}`;
        const driveRoot = path.parse(base).root;

        expect(
          policy.resolve(`${driveRoot}Users\\${guessedUser}\\Desktop`),
        ).toBe(desktopFolder);
        if (driveRoot.toLowerCase() === 'c:\\') {
          expect(
            policy.resolve(
              `${driveRoot.replace(/\\$/, '')} Users ${guessedUser} Desktop`,
            ),
          ).toBe(desktopFolder);
        }
        expect(policy.resolve('桌面/note.txt')).toBe(
          path.join(desktopFolder, 'note.txt'),
        );
      } finally {
        await fs.rm(base, { recursive: true, force: true });
      }
    },
  );
});
