/*
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';

import { PathPolicy } from './path-policy';
import { TOOL_API_VERSION } from './provider-types';
import { ToolUsageStore, type ToolUsageRecord } from './tool-usage';
import type {
  McpToolDescriptor,
  PreparedToolCall,
  ToolContext,
  ToolDefinition,
  ToolExecutionOptions,
  ToolResult,
  ToolVerificationResult,
} from './types';

export interface ToolExecutionEvent {
  toolId: string;
  ok: boolean;
  speech: string;
  data?: unknown;
  error?: string;
  timestamp: number;
  durationMs: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly providers = new Map<string, string>();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly usageListeners = new Set<(toolId: string) => void>();
  private readonly executionListeners = new Set<
    (event: ToolExecutionEvent) => void
  >();
  private readonly pathPolicy: PathPolicy;
  private currentRevision = 0;

  constructor(
    private readonly context: ToolContext,
    pathPolicy = new PathPolicy(context.cwd, context.homeDirectory),
    private readonly usageStore = new ToolUsageStore(),
  ) {
    this.pathPolicy = pathPolicy;
  }

  register(definition: ToolDefinition, providerId = 'builtin'): void {
    this.registerOne(definition, providerId);
    this.bumpRevision();
  }

  registerAll(definitions: ToolDefinition[], providerId = 'builtin'): void {
    const names = new Set<string>();
    for (const definition of definitions) {
      if (names.has(definition.name) || this.tools.has(definition.name)) {
        throw new Error(`Duplicate fast tool: ${definition.name}`);
      }
      names.add(definition.name);
    }
    for (const definition of definitions) {
      this.registerOne(definition, providerId);
    }
    if (definitions.length) {
      this.bumpRevision();
    }
  }

  unregister(name: string): boolean {
    if (!this.tools.delete(name)) {
      return false;
    }
    this.providers.delete(name);
    this.bumpRevision();
    return true;
  }

  replaceProvider(providerId: string, definitions: ToolDefinition[]): void {
    const nextNames = new Set(definitions.map((definition) => definition.name));
    if (nextNames.size !== definitions.length) {
      throw new Error(`Duplicate fast tool in provider ${providerId}`);
    }
    for (const definition of definitions) {
      const owner = this.providers.get(definition.name);
      if (owner && owner !== providerId) {
        throw new Error(
          `Fast tool ${definition.name} already belongs to ${owner}`,
        );
      }
    }
    for (const [name, owner] of [...this.providers.entries()]) {
      if (owner === providerId && !nextNames.has(name)) {
        this.tools.delete(name);
        this.providers.delete(name);
      }
    }
    for (const definition of definitions) {
      this.tools.set(definition.name, definition);
      this.providers.set(definition.name, providerId);
    }
    this.bumpRevision();
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  listByProvider(providerId: string): ToolDefinition[] {
    return this.list().filter(
      (definition) => this.getProviderId(definition.name) === providerId,
    );
  }

  getProviderId(name: string): string | null {
    return this.providers.get(name) || null;
  }

  get revision(): number {
    return this.currentRevision;
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeUsage(listener: (toolId: string) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  subscribeExecutions(
    listener: (event: ToolExecutionEvent) => void,
  ): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  describeMcpTools(): McpToolDescriptor[] {
    return this.list().map((definition) => ({
      name: definition.name,
      description: `[${definition.domain}/${definition.risk}] ${definition.description}`,
      inputSchema: definition.inputSchema,
    }));
  }

  async prepare(
    tool: string,
    rawArgs: Record<string, unknown> = {},
  ): Promise<PreparedToolCall> {
    const definition = this.tools.get(tool);
    if (!definition) {
      throw new Error(`Unknown fast tool: ${tool}`);
    }
    const args = await definition.prepare(rawArgs, this.context);
    const policy = definition.pathArgs
      ? this.pathPolicy.inspect(definition.pathArgs(args), undefined, {
          allowOutsideRoots: isReadOnlyPathTool(definition.name),
        })
      : {
          requiresConfirmation: false,
          reason: null,
          resolvedPaths: [],
        };
    const toolReason = definition.requiresConfirmation
      ? await definition.requiresConfirmation(args, this.context)
      : null;
    const confirmationReason = policy.reason || toolReason;
    return {
      tool: definition.name,
      args,
      definition,
      risk: definition.risk,
      requiresConfirmation: Boolean(confirmationReason),
      confirmationReason,
    };
  }

  async execute(
    tool: string,
    rawArgs: Record<string, unknown>,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    let prepared: PreparedToolCall;
    try {
      prepared = await this.prepare(tool, rawArgs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: tool,
        providerId: this.getProviderId(tool),
        ok: false,
        durationMs: 0,
        error: message,
      });
      this.notifyUsage(tool);
      this.emitExecution({
        toolId: tool,
        ok: false,
        speech: `操作失败：${message}`,
        error: message,
        timestamp: Date.now(),
        durationMs: 0,
      });
      throw error;
    }
    return this.executePrepared(prepared, options);
  }

  async executePrepared(
    prepared: PreparedToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    try {
      const executionContext = options.onProgress
        ? { ...this.context, reportProgress: options.onProgress }
        : this.context;
      const executed = await prepared.definition.execute(
        prepared.args,
        executionContext,
      );
      const result = executed.ok
        ? await this.verifyExecution(prepared, executed)
        : executed;
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: prepared.tool,
        providerId: this.getProviderId(prepared.tool),
        ok: result.ok,
        durationMs: Date.now() - startedAt,
        error: result.error?.message,
      });
      this.notifyUsage(prepared.tool);
      this.emitExecution({
        toolId: prepared.tool,
        ok: result.ok,
        speech: result.speech,
        data: result.data,
        error: result.error?.message,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: ToolResult = {
        ok: false,
        tool: prepared.tool,
        speech: `操作失败：${message}`,
        error: {
          code: 'TOOL_EXECUTION_FAILED',
          message,
        },
      };
      this.usageStore.record({
        timestamp: Date.now(),
        toolId: prepared.tool,
        providerId: this.getProviderId(prepared.tool),
        ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      this.notifyUsage(prepared.tool);
      this.emitExecution({
        toolId: prepared.tool,
        ok: false,
        speech: result.speech,
        error: result.error?.message,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      return result;
    }
  }

  getUsage(toolId: string): ToolUsageRecord {
    return this.usageStore.get(toolId);
  }

  async verify(
    tool: string,
    rawArgs: Record<string, unknown>,
    result: ToolResult,
  ): Promise<ToolResult> {
    const prepared = await this.prepare(tool, rawArgs);
    return this.verifyExecution(prepared, result);
  }

  get usage(): ToolUsageStore {
    return this.usageStore;
  }

  private bumpRevision(): void {
    this.currentRevision += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener(this.currentRevision);
      } catch {
        // Registry observers must not prevent tool registration.
      }
    }
  }

  private registerOne(definition: ToolDefinition, providerId: string): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Duplicate fast tool: ${definition.name}`);
    }
    const schemaVersion = definition.capability?.schemaVersion ?? 1;
    if (schemaVersion > TOOL_API_VERSION) {
      throw new Error(
        `Fast tool ${definition.name} requires unsupported schema version ${schemaVersion}`,
      );
    }
    this.tools.set(definition.name, definition);
    this.providers.set(definition.name, providerId);
  }

  private notifyUsage(toolId: string): void {
    for (const listener of [...this.usageListeners]) {
      try {
        listener(toolId);
      } catch {
        // Usage observers must not affect tool execution.
      }
    }
  }

  private emitExecution(event: ToolExecutionEvent): void {
    for (const listener of [...this.executionListeners]) {
      try {
        listener(event);
      } catch {
        // Execution observers must not alter tool outcomes.
      }
    }
  }

  private async verifyExecution(
    prepared: PreparedToolCall,
    result: ToolResult,
  ): Promise<ToolResult> {
    const definition = prepared.definition;
    let verification: ToolVerificationResult;
    if (definition.verify) {
      try {
        verification = await definition.verify(
          prepared.args,
          result,
          this.context,
        );
      } catch (error) {
        verification = {
          ok: false,
          message: `结果验证异常：${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    } else if (definition.contract?.verification === 'required') {
      verification = {
        ok: false,
        message: '工具声明必须验证结果，但没有提供验证器。',
      };
    } else {
      return result;
    }

    const verificationData =
      result.data &&
      typeof result.data === 'object' &&
      !Array.isArray(result.data)
        ? { ...(result.data as Record<string, unknown>) }
        : { result: result.data };
    if (verification.ok) {
      return {
        ...result,
        data: {
          ...verificationData,
          verification: {
            ok: true,
            message: verification.message,
            data: verification.data,
          },
        },
      };
    }
    return {
      ...result,
      ok: false,
      speech: `操作已执行，但结果验证失败：${verification.message}`,
      data: {
        ...verificationData,
        verification: {
          ok: false,
          message: verification.message,
          data: verification.data,
        },
      },
      error: {
        code: 'TOOL_VERIFICATION_FAILED',
        message: verification.message,
      },
    };
  }
}

const READ_ONLY_PATH_TOOLS = new Set([
  'condition.check',
  'condition.wait',
  'document.extract_text',
  'fs.directory_tree',
  'fs.exists',
  'fs.get_info',
  'fs.hash',
  'fs.list_directory',
  'fs.open',
  'fs.open_random',
  'fs.read_file',
  'fs.search',
  'pdf.extract_text',
  'screen.ocr',
  'vscode.open_file',
  'vscode.open_folder',
]);

const isReadOnlyPathTool = (tool: string): boolean =>
  READ_ONLY_PATH_TOOLS.has(tool);

export const createDefaultToolContext = (
  desktop: ToolContext['desktop'],
  pathPolicy = new PathPolicy(),
): ToolContext => {
  const homeDirectory = os.homedir();
  return {
    cwd: process.cwd(),
    homeDirectory,
    platform: process.platform,
    desktop,
    resolvePath: (input) => pathPolicy.resolve(input, homeDirectory),
  };
};
