/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import type { CapabilityBroker } from './capability-broker';
import { SENSITIVE_CONFIRMATION_PROMPT } from './confirmation-policy';
import { isSupportedApplicationAlias } from './desktop-host';
import {
  createFastToolProviderCatalog,
  type FastToolProviderCatalog,
} from './llm-tools';
import type {
  FastToolOutcome,
  FastToolRoute,
  PendingConfirmationSnapshot,
  PreparedToolCall,
  ToolContext,
} from './types';
import { ToolRegistry as Registry } from './registry';

interface ParsedCommand {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

interface PendingConfirmation {
  prepared: PreparedToolCall;
  route: FastToolRoute;
  expiresAt: number;
}

const CONFIRM_COMMAND_PATTERN =
  /^(?:确认|确定|确认执行|执行|执行吧|直行|可以|可以执行|同意|继续执行|好|是|yes|confirm|go ahead)$/i;
const CANCEL_COMMAND_PATTERN =
  /^(?:取消|算了|不要|不要执行|别执行|否|no|cancel)$/i;

const compactCommand = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:：""''“”‘’]/g, '');

const isContextualConfirmation = (text: string): boolean => {
  const raw = text.trim();
  if (CONFIRM_COMMAND_PATTERN.test(raw)) {
    return true;
  }
  const compact = compactCommand(raw);
  if (
    /^(?:是的|是啊|对呀|嗯|嗯嗯|好的|行|当然|直接执行|直接删除|确认删除|我已确认|对|对的|对的对的|没问题|可以删|可以删了|删吧|删了吧|执行吧)$/.test(
      compact,
    )
  ) {
    return true;
  }
  return (
    /(?:确认|对|可以|好)/.test(compact) &&
    /(?:删除|删掉|执行|继续|处理)/.test(compact) &&
    !/(?:不|别|取消|算了|否)/.test(compact)
  );
};

const isContextualCancellation = (text: string): boolean => {
  if (CANCEL_COMMAND_PATTERN.test(text.trim())) {
    return true;
  }
  return /^(?:不要了|不要删|别删|不对|不行|不用了|停止|先不要)$/.test(
    compactCommand(text),
  );
};

const parseLineNumber = (value: string): number | null => {
  if (/^\d+$/.test(value)) {
    return Math.max(1, Number(value));
  }
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (digits[character]) {
      current = digits[character];
    } else if (character === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else {
      return null;
    }
  }
  const parsed = total + current;
  return parsed > 0 ? parsed : null;
};

export interface FastToolRouterOptions {
  confirmationTtlMs?: number;
  providerCatalog?: FastToolProviderCatalog;
  capabilityBroker?: CapabilityBroker;
}

export interface FastToolExecutionScheduler {
  execute(route: FastToolRoute): Promise<FastToolOutcome>;
}

const KNOWN_FOLDER_NAMES = new Set([
  '桌面',
  'desktop',
  '下载',
  'downloads',
  '文档',
  'documents',
  '图片',
  'pictures',
  '音乐',
  'music',
  '视频',
  'videos',
]);

const ALWAYS_BACKGROUND_TOOLS = new Set([
  'office.create_presentation',
  'web.download',
  'archive.create',
  'archive.extract',
  'document.extract_text',
  'pdf.extract_text',
]);
const BACKGROUND_TIMEOUT_MS = 60_000;

const normalize = (input: string): string => {
  let value = input
    .normalize('NFKC')
    .trim()
    .replace(
      /^(?:(?:你好|您好|嗨|哈喽|hello|hi|hey)[\s,，。!！]*)?(?:cyrvis|赛维斯|瑟维斯|瑟维丝|service|sirvis|cervis|serious|sirius)[\s,，:：-]*/i,
      '',
    )
    .replace(/^(?:请|麻烦|帮我|给我|我想要|我要|你能|能不能)\s*/i, '')
    .replace(/^(?:请|麻烦|帮我|给我|我想要|我要|你能|能不能)\s*/i, '')
    .trim();
  value = value.replace(/[。！？!?]+$/u, '').trim();
  value = value.replace(/\s+(?:好吗|可以吗|行吗)$/u, '').trim();
  return value;
};

const unquote = (input: string): string => {
  const value = input.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['`', '`'],
  ];
  for (const [left, right] of pairs) {
    if (value.startsWith(left) && value.endsWith(right)) {
      return value.slice(left.length, -right.length).trim();
    }
  }
  return value.replace(/^[，,：:\s]+|[，,：:\s]+$/g, '').trim();
};

const looksLikePath = (value: string): boolean => {
  const normalized = unquote(value);
  const firstSegment = normalized.split(/[\\/]/, 1)[0]?.toLowerCase();
  return (
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    /^\\\\/.test(normalized) ||
    /^[/~]/.test(normalized) ||
    /[\\/]/.test(normalized) ||
    /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,12}$/.test(normalized) ||
    Boolean(firstSegment && KNOWN_FOLDER_NAMES.has(firstSegment))
  );
};

const splitContent = (
  input: string,
): { target: string; content: string | null } => {
  const match =
    input.match(
      /(?:[,，]\s*)?(?:内容|文本)(?!\.)(?:\s*(?:为|是|设置成|设置为|：|:|=))?\s*([\s\S]*)$/u,
    ) ||
    input.match(
      /(?:[,，]\s*|\s+)(?:content|contents)(?:\s*(?:is|为|是|：|:|=))?\s*([\s\S]*)$/i,
    );
  if (!match || match.index === undefined || match.index === 0) {
    return { target: unquote(input), content: null };
  }
  return {
    target: unquote(input.slice(0, match.index)),
    content: unquote(match[1]),
  };
};

const joinDirectory = (
  directory: string,
  target: string,
  context: { resolvePath(input: string): string },
): string => {
  const cleanTarget = unquote(target);
  if (path.isAbsolute(cleanTarget)) {
    return cleanTarget;
  }
  return path.join(context.resolvePath(unquote(directory)), cleanTarget);
};

const parseUrl = (value: string): string | null => {
  try {
    const parsed = new URL(unquote(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

export const extractBrowserSearchQuery = (input: string): string | null => {
  const text = input
    .normalize('NFKC')
    .trim()
    .replace(/^(?:请|麻烦|帮我|给我)\s*/i, '')
    .replace(/[。！？!?]+$/u, '')
    .trim();
  const browserSearch = text.match(
    /^(?:(?:打开|启动|用)\s*)?(?:浏览器|网页)\s*(?:并|然后)?\s*(?:搜索|搜一下|查一下|查找)\s*(.+)$/i,
  );
  const genericSearch = text.match(/^(?:搜索|搜一下|查一下|查找)\s*(.+)$/i);
  const rawQuery = browserSearch?.[1] || genericSearch?.[1] || '';
  const query = rawQuery
    .replace(/^一下\s*/u, '')
    .replace(/^(?:网页|网上|网上关于)\s*/u, '')
    .trim();
  if (
    !query ||
    (!browserSearch && /^(?:文件|目录|文件夹|本地文件|代码)\b/i.test(query))
  ) {
    return null;
  }
  return query;
};

const command = (
  tool: string,
  args: Record<string, unknown>,
  summary: string,
): ParsedCommand => ({ tool, args, summary });

export class FastToolRouter {
  private pending: PendingConfirmation | null = null;
  private executionScheduler: FastToolExecutionScheduler | null = null;
  private readonly confirmationTtlMs: number;
  private readonly providerCatalog: FastToolProviderCatalog;

  constructor(
    private readonly registry: Registry,
    private readonly context: ToolContext,
    options: FastToolRouterOptions = {},
  ) {
    this.confirmationTtlMs = options.confirmationTtlMs ?? 120_000;
    this.providerCatalog =
      options.providerCatalog || createFastToolProviderCatalog(registry);
    options.capabilityBroker?.setConfirmationHandler(
      async (prepared, summary) =>
        this.requestPreparedConfirmation(prepared, summary),
    );
  }

  setExecutionScheduler(scheduler: FastToolExecutionScheduler | null): void {
    this.executionScheduler = scheduler;
  }

  async executeNavigationTool(toolId: string, args: Record<string, unknown>) {
    return this.executeProviderToolCall('cyrvis_capability_invoke', {
      toolId,
      arguments: args,
    });
  }

  resolveProviderToolName(providerName: string): string | null {
    return this.providerCatalog.resolve(providerName);
  }

  hasPendingConfirmation(now = Date.now()): boolean {
    return Boolean(this.validPending(now));
  }

  getPendingConfirmation(now = Date.now()): PendingConfirmationSnapshot | null {
    const pending = this.validPending(now);
    return pending
      ? {
          tool: pending.route.tool,
          risk: pending.route.risk,
          domain: pending.route.domain,
          confirmationReason: pending.route.confirmationReason,
          expiresAt: pending.expiresAt,
        }
      : null;
  }

  async confirmPending(): Promise<FastToolOutcome> {
    const pending = this.validPending(Date.now());
    if (!pending) {
      return {
        handled: true,
        ok: false,
        speech: '确认已经过期，请重新发出指令。',
      };
    }
    return this.execute({
      ...pending.route,
      kind: 'confirm',
      requiresConfirmation: false,
      confirmationReason: null,
    });
  }

  async cancelPending(): Promise<FastToolOutcome> {
    const pending = this.validPending(Date.now());
    if (!pending) {
      return { handled: false };
    }
    return this.execute({
      ...pending.route,
      kind: 'cancel',
      requiresConfirmation: false,
      confirmationReason: null,
      summary: `取消${pending.route.summary}`,
    });
  }

  isPendingConfirmationReply(text: string, now = Date.now()): boolean {
    if (!this.validPending(now)) {
      return false;
    }
    return isContextualConfirmation(text) || isContextualCancellation(text);
  }

  isConfirmationIntent(text: string): boolean {
    const normalized = normalize(text);
    if (this.validPending()) {
      return isContextualConfirmation(text) || isContextualCancellation(text);
    }
    return (
      CONFIRM_COMMAND_PATTERN.test(normalized) ||
      CANCEL_COMMAND_PATTERN.test(normalized)
    );
  }

  isLongRunningProviderTool(
    providerName: string,
    args: Record<string, unknown>,
  ): boolean {
    const localName = this.resolveProviderToolName(providerName);
    return localName ? this.isLongRunningTool(localName, args) : false;
  }

  isLongRunningTool(tool: string, args: Record<string, unknown>): boolean {
    const target =
      tool === 'capability.invoke' && typeof args.toolId === 'string'
        ? args.toolId
        : tool;
    const definition = this.registry.get(target);
    if (!definition) return ALWAYS_BACKGROUND_TOOLS.has(target);
    if (definition.capability?.latencyClass === 'slow') return true;
    if ((definition.contract?.timeoutMs || 0) >= BACKGROUND_TIMEOUT_MS) {
      return true;
    }
    if (ALWAYS_BACKGROUND_TOOLS.has(target)) return true;
    if (
      target === 'process.run' &&
      typeof args.timeoutMs === 'number' &&
      args.timeoutMs >= BACKGROUND_TIMEOUT_MS
    ) {
      return true;
    }
    return false;
  }

  async executeProviderToolCall(
    providerName: string,
    args: Record<string, unknown>,
  ): Promise<{ localName: string; outcome: FastToolOutcome } | null> {
    const localName = this.resolveProviderToolName(providerName);
    if (!localName) {
      return null;
    }
    const prepared = await this.registry.prepare(localName, args);
    const route: FastToolRoute = {
      kind: 'execute',
      tool: prepared.tool,
      args: prepared.args,
      summary: `执行本地工具 ${prepared.tool}`,
      requiresConfirmation: prepared.requiresConfirmation,
      confirmationReason: prepared.confirmationReason,
      risk: prepared.risk,
      domain: prepared.definition.domain,
    };
    return {
      localName,
      outcome: await this.execute(route),
    };
  }

  async executeConfirmedCommand(text: string): Promise<FastToolOutcome | null> {
    const parsed = this.parse(text, Date.now());
    if (!parsed || parsed.tool.startsWith('__')) {
      return null;
    }
    const prepared = await this.registry.prepare(parsed.tool, parsed.args);
    const result = await this.registry.execute(prepared.tool, prepared.args, {
      confirmed: true,
    });
    const route: FastToolRoute = {
      kind: 'execute',
      tool: prepared.tool,
      args: prepared.args,
      summary: parsed.summary,
      requiresConfirmation: false,
      confirmationReason: null,
      risk: prepared.risk,
      domain: prepared.definition.domain,
    };
    return {
      handled: true,
      ok: result.ok,
      speech: result.speech,
      result,
      route,
    };
  }

  canHandle(text: string): boolean {
    return this.parse(text, Date.now()) !== null;
  }

  async match(text: string, now = Date.now()): Promise<FastToolRoute | null> {
    const parsed = this.parse(text, now);
    if (!parsed) {
      return null;
    }
    if (parsed.tool === '__confirm__') {
      const pending = this.validPending(now);
      if (!pending) {
        return null;
      }
      return {
        ...pending.route,
        kind: 'confirm',
        requiresConfirmation: false,
        confirmationReason: null,
      };
    }
    if (parsed.tool === '__cancel__') {
      const pending = this.validPending(now);
      if (!pending) {
        return null;
      }
      return {
        ...pending.route,
        kind: 'cancel',
        requiresConfirmation: false,
        confirmationReason: null,
        summary: `取消${pending.route.summary}`,
      };
    }

    // A new explicit command supersedes any older confirmation request.
    this.pending = null;
    const prepared = await this.registry.prepare(parsed.tool, parsed.args);
    return {
      kind: 'execute',
      tool: prepared.tool,
      args: prepared.args,
      summary: parsed.summary,
      requiresConfirmation: prepared.requiresConfirmation,
      confirmationReason: prepared.confirmationReason,
      risk: prepared.risk,
      domain: prepared.definition.domain,
    };
  }

  async execute(route: FastToolRoute): Promise<FastToolOutcome> {
    if (route.kind === 'cancel') {
      this.pending = null;
      return {
        handled: true,
        ok: true,
        speech: '已取消，没有执行这个操作。',
        route,
      };
    }

    if (route.kind === 'confirm') {
      const pending = this.validPending(Date.now());
      this.pending = null;
      if (!pending) {
        return {
          handled: true,
          ok: false,
          speech: '确认已经过期，请重新发出指令。',
          route,
        };
      }
      return this.runRoute({
        ...pending.route,
        kind: 'execute',
        requiresConfirmation: false,
        confirmationReason: null,
      });
    }

    if (route.requiresConfirmation) {
      const prepared = await this.registry.prepare(route.tool, route.args);
      return {
        handled: true,
        ok: true,
        speech: this.requestPreparedConfirmation(prepared, route.summary),
        route,
      };
    }

    return this.runRoute(route);
  }

  private async runRoute(route: FastToolRoute): Promise<FastToolOutcome> {
    if (this.executionScheduler) {
      return this.executionScheduler.execute(route);
    }

    const result = await this.registry.execute(route.tool, route.args, {
      confirmed: true,
    });
    return {
      handled: true,
      ok: result.ok,
      speech: result.speech,
      result,
      route,
    };
  }

  async handleText(text: string, now = Date.now()): Promise<FastToolOutcome> {
    const route = await this.match(text, now);
    if (!route) {
      return { handled: false };
    }
    return this.execute(route);
  }

  private validPending(now = Date.now()): PendingConfirmation | null {
    if (!this.pending) {
      return null;
    }
    if (this.pending.expiresAt < now) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  private requestPreparedConfirmation(
    prepared: PreparedToolCall,
    summary: string,
  ): string {
    if (this.validPending(Date.now())) {
      return SENSITIVE_CONFIRMATION_PROMPT;
    }
    const route: FastToolRoute = {
      kind: 'execute',
      tool: prepared.tool,
      args: prepared.args,
      summary,
      requiresConfirmation: true,
      confirmationReason: prepared.confirmationReason,
      risk: prepared.risk,
      domain: prepared.definition.domain,
    };
    this.pending = {
      prepared,
      route,
      expiresAt: Date.now() + this.confirmationTtlMs,
    };
    return SENSITIVE_CONFIRMATION_PROMPT;
  }

  private parse(input: string, now: number): ParsedCommand | null {
    const text = normalize(input);
    if (!text) {
      return null;
    }
    if (this.validPending(now)) {
      if (isContextualConfirmation(text)) {
        return command('__confirm__', {}, '确认执行');
      }
      if (isContextualCancellation(text)) {
        return command('__cancel__', {}, '取消操作');
      }
    }

    return (
      this.parseClipboard(text) ||
      this.parseSystem(text) ||
      this.parseBrowserPage(text) ||
      this.parseWindow(text) ||
      this.parseApplication(text) ||
      this.parseWeb(text) ||
      this.parsePresentation(text) ||
      this.parseCreateDirectory(text) ||
      this.parseCreateFile(text) ||
      this.parseWriteFile(text) ||
      this.parseAppendFile(text) ||
      this.parseDeleteLines(text) ||
      this.parseReplaceText(text) ||
      this.parseCopy(text) ||
      this.parseMove(text) ||
      this.parseRename(text) ||
      this.parseDelete(text) ||
      this.parseSearch(text) ||
      this.parseReadFile(text) ||
      this.parseDirectoryTree(text) ||
      this.parseListDirectory(text) ||
      this.parseFileInfo(text) ||
      this.parseRandomOpen(text) ||
      this.parseOpenPath(text)
    );
  }

  private parseClipboard(text: string): ParsedCommand | null {
    if (
      /^(?:读取|查看|看看)?\s*(?:系统)?剪贴板(?:里|中)?(?:的)?(?:内容|是什么|有什么)?$/i.test(
        text,
      )
    ) {
      return command('clipboard.read', {}, '读取剪贴板');
    }
    let match = text.match(
      /^(?:把|将)?\s*([\s\S]+?)\s*(?:写入|复制到|放到)\s*剪贴板$/i,
    );
    if (match) {
      return command(
        'clipboard.write',
        { text: unquote(match[1]) },
        '写入剪贴板',
      );
    }
    match = text.match(
      /^(?:写入|设置)\s*剪贴板\s+(?:内容为|内容是|为|：|:)?\s*([\s\S]+)$/i,
    );
    if (match) {
      return command(
        'clipboard.write',
        { text: unquote(match[1]) },
        '写入剪贴板',
      );
    }
    return null;
  }

  private parseSystem(text: string): ParsedCommand | null {
    if (
      /^(?:查看|显示|告诉我)?\s*(?:系统信息|电脑信息|设备信息|配置信息|系统状态)$/i.test(
        text,
      )
    ) {
      return command('system.info', {}, '读取系统信息');
    }
    const disk = text.match(
      /^(?:查看|显示|告诉我)?\s*(?:磁盘空间|硬盘空间)(?:\s+(.+))?$/i,
    );
    if (disk) {
      return command(
        'system.disk',
        disk[1] ? { path: unquote(disk[1]) } : {},
        '查看磁盘空间',
      );
    }
    if (
      /^(?:列出|查看|显示)?\s*(?:运行中的程序|进程列表|所有进程|当前进程)$/i.test(
        text,
      )
    ) {
      return command('process.list', {}, '列出运行中的进程');
    }
    return null;
  }

  private parseWindow(text: string): ParsedCommand | null {
    const documentExtensions =
      /\.(?:txt|text|md|markdown|log|csv|json|pdf|docx?|pptx?|xlsx?)$/i;
    const closeMatch = text.match(/^(?:关闭|关掉|退出)\s*(.+)$/i);
    if (closeMatch) {
      let target = unquote(closeMatch[1]);
      target = target.replace(/^(?:这个|那个|当前)\s*/i, '').trim();
      const explicitlyRequestsWindow =
        /^(?:窗口|文件窗口)\s*/i.test(target) ||
        /^文件\s*/i.test(target) ||
        /\s*窗口$/i.test(target) ||
        documentExtensions.test(target) ||
        /^(?:txt|text|文本|文字|md|markdown|log|csv|json|pdf|docx?|pptx?|xlsx?)(?:\s*文件|\s*窗口)?$/i.test(
          target,
        ) ||
        /(?:^|\s)(?:txt|text|文本|文字|md|markdown|log|csv|json|pdf|docx?|pptx?|xlsx?)(?:\s*文件|\s*窗口)?$/i.test(
          target,
        );
      if (explicitlyRequestsWindow) {
        target = target
          .replace(/^(?:窗口|文件窗口|文件)\s*/i, '')
          .replace(/\s*(?:文件|窗口)$/i, '')
          .trim();
        if (target) {
          return command(
            'window.close',
            { query: target },
            `关闭文件窗口 ${target}`,
          );
        }
      }
    }
    const reversedClose = text.match(
      /^(?:把|将)\s*(.+?)\s*(?:窗口|文件)?\s*(?:关闭|关掉|退出)$/i,
    );
    if (reversedClose) {
      const target = unquote(reversedClose[1]);
      if (documentExtensions.test(target) || /(?:窗口|文件)$/i.test(target)) {
        return command(
          'window.close',
          {
            query: target.replace(/\s*(?:窗口|文件)$/i, '').trim(),
          },
          `关闭文件窗口 ${target}`,
        );
      }
    }

    const allWindows =
      /^(?:把|将)?\s*(?:所有|全部)?\s*(?:桌面(?:上|中的?)?)?\s*(?:所有|全部)?\s*窗口\s*(?:都|全部)?\s*(?:最小化|收起)$/i;
    const minimizeAll =
      /^(?:最小化|收起)\s*(?:所有|全部)?\s*(?:桌面(?:上|中的?)?)?\s*(?:所有|全部)?\s*窗口$/i;
    if (
      allWindows.test(text) ||
      minimizeAll.test(text) ||
      /^显示桌面$/i.test(text)
    ) {
      return command('window.minimize_all', {}, '最小化所有桌面窗口');
    }

    const restoreAll =
      /^(?:把|将)?\s*(?:所有|全部)?\s*(?:桌面(?:上|中的?)?)?\s*(?:所有|全部)?\s*窗口\s*(?:都|全部)?\s*(?:恢复|还原|显示出来)$/i;
    const restoreAllVerb =
      /^(?:恢复|还原)\s*(?:所有|全部)?\s*(?:桌面(?:上|中的?)?)?\s*(?:所有|全部)?\s*窗口$/i;
    if (restoreAll.test(text) || restoreAllVerb.test(text)) {
      return command('window.restore_all', {}, '恢复所有桌面窗口');
    }

    if (
      /^(?:列出|查看|显示)?\s*(?:当前)?(?:窗口列表|所有窗口|可见窗口)$/i.test(
        text,
      )
    ) {
      return command('window.list', {}, '列出窗口');
    }
    const match = text.match(
      /^(切换(?:到)?|聚焦|激活|最小化|最大化)\s*窗口\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const query = unquote(match[2]);
    if (!query) {
      return null;
    }
    if (match[1].startsWith('最小化')) {
      return command('window.minimize', { query }, `最小化窗口 ${query}`);
    }
    if (match[1].startsWith('最大化')) {
      return command('window.maximize', { query }, `最大化窗口 ${query}`);
    }
    return command('window.focus', { query }, `切换到窗口 ${query}`);
  }

  private parseBrowserPage(text: string): ParsedCommand | null {
    const forward = text.match(
      /^(?:关闭|关掉)\s*(?:浏览器(?:里|中)?(?:的)?)?(.+?)\s*(?:网页|页面|标签页|标签)$/i,
    );
    const reverse = text.match(
      /^(?:把|将)\s*(.+?)\s*(?:网页|页面|标签页|标签)\s*(?:关闭|关掉)$/i,
    );
    const raw = forward?.[1] || reverse?.[1] || '';
    const query = unquote(raw)
      .replace(/^(?:这个|那个|当前)\s*/i, '')
      .replace(/\s*(?:这个|那个|当前)$/i, '')
      .trim();
    if (!query || /^(?:浏览器|网页|页面|标签页|标签)$/i.test(query)) {
      return null;
    }
    return command('browser.close_page', { query }, `关闭网页 ${query}`);
  }

  private parseApplication(text: string): ParsedCommand | null {
    if (
      /^(?:列出|查看|显示)?\s*(?:正在运行的|运行中的)?\s*(?:应用程序|应用|程序)(?:列表)?$/i.test(
        text,
      )
    ) {
      return command('app.list', {}, '列出运行中的应用');
    }
    let match = text.match(
      /^(?:打开|启动|运行|launch|open)\s*(?:应用|程序|app)?\s*(.+)$/i,
    );
    if (match) {
      const name = unquote(match[1]);
      if (isSupportedApplicationAlias(name)) {
        return command('app.launch', { name }, `打开${name}`);
      }
    }
    match = text.match(
      /^(?:关闭|退出|结束|close)\s*(?:应用|程序|app)?\s*(.+)$/i,
    );
    if (match) {
      const name = unquote(match[1]);
      if (isSupportedApplicationAlias(name)) {
        return command('app.close', { name }, `关闭${name}`);
      }
    }
    return null;
  }

  private parseWeb(text: string): ParsedCommand | null {
    const browserSearchQuery = extractBrowserSearchQuery(text);
    if (browserSearchQuery) {
      return command(
        'web.search',
        { query: browserSearchQuery },
        `搜索网页 ${browserSearchQuery}`,
      );
    }
    const open = text.match(
      /^(?:打开|访问|前往)\s*(?:网址|链接|网页|url)?\s+(.+)$/i,
    );
    if (open) {
      const url = parseUrl(open[1]);
      if (url) {
        return command('web.open_url', { url }, '打开网址');
      }
    }
    const search = text.match(
      /^(?:搜索网页|网页搜索|上网搜索|上网搜|浏览器搜索|web search|search the web)\s*(.+)$/i,
    );
    if (search) {
      const query = unquote(search[1]);
      return command('web.search', { query }, `搜索网页 ${query}`);
    }
    return null;
  }

  private parsePresentation(text: string): ParsedCommand | null {
    if (
      !/(?:创建|新建|生成|制作|做)/i.test(text) ||
      !/(?:pptx?|powerpoint|演示文稿)/i.test(text)
    ) {
      return null;
    }

    const quotedPath = text.match(/[“"]([^”"]+\.pptx?)[”"]/i)?.[1];
    const barePath = text.match(
      /((?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])[^，,。；;]+?\.pptx?)/i,
    )?.[1];
    const explicitPath = quotedPath || barePath;
    const titleMatch = text.match(
      /(?:关于|主题(?:是|为)?|标题(?:是|为)?)\s*(.+?)(?:的)?\s*(?:pptx?|powerpoint|演示文稿)/i,
    );
    const title = unquote(titleMatch?.[1] || 'CYRVIS 演示文稿');
    const pageCountMatch = text.match(/(\d{1,2})\s*页/i);
    const pageCount = pageCountMatch
      ? Math.max(3, Math.min(30, Number(pageCountMatch[1]) || 10))
      : 10;
    const audience =
      text.match(/(?:受众|面向|给)\s*([^，,。；;]{1,30})/i)?.[1]?.trim() || '';
    const locationMatch = text.match(
      /在\s*(.+?)\s*(?:上|里|中)?\s*(?:创建|新建|生成|制作|做)/i,
    );
    const explicitDirectory = locationMatch
      ? unquote(locationMatch[1])
      : '桌面';
    const safeTitle =
      title
        .replace(/[<>:"/\\|?*]/g, '-')
        .replace(/\p{Cc}/gu, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || 'CYRVIS 演示文稿';
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    const target = explicitPath
      ? unquote(explicitPath)
      : path.join(
          this.context.resolvePath(explicitDirectory),
          `CYRVIS-${safeTitle}-${timestamp}.pptx`,
        );

    return command(
      'office.create_presentation',
      {
        path: target,
        title,
        subtitle: '根据用户要求生成',
        content: text,
        ...(pageCountMatch ? { pageCount } : {}),
        audience,
        templateId: /(论文|学术)/i.test(text) ? 'thesis_01' : 'summary_01',
        mode: /(创意|设计感|视觉|风格化)/i.test(text) ? 'creative' : 'general',
        provider: 'auto',
      },
      `创建演示文稿 ${title}`,
    );
  }

  private parseCreateDirectory(text: string): ParsedCommand | null {
    let match = text.match(
      /^在\s*(.+?)\s*(?:下|里|中)?\s*(?:创建|新建)\s*(?:一个)?(?:文件夹|目录)\s*(.+)$/i,
    );
    if (match) {
      const target = joinDirectory(match[1], match[2], this.context);
      return command(
        'fs.create_directory',
        { path: target },
        `创建文件夹 ${target}`,
      );
    }
    match = text.match(
      /^(?:创建|新建|create)\s*(?:一个|a)?\s*(?:文件夹|目录|directory|folder)\s*(.+)$/i,
    );
    if (match) {
      const target = unquote(match[1]);
      return command(
        'fs.create_directory',
        { path: target },
        `创建文件夹 ${target}`,
      );
    }
    return null;
  }

  private parseCreateFile(text: string): ParsedCommand | null {
    let match = text.match(
      /^在\s*(.+?)\s*(?:下|里|中)?\s*(?:创建|新建|生成)\s*(?:一个)?(?:文本)?文件\s*(.+)$/i,
    );
    if (match) {
      const split = splitContent(match[2]);
      const target = joinDirectory(match[1], split.target, this.context);
      return command(
        'fs.create_file',
        { path: target, content: split.content ?? '' },
        `创建文件 ${target}`,
      );
    }
    match = text.match(
      /^(?:创建|新建|生成|create)\s*(?:一个|a)?\s*(?:文本)?(?:文件|file)\s*(.+)$/i,
    );
    if (match) {
      const split = splitContent(match[1]);
      return command(
        'fs.create_file',
        { path: split.target, content: split.content ?? '' },
        `创建文件 ${split.target}`,
      );
    }
    return null;
  }

  private parseWriteFile(text: string): ParsedCommand | null {
    const directWrite = text.match(
      /^(?:往|向|在)\s*(.+?\.(?:txt|text|md|markdown|log|csv|json|ya?ml|ini|xml))\s*(?:里|中)?\s*(?:写入|写进|写)\s*(?:内容)?\s*(?:为|是|：|:)?\s*([\s\S]+)$/i,
    );
    if (directWrite?.[2]?.trim()) {
      return command(
        'fs.write_file',
        {
          path: unquote(directWrite[1]),
          content: unquote(directWrite[2]),
        },
        `写入文件 ${unquote(directWrite[1])}`,
      );
    }
    const contentFirst = text.match(
      /^(?:把|将)\s*([\s\S]+?)\s*(?:写入|写进|写到)\s*(.+?\.(?:txt|text|md|markdown|log|csv|json|ya?ml|ini|xml))$/i,
    );
    if (contentFirst?.[1]?.trim()) {
      return command(
        'fs.write_file',
        {
          path: unquote(contentFirst[2]),
          content: unquote(contentFirst[1]),
        },
        `写入文件 ${unquote(contentFirst[2])}`,
      );
    }
    const match =
      text.match(/^(?:写入|写入到|写文件|write)\s*(?:文件)?\s*(.+)$/i) ||
      text.match(/^(?:修改|编辑)\s*文件\s*(.+)$/i);
    if (!match) {
      return null;
    }
    const split = splitContent(match[1]);
    if (!split.content) {
      return null;
    }
    return command(
      'fs.write_file',
      { path: split.target, content: split.content },
      `写入文件 ${split.target}`,
    );
  }

  private parseAppendFile(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:追加到|追加写入|append to)\s*(?:文件)?\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const split = splitContent(match[1]);
    if (!split.content) {
      return null;
    }
    return command(
      'fs.append_file',
      { path: split.target, content: split.content },
      `追加文件 ${split.target}`,
    );
  }

  private parseDeleteLines(text: string): ParsedCommand | null {
    if (
      !/(?:删除|删掉|移除|delete)/i.test(text) ||
      !/第\s*[\d一二三四五六七八九十百]+\s*行|(?:那|这)?一?行/i.test(text)
    ) {
      return null;
    }
    const fileMatch = text.match(
      /((?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])?[^，,。；;\n]+?\.(?:txt|text|md|markdown|log|csv|json|ya?ml|ini|xml))/i,
    );
    const target = unquote(fileMatch?.[1] || '')
      .replace(/^(?:把|将|删除|删掉|移除|文件)\s*/i, '')
      .replace(/^(?:把|将|删除|删掉|移除|文件)\s*/i, '')
      .replace(/\s*(?:文件|文本文件)$/i, '')
      .trim();
    if (!target || !looksLikePath(target)) {
      return null;
    }

    const rangeMatch = text.match(
      /第\s*([\d一二三四五六七八九十百]+)\s*行\s*(?:到|至|-|~)\s*第?\s*([\d一二三四五六七八九十百]+)\s*行/i,
    );
    const singleLineMatch = text.match(
      /第\s*([\d一二三四五六七八九十百]+)\s*行/i,
    );
    if (rangeMatch) {
      const startLine = parseLineNumber(rangeMatch[1]);
      const endLine = parseLineNumber(rangeMatch[2]);
      if (startLine === null || endLine === null) {
        return null;
      }
      return command(
        'fs.delete_lines',
        { path: target, startLine, endLine },
        `删除 ${target} 第 ${startLine} 到 ${endLine} 行`,
      );
    }
    if (singleLineMatch) {
      const line = parseLineNumber(singleLineMatch[1]);
      if (line === null) {
        return null;
      }
      return command(
        'fs.delete_lines',
        { path: target, line },
        `删除 ${target} 第 ${line} 行`,
      );
    }

    const match =
      text.match(
        /(?:包含|含有|写着|内容为|是)\s*(.+?)\s*(?:的)?(?:那|这)?一?行/i,
      ) || text.match(/(?:中|里)\s*(.+?)\s*(?:的)?(?:那|这)?一?行/i);
    const needle = unquote(match?.[1] || '').trim();
    if (!needle) {
      return null;
    }
    return command(
      'fs.delete_lines',
      {
        path: target,
        match: needle,
        all: /(?:所有|全部|每一|每个)/i.test(text),
      },
      `删除 ${target} 中包含 ${needle} 的行`,
    );
  }

  private parseReplaceText(text: string): ParsedCommand | null {
    let match = text.match(
      /^(?:修改|编辑|替换)\s*文件\s+(.+?)\s*(?:中的|里的|，|,)\s*(.+?)\s*(?:替换为|改成|改为|换成)\s*(.+)$/i,
    );
    if (match) {
      return command(
        'fs.replace_text',
        {
          path: unquote(match[1]),
          oldText: unquote(match[2]),
          newText: unquote(match[3]),
          all: false,
        },
        `修改文件 ${unquote(match[1])}`,
      );
    }
    match = text.match(
      /^(?:把|将)\s*文件\s+(.+?)\s*(?:中的|里的)\s*(.+?)\s*(?:替换为|改成|改为|换成)\s*(.+)$/i,
    );
    if (match) {
      return command(
        'fs.replace_text',
        {
          path: unquote(match[1]),
          oldText: unquote(match[2]),
          newText: unquote(match[3]),
          all: false,
        },
        `修改文件 ${unquote(match[1])}`,
      );
    }
    return null;
  }

  private parseCopy(text: string): ParsedCommand | null {
    const match =
      text.match(/^(?:复制|拷贝|copy)\s+(.+?)\s+(?:到|至|to)\s+(.+)$/i) ||
      text.match(/^(?:把|将)\s*(.+?)\s*(?:复制|拷贝)\s*(?:到|至)\s+(.+)$/i);
    if (!match) {
      return null;
    }
    const source = unquote(match[1]);
    const destination = unquote(match[2]);
    return command('fs.copy', { source, destination }, `复制 ${source}`);
  }

  private parseMove(text: string): ParsedCommand | null {
    const match =
      text.match(/^(?:移动|move)\s+(.+?)\s+(?:到|至|to)\s+(.+)$/i) ||
      text.match(/^(?:把|将)\s*(.+?)\s*(?:移动)\s*(?:到|至)\s+(.+)$/i);
    if (!match) {
      return null;
    }
    const source = unquote(match[1]);
    const destination = unquote(match[2]);
    return command('fs.move', { source, destination }, `移动 ${source}`);
  }

  private parseRename(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:重命名|改名|rename)\s+(.+?)\s+(?:为|成|to)\s+(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1]);
    const newName = unquote(match[2]);
    return command('fs.rename', { path: target, newName }, `重命名 ${target}`);
  }

  private parseDelete(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:删除|删掉|移除|delete)\s*(?:文件|文件夹|目录)?\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1]);
    if (!looksLikePath(target)) {
      return null;
    }
    return command('fs.delete_to_trash', { path: target }, `删除 ${target}`);
  }

  private parseSearch(text: string): ParsedCommand | null {
    let match = text.match(
      /^(?:搜索文件|查找文件|文件搜索)\s+(.+?)\s+(?:中的|里的|中|里)\s+(.+)$/i,
    );
    if (match) {
      return command(
        'fs.search',
        {
          path: unquote(match[1]),
          query: unquote(match[2]),
          scope: 'name',
        },
        `搜索文件 ${unquote(match[2])}`,
      );
    }
    match = text.match(
      /^(?:在\s*)?(.+?)\s*(?:目录下|文件夹下|中|里|下)?\s*(?:搜索|查找)\s+(.+)$/i,
    );
    if (match && looksLikePath(match[1])) {
      const scope = /内容|文本|文字/i.test(match[2]) ? 'content' : 'name';
      const query = unquote(
        match[2]
          .replace(/^(?:文件|文件名|名称|内容|文本|文字)\s+/i, '')
          .replace(/^(?:内容|文本|文字)$/i, ''),
      );
      if (!query) {
        return null;
      }
      return command(
        'fs.search',
        { path: unquote(match[1]), query, scope },
        `搜索文件 ${unquote(match[1])}`,
      );
    }
    return null;
  }

  private parseReadFile(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:读取|读一下|读出)(?:文件)?\s*(.+)$|^(?:查看|显示)文件内容\s*(.+)$|^read file\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1] || match[2] || match[3]);
    return command('fs.read_file', { path: target }, `读取文件 ${target}`);
  }

  private parseDirectoryTree(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:查看|显示|生成)?\s*(?:目录树|文件夹树|tree)\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1]);
    return command(
      'fs.directory_tree',
      { path: target },
      `查看目录树 ${target}`,
    );
  }

  private parseListDirectory(text: string): ParsedCommand | null {
    let match = text.match(
      /^(?:列出|查看|显示)\s*(.+?)\s*(?:目录|文件夹)(?:内容|下有什么|里有什么)?$/i,
    );
    if (match) {
      const target = unquote(match[1]);
      return command(
        'fs.list_directory',
        { path: target },
        `列出目录 ${target}`,
      );
    }
    match = text.match(
      /^(?:列出|查看|显示)\s*(.+?)\s*(?:下|里)(?:有什么|的内容|内容)?$/i,
    );
    if (match && looksLikePath(match[1])) {
      const target = unquote(match[1]);
      return command(
        'fs.list_directory',
        { path: target },
        `列出目录 ${target}`,
      );
    }
    return null;
  }

  private parseFileInfo(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:文件信息|查看文件信息|查看文件属性|获取文件信息)\s+(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1]);
    return command('fs.get_info', { path: target }, `查看文件信息 ${target}`);
  }

  private parseRandomOpen(text: string): ParsedCommand | null {
    if (
      !/(?:随机|任意|随意|随便)/i.test(text) ||
      !/(?:打开|挑|选|来一个|来个)/i.test(text)
    ) {
      return null;
    }
    const marker = text.search(/(?:随机|任意|随意|随便)/i);
    if (marker < 0) {
      return null;
    }
    const extensionMatch =
      text.match(/\.([A-Za-z0-9]{1,12})\b/) ||
      text.match(/\b(txt|text|md|markdown|csv|json|log|pdf|docx?)\b/i) ||
      text.match(/(文本|文字)/);
    const extension =
      extensionMatch?.[1]?.toLowerCase() === '文本' ||
      extensionMatch?.[1]?.toLowerCase() === '文字'
        ? 'txt'
        : extensionMatch?.[1]?.toLowerCase() || 'txt';
    if (
      !/^[a-z0-9]+$/i.test(extension) ||
      ![
        'txt',
        'text',
        'md',
        'markdown',
        'csv',
        'json',
        'log',
        'pdf',
        'doc',
        'docx',
      ].includes(extension)
    ) {
      return null;
    }
    if (extension === 'text') {
      return command(
        'fs.open_random',
        { path: '桌面', extension: 'txt' },
        '随机打开文本文件',
      );
    }

    let location = text
      .slice(0, marker)
      .replace(
        /^(?:(?:(?:帮我|请|麻烦你?|可以|能不能|给我)\s*)+(?:把|将)?|(?:把|将))\s*/i,
        '',
      )
      .replace(/^(?:在|从|打开|进入)\s*/i, '')
      .replace(
        new RegExp(
          `(?:[，,。；;\\s]*\\.?${extension})\\s*[，,。；;]?\\s*$`,
          'i',
        ),
        '',
      )
      .replace(/\s*(?:的|上|里|中|里面|其中)\s*$/i, '')
      .replace(/\s*(?:这|这个|那个)\s*$/i, '')
      .replace(/\s*(?:的|上|里|中|里面|其中)\s*$/i, '')
      .replace(/^(桌面|下载|文档|图片|音乐|视频)(?:目录|文件夹)$/i, '$1')
      .trim();
    if (!location) {
      location = '桌面';
    }
    if (/^(?:这|这个|那个|一个)$/i.test(location)) {
      location = '桌面';
    }
    return command(
      'fs.open_random',
      { path: unquote(location), extension },
      `从 ${location} 随机打开 .${extension} 文件`,
    );
  }

  private parseOpenPath(text: string): ParsedCommand | null {
    const match = text.match(
      /^(?:打开|编辑|open|edit)\s*(?:文件|文件夹|目录|路径|file|folder)?\s*(.+)$/i,
    );
    if (!match) {
      return null;
    }
    const target = unquote(match[1]);
    if (!looksLikePath(target)) {
      return null;
    }
    return command('fs.open', { path: target }, `打开 ${target}`);
  }
}
