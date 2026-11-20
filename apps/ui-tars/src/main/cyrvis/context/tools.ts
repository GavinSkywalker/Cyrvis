import type { ToolDefinition, ToolResult } from '../tools/types';
import type { DynamicContextStore } from './dynamic-context';
import type { ResourceKind } from './types';

const text = (
  input: Record<string, unknown>,
  key: string,
  fallback = '',
): string => (typeof input[key] === 'string' ? input[key] : fallback);

const number = (
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  maximum: number,
): number =>
  typeof input[key] === 'number' && Number.isFinite(input[key])
    ? Math.max(1, Math.min(maximum, Math.floor(input[key])))
    : fallback;

const success = (tool: string, speech: string, data?: unknown): ToolResult => ({
  ok: true,
  tool,
  speech,
  data,
});

const RESOURCE_KINDS = new Set<ResourceKind>([
  'application',
  'window',
  'tab',
  'document',
  'file',
  'website',
  'account',
  'device',
]);

export const createContextTools = (
  context: DynamicContextStore,
): ToolDefinition[] => [
  {
    name: 'context.snapshot',
    domain: 'context',
    description:
      'Read the current user context, active application/window, focused control, recent actions, active resources, and capability bindings.',
    risk: 'low',
    capability: {
      providerId: 'context',
      tier: 2,
      activation: 'on-demand',
      priority: 96,
      tags: [
        'context',
        'user',
        'active',
        'window',
        'resource',
        '上下文',
        '当前',
        '窗口',
        '资源',
      ],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const snapshot = context.getSnapshot();
      const active = snapshot.resources.filter((resource) =>
        snapshot.activeResourceIds.includes(resource.id),
      );
      return success(
        'context.snapshot',
        active.length
          ? `当前上下文已读取：${active.map((resource) => resource.name).join('、')}。`
          : '当前没有可识别的活动资源。',
        {
          revision: snapshot.revision,
          updatedAt: snapshot.updatedAt,
          user: snapshot.user,
          activeResources: active,
          fallbackResourceIds: snapshot.fallbackResourceIds,
          bindings: snapshot.bindings.filter((binding) => binding.active),
          perception: context.getPerceptionStatuses(),
          intent: context.intent.getSnapshot(),
        },
      );
    },
  },
  {
    name: 'context.resources',
    domain: 'context',
    description:
      'Search dynamic application, window, tab, document, file, website, account, and device resources and inspect their currently bound capabilities.',
    risk: 'low',
    capability: {
      providerId: 'context',
      tier: 2,
      activation: 'on-demand',
      priority: 95,
      tags: [
        'context',
        'resource',
        'application',
        'window',
        'capability',
        '资源',
        '应用',
        '窗口',
        '能力',
      ],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: {
          type: 'string',
          enum: [
            'application',
            'window',
            'tab',
            'document',
            'file',
            'website',
            'account',
            'device',
          ],
        },
        activeOnly: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    prepare: (input) => {
      const requestedKind = text(input, 'kind') as ResourceKind;
      return {
        query: text(input, 'query').trim(),
        kind: RESOURCE_KINDS.has(requestedKind) ? requestedKind : '',
        activeOnly: input.activeOnly === true,
        limit: number(input, 'limit', 20, 100),
      };
    },
    async execute(args) {
      const snapshot = context.getSnapshot();
      const resources = context.resources.search(
        snapshot.resources,
        String(args.query),
        {
          kind: (String(args.kind) || undefined) as ResourceKind | undefined,
          activeOnly: Boolean(args.activeOnly),
          limit: Number(args.limit),
        },
      );
      const bindings = snapshot.bindings.filter((binding) =>
        resources.some((resource) => resource.id === binding.resourceId),
      );
      return success(
        'context.resources',
        resources.length
          ? `找到 ${resources.length} 个相关资源，包括 ${resources
              .slice(0, 5)
              .map((resource) => resource.name)
              .join('、')}。`
          : '没有找到匹配的动态资源。',
        {
          query: args.query,
          resources,
          bindings,
        },
      );
    },
  },
  {
    name: 'context.intent',
    domain: 'context',
    description:
      'Read the fused user activity and intent state derived from the active application, focus, recent speech, conversation history, task state, and recent gaze target. Treat it as a probabilistic clue, not execution authorization.',
    risk: 'low',
    capability: {
      providerId: 'context',
      tier: 2,
      activation: 'on-demand',
      priority: 66,
      tags: [
        'intent',
        'activity',
        'gaze',
        'voice',
        'context',
        '意图',
        '活动',
        '眼动',
        '语音',
      ],
      permissions: ['system.read'],
    },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    prepare: () => ({}),
    async execute() {
      const intent = context.intent.getSnapshot();
      return success(
        'context.intent',
        `当前活动判断为 ${intent.activity}。`,
        intent,
      );
    },
  },
];
