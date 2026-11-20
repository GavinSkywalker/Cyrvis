/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QwenToolDefinition } from '../voice/tools';
import type { ToolRegistry } from './registry';
import type { ToolSurface, ToolSurfaceSnapshot } from './tool-surface';
import type { ToolDefinition } from './types';

export const FAST_TOOL_PROVIDER_PREFIX = 'cyrvis_';

export interface FastToolProviderCatalog {
  readonly tools: QwenToolDefinition[];
  resolve(providerName: string): string | null;
  subscribe?(listener: (tools: QwenToolDefinition[]) => void): () => void;
  readonly revision?: number;
}

export const toFastToolProviderName = (localName: string): `cyrvis_${string}` =>
  `${FAST_TOOL_PROVIDER_PREFIX}${localName.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const toDescription = (
  definition: ToolDefinition,
  providerName: string,
): string => {
  const acceptsPath = Object.keys(definition.inputSchema.properties).some(
    (key) => ['path', 'source', 'destination'].includes(key),
  );
  return [
    `CYRVIS local fast tool "${providerName}".`,
    `Prefer this over start_gui_task when it can complete the request without visual UI interaction.`,
    `Domain: ${definition.domain}. Risk: ${definition.risk}.`,
    acceptsPath
      ? 'Path arguments accept absolute paths or Desktop/Downloads/Documents aliases. Relative paths resolve from the user home directory, never the project directory. Do not infer a Windows username from the project path.'
      : '',
    'An explicit user request authorizes the requested operation. Execute it directly; do not ask for confirmation.',
    definition.description,
  ]
    .filter(Boolean)
    .join(' ');
};

export const createFastToolProviderCatalog = (
  registry: ToolRegistry,
): FastToolProviderCatalog => {
  const localNameByProviderName = new Map<string, string>();
  const tools = registry.list().map((definition) => {
    const providerName = toFastToolProviderName(definition.name);
    const existing = localNameByProviderName.get(providerName);
    if (existing && existing !== definition.name) {
      throw new Error(
        `Fast tool provider name collision: ${existing} and ${definition.name}`,
      );
    }
    localNameByProviderName.set(providerName, definition.name);
    return {
      type: 'function' as const,
      function: {
        name: providerName,
        description: toDescription(definition, providerName),
        parameters: definition.inputSchema,
      },
    };
  });

  return {
    tools,
    resolve: (providerName) =>
      localNameByProviderName.get(providerName) ?? null,
  };
};

export const createDynamicFastToolProviderCatalog = (
  registry: ToolRegistry,
  surface: ToolSurface,
): FastToolProviderCatalog => {
  const toProviderTools = (definitions: ToolDefinition[]) =>
    definitions.map((definition) => {
      const providerName = toFastToolProviderName(definition.name);
      return {
        type: 'function' as const,
        function: {
          name: providerName,
          description: toDescription(definition, providerName),
          parameters: definition.inputSchema,
        },
      };
    });
  const resolveProviderToolName = (providerName: string): string | null => {
    const definition = registry
      .list()
      .find((entry) => toFastToolProviderName(entry.name) === providerName);
    return definition?.name || null;
  };
  return {
    get tools() {
      return toProviderTools(surface.snapshot().visibleDefinitions);
    },
    resolve: resolveProviderToolName,
    get revision() {
      return surface.snapshot().revision;
    },
    subscribe(listener) {
      return surface.subscribe((snapshot: ToolSurfaceSnapshot) => {
        listener(toProviderTools(snapshot.visibleDefinitions));
      });
    },
  };
};
