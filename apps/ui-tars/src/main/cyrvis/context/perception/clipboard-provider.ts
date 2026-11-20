import { createHash } from 'node:crypto';

import { isSensitiveMemoryText } from '../../memory-context';
import type { ResourceDescriptor } from '../types';
import type { PerceptionContext, PerceptionProvider } from './types';

export interface ClipboardPerceptionProviderOptions {
  id?: string;
  intervalMs?: number;
  ttlMs?: number;
  timeoutMs?: number;
  includeContent?: boolean;
}

export class ClipboardPerceptionProvider implements PerceptionProvider {
  readonly id: string;
  readonly intervalMs: number;
  readonly ttlMs: number;
  readonly timeoutMs: number;

  constructor(
    private readonly options: ClipboardPerceptionProviderOptions = {},
  ) {
    this.id = options.id || 'clipboard';
    this.intervalMs = Math.max(750, options.intervalMs ?? 1_500);
    this.ttlMs = Math.max(
      this.intervalMs * 2,
      options.ttlMs ?? this.intervalMs * 4,
    );
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 3_000);
  }

  async refresh(
    context: PerceptionContext,
    signal: AbortSignal,
  ): Promise<ResourceDescriptor[]> {
    if (!context.desktop || signal.aborted) return [];
    const content = await context.desktop.clipboardRead();
    if (signal.aborted) return [];
    const normalized = content.replace(/\r\n/g, '\n');
    const hash = createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 16);
    const includeContent =
      this.options.includeContent === true &&
      normalized.length <= 4_000 &&
      !isSensitiveMemoryText(normalized);
    return [
      {
        id: 'clipboard:current',
        kind: 'clipboard',
        name:
          normalized.length === 0
            ? '空剪贴板'
            : `剪贴板 ${normalized.length} 字符`,
        aliases: ['clipboard', '剪贴板', hash],
        source: `perception:${this.id}`,
        active: true,
        health: 'available',
        providerIds: [this.id],
        capabilities: ['clipboard.read', 'clipboard.write'],
        updatedAt: Date.now(),
        sensitivity: 'private',
        confidence: 0.95,
        metadata: {
          length: normalized.length,
          hash,
          hasContent: normalized.length > 0,
          text: includeContent && normalized.length > 0 ? normalized : null,
        },
      },
    ];
  }
}
