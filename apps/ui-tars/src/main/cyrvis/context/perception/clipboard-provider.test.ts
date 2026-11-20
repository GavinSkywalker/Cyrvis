import { describe, expect, it, vi } from 'vitest';

import type { DesktopHost } from '../../tools/types';
import { ClipboardPerceptionProvider } from './clipboard-provider';

const context = (text: string) => ({
  now: Date.now(),
  system: null,
  desktop: {
    clipboardRead: vi.fn(async () => text),
  } as unknown as DesktopHost,
  user: {
    revision: 0,
    updatedAt: 0,
    activeApplication: null,
    activeWindow: null,
    focusedControl: null,
    selectedText: null,
    clipboard: null,
    recentRequest: null,
    recentActions: [],
    recentResourceIds: [],
    currentTask: null,
  },
});

describe('ClipboardPerceptionProvider', () => {
  it('exposes metadata and a stable hash without content by default', async () => {
    const provider = new ClipboardPerceptionProvider();
    const resources = await provider.refresh(
      context('hello clipboard'),
      new AbortController().signal,
    );
    expect(resources[0]).toMatchObject({
      kind: 'clipboard',
      metadata: {
        length: 15,
        hasContent: true,
        text: null,
      },
    });
    expect(resources[0].metadata.hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('can include bounded non-sensitive content when explicitly enabled', async () => {
    const provider = new ClipboardPerceptionProvider({
      includeContent: true,
    });
    const resources = await provider.refresh(
      context('ordinary text'),
      new AbortController().signal,
    );
    expect(resources[0].metadata.text).toBe('ordinary text');
  });
});
