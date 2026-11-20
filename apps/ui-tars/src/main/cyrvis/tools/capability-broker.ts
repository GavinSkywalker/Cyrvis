/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CapabilityCatalog } from './capability-catalog';
import { SENSITIVE_CONFIRMATION_PROMPT } from './confirmation-policy';
import type { ToolRegistry } from './registry';
import type { ToolSurface } from './tool-surface';
import type {
  CapabilityDescriptor,
  PreparedToolCall,
  ToolResult,
} from './types';

export type CapabilitySearchResult = Omit<
  CapabilityDescriptor,
  'inputSchema'
> & {
  visible: boolean;
};

export interface CapabilityDescription extends CapabilityDescriptor {
  visible: boolean;
}

export interface CapabilityRouteCandidate {
  capability: CapabilityDescriptor;
  routeClass: 'local' | 'remote' | 'gui';
  score: number;
  expectedSuccess: number;
  availabilityFactor: number;
  latencyFactor: number;
  costFactor: number;
  riskPenalty: number;
  reasons: string[];
}

export type CapabilityConfirmationHandler = (
  prepared: PreparedToolCall,
  summary: string,
) => Promise<string | null>;

export class CapabilityBroker {
  private confirmationHandler: CapabilityConfirmationHandler | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly catalog: CapabilityCatalog,
    private readonly surface: ToolSurface,
  ) {}

  setConfirmationHandler(handler: CapabilityConfirmationHandler): void {
    this.confirmationHandler = handler;
  }

  search(query: string, limit = 20): CapabilitySearchResult[] {
    return this.catalog.search(query, limit).map((capability) => {
      const { inputSchema: _inputSchema, ...summary } = capability;
      return {
        ...summary,
        visible: this.surface.isVisible(capability.toolId),
      };
    });
  }

  route(
    query: string,
    options: {
      limit?: number;
      maxRisk?: CapabilityDescriptor['risk'];
    } = {},
  ): CapabilityRouteCandidate[] {
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const riskRank = { low: 0, medium: 1, high: 2 } as const;
    const maxRisk = riskRank[options.maxRisk || 'high'];
    return this.catalog
      .search(query, Math.max(20, limit * 4))
      .filter((capability) => riskRank[capability.risk] <= maxRisk)
      .map((capability) => {
        const routeClass: CapabilityRouteCandidate['routeClass'] =
          capability.id.startsWith('ui.')
            ? 'gui'
            : [
                  'builtin',
                  'filesystem',
                  'desktop.app',
                  'desktop.window',
                  'desktop.screen',
                  'desktop.ui',
                  'clipboard',
                  'system',
                  'office',
                  'capability',
                  'orchestration',
                  'synthesized',
                ].includes(capability.providerId)
              ? 'local'
              : 'remote';
        const total = capability.usage.successes + capability.usage.failures;
        const expectedSuccess = (capability.usage.successes + 2) / (total + 3);
        const availabilityFactor =
          capability.availability === 'available'
            ? 1
            : capability.availability === 'degraded'
              ? 0.55
              : capability.availability === 'unknown'
                ? 0.35
                : 0;
        const declaredLatencyFactor =
          capability.latencyClass === 'instant'
            ? 1
            : capability.latencyClass === 'fast'
              ? 0.9
              : capability.latencyClass === 'normal'
                ? 0.72
                : 0.5;
        const observedLatencyFactor =
          capability.usage.averageDurationMs === null
            ? declaredLatencyFactor
            : capability.usage.averageDurationMs <= 500
              ? 1
              : capability.usage.averageDurationMs <= 2_000
                ? 0.88
                : capability.usage.averageDurationMs <= 10_000
                  ? 0.68
                  : 0.4;
        const latencyFactor =
          declaredLatencyFactor * 0.55 + observedLatencyFactor * 0.45;
        const costFactor =
          capability.costClass === 'free'
            ? 1
            : capability.costClass === 'low'
              ? 0.9
              : capability.costClass === 'medium'
                ? 0.7
                : 0.45;
        const riskPenalty = riskRank[capability.risk] * 0.08;
        const routePenalty =
          routeClass === 'gui' ? 0.18 : routeClass === 'remote' ? 0.08 : 0;
        const baseScore =
          capability.priority / 100 +
          expectedSuccess * 0.55 +
          availabilityFactor * 0.45 +
          latencyFactor * 0.25 +
          costFactor * 0.2 -
          riskPenalty -
          routePenalty;
        return {
          capability,
          routeClass,
          score: Number((baseScore * availabilityFactor).toFixed(4)),
          expectedSuccess,
          availabilityFactor,
          latencyFactor,
          costFactor,
          riskPenalty,
          reasons: [
            `availability=${capability.availability}`,
            `route=${routeClass}`,
            `success=${(expectedSuccess * 100).toFixed(1)}%`,
            `latency=${capability.latencyClass}`,
            `cost=${capability.costClass}`,
            `risk=${capability.risk}`,
          ],
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.capability.priority - left.capability.priority,
      )
      .slice(0, limit);
  }

  describe(toolId: string): CapabilityDescription | null {
    const capability = this.catalog.get(toolId);
    return capability
      ? {
          ...capability,
          visible: this.surface.isVisible(capability.toolId),
        }
      : null;
  }

  async invoke(
    toolId: string,
    args: Record<string, unknown>,
    options: { allowFallbacks?: boolean } = {},
  ): Promise<ToolResult> {
    if (toolId.startsWith('capability.')) {
      return failure(
        'CAPABILITY_META_TOOL_REJECTED',
        '能力 Broker 不能递归调用 capability 元工具。',
      );
    }
    const capability = this.catalog.get(toolId);
    if (!capability) {
      return failure('CAPABILITY_NOT_FOUND', `没有找到能力 ${toolId}。`);
    }
    if (
      capability.availability === 'unavailable' ||
      capability.availability === 'unknown'
    ) {
      return failure(
        'CAPABILITY_UNAVAILABLE',
        capability.unavailableReason || `${toolId} 当前不可用。`,
      );
    }

    let prepared: PreparedToolCall;
    try {
      prepared = await this.registry.prepare(toolId, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('CAPABILITY_PREPARE_FAILED', `能力参数无效：${message}`);
    }

    if (prepared.requiresConfirmation) {
      const summary =
        prepared.confirmationReason || `执行深层能力 ${capability.toolId}`;
      const prompt = this.confirmationHandler
        ? await this.confirmationHandler(prepared, summary)
        : null;
      return {
        ok: false,
        tool: 'capability.invoke',
        speech: prompt || SENSITIVE_CONFIRMATION_PROMPT,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: summary,
        },
        data: {
          status: 'confirmation_required',
          toolId: capability.toolId,
        },
      };
    }

    const result = await this.executePrepared(capability, prepared);
    this.catalog.recordCall(
      capability.toolId,
      result.ok,
      result.error?.message,
    );
    if (result.ok) {
      this.surface.activate(capability.toolId);
    } else if (options.allowFallbacks) {
      for (const fallbackId of capability.fallbackToolIds) {
        const fallback = this.catalog.get(fallbackId);
        if (
          !fallback ||
          fallback.risk === 'high' ||
          fallback.availability === 'unavailable'
        ) {
          continue;
        }
        try {
          const fallbackPrepared = await this.registry.prepare(
            fallbackId,
            args,
          );
          const fallbackResult = await this.executePrepared(
            fallback,
            fallbackPrepared,
          );
          if (fallbackResult.ok) {
            this.surface.activate(fallbackId);
            return {
              ...fallbackResult,
              tool: 'capability.invoke',
              data: {
                toolId: capability.toolId,
                fallbackToolId: fallbackId,
                result: fallbackResult.data,
              },
            };
          }
        } catch {
          // Continue through the declared fallback chain.
        }
      }
    }
    return {
      ...result,
      tool: 'capability.invoke',
      data: {
        toolId: capability.toolId,
        result: result.data,
      },
    };
  }

  private executePrepared(
    capability: CapabilityDescriptor,
    prepared: PreparedToolCall,
  ): Promise<ToolResult> {
    void capability;
    return this.registry.executePrepared(prepared);
  }
}

const failure = (code: string, speech: string): ToolResult => ({
  ok: false,
  tool: 'capability.invoke',
  speech,
  error: { code, message: speech },
});
