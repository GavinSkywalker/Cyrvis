import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { ProviderManifest } from '../tools/provider-types';
import type { ToolDefinition } from '../tools/types';
import {
  activateBrowserTab,
  closeBrowserTab,
  listBrowserTabs,
  normalizeBrowserTabs,
  openBrowserTab,
  resolveBrowserTab,
  waitForBrowserTabMissing,
  type BrowserCdpOptions,
} from './browser-cdp';

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key] : fallback);

const success = (
  tool: string,
  speech: string,
  data?: unknown,
): {
  ok: true;
  tool: string;
  speech: string;
  data?: unknown;
} => ({ ok: true, tool, speech, data });

const failure = (
  tool: string,
  speech: string,
  code: string,
  message: string,
): {
  ok: false;
  tool: string;
  speech: string;
  error: { code: string; message: string };
} => ({ ok: false, tool, speech, error: { code, message } });

const vscodeUri = (target: string): string =>
  pathToFileURL(target).href.replace(/^file:\/\//, 'vscode://file');

const createVscodeTools = (): ToolDefinition[] => [
  {
    name: 'vscode.open_folder',
    domain: 'desktop',
    description: 'Open an existing folder in Visual Studio Code.',
    risk: 'low',
    capability: {
      providerId: 'vscode',
      tier: 2,
      activation: 'on-demand',
      priority: 74,
      requirements: { applications: ['Visual Studio Code'] },
      permissions: ['filesystem.read', 'desktop.app'],
      tags: ['vscode', 'folder', 'project', '代码', '项目', '文件夹'],
    },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(text(input, 'path')),
    }),
    async execute(args, context) {
      const target = String(args.path);
      try {
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) {
          return failure(
            'vscode.open_folder',
            '目标不是文件夹。',
            'NOT_A_DIRECTORY',
            'Target is not a directory.',
          );
        }
        const uri = vscodeUri(target);
        await context.desktop.openUrl(uri);
        return success(
          'vscode.open_folder',
          '已在 Visual Studio Code 中打开文件夹。',
          {
            path: target,
            url: uri,
            verification: {
              kind: 'window_exists',
              target: 'Visual Studio Code',
              timeoutMs: 5_000,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'vscode.open_folder',
          `打开文件夹失败：${message}`,
          'VSCODE_OPEN_FOLDER_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'vscode.open_file',
    domain: 'desktop',
    description: 'Open an existing file in Visual Studio Code.',
    risk: 'low',
    capability: {
      providerId: 'vscode',
      tier: 2,
      activation: 'on-demand',
      priority: 73,
      requirements: { applications: ['Visual Studio Code'] },
      permissions: ['filesystem.read', 'desktop.app'],
      tags: ['vscode', 'file', '代码', '文件', '编辑器'],
    },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      path: context.resolvePath(text(input, 'path')),
    }),
    async execute(args, context) {
      const target = String(args.path);
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          return failure(
            'vscode.open_file',
            '目标不是文件。',
            'NOT_A_FILE',
            'Target is not a file.',
          );
        }
        const uri = vscodeUri(target);
        await context.desktop.openUrl(uri);
        return success(
          'vscode.open_file',
          '已在 Visual Studio Code 中打开文件。',
          {
            path: target,
            url: uri,
            verification: {
              kind: 'window_exists',
              target: 'Visual Studio Code',
              timeoutMs: 5_000,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'vscode.open_file',
          `打开文件失败：${message}`,
          'VSCODE_OPEN_FILE_FAILED',
          message,
        );
      }
    },
  },
];

export const createBrowserTools = (
  options: BrowserCdpOptions = {},
): ToolDefinition[] => [
  {
    name: 'browser.list_tabs',
    domain: 'network',
    description:
      'List tabs exposed by the configured loopback Chrome DevTools endpoint.',
    risk: 'low',
    capability: {
      providerId: 'browser-debug',
      tier: 2,
      activation: 'on-demand',
      priority: 77,
      requirements: { environment: ['CYRVIS_BROWSER_DEBUG_URL'] },
      permissions: ['network'],
      tags: ['browser', 'tab', 'chrome', 'edge', '浏览器', '标签页'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      try {
        const tabs = await listBrowserTabs(options);
        return success(
          'browser.list_tabs',
          `发现 ${tabs.length} 个浏览器标签页。`,
          {
            tabs,
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'browser.list_tabs',
          `读取浏览器标签页失败：${message}`,
          'BROWSER_TABS_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'browser.open_tab',
    domain: 'network',
    description:
      'Open a URL in a new browser tab through the DevTools endpoint.',
    risk: 'medium',
    capability: {
      providerId: 'browser-debug',
      tier: 2,
      activation: 'on-demand',
      priority: 76,
      requirements: { environment: ['CYRVIS_BROWSER_DEBUG_URL'] },
      permissions: ['network'],
      tags: ['browser', 'open', 'tab', 'url', '浏览器', '打开', '标签页'],
    },
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const url = new URL(text(input, 'url'));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http/https URLs are allowed.');
      }
      return { url: url.toString() };
    },
    async execute(args) {
      try {
        const tab = await openBrowserTab(String(args.url), options);
        const normalized = normalizeBrowserTabs([tab])[0];
        return success('browser.open_tab', '已打开新的浏览器标签页。', {
          tab: normalized || tab,
          verification: { kind: 'tool_result' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'browser.open_tab',
          `打开浏览器标签页失败：${message}`,
          'BROWSER_OPEN_TAB_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'browser.activate_tab',
    domain: 'network',
    description: 'Activate a browser tab by DevTools target ID.',
    risk: 'medium',
    capability: {
      providerId: 'browser-debug',
      tier: 2,
      activation: 'on-demand',
      priority: 75,
      requirements: { environment: ['CYRVIS_BROWSER_DEBUG_URL'] },
      permissions: ['network'],
      tags: ['browser', 'activate', 'tab', '浏览器', '切换', '标签页'],
    },
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const tabId = text(input, 'tabId').trim();
      if (!tabId) {
        throw new Error('tabId is required.');
      }
      return { tabId };
    },
    async execute(args) {
      try {
        await activateBrowserTab(String(args.tabId), options);
        return success('browser.activate_tab', '已切换到目标浏览器标签页。', {
          tabId: args.tabId,
          verification: { kind: 'tool_result' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'browser.activate_tab',
          `切换浏览器标签页失败：${message}`,
          'BROWSER_ACTIVATE_TAB_FAILED',
          message,
        );
      }
    },
  },
  {
    name: 'browser.close_tab',
    domain: 'network',
    description:
      'Close a browser tab by DevTools target ID or by a title/URL query.',
    risk: 'medium',
    capability: {
      providerId: 'browser-debug',
      tier: 2,
      activation: 'on-demand',
      priority: 72,
      requirements: { environment: ['CYRVIS_BROWSER_DEBUG_URL'] },
      permissions: ['network'],
      tags: ['browser', 'close', 'tab', '浏览器', '关闭', '标签页'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string' },
        query: { type: 'string' },
      },
      required: [],
      additionalProperties: false,
    },
    prepare: (input) => {
      const tabId = text(input, 'tabId').trim();
      const query = text(input, 'query').trim();
      if (!tabId && !query) {
        throw new Error('tabId or query is required.');
      }
      return { tabId, query };
    },
    async execute(args) {
      try {
        const query = String(args.query || '').trim();
        const tab = query ? await resolveBrowserTab(query, options) : null;
        if (query && !tab) {
          return failure(
            'browser.close_tab',
            `没有找到网页：${query}`,
            'BROWSER_TAB_NOT_FOUND',
            `No browser tab matched ${query}.`,
          );
        }
        const tabId = String(args.tabId || tab?.id || '');
        await closeBrowserTab(tabId, options);
        const verified = await waitForBrowserTabMissing(tabId, options, 2_000);
        if (!verified) {
          return failure(
            'browser.close_tab',
            '浏览器标签页关闭后未能确认目标消失。',
            'BROWSER_CLOSE_NOT_VERIFIED',
            'Browser tab still exists after close timeout.',
          );
        }
        return success('browser.close_tab', '已关闭目标浏览器标签页。', {
          tabId,
          title: tab?.title || '',
          verification: { kind: 'tool_result' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'browser.close_tab',
          `关闭浏览器标签页失败：${message}`,
          'BROWSER_CLOSE_TAB_FAILED',
          message,
        );
      }
    },
  },
];

export interface BuiltinProviderBundle {
  tools: ToolDefinition[];
  manifests: ProviderManifest[];
}

export const createBuiltinProviderBundle = (
  browserOptions: BrowserCdpOptions = {},
): BuiltinProviderBundle => {
  const vscodeTools = createVscodeTools();
  const browserTools = createBrowserTools(browserOptions);
  return {
    tools: [...vscodeTools, ...browserTools],
    manifests: [
      {
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'vscode',
        name: 'Visual Studio Code',
        version: '1.0.0',
        trust: 'builtin',
        enabled: true,
        requirements: { applications: ['Visual Studio Code'] },
        activation: {
          mode: 'foreground',
          applications: ['Visual Studio Code'],
          processes: ['Code'],
        },
        permissions: ['filesystem.read', 'desktop.app'],
        transport: {
          type: 'builtin',
          toolIds: vscodeTools.map((tool) => tool.name),
        },
      },
      {
        schemaVersion: 1,
        toolApiVersion: 1,
        id: 'browser-debug',
        name: 'Browser DevTools',
        version: '1.0.0',
        trust: 'builtin',
        enabled: true,
        requirements: { environment: ['CYRVIS_BROWSER_DEBUG_URL'] },
        activation: {
          mode: 'foreground',
          applications: ['Google Chrome', 'Microsoft Edge', 'Chrome', 'Edge'],
          processes: ['chrome', 'msedge'],
        },
        permissions: ['network'],
        transport: {
          type: 'builtin',
          toolIds: browserTools.map((tool) => tool.name),
        },
      },
    ],
  };
};
