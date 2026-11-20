/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import {
  buildSearchUrl,
  defaultSearchEngine,
  type SearchEngine,
} from '../navigation';
import type {
  ToolContext,
  ToolDefinition,
  ToolResourceHint,
  ToolResult,
} from './types';

const text = (
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; fallback?: string } = {},
): string => {
  const value = input[key];
  if (typeof value === 'string') {
    return value;
  }
  if (options.required) {
    throw new Error(`${key} is required`);
  }
  return options.fallback ?? '';
};

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const formatBytes = (value: number): string => {
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  return url.toString();
};

const normalizeTarget = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ');

const isCyrvisWindow = (window: { pid: number; title: string }): boolean =>
  window.pid === process.pid ||
  window.title.trim() === 'Cyrvis' ||
  window.title.trim() === 'Cyrvis Companion';

const recentFileQueryCandidates = (
  query: string,
  resources: ToolResourceHint[],
): string[] => {
  const normalizedQuery = normalizeTarget(query);
  if (!normalizedQuery) {
    return [];
  }
  const files = resources.filter((resource) => resource.kind === 'file');
  const matchesResource = (resource: ToolResourceHint, exact: boolean) =>
    [resource.name, ...resource.aliases].some((candidate) => {
      const normalizedCandidate = normalizeTarget(candidate);
      return exact
        ? normalizedCandidate === normalizedQuery
        : normalizedCandidate.includes(normalizedQuery);
    });
  const exactMatches = files.filter((resource) =>
    matchesResource(resource, true),
  );
  const fuzzyMatches = files.filter((resource) =>
    matchesResource(resource, false),
  );
  const matchedFiles = exactMatches.length > 0 ? exactMatches : fuzzyMatches;
  if (matchedFiles.length !== 1 || !matchedFiles[0]) {
    return [];
  }
  const matches = matchedFiles[0];
  const filePath =
    typeof matches.metadata.path === 'string'
      ? matches.metadata.path
      : undefined;
  const basename = filePath ? path.basename(filePath) : matches.name;
  const extension = path.extname(basename);
  return [
    basename,
    extension && basename.toLowerCase().endsWith(extension.toLowerCase())
      ? basename.slice(0, -extension.length)
      : '',
    filePath || '',
  ].filter(
    (candidate, index, values): candidate is string =>
      Boolean(candidate) &&
      values.findIndex(
        (entry) => normalizeTarget(entry) === normalizeTarget(candidate),
      ) === index,
  );
};

const closeWindow = async (
  query: string,
  context: ToolContext,
): Promise<{ query: string; title: string }> => {
  const recentQueries = recentFileQueryCandidates(
    query,
    context.getRecentResources?.() || [],
  );
  const queries = [...recentQueries, query].filter(
    (candidate, index, values) =>
      Boolean(candidate) &&
      values.findIndex(
        (entry) => normalizeTarget(entry) === normalizeTarget(candidate),
      ) === index,
  );
  let lastError: unknown;
  for (const candidate of queries) {
    try {
      const title = await context.desktop.controlWindow(candidate, 'close');
      return { query: candidate, title };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('No matching closable window.');
};

export const DESKTOP_TOOLS: ToolDefinition[] = [
  {
    name: 'app.launch',
    domain: 'desktop',
    description:
      'Launch a supported local application such as Notepad, Calculator, Paint, Explorer, Terminal, or VS Code.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, target: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    prepare: (input, context) => {
      const name = text(input, 'name', { required: true });
      const target = text(input, 'target').trim();
      return {
        name,
        ...(target
          ? {
              target: /^https?:\/\//i.test(target)
                ? normalizeUrl(target)
                : context.resolvePath(target),
            }
          : {}),
      };
    },
    pathArgs: (args) =>
      args.target && !/^https?:\/\//i.test(String(args.target))
        ? [String(args.target)]
        : [],
    async execute(args, context) {
      const name = String(args.name);
      const launched = await context.desktop.launchApplication(
        name,
        typeof args.target === 'string' ? args.target : undefined,
      );
      return success('app.launch', `正在打开${launched}。`, { name: launched });
    },
  },
  {
    name: 'app.list',
    domain: 'desktop',
    description: 'List running applications and processes.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 300 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      limit:
        typeof input.limit === 'number'
          ? Math.max(1, Math.min(300, Math.floor(input.limit)))
          : 100,
    }),
    async execute(args, context) {
      const processes = await context.desktop.listProcesses();
      const selected = processes
        .sort((left, right) => {
          if (Boolean(left.title) !== Boolean(right.title)) {
            return left.title ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        })
        .slice(0, Number(args.limit))
        .map((processInfo) => ({
          pid: processInfo.pid,
          name: processInfo.name,
          title: processInfo.title || '',
          memoryBytes: processInfo.memoryBytes || 0,
        }));
      return success('app.list', `当前列出了 ${selected.length} 个进程。`, {
        total: processes.length,
        processes: selected,
      });
    },
  },
  {
    name: 'app.close',
    domain: 'desktop',
    description:
      'Close a running application by supported name or process name.',
    risk: 'high',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    prepare: (input) => ({ name: text(input, 'name', { required: true }) }),
    requiresConfirmation: (args) =>
      `关闭${String(args.name)}可能丢失未保存内容。`,
    async execute(args, context) {
      const name = String(args.name);
      await context.desktop.closeApplication(name);
      return success('app.close', `已关闭${name}。`, { name });
    },
  },
  {
    name: 'browser.close_page',
    domain: 'network',
    description:
      'Close a specific Chrome, Edge, or Chromium browser page by matching its visible tab title. Does not require a DevTools endpoint.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.browser',
      tier: 2,
      activation: 'state',
      priority: 74,
      permissions: ['desktop.window'],
      tags: ['browser', 'tab', 'close', '网页', '浏览器', '标签页', '关闭'],
    },
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
    }),
    async execute(args, context) {
      if (!context.desktop.closeBrowserPage) {
        throw new Error('当前系统不支持直接关闭指定网页');
      }
      const closed = await context.desktop.closeBrowserPage(String(args.query));
      return success(
        'browser.close_page',
        `已关闭网页「${closed.title}」。`,
        closed,
      );
    },
  },
  {
    name: 'window.list',
    domain: 'desktop',
    description:
      'List visible top-level windows, excluding CYRVIS application surfaces.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      const windows = (await context.desktop.listWindows()).filter(
        (window) => !isCyrvisWindow(window),
      );
      return success('window.list', `当前有 ${windows.length} 个可见窗口。`, {
        windows,
      });
    },
  },
  {
    name: 'window.focus',
    domain: 'desktop',
    description: 'Focus and bring a matching window to the foreground.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
    }),
    async execute(args, context) {
      const title = await context.desktop.controlWindow(
        String(args.query),
        'focus',
      );
      return success('window.focus', `已切换到 ${title}。`, { title });
    },
  },
  {
    name: 'window.close',
    domain: 'desktop',
    description:
      'Request a matching file or document window to close without killing its application process. Resolve recent-document references first; never target CYRVIS application surfaces.',
    risk: 'medium',
    capability: {
      providerId: 'desktop.window',
      tier: 2,
      activation: 'state',
      priority: 47,
      tags: ['window', 'close', 'file', '窗口', '关闭', '文件'],
    },
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
    }),
    async execute(args, context) {
      const query = String(args.query);
      const resolved = await closeWindow(query, context);
      return success('window.close', `已请求关闭 ${resolved.title}。`, {
        query,
        resolvedQuery: resolved.query,
        title: resolved.title,
      });
    },
  },
  {
    name: 'window.minimize_all',
    domain: 'desktop',
    description: 'Minimize every visible desktop window.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      const count = await context.desktop.minimizeAllWindows();
      return success(
        'window.minimize_all',
        count > 0
          ? `已最小化 ${count} 个可见窗口。`
          : '当前没有可最小化的可见窗口。',
        { windows: count },
      );
    },
  },
  {
    name: 'window.restore_all',
    domain: 'desktop',
    description: 'Restore windows minimized by the last minimize-all action.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      const count = await context.desktop.restoreAllWindows();
      return success(
        'window.restore_all',
        count > 0 ? `已恢复 ${count} 个窗口。` : '没有可恢复的窗口。',
        { windows: count },
      );
    },
  },
  {
    name: 'window.minimize',
    domain: 'desktop',
    description: 'Minimize a matching window.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
    }),
    async execute(args, context) {
      const title = await context.desktop.controlWindow(
        String(args.query),
        'minimize',
      );
      return success('window.minimize', `已最小化 ${title}。`, { title });
    },
  },
  {
    name: 'window.maximize',
    domain: 'desktop',
    description: 'Maximize a matching window.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
    }),
    async execute(args, context) {
      const title = await context.desktop.controlWindow(
        String(args.query),
        'maximize',
      );
      return success('window.maximize', `已最大化 ${title}。`, { title });
    },
  },
  {
    name: 'clipboard.read',
    domain: 'clipboard',
    description: 'Read plain text from the system clipboard.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      const content = await context.desktop.clipboardRead();
      const preview = content.replace(/\s+/g, ' ').slice(0, 300);
      return success(
        'clipboard.read',
        content.trim()
          ? `剪贴板内容是：${preview}${content.length > 300 ? '…' : ''}`
          : '剪贴板是空的。',
        { content, length: content.length },
      );
    },
  },
  {
    name: 'clipboard.write',
    domain: 'clipboard',
    description: 'Replace the system clipboard with plain text.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      text: text(input, 'text', { required: true }),
    }),
    async execute(args, context) {
      await context.desktop.clipboardWrite(String(args.text));
      return success('clipboard.write', '已写入剪贴板。', {
        length: String(args.text).length,
      });
    },
  },
  {
    name: 'web.open_url',
    domain: 'network',
    description: 'Open an HTTP or HTTPS URL in the default browser.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      url: normalizeUrl(text(input, 'url', { required: true })),
    }),
    async execute(args, context) {
      await context.desktop.openUrl(String(args.url));
      return success('web.open_url', '已打开网址。', { url: String(args.url) });
    },
  },
  {
    name: 'web.search',
    domain: 'network',
    description: 'Open a web search in the default browser.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        engine: { type: 'string', enum: ['bing', 'google', 'baidu'] },
        site: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query', { required: true }),
      engine: text(input, 'engine', { fallback: defaultSearchEngine() }),
      site: text(input, 'site'),
    }),
    async execute(args, context) {
      const query = String(args.query);
      const engine = String(args.engine);
      if (!['bing', 'google', 'baidu'].includes(engine))
        throw new Error('Unsupported search engine');
      const url = buildSearchUrl(
        query,
        engine as SearchEngine,
        String(args.site || '') || undefined,
      );
      if (context.desktop.openSearch) await context.desktop.openSearch(url);
      else await context.desktop.openUrl(url);
      return success('web.search', `已在浏览器中搜索 ${query}。`, {
        query,
        url,
      });
    },
  },
  {
    name: 'system.info',
    domain: 'system',
    description:
      'Get basic operating system, CPU, memory, and uptime information.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute(_args, context) {
      const info = await context.desktop.systemInfo();
      return success(
        'system.info',
        `当前是 ${info.platform} ${info.release}，${info.cpuCount} 核 CPU，可用内存 ${formatBytes(info.freeMemoryBytes)}。`,
        info,
      );
    },
  },
  {
    name: 'system.disk',
    domain: 'system',
    description: 'Get total and free disk space for a path.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
    prepare: (input, context) => ({
      path: context.resolvePath(
        text(input, 'path', { fallback: context.homeDirectory }),
      ),
    }),
    async execute(args, context) {
      const info = await context.desktop.diskInfo(String(args.path));
      return success(
        'system.disk',
        `磁盘总容量 ${formatBytes(info.totalBytes)}，可用 ${formatBytes(info.freeBytes)}。`,
        info,
      );
    },
  },
  {
    name: 'process.list',
    domain: 'system',
    description: 'List running processes with memory usage and window titles.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', minimum: 1, maximum: 300 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      limit:
        typeof input.limit === 'number'
          ? Math.max(1, Math.min(300, Math.floor(input.limit)))
          : 100,
    }),
    async execute(args, context) {
      const processes = (await context.desktop.listProcesses())
        .sort(
          (left, right) => (right.memoryBytes || 0) - (left.memoryBytes || 0),
        )
        .slice(0, Number(args.limit));
      return success(
        'process.list',
        `已按内存占用列出 ${processes.length} 个进程。`,
        { processes },
      );
    },
  },
];
