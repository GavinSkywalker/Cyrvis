/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

export type ToolDomain =
  | 'filesystem'
  | 'desktop'
  | 'clipboard'
  | 'system'
  | 'office'
  | 'network'
  | 'context'
  | 'capability';

export type ToolRisk = 'low' | 'medium' | 'high';
export type ToolExposureTier = 0 | 1 | 2 | 3 | 4;
export type ToolSideEffect =
  | 'none'
  | 'read'
  | 'write'
  | 'external'
  | 'irreversible';
export type ToolCostClass = 'free' | 'low' | 'medium' | 'high';
export type ToolLatencyClass = 'instant' | 'fast' | 'normal' | 'slow';
export type CapabilityAvailability =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type ToolPermission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'desktop.app'
  | 'desktop.window'
  | 'desktop.screen'
  | 'desktop.input'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'system.read'
  | 'system.process'
  | 'system.media'
  | 'system.power'
  | 'network'
  | 'office'
  | 'process.spawn'
  | 'remote.tools';

export interface CapabilityRequirements {
  platforms?: NodeJS.Platform[];
  applications?: string[];
  services?: string[];
  environment?: string[];
  executables?: string[];
  steamGamesMin?: number;
  permissions?: ToolPermission[];
}

export interface ToolCapabilityMetadata {
  providerId?: string;
  tier?: ToolExposureTier;
  activation?: 'always' | 'state' | 'on-demand';
  priority?: number;
  tags?: string[];
  version?: string;
  schemaVersion?: number;
  permissions?: ToolPermission[];
  requirements?: CapabilityRequirements;
  fallbackToolIds?: string[];
  costClass?: ToolCostClass;
  latencyClass?: ToolLatencyClass;
}

export interface ToolExecutionContract {
  sideEffect?: ToolSideEffect;
  idempotent?: boolean;
  retryable?: boolean;
  maxAttempts?: number;
  retryBackoffMs?: number;
  timeoutMs?: number;
  resumePolicy?: 'manual' | 'restart' | 'verify_then_resume';
  verification?: 'none' | 'preferred' | 'required';
}

export interface ToolVerificationResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  speech: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface DesktopHost {
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  openSearch?(url: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  launchApplication(name: string, target?: string): Promise<string>;
  closeApplication(name: string): Promise<string>;
  closeBrowserPage?(query: string): Promise<{ title: string; process: string }>;
  listProcesses(): Promise<ProcessInfo[]>;
  listWindows(): Promise<WindowInfo[]>;
  getForegroundWindow?(): Promise<WindowInfo | null>;
  showNotification?(title: string, body: string): Promise<void>;
  controlWindow(
    query: string,
    action: 'focus' | 'minimize' | 'maximize' | 'close',
  ): Promise<string>;
  minimizeAllWindows(): Promise<number>;
  restoreAllWindows(): Promise<number>;
  createPresentation(input: {
    path: string;
    title: string;
    subtitle?: string;
  }): Promise<void>;
  systemInfo(): Promise<SystemInfo>;
  diskInfo(path: string): Promise<DiskInfo>;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  title?: string;
  memoryBytes?: number;
}

export interface WindowInfo {
  pid: number;
  process: string;
  title: string;
  focused?: boolean;
  handle?: number;
}

export interface SystemInfo {
  platform: string;
  release: string;
  architecture: string;
  hostname: string;
  homeDirectory: string;
  cpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  uptimeSeconds: number;
}

export interface DiskInfo {
  path: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ToolResourceHint {
  kind: string;
  name: string;
  aliases: string[];
  metadata: Record<string, string | number | boolean | null>;
  updatedAt: number;
}

export interface ToolContext {
  cwd: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
  desktop: DesktopHost;
  resolvePath(input: string): string;
  getRecentResources?(): ToolResourceHint[];
  reportProgress?(message: string, percent?: number): void;
}

export interface ToolExecutionOptions {
  confirmed?: boolean;
  onProgress?: (message: string, percent?: number) => void;
}

export interface ToolDefinition<
  Args extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  domain: ToolDomain;
  description: string;
  risk: ToolRisk;
  capability?: ToolCapabilityMetadata;
  contract?: ToolExecutionContract;
  inputSchema: JsonSchema;
  prepare(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Args | Promise<Args>;
  pathArgs?(args: Args): string[];
  requiresConfirmation?(
    args: Args,
    context: ToolContext,
  ): string | null | Promise<string | null>;
  verify?(
    args: Args,
    result: ToolResult,
    context: ToolContext,
  ): ToolVerificationResult | Promise<ToolVerificationResult>;
  execute(args: Args, context: ToolContext): Promise<ToolResult>;
}

export interface PreparedToolCall {
  tool: string;
  args: Record<string, unknown>;
  definition: ToolDefinition;
  risk: ToolRisk;
  requiresConfirmation: boolean;
  confirmationReason: string | null;
}

export interface PendingConfirmationSnapshot {
  tool: string;
  risk: ToolRisk;
  domain: ToolDomain;
  confirmationReason: string | null;
  expiresAt: number;
}

export interface FastToolRoute {
  kind: 'execute' | 'confirm' | 'cancel';
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  requiresConfirmation: boolean;
  confirmationReason: string | null;
  risk: ToolRisk;
  domain: ToolDomain;
}

export interface FastToolOutcome {
  handled: boolean;
  ok?: boolean;
  speech?: string;
  result?: ToolResult;
  route?: FastToolRoute;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface CapabilityDescriptor {
  id: string;
  toolId: string;
  providerId: string;
  name: string;
  description: string;
  domain: ToolDomain;
  risk: ToolRisk;
  tier: ToolExposureTier;
  activation: 'always' | 'state' | 'on-demand';
  priority: number;
  tags: string[];
  version: string;
  schemaVersion: number;
  permissions: ToolPermission[];
  requirements: CapabilityRequirements;
  contract: Required<ToolExecutionContract>;
  fallbackToolIds: string[];
  costClass: ToolCostClass;
  latencyClass: ToolLatencyClass;
  availability: CapabilityAvailability;
  unavailableReason: string | null;
  usage: {
    successes: number;
    failures: number;
    consecutiveFailures: number;
    lastUsedAt: number | null;
    averageDurationMs: number | null;
    timeouts: number;
  };
  inputSchema: JsonSchema;
}
