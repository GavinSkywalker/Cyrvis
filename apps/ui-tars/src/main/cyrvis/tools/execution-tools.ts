/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';

import type { ToolDefinition, ToolResult } from './types';

const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_ARGS = 64;

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

const stringArray = (value: unknown, key: string): string[] => {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARGS ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${key} must be an array of at most ${MAX_ARGS} strings`);
  }
  return value;
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

const truncateOutput = (
  value: string | Buffer | undefined,
): { output: string; truncated: boolean } => {
  const buffer = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value || '', 'utf8');
  if (buffer.byteLength <= MAX_OUTPUT_BYTES) {
    return { output: buffer.toString('utf8'), truncated: false };
  }
  return {
    output: buffer.subarray(0, MAX_OUTPUT_BYTES).toString('utf8'),
    truncated: true,
  };
};

const prepareProcessArgs = (
  input: Record<string, unknown>,
  context: Parameters<ToolDefinition['prepare']>[1],
) => {
  const executable = text(input, 'executable', { required: true });
  if (!executable) {
    throw new Error('executable is required');
  }
  const cwdInput = text(input, 'cwd');
  return {
    executable,
    args: stringArray(input.args, 'args'),
    cwd: cwdInput ? context.resolvePath(cwdInput) : context.cwd,
    timeoutMs: integer(
      input,
      'timeoutMs',
      DEFAULT_TIMEOUT_MS,
      100,
      MAX_TIMEOUT_MS,
    ),
  };
};

export const EXECUTION_TOOLS: ToolDefinition[] = [
  {
    name: 'process.run',
    domain: 'system',
    description:
      'Run an executable with an argument array, wait for it to finish, and return exit code, stdout, and stderr. This never invokes a shell.',
    risk: 'high',
    capability: {
      providerId: 'system.process',
      tier: 4,
      activation: 'on-demand',
      priority: 8,
      tags: [
        'process',
        'command',
        'terminal',
        'run',
        '进程',
        '命令',
        '终端',
        '执行',
      ],
      permissions: ['process.spawn', 'system.process'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        executable: { type: 'string' },
        args: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_ARGS,
        },
        cwd: { type: 'string' },
        timeoutMs: {
          type: 'number',
          minimum: 100,
          maximum: MAX_TIMEOUT_MS,
        },
      },
      required: ['executable'],
      additionalProperties: false,
    },
    pathArgs: (args) => (args.cwd ? [String(args.cwd)] : []),
    prepare: prepareProcessArgs,
    requiresConfirmation: (args) =>
      `运行外部程序 ${String(args.executable)} 可能改变系统状态。`,
    async execute(args) {
      const startedAt = Date.now();
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        stdoutTruncated: boolean;
        stderrTruncated: boolean;
        timedOut: boolean;
        errorMessage: string | null;
      }>((resolve) => {
        execFile(
          String(args.executable),
          args.args as string[],
          {
            cwd: String(args.cwd),
            timeout: Number(args.timeoutMs),
            windowsHide: true,
            maxBuffer: MAX_OUTPUT_BYTES * 2,
          },
          (error, stdout, stderr) => {
            const truncatedStdout = truncateOutput(stdout);
            const truncatedStderr = truncateOutput(stderr);
            resolve({
              code:
                error && typeof error.code === 'number'
                  ? error.code
                  : error
                    ? null
                    : 0,
              signal: error?.signal || null,
              stdout: truncatedStdout.output,
              stderr: truncatedStderr.output,
              stdoutTruncated: truncatedStdout.truncated,
              stderrTruncated: truncatedStderr.truncated,
              timedOut: error?.killed === true,
              errorMessage: error?.message || null,
            });
          },
        );
      });
      const data = {
        executable: args.executable,
        args: args.args,
        cwd: args.cwd,
        durationMs: Date.now() - startedAt,
        ...result,
      };
      if (result.code === 0) {
        return success(
          'process.run',
          `程序执行完成，耗时 ${data.durationMs} 毫秒。`,
          data,
        );
      }
      return failure(
        'process.run',
        result.timedOut
          ? '程序执行超时。'
          : `程序执行失败，退出码 ${result.code ?? '未知'}。`,
        result.timedOut ? 'PROCESS_TIMEOUT' : 'PROCESS_EXIT_NON_ZERO',
        data,
      );
    },
  },
  {
    name: 'process.start',
    domain: 'system',
    description:
      'Start a detached executable with an argument array and return its PID without waiting for completion.',
    risk: 'high',
    capability: {
      providerId: 'system.process',
      tier: 4,
      activation: 'on-demand',
      priority: 7,
      tags: ['process', 'start', 'spawn', 'background', '进程', '启动', '后台'],
      permissions: ['process.spawn', 'system.process'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        executable: { type: 'string' },
        args: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_ARGS,
        },
        cwd: { type: 'string' },
      },
      required: ['executable'],
      additionalProperties: false,
    },
    pathArgs: (args) => (args.cwd ? [String(args.cwd)] : []),
    prepare: prepareProcessArgs,
    requiresConfirmation: (args) =>
      `启动后台程序 ${String(args.executable)} 可能改变系统状态。`,
    async execute(args) {
      const pid = await new Promise<number>((resolve, reject) => {
        const child = spawn(String(args.executable), args.args as string[], {
          cwd: String(args.cwd),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('spawn', () => {
          child.unref();
          resolve(child.pid || 0);
        });
        child.once('error', reject);
      });
      return success('process.start', `已启动后台程序，PID ${pid}。`, {
        executable: args.executable,
        args: args.args,
        cwd: args.cwd,
        pid,
      });
    },
  },
  {
    name: 'process.stop',
    domain: 'system',
    description:
      'Stop a running process by PID. Execute directly when the user explicitly requests it.',
    risk: 'high',
    capability: {
      providerId: 'system.process',
      tier: 4,
      activation: 'on-demand',
      priority: 6,
      tags: ['process', 'stop', 'kill', 'terminate', '进程', '停止', '结束'],
      permissions: ['system.process'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', minimum: 5 },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      pid: integer(input, 'pid', 0, 5, 2_147_483_647),
    }),
    requiresConfirmation: (args) =>
      `结束进程 ${String(args.pid)} 可能丢失未保存数据。`,
    async execute(args) {
      const pid = Number(args.pid);
      if (pid === process.pid) {
        return failure(
          'process.stop',
          '拒绝终止 CYRVIS 自身进程。',
          'PROTECTED_PROCESS',
        );
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        return failure(
          'process.stop',
          `无法结束进程 ${pid}。`,
          'PROCESS_STOP_FAILED',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
      return success('process.stop', `已请求结束进程 ${pid}。`, { pid });
    },
  },
  {
    name: 'process.inspect',
    domain: 'system',
    description:
      'Inspect whether a PID is running and return its visible process or window metadata when available.',
    risk: 'low',
    capability: {
      providerId: 'system.process',
      tier: 2,
      activation: 'state',
      priority: 53,
      tags: ['process', 'inspect', 'pid', 'status', '进程', '检查', '状态'],
      permissions: ['system.process'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        pid: { type: 'number', minimum: 1 },
      },
      required: ['pid'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      pid: integer(input, 'pid', 0, 1, 2_147_483_647),
    }),
    async execute(args, context) {
      const pid = Number(args.pid);
      const processes = await context.desktop.listProcesses();
      const matched = processes.find((entry) => entry.pid === pid);
      let running = Boolean(matched);
      if (!running) {
        try {
          process.kill(pid, 0);
          running = true;
        } catch {
          running = false;
        }
      }
      return running
        ? success('process.inspect', `进程 ${pid} 正在运行。`, {
            pid,
            running,
            process: matched || null,
          })
        : failure(
            'process.inspect',
            `进程 ${pid} 未运行。`,
            'PROCESS_NOT_RUNNING',
            { pid, running, process: null },
          );
    },
  },
];
