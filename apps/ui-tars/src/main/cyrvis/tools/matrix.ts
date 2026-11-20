/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';

import type { SystemStateStore } from '../system/system-state';
import { createSystemStateTools } from '../system/tools';
import { createReminderTools } from '../system/reminders';
import {
  BrowserPerceptionProvider,
  ClipboardPerceptionProvider,
  createBuiltinProviderBundle,
  createContextTools,
  DynamicContextStore,
  FilePerceptionProvider,
  UiFocusPerceptionProvider,
  type PerceptionProvider,
  type BuiltinProviderBundle,
} from '../context';
import { CapabilityBroker } from './capability-broker';
import { CapabilityCatalog } from './capability-catalog';
import { createCapabilityTools } from './capability-tools';
import { CONDITION_TOOLS } from './condition-tools';
import { DESKTOP_TOOLS } from './desktop-tools';
import { DOCUMENT_TOOLS } from './document-tools';
import { LocalDesktopHost } from './desktop-host';
import { EXECUTION_TOOLS } from './execution-tools';
import { FILESYSTEM_TOOLS } from './filesystem';
import { NETWORK_TOOLS } from './network-tools';
import { OBSERVATION_TOOLS } from './observation-tools';
import { OFFICE_TOOLS } from './office-tools';
import { PathPolicy } from './path-policy';
import { ProviderManager } from './provider-manager';
import { ProviderRegistry } from './provider-registry';
import { ToolRegistry } from './registry';
import { FastToolRouter } from './router';
import { SYSTEM_CONTROL_TOOLS } from './system-control-tools';
import {
  createDynamicFastToolProviderCatalog,
  type FastToolProviderCatalog,
} from './llm-tools';
import { ToolSurface } from './tool-surface';
import { ToolUsageStore } from './tool-usage';
import type { DesktopHost, ToolContext, ToolPermission } from './types';
import { LocalWorkflowEngine } from './workflow-engine';
import { createWorkflowTools } from './workflow-tools';

export interface FastToolMatrix {
  context: ToolContext;
  dynamicContext: DynamicContextStore;
  registry: ToolRegistry;
  router: FastToolRouter;
  providerCatalog: FastToolProviderCatalog;
  capabilityCatalog: CapabilityCatalog;
  capabilityBroker: CapabilityBroker;
  surface: ToolSurface;
  providerRegistry: ProviderRegistry;
  providerManager: ProviderManager;
  usage: ToolUsageStore;
  workflow: LocalWorkflowEngine;
  dispose(): void;
}

export interface FastToolMatrixOptions {
  maxVisibleTools?: number;
  activationTtlMs?: number;
  foregroundRefreshMs?: number;
  nativeForegroundEvents?: boolean;
  foregroundScriptPath?: string;
  manifestDirectories?: string[];
  providerPublicKeyPem?: string;
  allowUntrustedProviders?: boolean;
  deniedPermissions?: ToolPermission[];
  usageStateFile?: string;
  usageAuditFile?: string;
  workflowStateFile?: string;
  builtinProviders?: BuiltinProviderBundle;
  perceptionProviders?: PerceptionProvider[];
  enableBrowserPerception?: boolean;
  browserPerceptionIntervalMs?: number;
  enableFilePerception?: boolean;
  filePerceptionRoots?: string[];
  filePerceptionIntervalMs?: number;
  timelineStateFile?: string;
  enableClipboardPerception?: boolean;
  clipboardPerceptionIntervalMs?: number;
  includeClipboardContent?: boolean;
  enableUiFocusPerception?: boolean;
  uiFocusPerceptionIntervalMs?: number;
  includeSelectedText?: boolean;
}

export const createFastToolContext = (
  desktop: DesktopHost = new LocalDesktopHost(),
  cwd = process.cwd(),
): { context: ToolContext; pathPolicy: PathPolicy } => {
  const homeDirectory = os.homedir();
  const pathPolicy = new PathPolicy(cwd, homeDirectory);
  return {
    pathPolicy,
    context: {
      cwd,
      homeDirectory,
      platform: process.platform,
      desktop,
      resolvePath: (input) => pathPolicy.resolve(input, homeDirectory),
    },
  };
};

export const createFastToolMatrix = (
  desktop: DesktopHost = new LocalDesktopHost(),
  cwd = process.cwd(),
  systemState?: SystemStateStore,
  options: FastToolMatrixOptions = {},
): FastToolMatrix => {
  const { context, pathPolicy } = createFastToolContext(desktop, cwd);
  const usage = new ToolUsageStore({
    stateFile: options.usageStateFile,
    auditFile: options.usageAuditFile,
  });
  const registry = new ToolRegistry(context, pathPolicy, usage);
  const workflow = new LocalWorkflowEngine(registry, {
    stateFile: options.workflowStateFile,
  });
  const reminders = createReminderTools();
  registry.registerAll([
    ...FILESYSTEM_TOOLS,
    ...DESKTOP_TOOLS,
    ...DOCUMENT_TOOLS,
    ...OBSERVATION_TOOLS,
    ...CONDITION_TOOLS,
    ...EXECUTION_TOOLS,
    ...NETWORK_TOOLS,
    ...SYSTEM_CONTROL_TOOLS,
    ...OFFICE_TOOLS,
    ...reminders.tools,
    ...createWorkflowTools(workflow),
    ...(systemState ? createSystemStateTools(systemState) : []),
  ]);
  const providerRegistry = new ProviderRegistry();
  const builtinProviders =
    options.builtinProviders || createBuiltinProviderBundle();
  registry.registerAll(builtinProviders.tools, 'builtin-provider');
  for (const manifest of builtinProviders.manifests) {
    providerRegistry.register(manifest, `builtin:${manifest.id}`);
    providerRegistry.updateStatus(manifest.id, {
      availability: 'available',
      unavailableReason: null,
      toolIds:
        manifest.transport.type === 'builtin'
          ? manifest.transport.toolIds || []
          : [],
      connectedAt: null,
      lastHealthCheckAt: Date.now(),
      lastError: null,
    });
  }
  const capabilityCatalog = new CapabilityCatalog(
    registry,
    systemState,
    providerRegistry,
    options.deniedPermissions,
  );
  const browserPerceptionIntervalMs =
    options.browserPerceptionIntervalMs ??
    Number(process.env.CYRVIS_BROWSER_STATE_REFRESH_MS);
  const browserPerceptionEnabled =
    options.enableBrowserPerception ??
    Boolean(process.env.CYRVIS_BROWSER_DEBUG_URL);
  const perceptionProviders = options.perceptionProviders ?? [
    ...(browserPerceptionEnabled
      ? [
          new BrowserPerceptionProvider({
            intervalMs:
              Number.isFinite(browserPerceptionIntervalMs) &&
              browserPerceptionIntervalMs >= 500
                ? browserPerceptionIntervalMs
                : undefined,
          }),
        ]
      : []),
    ...(options.enableFilePerception
      ? [
          new FilePerceptionProvider({
            roots: options.filePerceptionRoots || [
              path.join(os.homedir(), 'Desktop'),
              path.join(os.homedir(), 'Downloads'),
              path.join(os.homedir(), 'Documents'),
              cwd,
            ],
            intervalMs: options.filePerceptionIntervalMs,
          }),
        ]
      : []),
    ...(options.enableClipboardPerception
      ? [
          new ClipboardPerceptionProvider({
            intervalMs: options.clipboardPerceptionIntervalMs,
            includeContent: options.includeClipboardContent,
          }),
        ]
      : []),
    ...(options.enableUiFocusPerception
      ? [
          new UiFocusPerceptionProvider({
            intervalMs: options.uiFocusPerceptionIntervalMs,
            includeSelectedText: options.includeSelectedText,
          }),
        ]
      : []),
  ];
  const dynamicContext = new DynamicContextStore({
    registry,
    providers: providerRegistry,
    systemState,
    desktop,
    foregroundRefreshMs: options.foregroundRefreshMs,
    nativeForegroundEvents: options.nativeForegroundEvents,
    foregroundScriptPath: options.foregroundScriptPath,
    capabilities: () => capabilityCatalog.list(),
    perceptionProviders,
    timelineStateFile: options.timelineStateFile,
  });
  capabilityCatalog.setRuntimeAvailabilityProvider((providerId) => {
    const perceptionProviderId =
      providerId === 'desktop.ui'
        ? 'windows-ui-focus'
        : providerId === 'clipboard'
          ? 'clipboard'
          : providerId;
    const status = dynamicContext
      .getPerceptionStatuses()
      .find((provider) => provider.id === perceptionProviderId);
    if (!status) {
      return null;
    }
    if (status.state === 'degraded') {
      return {
        availability: status.resourceCount > 0 ? 'degraded' : 'unavailable',
        reason: status.error || 'Dynamic perception is degraded.',
      };
    }
    if (status.state === 'healthy') {
      return { availability: 'available', reason: null };
    }
    return null;
  });
  context.getRecentResources = () => dynamicContext.getRecentResources();
  registry.registerAll(createContextTools(dynamicContext), 'context');
  const surface = new ToolSurface(registry, capabilityCatalog, {
    ...options,
    context: dynamicContext,
  });
  const capabilityBroker = new CapabilityBroker(
    registry,
    capabilityCatalog,
    surface,
  );
  registry.registerAll(
    createCapabilityTools(capabilityBroker, providerRegistry),
    'capability',
  );
  surface.refresh();
  const unsubscribeRegistry = registry.subscribe(() => surface.refresh());
  const unsubscribeProviders = providerRegistry.subscribe(() => {
    surface.refresh();
  });
  const providerManager = new ProviderManager(
    registry,
    providerRegistry,
    systemState,
    {
      manifestDirectories: options.manifestDirectories,
      publicKeyPem: options.providerPublicKeyPem,
      allowUntrusted: options.allowUntrustedProviders,
      deniedPermissions: options.deniedPermissions,
      foregroundWindow: () => {
        const window =
          dynamicContext.getSnapshot().user.activeWindow?.value || null;
        return window ? { ...window, focused: true } : null;
      },
    },
  );
  const providerCatalog = createDynamicFastToolProviderCatalog(
    registry,
    surface,
  );
  const router = new FastToolRouter(registry, context, {
    providerCatalog,
    capabilityBroker,
  });
  const unsubscribeState = systemState?.onChange(() => surface.refresh());
  dynamicContext.start();
  return {
    context,
    dynamicContext,
    registry,
    router,
    providerCatalog,
    capabilityCatalog,
    capabilityBroker,
    surface,
    providerRegistry,
    providerManager,
    usage,
    workflow,
    dispose: () => {
      void providerManager.stop();
      workflow.dispose();
      surface.dispose();
      unsubscribeRegistry();
      unsubscribeProviders();
      unsubscribeState?.();
      dynamicContext.dispose();
      reminders.service.dispose();
    },
  };
};
