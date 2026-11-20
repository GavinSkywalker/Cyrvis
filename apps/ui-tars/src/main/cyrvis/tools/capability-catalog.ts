/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SystemStateStore } from '../system/system-state';
import type { SystemStateSnapshot } from '../system/types';
import { ProviderRegistry } from './provider-registry';
import {
  evaluateRequirements,
  mergeRequirements,
} from './provider-requirements';
import type { ToolRegistry } from './registry';
import type {
  CapabilityAvailability,
  CapabilityDescriptor,
  CapabilityRequirements,
  ToolExecutionContract,
  ToolDefinition,
  ToolExposureTier,
  ToolPermission,
} from './types';

interface CapabilityPolicy {
  providerId: string;
  tier: ToolExposureTier;
  activation: 'always' | 'state' | 'on-demand';
  priority: number;
  tags: string[];
}

interface RuntimeProviderAvailability {
  availability: CapabilityAvailability;
  reason?: string | null;
}

const DEFAULT_POLICY: CapabilityPolicy = {
  providerId: 'builtin',
  tier: 1,
  activation: 'always',
  priority: 50,
  tags: [],
};

const PROVIDER_PREFIXES: Array<[string, string]> = [
  ['capability.', 'capability'],
  ['fs.', 'filesystem'],
  ['app.', 'desktop.app'],
  ['window.', 'desktop.window'],
  ['clipboard.', 'clipboard'],
  ['web.', 'web'],
  ['office.', 'office'],
  ['steam.', 'steam'],
  ['software.', 'software'],
  ['system.', 'system'],
  ['process.', 'system'],
  ['context.', 'context'],
];

const TIER_OVERRIDES: Record<
  string,
  Pick<CapabilityPolicy, 'tier' | 'activation' | 'priority'>
> = {
  'capability.search': { tier: 0, activation: 'always', priority: 100 },
  'capability.describe': { tier: 0, activation: 'always', priority: 99 },
  'capability.invoke': { tier: 0, activation: 'always', priority: 98 },
  'capability.providers': { tier: 0, activation: 'always', priority: 97 },

  'fs.list_directory': { tier: 1, activation: 'always', priority: 90 },
  'fs.read_file': { tier: 1, activation: 'always', priority: 89 },
  'fs.open': { tier: 1, activation: 'always', priority: 88 },
  'fs.open_random': { tier: 1, activation: 'always', priority: 87 },
  'fs.create_file': { tier: 1, activation: 'always', priority: 85 },
  'app.launch': { tier: 1, activation: 'always', priority: 84 },
  'app.list': { tier: 1, activation: 'always', priority: 72 },
  'window.list': { tier: 1, activation: 'always', priority: 78 },
  'window.focus': { tier: 1, activation: 'always', priority: 77 },
  'clipboard.read': { tier: 1, activation: 'always', priority: 70 },
  'clipboard.write': { tier: 1, activation: 'always', priority: 69 },
  'web.search': { tier: 1, activation: 'always', priority: 76 },
  'web.open_url': { tier: 2, activation: 'state', priority: 64 },
  'system.info': { tier: 1, activation: 'always', priority: 74 },
  'software.launch': { tier: 1, activation: 'always', priority: 83 },
  'system.search_apps': { tier: 1, activation: 'always', priority: 82 },
  'system.snapshot': { tier: 1, activation: 'always', priority: 81 },
  'system.capabilities': { tier: 1, activation: 'always', priority: 80 },

  'fs.get_info': { tier: 2, activation: 'state', priority: 65 },
  'fs.directory_tree': { tier: 2, activation: 'state', priority: 55 },
  'fs.search': { tier: 2, activation: 'state', priority: 60 },
  'fs.write_file': { tier: 2, activation: 'on-demand', priority: 58 },
  'fs.append_file': { tier: 2, activation: 'on-demand', priority: 57 },
  'fs.replace_text': { tier: 2, activation: 'on-demand', priority: 56 },
  'fs.create_directory': { tier: 2, activation: 'state', priority: 54 },
  'window.minimize_all': { tier: 2, activation: 'state', priority: 52 },
  'window.restore_all': { tier: 2, activation: 'state', priority: 51 },
  'window.minimize': { tier: 2, activation: 'state', priority: 50 },
  'window.maximize': { tier: 2, activation: 'state', priority: 49 },
  'window.close': { tier: 2, activation: 'state', priority: 47 },
  'system.disk': { tier: 2, activation: 'state', priority: 62 },
  'process.list': { tier: 2, activation: 'state', priority: 61 },
  'system.list_services': { tier: 2, activation: 'state', priority: 45 },
  'system.refresh': { tier: 2, activation: 'state', priority: 44 },
  'software.list_installed': { tier: 2, activation: 'state', priority: 64 },
  'steam.list_games': { tier: 2, activation: 'state', priority: 68 },
  'steam.launch_game': { tier: 2, activation: 'state', priority: 75 },
  'office.create_presentation': { tier: 2, activation: 'state', priority: 73 },

  'fs.copy': { tier: 3, activation: 'on-demand', priority: 35 },
  'fs.move': { tier: 3, activation: 'on-demand', priority: 34 },
  'fs.rename': { tier: 3, activation: 'on-demand', priority: 33 },
  'app.close': { tier: 3, activation: 'on-demand', priority: 30 },
  'fs.delete_to_trash': { tier: 4, activation: 'on-demand', priority: 10 },
};

const TAGS: Record<string, string[]> = {
  filesystem: ['file', 'directory', '文件', '目录'],
  'desktop.app': ['application', 'app', '应用', '程序'],
  'desktop.window': ['window', '窗口'],
  clipboard: ['clipboard', '剪贴板'],
  web: ['web', 'browser', '网页', '浏览器'],
  office: ['office', 'powerpoint', 'ppt', '演示文稿'],
  steam: ['steam', 'game', '游戏'],
  software: ['software', 'application', '软件', '应用'],
  system: ['system', 'process', '系统', '进程', '服务'],
  context: ['context', 'resource', 'user', 'state', '上下文', '资源', '状态'],
  capability: ['capability', 'tool', '能力', '工具'],
  builtin: ['builtin'],
};

const inferProviderId = (definition: ToolDefinition): string => {
  const configured = definition.capability?.providerId?.trim();
  if (configured) {
    return configured;
  }
  return (
    PROVIDER_PREFIXES.find(([prefix]) =>
      definition.name.startsWith(prefix),
    )?.[1] || DEFAULT_POLICY.providerId
  );
};

const resolveProviderId = (
  definition: ToolDefinition,
  registeredProviderId: string | null,
): string => {
  if (definition.capability?.providerId?.trim()) {
    return definition.capability.providerId.trim();
  }
  if (registeredProviderId && registeredProviderId !== 'builtin') {
    return registeredProviderId;
  }
  return inferProviderId(definition);
};

const inferPolicy = (
  definition: ToolDefinition,
  providerId: string,
): CapabilityPolicy => {
  const override = TIER_OVERRIDES[definition.name];
  return {
    providerId,
    tier: definition.capability?.tier ?? override?.tier ?? DEFAULT_POLICY.tier,
    activation:
      definition.capability?.activation ??
      override?.activation ??
      DEFAULT_POLICY.activation,
    priority:
      definition.capability?.priority ??
      override?.priority ??
      DEFAULT_POLICY.priority,
    tags: [...(TAGS[providerId] || []), ...(definition.capability?.tags || [])],
  };
};

const normalize = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const inferExecutionContract = (
  definition: ToolDefinition,
): Required<ToolExecutionContract> => {
  const mutation =
    /(?:create|write|append|replace|copy|move|rename|delete|launch|close|control|focus|invoke|start)/i.test(
      definition.name,
    );
  const readOnly =
    /(?:list|read|inspect|snapshot|search|get_info|exists|hash)/i.test(
      definition.name,
    );
  return {
    sideEffect:
      definition.contract?.sideEffect ||
      (definition.risk === 'high'
        ? 'irreversible'
        : mutation
          ? 'external'
          : 'read'),
    idempotent: definition.contract?.idempotent ?? readOnly,
    retryable:
      definition.contract?.retryable ??
      (readOnly || (mutation && definition.risk === 'low')),
    maxAttempts: definition.contract?.maxAttempts ?? (readOnly ? 2 : 1),
    retryBackoffMs: definition.contract?.retryBackoffMs ?? 500,
    timeoutMs:
      definition.contract?.timeoutMs ??
      (definition.domain === 'network'
        ? 30_000
        : definition.domain === 'office'
          ? 120_000
          : 20_000),
    resumePolicy:
      definition.contract?.resumePolicy ?? (readOnly ? 'restart' : 'manual'),
    verification:
      definition.contract?.verification ?? (mutation ? 'preferred' : 'none'),
  };
};

export class CapabilityCatalog {
  private readonly deniedPermissions: ToolPermission[];
  private runtimeAvailabilityProvider:
    | ((providerId: string) => RuntimeProviderAvailability | null)
    | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly systemState?: SystemStateStore,
    private readonly providers = new ProviderRegistry(),
    deniedPermissions: ToolPermission[] = (
      process.env.CYRVIS_DENIED_TOOL_PERMISSIONS || ''
    )
      .split(/[;,\r\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean) as ToolPermission[],
  ) {
    this.deniedPermissions = deniedPermissions;
  }

  setRuntimeAvailabilityProvider(
    provider: (providerId: string) => RuntimeProviderAvailability | null,
  ): void {
    this.runtimeAvailabilityProvider = provider;
  }

  list(): CapabilityDescriptor[] {
    const snapshot = this.systemState?.getSnapshot() || null;
    return this.registry
      .list()
      .map((definition) => this.describeDefinition(definition, snapshot))
      .sort(
        (left, right) =>
          left.tier - right.tier ||
          right.priority - left.priority ||
          left.id.localeCompare(right.id),
      );
  }

  get(toolId: string): CapabilityDescriptor | null {
    const definition = this.registry.get(toolId);
    if (!definition) {
      return null;
    }
    return this.describeDefinition(
      definition,
      this.systemState?.getSnapshot() || null,
    );
  }

  search(query: string, limit = 20): CapabilityDescriptor[] {
    const needle = normalize(query);
    if (!needle) {
      return this.list().slice(0, limit);
    }
    return this.list()
      .map((capability) => {
        const id = normalize(capability.id);
        const provider = normalize(capability.providerId);
        const description = normalize(capability.description);
        const tags = normalize(capability.tags.join(' '));
        const searchable = `${id} ${provider} ${description} ${tags}`;
        const terms = needle.split(/\s+/).filter(Boolean);
        let score = 0;
        if (id === needle) {
          score = 100;
        } else if (id.startsWith(needle)) {
          score = 80;
        } else if (id.includes(needle)) {
          score = 60;
        } else if (tags.includes(needle)) {
          score = 40;
        } else if (provider.includes(needle)) {
          score = 30;
        } else if (description.includes(needle)) {
          score = 20;
        } else if (
          terms.length > 0 &&
          terms.every((term) => searchable.includes(term))
        ) {
          score = 15;
        }
        return { capability, score };
      })
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.capability.tier - right.capability.tier ||
          right.capability.priority - left.capability.priority,
      )
      .slice(0, limit)
      .map((entry) => entry.capability);
  }

  recordCall(toolId: string, ok: boolean, error?: string): void {
    void toolId;
    void ok;
    void error;
  }

  private describeDefinition(
    definition: ToolDefinition,
    snapshot: SystemStateSnapshot | null,
  ): CapabilityDescriptor {
    const providerId = resolveProviderId(
      definition,
      this.registry.getProviderId(definition.name),
    );
    const policy = inferPolicy(definition, providerId);
    const requirements = mergeRequirements(
      builtInRequirements(definition, providerId),
      this.providers.get(providerId)?.manifest.requirements,
      definition.capability?.requirements,
    );
    const permissions = [
      ...new Set([
        ...inferPermissions(definition),
        ...(requirements.permissions || []),
      ]),
    ];
    const state = this.availability(
      snapshot,
      providerId,
      permissions,
      requirements,
    );
    const usage = this.registry.getUsage(definition.name);
    const degraded = usage.consecutiveFailures >= 3;
    return {
      id: definition.name,
      toolId: definition.name,
      providerId,
      name: definition.name,
      description: definition.description,
      domain: definition.domain,
      risk: definition.risk,
      tier: policy.tier,
      activation: policy.activation,
      priority: policy.priority,
      tags: policy.tags,
      version: definition.capability?.version || '1.0.0',
      schemaVersion: definition.capability?.schemaVersion || 1,
      permissions,
      requirements,
      contract: inferExecutionContract(definition),
      fallbackToolIds: (definition.capability?.fallbackToolIds || []).filter(
        (toolId) => Boolean(this.registry.get(toolId)),
      ),
      costClass:
        definition.capability?.costClass ||
        (providerId === 'web' || providerId === 'office' ? 'medium' : 'free'),
      latencyClass:
        definition.capability?.latencyClass ||
        (definition.domain === 'network'
          ? 'slow'
          : definition.domain === 'desktop'
            ? 'fast'
            : 'instant'),
      availability:
        state.availability === 'available' && degraded
          ? 'degraded'
          : state.availability,
      unavailableReason:
        state.availability === 'available' && degraded
          ? `连续失败 ${usage.consecutiveFailures} 次：${usage.lastError}`
          : state.reason,
      usage: {
        successes: usage.successes,
        failures: usage.failures,
        consecutiveFailures: usage.consecutiveFailures,
        lastUsedAt: usage.lastUsedAt,
        averageDurationMs: usage.averageDurationMs,
        timeouts: usage.timeouts,
      },
      inputSchema: definition.inputSchema,
    };
  }

  private availability(
    snapshot: SystemStateSnapshot | null,
    providerId: string,
    permissions: ToolPermission[],
    requirements: CapabilityRequirements,
  ): {
    availability: CapabilityAvailability;
    reason: string | null;
  } {
    const provider = this.providers.get(providerId);
    const runtimeAvailability =
      this.runtimeAvailabilityProvider?.(providerId) || null;
    if (runtimeAvailability?.availability === 'unavailable') {
      return {
        availability: 'unavailable',
        reason:
          runtimeAvailability.reason ||
          `Provider ${providerId} 的动态感知当前不可用。`,
      };
    }
    if (provider && provider.availability !== 'available') {
      return {
        availability: provider.availability,
        reason:
          provider.unavailableReason ||
          provider.lastError ||
          `Provider ${providerId} 当前不可用。`,
      };
    }
    if (provider?.manifest.permissions?.length) {
      const missing = permissions.find(
        (permission) => !provider.manifest.permissions?.includes(permission),
      );
      if (missing) {
        return {
          availability: 'unavailable',
          reason: `Provider ${providerId} 未声明权限 ${missing}。`,
        };
      }
    }
    const deniedPermission = permissions.find((permission) =>
      this.deniedPermissions.includes(permission),
    );
    if (deniedPermission) {
      return {
        availability: 'unavailable',
        reason: `权限已被策略禁用：${deniedPermission}。`,
      };
    }
    const evaluated = evaluateRequirements(requirements, snapshot, []);
    if (!evaluated.available) {
      return {
        availability: snapshot?.capturedAt ? 'unavailable' : 'unknown',
        reason: evaluated.reason,
      };
    }
    if (runtimeAvailability?.availability === 'degraded') {
      return {
        availability: 'degraded',
        reason:
          runtimeAvailability.reason ||
          `Provider ${providerId} 当前处于降级状态。`,
      };
    }
    return { availability: 'available', reason: null };
  }
}

const inferPermissions = (definition: ToolDefinition): ToolPermission[] => {
  if (definition.capability?.permissions?.length) {
    return [...new Set(definition.capability.permissions)];
  }
  if (definition.name.startsWith('fs.')) {
    return /(?:create|write|append|replace|copy|move|rename|delete)/i.test(
      definition.name,
    )
      ? ['filesystem.read', 'filesystem.write']
      : ['filesystem.read'];
  }
  if (definition.name.startsWith('app.')) {
    return ['desktop.app'];
  }
  if (definition.name.startsWith('window.')) {
    return ['desktop.window'];
  }
  if (definition.name === 'clipboard.read') {
    return ['clipboard.read'];
  }
  if (definition.name === 'clipboard.write') {
    return ['clipboard.write'];
  }
  if (definition.name.startsWith('web.')) {
    return ['network'];
  }
  if (definition.name.startsWith('office.')) {
    return ['office'];
  }
  if (definition.name === 'process.list' || definition.name === 'app.close') {
    return ['system.process'];
  }
  if (definition.name.startsWith('system.')) {
    return ['system.read'];
  }
  return [];
};

const builtInRequirements = (
  definition: ToolDefinition,
  providerId: string,
): CapabilityRequirements => {
  if (definition.name.startsWith('steam.')) {
    return { steamGamesMin: 1 };
  }
  if (definition.name.startsWith('office.')) {
    return {
      platforms: ['win32'],
      applications: ['PowerPoint'],
    };
  }
  if (
    definition.name === 'system.list_services' ||
    (providerId === 'desktop.window' && definition.name !== 'window.list')
  ) {
    return { platforms: ['win32'] };
  }
  if (definition.name === 'app.close') {
    return { platforms: ['win32'] };
  }
  return {};
};
