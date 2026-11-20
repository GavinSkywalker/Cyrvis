/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import type { ToolDefinition, ToolResult } from './types';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_FETCH_BYTES = 8 * 1024 * 1024;

const text = (
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; fallback?: string } = {},
): string => {
  const value = input[key];
  if (typeof value === 'string') {
    return value.trim();
  }
  if (options.required) {
    throw new Error(`${key} is required`);
  }
  return options.fallback ?? '';
};

const integer = (
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

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const failure = (
  tool: string,
  speech: string,
  code: string,
  data?: unknown,
): ToolResult => ({
  ok: false,
  tool,
  speech,
  data,
  error: { code, message: speech },
});

const normalizeUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  url.username = '';
  // secretlint-disable-next-line @secretlint/secretlint-rule-pattern
  url.password = '';
  return url.toString();
};

const isPrivateAddress = (value: string): boolean => {
  if (net.isIPv4(value)) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(value)) {
    const normalized = value.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    );
  }
  return false;
};

const isPrivateTarget = async (value: string): Promise<boolean> => {
  const hostname = new URL(value).hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal'
  ) {
    return true;
  }
  if (isPrivateAddress(hostname)) {
    return true;
  }
  try {
    const addresses = await dns.lookup(hostname, {
      all: true,
      verbatim: true,
    });
    return addresses.some((entry) => isPrivateAddress(entry.address));
  } catch {
    return false;
  }
};

const readLimitedBody = async (
  response: Response,
  maximumBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> => {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    const chunk = Buffer.from(value);
    const remaining = maximumBytes - received;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk.subarray(0, remaining));
    received += Math.min(chunk.byteLength, remaining);
    if (chunk.byteLength > remaining) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { buffer: Buffer.concat(chunks), truncated };
};

const withFetchResponse = async <T>(
  url: string,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'CYRVIS/1.0 (+desktop assistant)',
        accept: '*/*',
      },
    });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
};

const isTextContentType = (contentType: string): boolean =>
  /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)|image\/svg\+xml)/i.test(
    contentType,
  );

export const NETWORK_TOOLS: ToolDefinition[] = [
  {
    name: 'web.fetch',
    domain: 'network',
    description:
      'Fetch an HTTP or HTTPS URL without browser automation and return bounded text or base64 data plus response metadata.',
    risk: 'medium',
    capability: {
      providerId: 'web',
      tier: 2,
      activation: 'on-demand',
      priority: 75,
      tags: [
        'web',
        'http',
        'fetch',
        'api',
        'page',
        '网页',
        '抓取',
        '请求',
        '接口',
      ],
      permissions: ['network'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxBytes: {
          type: 'number',
          minimum: 1024,
          maximum: MAX_FETCH_BYTES,
        },
        timeoutMs: {
          type: 'number',
          minimum: 500,
          maximum: 30_000,
        },
        binary: { type: 'boolean' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      url: normalizeUrl(text(input, 'url', { required: true })),
      maxBytes: integer(
        input,
        'maxBytes',
        DEFAULT_MAX_BYTES,
        1024,
        MAX_FETCH_BYTES,
      ),
      timeoutMs: integer(input, 'timeoutMs', 15_000, 500, 30_000),
      binary: input.binary === true,
    }),
    requiresConfirmation: async (args) =>
      (await isPrivateTarget(String(args.url)))
        ? `访问本地或私有网络地址 ${String(args.url)}。`
        : null,
    async execute(args) {
      try {
        return await withFetchResponse(
          String(args.url),
          Number(args.timeoutMs),
          async (response) => {
            const body = await readLimitedBody(response, Number(args.maxBytes));
            const contentType =
              response.headers.get('content-type') ||
              'application/octet-stream';
            const asText =
              args.binary !== true && isTextContentType(contentType);
            const content = asText
              ? body.buffer.toString('utf8')
              : body.buffer.toString('base64');
            const data = {
              url: String(args.url),
              finalUrl: response.url,
              status: response.status,
              statusText: response.statusText,
              contentType,
              encoding: asText ? 'utf8' : 'base64',
              bytes: body.buffer.byteLength,
              truncated: body.truncated,
              content,
            };
            return response.ok
              ? success(
                  'web.fetch',
                  `网页请求完成，状态码 ${response.status}。`,
                  data,
                )
              : failure(
                  'web.fetch',
                  `网页请求失败，状态码 ${response.status}。`,
                  'HTTP_STATUS_ERROR',
                  data,
                );
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'web.fetch',
          `网页请求失败：${message}`,
          error instanceof DOMException && error.name === 'AbortError'
            ? 'HTTP_TIMEOUT'
            : 'HTTP_REQUEST_FAILED',
          { url: args.url, error: message },
        );
      }
    },
  },
  {
    name: 'web.download',
    domain: 'network',
    description:
      'Download an HTTP or HTTPS resource to a local path with bounded size and direct overwrite when requested.',
    risk: 'medium',
    capability: {
      providerId: 'web',
      tier: 3,
      activation: 'on-demand',
      priority: 32,
      tags: ['web', 'download', 'file', '网页', '下载', '文件'],
      permissions: ['network', 'filesystem.write'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        path: { type: 'string' },
        maxBytes: {
          type: 'number',
          minimum: 1024,
          maximum: MAX_FETCH_BYTES,
        },
        timeoutMs: {
          type: 'number',
          minimum: 500,
          maximum: 30_000,
        },
      },
      required: ['url', 'path'],
      additionalProperties: false,
    },
    pathArgs: (args) => [String(args.path)],
    prepare: (input, context) => ({
      url: normalizeUrl(text(input, 'url', { required: true })),
      path: context.resolvePath(text(input, 'path', { required: true })),
      maxBytes: integer(
        input,
        'maxBytes',
        MAX_FETCH_BYTES,
        1024,
        MAX_FETCH_BYTES,
      ),
      timeoutMs: integer(input, 'timeoutMs', 30_000, 500, 30_000),
    }),
    requiresConfirmation: async (args) => {
      if (await isPrivateTarget(String(args.url))) {
        return `从本地或私有网络地址下载 ${String(args.url)}。`;
      }
      try {
        await fs.access(String(args.path));
        return `覆盖已有文件 ${String(args.path)}。`;
      } catch {
        return null;
      }
    },
    async execute(args) {
      try {
        return await withFetchResponse(
          String(args.url),
          Number(args.timeoutMs),
          async (response) => {
            if (!response.ok) {
              return failure(
                'web.download',
                `下载失败，状态码 ${response.status}。`,
                'HTTP_STATUS_ERROR',
                { url: args.url, status: response.status },
              );
            }
            const body = await readLimitedBody(response, Number(args.maxBytes));
            if (body.truncated) {
              return failure(
                'web.download',
                '下载内容超过允许大小，已拒绝写入不完整文件。',
                'DOWNLOAD_TOO_LARGE',
                {
                  url: args.url,
                  path: args.path,
                  maximumBytes: args.maxBytes,
                },
              );
            }
            const target = String(args.path);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, body.buffer);
            return success(
              'web.download',
              `已下载到 ${path.basename(target)}。`,
              {
                url: args.url,
                finalUrl: response.url,
                path: target,
                bytes: body.buffer.byteLength,
                truncated: false,
                contentType:
                  response.headers.get('content-type') ||
                  'application/octet-stream',
              },
            );
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(
          'web.download',
          `下载失败：${message}`,
          error instanceof DOMException && error.name === 'AbortError'
            ? 'HTTP_TIMEOUT'
            : 'DOWNLOAD_FAILED',
          { url: args.url, path: args.path, error: message },
        );
      }
    },
  },
];
