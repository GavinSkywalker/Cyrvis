/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createQwenDocPresentation,
  isQwenDocConfigured,
  type QwenDocPptMode,
} from './qwen-doc-presentation';
import { DOCUMENT_TOOLS } from './document-tools';
import type { ToolDefinition, ToolResult } from './types';

const MAX_REMOTE_PRESENTATION_BYTES = 50 * 1024 * 1024;

type PresentationProvider = 'auto' | 'qwen-doc' | 'powerpoint' | 'remote-api';

interface PreparedPresentation {
  path: string;
  title: string;
  subtitle: string;
  content: string;
  sourcePath: string;
  sourceFileId: string;
  mode: QwenDocPptMode;
  templateId: string;
  pageCount: number;
  audience: string;
  provider: PresentationProvider;
  complex: boolean;
}

const asString = (
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

const asNumber = (
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
};

const safeFileStem = (value: string): string =>
  value
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\p{Cc}/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'presentation';

const documentApiUrl = (): URL | null => {
  const value = process.env.CYRVIS_DOCUMENT_API_URL?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    )
  ) {
    throw new Error(
      'CYRVIS_DOCUMENT_API_URL 必须使用 HTTPS，或使用本机回环 HTTP 地址。',
    );
  }
  return url;
};

const validatePptx = async (target: string): Promise<number> => {
  const stats = await fs.stat(target);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error('PowerPoint 未生成有效文件。');
  }
  if (stats.size > MAX_REMOTE_PRESENTATION_BYTES) {
    throw new Error('演示文稿超过 50 MB。');
  }
  const handle = await fs.open(target, 'r');
  try {
    const signature = Buffer.alloc(2);
    await handle.read(signature, 0, 2, 0);
    if (signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new Error('生成的文件不是有效的 PPTX ZIP 文件。');
    }
  } finally {
    await handle.close();
  }
  return stats.size;
};

const createWithPowerPoint = async (
  input: PreparedPresentation,
  context: Parameters<ToolDefinition['prepare']>[1],
): Promise<void> => {
  await context.desktop.createPresentation({
    path: input.path,
    title: input.title,
    subtitle: input.subtitle || undefined,
  });
  await validatePptx(input.path);
};

const createRemotePresentation = async (
  input: PreparedPresentation,
): Promise<number> => {
  const url = documentApiUrl();
  if (!url) throw new Error('未配置 CYRVIS_DOCUMENT_API_URL。');
  const key = process.env.CYRVIS_DOCUMENT_API_KEY?.trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      format: 'pptx',
      filename: path.basename(input.path),
      title: input.title,
      subtitle: input.subtitle || '',
      content: input.content || '',
      pageCount: input.pageCount,
      audience: input.audience || '',
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(
      `远端文档服务返回 ${response.status} ${response.statusText}`.trim(),
    );
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REMOTE_PRESENTATION_BYTES
  ) {
    throw new Error('远端演示文稿超过允许的大小。');
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length) throw new Error('远端文档服务返回了空文件。');
  if (content.length > MAX_REMOTE_PRESENTATION_BYTES) {
    throw new Error('远端演示文稿超过允许的大小。');
  }
  if (content[0] !== 0x50 || content[1] !== 0x4b) {
    throw new Error('远端文档服务返回的内容不是有效的 PPTX ZIP 文件。');
  }
  const temporary = `${input.path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content);
    await fs.copyFile(temporary, input.path);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return content.length;
};

const failure = (
  errors: Array<{ provider: string; message: string }>,
): ToolResult => {
  const detail = errors
    .map((entry) => `${entry.provider}: ${entry.message}`)
    .join('; ');
  return {
    ok: false,
    tool: 'office.create_presentation',
    speech: 'PPT 制作没有完成，请稍后重试，或者告诉我换一种版式。',
    error: {
      code: 'POWERPOINT_UNAVAILABLE',
      message: detail,
    },
    data: { attempts: errors },
  };
};

export const OFFICE_TOOLS: ToolDefinition[] = [
  {
    name: 'office.create_presentation',
    domain: 'office',
    description:
      'Create a native PPTX. In auto mode, complex presentations prefer the configured qwen-doc-turbo cloud API and do not silently degrade to a one-slide local PowerPoint deck. Basic presentations may fall back to installed Microsoft PowerPoint or a configured document API.',
    risk: 'medium',
    capability: {
      providerId: 'office',
      tier: 2,
      activation: 'on-demand',
      priority: 73,
      tags: ['ppt', 'pptx', 'presentation', 'qwen-doc', '演示文稿', '幻灯片'],
      permissions: ['office'],
      costClass: 'medium',
      latencyClass: 'slow',
    },
    contract: {
      sideEffect: 'write',
      idempotent: false,
      retryable: false,
      timeoutMs: 10 * 60_000,
      verification: 'required',
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional PPTX path. Defaults to a timestamped file on the desktop.',
        },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        content: {
          type: 'string',
          description:
            'Source document text for generation. If omitted, the title and subtitle are used as the brief.',
        },
        sourcePath: {
          type: 'string',
          description:
            'Optional local text, DOCX, PPTX, or XLSX document used as PPT source content.',
        },
        sourceFileId: {
          type: 'string',
          description:
            'Optional Bailian file ID from the OpenAI-compatible files API, used as fileid://.',
        },
        mode: {
          type: 'string',
          enum: ['general', 'creative'],
        },
        templateId: {
          type: 'string',
          enum: ['news_01', 'summary_01', 'internet_01', 'thesis_01'],
        },
        pageCount: { type: 'number', minimum: 3, maximum: 30 },
        audience: { type: 'string' },
        provider: {
          type: 'string',
          enum: ['auto', 'qwen-doc', 'powerpoint', 'remote-api'],
        },
        complex: { type: 'boolean' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    pathArgs: (args) => [
      String(args.path),
      ...(typeof args.sourcePath === 'string' && args.sourcePath
        ? [args.sourcePath]
        : []),
    ],
    requiresConfirmation: async (args) => {
      try {
        await fs.access(String(args.path));
        return '目标演示文稿已存在，重新创建会覆盖它。';
      } catch {
        return null;
      }
    },
    prepare: (input, context) => {
      const title = asString(input, 'title', { required: true }).trim();
      const rawPath = asString(input, 'path').trim();
      const timestamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14);
      const requestedPath = rawPath
        ? context.resolvePath(rawPath)
        : path.join(
            context.resolvePath('Desktop'),
            `CYRVIS-${safeFileStem(title)}-${timestamp}.pptx`,
          );
      const extension = path.extname(requestedPath).toLowerCase();
      const target =
        extension === '.pptx'
          ? requestedPath
          : `${requestedPath.replace(/\.pptx?$/i, '')}.pptx`;
      const providerValue = asString(input, 'provider', {
        fallback: 'auto',
      });
      const provider: PresentationProvider = [
        'auto',
        'qwen-doc',
        'powerpoint',
        'remote-api',
      ].includes(providerValue)
        ? (providerValue as PresentationProvider)
        : 'auto';
      const modeValue = asString(input, 'mode', {
        fallback: 'general',
      });
      const sourceFileId = asString(input, 'sourceFileId').trim();
      const content = asString(input, 'content').trim();
      const pageCount = asNumber(input, 'pageCount', 10, 3, 30);
      const mode: QwenDocPptMode =
        sourceFileId || modeValue === 'creative' ? 'creative' : 'general';
      const complex =
        typeof input.complex === 'boolean'
          ? input.complex
          : Boolean(sourceFileId) ||
            Boolean(asString(input, 'sourcePath').trim()) ||
            (typeof input.pageCount === 'number' && pageCount >= 8) ||
            content.length >= 160 ||
            /(详细|完整|专业|复杂|报告|方案|策划|路演|论文|调研|多页|精美|设计感|汇报)/i.test(
              `${content}\n${asString(input, 'title')}\n${asString(input, 'subtitle')}`,
            );
      return {
        path: target,
        title,
        subtitle: asString(input, 'subtitle').trim(),
        content,
        sourcePath: asString(input, 'sourcePath').trim()
          ? context.resolvePath(asString(input, 'sourcePath'))
          : '',
        sourceFileId,
        mode,
        templateId: asString(input, 'templateId', {
          fallback: 'summary_01',
        }).trim(),
        pageCount,
        audience: asString(input, 'audience').trim(),
        provider,
        complex,
      } satisfies PreparedPresentation;
    },
    async execute(args, context) {
      const errors: Array<{ provider: string; message: string }> = [];
      let input = args as unknown as PreparedPresentation;
      await fs.mkdir(path.dirname(input.path), { recursive: true });
      const targetExisted = await fs
        .access(input.path)
        .then(() => true)
        .catch(() => false);
      const backupPath = targetExisted
        ? `${input.path}.cyrvis-backup-${new Date()
            .toISOString()
            .replace(/[-:.TZ]/g, '')}.pptx`
        : null;
      if (backupPath) {
        await fs.copyFile(input.path, backupPath);
      }
      if (input.sourcePath && !input.sourceFileId && !input.content) {
        const extractor = DOCUMENT_TOOLS.find(
          (tool) => tool.name === 'document.extract_text',
        );
        if (!extractor) {
          errors.push({
            provider: 'document-extract',
            message: 'document.extract_text 工具不可用。',
          });
        } else {
          try {
            const prepared = await extractor.prepare(
              { path: input.sourcePath },
              context,
            );
            const extracted = await extractor.execute(prepared, context);
            const text =
              extracted.data &&
              typeof extracted.data === 'object' &&
              typeof (extracted.data as { text?: unknown }).text === 'string'
                ? String((extracted.data as { text: string }).text)
                : '';
            if (!extracted.ok || !text.trim()) {
              throw new Error(extracted.speech || '文档内容为空。');
            }
            input = { ...input, content: text };
          } catch (error) {
            errors.push({
              provider: 'document-extract',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      const succeed = async (
        provider: string,
        data: Record<string, unknown> = {},
      ): Promise<ToolResult> => {
        let opened = false;
        let openError: string | null = null;
        try {
          await context.desktop.openPath(input.path);
          opened = true;
        } catch (error) {
          openError = error instanceof Error ? error.message : String(error);
        }
        return {
          ok: true,
          tool: 'office.create_presentation',
          speech: `演示文稿已制作完成：${path.basename(input.path)}。`,
          data: {
            path: input.path,
            title: input.title,
            provider,
            opened,
            openError,
            ...(backupPath ? { backupPath } : {}),
            ...data,
          },
        };
      };
      const attempt = async (
        provider: string,
        operation: () => Promise<Record<string, unknown> | void>,
      ): Promise<ToolResult | null> => {
        try {
          const data = (await operation()) || {};
          return await succeed(provider, data);
        } catch (error) {
          errors.push({
            provider,
            message: error instanceof Error ? error.message : String(error),
          });
          if (targetExisted && backupPath) {
            await fs.copyFile(backupPath, input.path).catch(() => undefined);
          } else {
            await fs.rm(input.path, { force: true }).catch(() => undefined);
          }
          return null;
        }
      };

      if (input.provider === 'qwen-doc') {
        context.reportProgress?.('正在整理演示内容。', 5);
        return (
          (await attempt('qwen-doc-turbo', async () => {
            const result = await createQwenDocPresentation(
              input,
              (message, percent) => context.reportProgress?.(message, percent),
            );
            return {
              model: result.model,
              mode: result.mode,
              templateId: result.templateId,
              downloadHost: result.downloadHost,
              bytes: result.bytes,
            };
          })) || failure(errors)
        );
      }
      if (input.provider === 'powerpoint') {
        context.reportProgress?.('正在准备演示文稿。', 20);
        return (
          (await attempt('powerpoint', async () => {
            await createWithPowerPoint(input, context);
          })) || failure(errors)
        );
      }
      if (input.provider === 'remote-api') {
        context.reportProgress?.('正在整理演示内容。', 8);
        return (
          (await attempt('remote-document-api', async () => ({
            bytes: await createRemotePresentation(input),
          }))) || failure(errors)
        );
      }

      if (isQwenDocConfigured()) {
        context.reportProgress?.('正在整理演示内容。', 5);
        const qwen = await attempt('qwen-doc-turbo', async () => {
          const result = await createQwenDocPresentation(
            input,
            (message, percent) => context.reportProgress?.(message, percent),
          );
          return {
            model: result.model,
            mode: result.mode,
            templateId: result.templateId,
            downloadHost: result.downloadHost,
            bytes: result.bytes,
          };
        });
        if (qwen) return qwen;
      } else if (input.complex) {
        errors.push({
          provider: 'qwen-doc-turbo',
          message:
            '未配置云端文档 API Key；复杂 PPT 不会降级为本机单页 PowerPoint。',
        });
      }
      let remoteConfigured = false;
      try {
        remoteConfigured = Boolean(documentApiUrl());
      } catch (error) {
        errors.push({
          provider: 'remote-document-api',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (remoteConfigured) {
        context.reportProgress?.('正在继续制作演示文稿。', 15);
        const remote = await attempt('remote-document-api', async () => ({
          bytes: await createRemotePresentation(input),
        }));
        if (remote) return remote;
      }
      if (!input.complex) {
        context.reportProgress?.('正在准备基础演示文稿。', 20);
        const local = await attempt('powerpoint', async () => {
          await createWithPowerPoint(input, context);
        });
        if (local) return local;
      }
      return failure(errors);
    },
    async verify(args) {
      try {
        const bytes = await validatePptx(String(args.path));
        return {
          ok: true,
          message: `已验证 PPTX 文件存在且 ZIP 头合法，共 ${bytes} 字节。`,
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  },
];
