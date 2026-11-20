/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import type { ToolDefinition, ToolResult } from './types';

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

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key].trim() : fallback);

const runDetached = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });

const TIME_ZONE_ALIASES: Record<string, string> = {
  北京: 'Asia/Shanghai',
  beijing: 'Asia/Shanghai',
  上海: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  东京: 'Asia/Tokyo',
  tokyo: 'Asia/Tokyo',
  伦敦: 'Europe/London',
  london: 'Europe/London',
  纽约: 'America/New_York',
  'new york': 'America/New_York',
  洛杉矶: 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
};

const normalizeTimeZone = (value: string): string => {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requested = value || local;
  return TIME_ZONE_ALIASES[requested.toLowerCase()] || requested;
};

const MEDIA_ACTIONS = [
  'play_pause',
  'stop',
  'next',
  'previous',
  'volume_up',
  'volume_down',
  'mute',
] as const;

const POWER_ACTIONS = ['lock', 'sleep', 'restart', 'shutdown'] as const;

export const SYSTEM_CONTROL_TOOLS: ToolDefinition[] = [
  {
    name: 'system.time',
    domain: 'system',
    description:
      'Return the current date, time, timezone, and Unix timestamp for a requested IANA timezone or the local timezone.',
    risk: 'low',
    capability: {
      providerId: 'system',
      tier: 2,
      activation: 'on-demand',
      priority: 71,
      tags: [
        'time',
        'date',
        'timezone',
        'clock',
        '时间',
        '日期',
        '时区',
        '现在',
      ],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string' },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      timezone: normalizeTimeZone(text(input, 'timezone')),
    }),
    async execute(args) {
      const timeZone = String(args.timezone);
      const now = new Date();
      try {
        const local = new Intl.DateTimeFormat('zh-CN', {
          timeZone,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now);
        return success('system.time', `当前时间是 ${local}。`, {
          epochMs: now.getTime(),
          iso: now.toISOString(),
          timeZone,
          local,
        });
      } catch {
        return failure(
          'system.time',
          `无法识别时区 ${timeZone}。`,
          'INVALID_TIMEZONE',
        );
      }
    },
  },
  {
    name: 'system.media',
    domain: 'system',
    description:
      'Control system media playback and volume with one media key action.',
    risk: 'low',
    capability: {
      providerId: 'system',
      tier: 2,
      activation: 'on-demand',
      priority: 48,
      tags: [
        'media',
        'volume',
        'mute',
        'music',
        'video',
        '媒体',
        '音量',
        '静音',
        '播放',
        '暂停',
        '下一首',
      ],
      permissions: ['system.media'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MEDIA_ACTIONS] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const action = text(input, 'action');
      if (!MEDIA_ACTIONS.includes(action as (typeof MEDIA_ACTIONS)[number])) {
        throw new Error(`Unsupported media action: ${action}`);
      }
      return { action };
    },
    async execute(args) {
      const { Key, keyboard } = await import('@computer-use/nut-js');
      const action = String(args.action);
      const keyByAction: Record<string, (typeof Key)[keyof typeof Key]> = {
        play_pause: Key.AudioPlay,
        stop: Key.AudioStop,
        next: Key.AudioNext,
        previous: Key.AudioPrev,
        volume_up: Key.AudioVolUp,
        volume_down: Key.AudioVolDown,
        mute: Key.AudioMute,
      };
      const key = keyByAction[action];
      await keyboard.pressKey(key);
      await keyboard.releaseKey(key);
      return success('system.media', `已执行媒体操作：${action}。`, {
        action,
      });
    },
  },
  {
    name: 'system.power',
    domain: 'system',
    description:
      'Lock, sleep, restart, or shut down the computer. Execute directly when the user explicitly requests it.',
    risk: 'high',
    capability: {
      providerId: 'system',
      tier: 4,
      activation: 'on-demand',
      priority: 9,
      tags: [
        'power',
        'lock',
        'sleep',
        'restart',
        'shutdown',
        '电源',
        '锁屏',
        '睡眠',
        '重启',
        '关机',
      ],
      permissions: ['system.power'],
      requirements: { platforms: ['win32'] },
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...POWER_ACTIONS] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    prepare: (input) => {
      const action = text(input, 'action');
      if (!POWER_ACTIONS.includes(action as (typeof POWER_ACTIONS)[number])) {
        throw new Error(`Unsupported power action: ${action}`);
      }
      return { action };
    },
    requiresConfirmation: (args) =>
      `执行电源操作 ${String(args.action)} 会中断当前活动。`,
    async execute(args) {
      if (process.platform !== 'win32') {
        return failure(
          'system.power',
          '电源控制当前只支持 Windows。',
          'UNSUPPORTED_PLATFORM',
        );
      }
      const action = String(args.action);
      switch (action) {
        case 'lock':
          await runDetached('rundll32.exe', ['user32.dll,LockWorkStation']);
          break;
        case 'sleep':
          await runDetached('rundll32.exe', [
            'powrprof.dll,SetSuspendState',
            '0,1,0',
          ]);
          break;
        case 'restart':
          await runDetached('shutdown.exe', ['/r', '/t', '0']);
          break;
        default:
          await runDetached('shutdown.exe', ['/s', '/t', '0']);
          break;
      }
      return success('system.power', `已执行电源操作：${action}。`, {
        action,
      });
    },
  },
  {
    name: 'network.interfaces',
    domain: 'network',
    description:
      'List local network interfaces, addresses, families, and internal/external status.',
    risk: 'low',
    capability: {
      providerId: 'network',
      tier: 2,
      activation: 'on-demand',
      priority: 55,
      tags: ['network', 'ip', 'adapter', 'interface', '网络', '网卡', '地址'],
      permissions: ['network'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const interfaces = Object.entries(os.networkInterfaces()).flatMap(
        ([name, addresses]) =>
          (addresses || []).map((address) => ({
            name,
            address: address.address,
            family: address.family,
            internal: address.internal,
            mac: address.mac,
            netmask: address.netmask,
            cidr: address.cidr,
          })),
      );
      return success(
        'network.interfaces',
        `当前读取到 ${interfaces.length} 个网络地址。`,
        { interfaces },
      );
    },
  },
];
