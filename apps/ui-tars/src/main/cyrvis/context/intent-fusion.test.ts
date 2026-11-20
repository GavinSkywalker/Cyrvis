import { describe, expect, it } from 'vitest';

import { IntentFusionStore } from './intent-fusion';
import type { DynamicContextSnapshot } from './types';

const contextSnapshot = (): DynamicContextSnapshot => ({
  revision: 1,
  updatedAt: 1_000,
  systemCapturedAt: 1_000,
  user: {
    revision: 1,
    updatedAt: 1_000,
    activeApplication: {
      value: 'application:start:code',
      source: 'system',
      confidence: 0.9,
      observedAt: 1_000,
      expiresAt: null,
      sensitivity: 'public',
    },
    activeWindow: {
      value: {
        pid: 10,
        process: 'Code',
        title: 'main.ts - Visual Studio Code',
        handle: 1,
      },
      source: 'system',
      confidence: 0.9,
      observedAt: 1_000,
      expiresAt: null,
      sensitivity: 'private',
    },
    focusedControl: null,
    selectedText: null,
    clipboard: null,
    recentRequest: null,
    recentActions: [],
    recentResourceIds: [],
    currentTask: null,
  },
  resources: [
    {
      id: 'application:start:code',
      kind: 'application',
      name: 'Visual Studio Code',
      aliases: ['code'],
      source: 'start-app',
      active: true,
      health: 'available',
      providerIds: ['vscode'],
      capabilities: [],
      updatedAt: 1_000,
      metadata: {},
    },
  ],
  activeResourceIds: ['application:start:code'],
  fallbackResourceIds: [],
  bindings: [],
  perception: [],
});

describe('IntentFusionStore', () => {
  it('combines coding context, recent gaze, and speech into ranked intents', () => {
    let now = 10_000;
    const store = new IntentFusionStore({ now: () => now });
    store.observeContext(contextSnapshot());
    store.observeGaze({
      x: 0.4,
      y: 0.5,
      at: now,
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      target: {
        id: 'function',
        scene: 'code',
        label: 'main function',
        role: 'text',
        source: 'accessibility',
        bounds: { x: 400, y: 300, width: 300, height: 200 },
      },
    });
    store.observeVoice('这个函数怎么修改', now);

    const snapshot = store.getSnapshot();
    expect(snapshot.activity).toBe('coding');
    expect(snapshot.gaze).toMatchObject({ label: 'main function' });
    expect(snapshot.candidateIntents[0]).toMatchObject({
      kind: 'edit',
    });
    expect(snapshot.candidateIntents[0].confidence).toBeGreaterThan(0.8);
    expect(store.getContext()).toContain('never execution authorization');
  });

  it('expires gaze and speech evidence independently', () => {
    let now = 20_000;
    const store = new IntentFusionStore({
      now: () => now,
      gazeTtlMs: 3_500,
      voiceTtlMs: 5_000,
    });
    store.observeContext(contextSnapshot());
    store.observeGaze({
      x: 0.5,
      y: 0.5,
      at: now,
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
    });
    store.observeVoice('这是什么', now);
    now += 4_000;
    expect(store.getSnapshot().gaze).toBeNull();
    expect(store.getSnapshot().recentUtterance?.text).toBe('这是什么');
    now += 2_000;
    expect(store.getSnapshot().recentUtterance).toBeNull();
  });
});
