/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolDefinition, ToolResult } from '../tools/types';
import type { SystemStateStore } from './system-state';

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key] : fallback);

const limit = (
  input: Record<string, unknown>,
  fallback: number,
  maximum = 200,
): number =>
  typeof input.limit === 'number' && Number.isFinite(input.limit)
    ? Math.max(1, Math.min(maximum, Math.floor(input.limit)))
    : fallback;

const ok = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const fail = (tool: string, speech: string, message: string): ToolResult => ({
  ok: false,
  tool,
  speech,
  error: { code: 'SYSTEM_STATE_TOOL_FAILED', message },
});

export const createSystemStateTools = (
  store: SystemStateStore,
): ToolDefinition[] => [
  {
    name: 'system.snapshot',
    domain: 'system',
    description:
      'Read the cached non-sensitive system snapshot: OS, CPU, memory, disks, battery, network interface names, installed apps, Steam games, running processes, and visible windows.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const snapshot = await store.ensureFresh(false);
      const installed = snapshot.installedApplications.length;
      const games = snapshot.steamGames.length;
      return ok(
        'system.snapshot',
        `系统状态已读取：${snapshot.runningProcesses.length} 个进程，${installed} 个可发现应用${games ? `，${games} 个 Steam 游戏` : ''}。`,
        snapshot,
      );
    },
  },
  {
    name: 'system.capabilities',
    domain: 'system',
    description:
      'List dynamic capabilities currently available from the live system, such as software launching, Steam games, storage, power, and window control.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const snapshot = await store.ensureFresh(false);
      return ok(
        'system.capabilities',
        `当前系统提供了 ${snapshot.capabilities.length} 类动态能力。`,
        {
          capabilities: snapshot.capabilities,
          capturedAt: snapshot.capturedAt,
          runtimeObservedAt: snapshot.runtimeObservedAt,
          fullObservedAt: snapshot.fullObservedAt,
        },
      );
    },
  },
  {
    name: 'system.search_apps',
    domain: 'system',
    description:
      'Search installed applications and Steam games by natural-language name. Use this before launching software that is not a built-in alias.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query').trim(),
      limit: limit(input, 20, 100),
    }),
    async execute(args) {
      const query = String(args.query);
      if (!query) {
        return fail('system.search_apps', '需要提供应用名称。', 'empty query');
      }
      await store.ensureFresh(
        !store.getSnapshot().installedApplications.length,
      );
      const applications = store.searchApplications(query, Number(args.limit));
      return ok(
        'system.search_apps',
        applications.length
          ? `找到 ${applications.length} 个匹配应用，包括 ${applications
              .slice(0, 5)
              .map((application) => application.name)
              .join('、')}。`
          : `没有找到与 ${query} 匹配的应用。`,
        { query, applications },
      );
    },
  },
  {
    name: 'system.list_services',
    domain: 'system',
    description:
      'List or search non-sensitive Windows service status, display name, and start type.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        status: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query').trim(),
      status: text(input, 'status').trim(),
      limit: limit(input, 200, 1000),
    }),
    async execute(args) {
      await store.ensureFresh(false);
      const query = String(args.query).toLowerCase();
      const statusFilter = String(args.status).toLowerCase();
      const services = store
        .getSnapshot()
        .services.filter((service) => {
          const matchesQuery =
            !query ||
            service.name.toLowerCase().includes(query) ||
            service.displayName.toLowerCase().includes(query);
          const matchesStatus =
            !statusFilter ||
            service.status.toLowerCase().includes(statusFilter);
          return matchesQuery && matchesStatus;
        })
        .slice(0, Number(args.limit));
      return ok(
        'system.list_services',
        services.length
          ? `找到 ${services.length} 个服务，包括 ${services
              .slice(0, 5)
              .map((service) => service.displayName || service.name)
              .join('、')}。`
          : '没有找到匹配的系统服务。',
        { services },
      );
    },
  },
  {
    name: 'software.list_installed',
    domain: 'system',
    description:
      'List or filter installed applications discovered from the system, including Start apps, registry entries, desktop launchers, and Steam games.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query').trim(),
      limit: limit(input, 100, 500),
    }),
    async execute(args) {
      await store.ensureFresh(
        !store.getSnapshot().installedApplications.length,
      );
      const query = String(args.query);
      const applications = query
        ? store.searchApplications(query, Number(args.limit))
        : store
            .getSnapshot()
            .installedApplications.slice(0, Number(args.limit));
      return ok(
        'software.list_installed',
        query
          ? `找到 ${applications.length} 个与 ${query} 相关的应用。`
          : `系统中发现 ${applications.length} 个应用。`,
        { query, applications },
      );
    },
  },
  {
    name: 'software.launch',
    domain: 'system',
    description:
      'Launch an installed application by discovered ID, exact name, or close name. Use system.search_apps first when the name is ambiguous.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({ query: text(input, 'query').trim() }),
    async execute(args) {
      const query = String(args.query);
      if (!query) {
        return fail('software.launch', '需要提供应用名称。', 'empty query');
      }
      try {
        const application = await store.launchApplication(query);
        return ok(
          'software.launch',
          `正在打开 ${application.name}。`,
          application,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          'software.launch',
          `没有找到或无法启动 ${query}。`,
          message,
        );
      }
    },
  },
  {
    name: 'system.refresh',
    domain: 'system',
    description:
      'Force a fresh scan of installed applications, Steam libraries, hardware, running processes, and visible windows.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({ full: input.full !== false }),
    async execute(args) {
      const snapshot = await store.refresh(Boolean(args.full));
      return ok('system.refresh', '系统状态已刷新。', {
        capturedAt: snapshot.capturedAt,
        runtimeObservedAt: snapshot.runtimeObservedAt,
        fullObservedAt: snapshot.fullObservedAt,
        applications: snapshot.installedApplications.length,
        steamGames: snapshot.steamGames.length,
        capabilities: snapshot.capabilities,
      });
    },
  },
  {
    name: 'steam.list_games',
    domain: 'system',
    description:
      'List installed Steam games by name or AppID using Steam library manifests.',
    risk: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 300 },
      },
      additionalProperties: false,
    },
    prepare: (input) => ({
      query: text(input, 'query').trim(),
      limit: limit(input, 100, 300),
    }),
    async execute(args) {
      await store.ensureFresh(!store.getSnapshot().steamGames.length);
      const query = String(args.query);
      const games = store
        .getSnapshot()
        .steamGames.filter(
          (game) =>
            !query ||
            game.appId === query ||
            game.name.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, Number(args.limit));
      return ok(
        'steam.list_games',
        games.length
          ? `找到 ${games.length} 个 Steam 游戏，包括 ${games
              .slice(0, 5)
              .map((game) => game.name)
              .join('、')}。`
          : query
            ? `没有找到与 ${query} 匹配的 Steam 游戏。`
            : '没有发现已安装的 Steam 游戏。',
        { query, games },
      );
    },
  },
  {
    name: 'steam.launch_game',
    domain: 'system',
    description:
      'Launch an installed Steam game by exact name, partial name, or AppID.',
    risk: 'medium',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    prepare: (input) => ({ query: text(input, 'query').trim() }),
    async execute(args) {
      try {
        const game = await store.launchSteamGame(String(args.query));
        return ok(
          'steam.launch_game',
          `正在启动 Steam 游戏 ${game.name}。`,
          game,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          'steam.launch_game',
          `没有找到或无法启动 Steam 游戏 ${String(args.query)}。`,
          message,
        );
      }
    },
  },
];
